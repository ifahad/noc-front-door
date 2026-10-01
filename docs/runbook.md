# NOC Front Door — operator runbook

**The question:** how would you know within a minute that the assistant is broken, and what would you look at first?

**The answer:** run the external prober — it alerts on `GET /ops/health/deep` failing twice in a row (worst case ≈ 30 s: outage starts just after a good probe → failure 1 by ~18 s, failure 2 by ~28 s → banner). First look at the live invocation log, then pull the per-call trace, then the Portal conversation, then the actor subsystem. Details below.

Prerequisites: `.env` with `EDGE_URL` (default `https://noc-edge-41d2a334-7.telnyxcompute.com`) and `OPS_TOKEN`. All scripts read `.env` themselves; no token is ever printed. One-off ops commands go through the helper — it reads `.env`, never echoes the token, prints `HTTP <status>` plus the body, and exits 0 only on 2xx:

```sh
node scripts/ops.mjs GET /ops/health/deep          # e.g.
node scripts/ops.mjs POST '/ops/ack?region=riyadh-north'
```

Do not use raw `curl … $OPS_TOKEN` — nothing exports the token into your shell.

## 1. Detect (≤ ~30 s)

```sh
node scripts/prober.mjs                # loop: every 10 s, minute summary, alerts
node scripts/prober.mjs --once         # one probe; exit 0 = ok, 1 = failing (for smoke)
node scripts/prober.mjs --interval 5   # tighter loop
```

- External probe on the dev box, outside the failure domain; the same loop keeps the edge function warm (spec §11.4).
- Every 10 s: `GET $EDGE_URL/ops/health/deep` with `Authorization: Bearer $OPS_TOKEN` and an 8 s abort timeout. 2 consecutive failures → console banner + `notify-send` (if installed).
- An actor **hang** that outlives two consecutive probes is a **failure** (`actor_hung` in the health body) — during the 2026-09-28 platform incident the actor runtime failed as 30 s hangs, which the old "slow is not down" branches counted as healthy for hours (DEBUGLOG #15).
- `degraded:true` with `slow:["kv"]` in the body is **not** a failure: it appears in the minute summary (`slow=[kv]`) and does not raise an alert (DEBUGLOG #6).
- Why the 8 s timeout (not 3 s): deep health runs its checks concurrently, but each check has a 4 s deadline of its own (Task 12b) and one KV op costs ~1–2 s on this account, so a full pass takes seconds when KV is slow (DEBUGLOG #6).
- Cross-checks: `telnyx-edge metrics` (5xx/error rate) and `dv.late` events in the logs — `dv.late` means the platform gave up on the webhook and spoke the greeting with defaults (fail-open by design, spec §5.4).

## 2. First look (~30 s): the invocation log

```sh
telnyx-edge logs noc-edge --tail --type invocations
```

Per-invocation records: `method`, `path`, `status_code`, `duration_ms`. Look for: which route is failing (`/dv`, `/tools/*`, `/mcp`, `/ops/*`), 4xx vs 5xx, and outlier durations.

`telnyx-edge logs` reads a window and caps a single pull at 250 lines (`--last`, max 250) — during an incident the runtime stream runs ~200 lines/min, so **count events by paging the logs API with narrow start/end windows** (`--since`), never from one page (the first count of the 2026-09-28 incident was off by ~4–5× that way; DEBUGLOG #15).

## 3. Then: the per-call trace

```sh
SINCE=15m scripts/trace.sh t-<call key>    # SINCE defaults to 30m
```

- `trace_id = "t-" + k` travels with the call (returned by `/dv`, carried in signed bodies, echoed by actors, recovered by MCP from `conv/<id>`). If the call never got a trace, there is no `trace_id` to grep — check the Portal conversation's Dynamic Variable Webhook Logs tab instead (the DV webhook never fired).
- Output: aligned columns `ts  hop  evt  outcome  total_ms` plus key extras (`route_hint`, `tool`, `site`, `status`), then the hop chain (`hops: dv → tool → mcp …`) and the total span.
- Read it like this: `outcome=error|denied|fallback` marks the broken hop; `total_ms` shows where the time went — `kv` hops of 1–2 s are the usual suspect on this account (DEBUGLOG #6).

## 4. Then: the Portal

- **Conversation → node labels:** which labelled node did the call reach? A call stuck before `t_open_ticket` vs. after it narrows the failure immediately.
- **Dynamic Variable Webhook Logs tab:** did `POST /dv` fire, and how long did it take? Absent or over the 2500 ms timeout → the platform used the static defaults; the call still works, degraded (spec §5.4).

## 5. Then: the actor subsystem

```sh
node scripts/ops.mjs GET '/ops/actor-ping?site=TST-001'
```

Returns `{mode, site:{…, actor_ms}, region:{…, actor_ms}}` — the active actor mode plus per-actor latency (warm ≈ 220 ms in mux mode).

**Do not** use `telnyx-edge actors instances` — it times out on this account (DEBUGLOG #4). `/ops/actor-ping` is the authoritative check.

## 6. Keep the prober running

The prober is not just a monitor — the design's heal loop and paging depend on it (DEBUGLOG #11: an incident vanished from the board after ~2 h because nothing was healing the KV projection). Run it continuously on the dev box:

```sh
nohup node scripts/prober.mjs > ~/code/telnyx-fde/ops-logs/prober.log 2>&1 &
```

What the single process does, on two independent timers:

- **Every 10 s — deep health + projection heal.** `GET /ops/health/deep` runs the KV, actor and MCP checks plus `syncCheck`, which re-syncs each region's incident projection **from actor truth** (the sync check runs at most every 30 s; the KV projection only has a 2 h TTL — `PROJECTION_TTL_SECONDS = 7200`). This is what keeps `/ops/status` and the front page board accurate, and it keeps the edge warm. Alert after 2 consecutive failures (worst case ≈ 30 s); `degraded` is not an outage, but a hang that survives two probes is **down** (`actor_hung`).
- **Every 30 s — escalation tick fallback + paging.** `POST /ops/tick` drives the SLA escalation ladder in `RegionState` as a fallback for the platform alarm (on this account the platform alarm does fire — DEBUGLOG #12 — so `fired:0` per tick is normal); then `GET /ops/pages/pending` → `POST /ops/pages/claim` → **PAGE banner** + `notify-send` + `page.sent` log line → `POST /ops/pages/sent`. Claim is exclusive (one claimer wins) and a page is never sent twice; the claimer id is `hostname:pid`. Non-2xx answers (401/5xx) throw and are logged as `paging.*_failed` warns; a failed sent-mark is retried in the same cycle (initial try + up to 3 retries) and again on later cycles, so a page is never silently dropped; `paging.stalled` warns after 3 consecutive failed cycles.

If the board shows nothing or pages never fire, the first suspect is **the prober is not running**.

## 7. Paging drill

1. Stage an incident: `node scripts/ops.mjs POST /ops/reset`, then `node scripts/ops.mjs POST '/ops/stage-incident?region=riyadh-north'` (or the operator console — `#console` or the backtick key). The staged P2 incident gets an escalation due time **5 min** out (P1: **2 min** — `P2_ACK_WINDOW_MS`/`P1_ACK_WINDOW_MS`).
2. Do nothing. When the due time passes without an acknowledgement, the ladder escalates (L1, L2, … up to L3) and mints a page (`INC-<n>:p<k>` — a monotonic per-incident counter, so an upgrade after a sent page never collides, DEBUGLOG #14).
3. Within ~30 s the prober's paging cycle claims the page: a loud **PAGE banner** in the prober log, a desktop notification (`notify-send`), and a `page.sent` JSON line; the pending queue returns to 0.
4. Stop the ladder: **Acknowledge** from the operator console (`#console` or the backtick key), or `node scripts/ops.mjs POST '/ops/ack?region=riyadh-north'`. The escalation column on the board flips to `ACKED`.
5. Recovery: if a demo site reports locked (the site-wide PIN lock after 6 failures from 2 calls), clear it with `node scripts/ops.mjs POST '/ops/unlock?site=RUH-114'` — note this also resets that site's ticket and call history.

## 8. Reading incident reports

On `resolve` (via `node scripts/ops.mjs POST '/ops/resolve?region=<region>'` or the operator console — only `/ops/resolve` writes reports), `RegionState`/the edge writes a JSON incident report to Telnyx Cloud Storage (bucket `noc-reports-fb8131`) — no presigned URLs (an API key cannot live in the function), so reports are read back through the ops-token routes:

```sh
# list (newest first):
node scripts/ops.mjs GET /ops/reports
# fetch one by key (as returned by the list / the board's last_report pointer):
node scripts/ops.mjs GET /ops/reports/<key>
```

The front page board carries the `last_report` pointer for the most recently resolved region.

## 9. The operator console

The public page (site root `/` and `/demo`) is the production front page; its **operator console is hidden**: append `#console` to the URL or press the backtick key. The console holds the demo scenarios with the two PIN chips, the detailed board, the event feed, the how-it-works copy and the presenter controls (stage/reset/ack/unlock/resolve, reports). It polls `/ops/board` every 10 s while open (the public map polls every 15 s, visible-only, pausing after 10 min idle). The ops token is pasted into the console once and stays in that tab's `sessionStorage`, sent only to this site's `/ops` routes.

## 10. During a platform incident

When the platform (not our code) is failing — the reference case is the 2026-09-28/29 actor + KV incident (DEBUGLOG #15):

- **Close idle tabs.** A forgotten board tab was ~60% of KV traffic during the incident; the page now pauses polling after 10 min idle, but old revisions and other clients may not.
- **Freeze host deploys.** Do not re-ship the actor host mid-incident — the same-code host redeploy at ~12:00Z on 2026-09-28 changed nothing. Ship edge/assistant fixes only.
- **Read logs through the logs API with narrow start/end windows.** `telnyx-edge logs` caps a single pull at 250 lines; during the incident the runtime stream ran ~200 lines/min, and a single-page count undercounted failures by ~4–5×.
- **Rollback — and know it can time out.** `telnyx-edge rollback <function> <revision-id>` retargets traffic to an existing immutable revision instantly (no rebuild; find revision ids with `telnyx-edge deployments <function>`). On 2026-09-28 the rollback API timed out twice against the degraded compute API; the fallback is a **revert-forward** — revert the change in git, re-run the tests, ship (commit `a94722c`, DEBUGLOG #17).
- Expect flapping: since 21:00:03Z on 09-28, 30–47% of actor calls failed while the rest succeeded — a green probe does not mean the platform is healthy; a red one does not mean our code broke.

## Known platform issues (this Trial account)

- **DEBUGLOG #15 — Telnyx platform incident 2026-09-28/29:** the actor runtime (Dapr scheduler, placement, actor directory, state store) failed from 06:14:44Z and the KV data plane from 19:06Z (hard down 20:45:33Z); it reproduces on paths our code cannot touch. Edge-side amplifiers were fixed (hang = down after two probes; 30 s sync; board 30 s from settle; flags cooldown; page polling pauses when idle) — nothing we ship ends a platform outage.
- **DEBUGLOG #4 — actor instances cannot be created:** every actor RPC from a second owner failed with `502` after ~30 s; the one working instance is the mux host. Contingency: set the KV flag `flag/actor_mode` = `mux` (all actor calls route through the single working instance, which multiplexes `SiteState`/`RegionState`). Check the active mode with `GET /ops/actor-ping` (`mode` field). Mode defaults: `flag/actor_mode` absent ⇒ per-entity (`services/flags.ts:100`); a failed or slow flag read ⇒ the last known mode, else `ACTOR_MODE_DEFAULT=mux` (`router.ts selectActorPort`). The mitigation in force holds the key at `mux` with **no expiry** (re-written 2026-10-01 07:4xZ) — **never write `flag/actor_mode` with a TTL**: an expired key reads as absent ⇒ per-entity, and live traffic must not run per-entity until the timing-wrapper fix ships (DEBUGLOG #21).
- **DEBUGLOG #5 — flag read budget:** every flag read costs a burst of KV gets (~1–2 s each). Flags are memoised (60 s after the Task 12b recalibration), so a flag change takes up to ~60 s to propagate — do not expect instant effect after `kv key put`.
- **DEBUGLOG #6 — KV reads cost ~1–2 s:** any route touching KV is slow; `/ops/health/deep` may answer `degraded` with `slow:["kv"]`. That is expected, not an outage. The prober does not alert on degraded.

## Fault-injection drills

Get the namespace id once (`telnyx-edge storage kv list` → the `noc-kv` id, below `$KV_ID`). Keys carry `--ttl 600s`, so drills self-heal after 10 min; allow up to ~60 s for the flag memo to expire.

1. **Tool failure** (breaks ticket opening):

   ```sh
   telnyx-edge storage kv key put "$KV_ID" flag/fault/open_ticket 503 --ttl 600s
   ```

   The next `open_ticket` (and `join_incident`) returns the injected status. Verify: `scripts/trace.sh` shows the tool hop with `outcome=error` (the raw log line carries `reason:"fault_injected"` — the injected status itself is not printed by the trace view); the caller is told the report failed.
   Clear: `telnyx-edge storage kv key put "$KV_ID" flag/fault/open_ticket 0 --ttl 600s`.

2. **DV delay** (exercises the fail-open greeting):

   ```sh
   telnyx-edge storage kv key put "$KV_ID" flag/fault/dv_delay_ms 3000 --ttl 600s
   ```

   Any injected delay logs `dv.late` with `fault_injected:true`; ~3000 ms pushes `/dv` past the platform's 2500 ms timeout, so the platform speaks the greeting with static defaults. Verify: the log line `dv.late … fault_injected:true`, and the conversation shows the default `site_id`/`route_hint`. Clear with `0`.

3. After each drill, check the prober stayed quiet (or fired and recovered), and reset lab state if the drill created tickets: `node scripts/ops.mjs POST /ops/reset`.

## Demo-call toggles

Two KV flags change who a web call is on the wire (the flags memo holds ~60 s after a write):

```sh
telnyx-edge storage kv key put "$KV_ID" flag/demo_caller c-khalid --ttl 600s   # identify every web caller as a seeded contact
telnyx-edge storage kv key put "$KV_ID" flag/deflection_enabled false --ttl 600s  # no incident advisory; verified callers go straight to triage
```

- With `flag/demo_caller` set and `flag/require_pin=false`, every web caller is identified as that contact — the Arabic intake (`c-khalid`, `preferred_language: ar`) and the deflection A/B (`c-ahmed`) are driven this way. **Never leave `demo_caller` set with `require_pin=false` on the public demo.** `/ops/reset` rewrites `require_pin=false` and does not clear `demo_caller`, so clear the toggles yourself: `telnyx-edge storage kv key delete "$KV_ID" flag/demo_caller` (or let the 600 s TTLs self-heal).
- Identified routing (route_hint `known_incident` / `verified` / `arabic`) is proven in unit tests and by these toggles; anonymous web calls always get the safe `unverified` path.
