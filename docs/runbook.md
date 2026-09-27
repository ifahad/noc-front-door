# NOC Front Door — operator runbook

**The question:** how would you know within a minute that the assistant is broken, and what would you look at first?

**The answer:** run the external prober — it alerts on `GET /ops/health/deep` failing twice in a row (worst case ≈ 23 s). First look at the live invocation log, then pull the per-call trace, then the Portal conversation, then the actor subsystem. Details below.

Prerequisites: `.env` with `EDGE_URL` (default `https://noc-edge-41d2a334-7.telnyxcompute.com`) and `OPS_TOKEN`. All scripts read `.env` themselves; no token is ever printed.

## 1. Detect (≤ ~23 s)

```sh
node scripts/prober.mjs                # loop: every 10 s, minute summary, alerts
node scripts/prober.mjs --once         # one probe; exit 0 = ok, 1 = failing (for smoke)
node scripts/prober.mjs --interval 5   # tighter loop
```

- External probe on the dev box, outside the failure domain; the same loop keeps the edge function warm (spec §11.4).
- Every 10 s: `GET $EDGE_URL/ops/health/deep` with `Authorization: Bearer $OPS_TOKEN` and an 8 s abort timeout. 2 consecutive failures → console banner + `notify-send` (if installed).
- `degraded:true` with `slow:["kv"]` in the body is **not** a failure: it appears in the minute summary (`slow=[kv]`) and does not raise an alert (DEBUGLOG #6).
- Why the 8 s timeout (not 3 s): deep health runs KV checks sequentially and one KV read costs ~1–2 s on this account, so a full pass takes seconds (DEBUGLOG #6; Task 12b parallelises the checks).
- Cross-checks: `telnyx-edge metrics` (5xx/error rate) and `dv.late` events in the logs — `dv.late` means the platform gave up on the webhook and spoke the greeting with defaults (fail-open by design, spec §5.4).

## 2. First look (~30 s): the invocation log

```sh
telnyx-edge logs noc-edge --tail --type invocations
```

Per-invocation records: `method`, `path`, `status_code`, `duration_ms`. Look for: which route is failing (`/dv`, `/tools/*`, `/mcp`, `/ops/*`), 4xx vs 5xx, and outlier durations.

## 3. Then: the per-call trace

```sh
SINCE=15m scripts/trace.sh t-<call key>    # SINCE defaults to 30m
```

- `trace_id = "t-" + k` travels with the call (returned by `/dv`, carried in signed bodies, echoed by actors, recovered by MCP from `conv/<id>`). If the call never got a trace, the logs show `trace.missing_key` — the DV webhook never fired.
- Output: aligned columns `ts  hop  evt  outcome  total_ms` plus key extras (`route_hint`, `tool`, `site`, `status`), then the hop chain (`hops: dv → tool → mcp …`) and the total span.
- Read it like this: `outcome=error|denied|fallback` marks the broken hop; `total_ms` shows where the time went — `kv` hops of 1–2 s are the usual suspect on this account (DEBUGLOG #6).

## 4. Then: the Portal

- **Conversation → node labels:** which labelled node did the call reach? A call stuck before `t_open_ticket` vs. after it narrows the failure immediately.
- **Dynamic Variable Webhook Logs tab:** did `POST /dv` fire, and how long did it take? Absent or over the 2500 ms timeout → the platform used the static defaults; the call still works, degraded (spec §5.4).

## 5. Then: the actor subsystem

```sh
curl -sS -H "Authorization: Bearer $OPS_TOKEN" "$EDGE_URL/ops/actor-ping?site=TST-001"
```

Returns `{mode, site:{…, actor_ms}, region:{…, actor_ms}}` — the active actor mode plus per-actor latency (warm ≈ 220 ms in mux mode).

**Do not** use `telnyx-edge actors instances` — it times out on this account (DEBUGLOG #4). `/ops/actor-ping` is the authoritative check.

## Known platform issues (this Trial account)

- **DEBUGLOG #4 — actor instances cannot be created:** every actor RPC from a second owner failed with `502` after ~30 s; the one working instance is the mux host. Contingency: set the KV flag `flag/actor_mode` = `mux` (all actor calls route through the single working instance, which multiplexes `SiteState`/`RegionState`). Check the active mode with `GET /ops/actor-ping` (`mode` field).
- **DEBUGLOG #5 — flag read budget:** every flag read costs a burst of KV gets (~1–2 s each). Flags are memoised (60 s after the Task 12b recalibration), so a flag change takes up to ~60 s to propagate — do not expect instant effect after `kv key put`.
- **DEBUGLOG #6 — KV reads cost ~1–2 s:** any route touching KV is slow; `/ops/health/deep` may answer `degraded` with `slow:["kv"]`. That is expected, not an outage. The prober does not alert on degraded.

## Fault-injection drills

Get the namespace id once (`telnyx-edge storage kv list` → the `noc-kv` id, below `$KV_ID`). Keys carry `--ttl 600s`, so drills self-heal after 10 min; allow up to ~60 s for the flag memo to expire.

1. **Tool failure** (breaks ticket opening):

   ```sh
   telnyx-edge storage kv key put "$KV_ID" flag/fault/open_ticket 503 --ttl 600s
   ```

   The next `open_ticket` (and `join_incident`) returns the injected status. Verify: `scripts/trace.sh` shows the tool hop with `outcome=error` and `status=503`; the caller is told the report failed.
   Clear: `telnyx-edge storage kv key put "$KV_ID" flag/fault/open_ticket 0 --ttl 600s`.

2. **DV delay** (exercises the fail-open greeting):

   ```sh
   telnyx-edge storage kv key put "$KV_ID" flag/fault/dv_delay_ms 3000 --ttl 600s
   ```

   Any injected delay logs `dv.late` with `fault_injected:true`; ~3000 ms pushes `/dv` past the platform's 2500 ms timeout, so the platform speaks the greeting with static defaults. Verify: the log line `dv.late … fault_injected:true`, and the conversation shows the default `site_id`/`route_hint`. Clear with `0`.

3. After each drill, check the prober stayed quiet (or fired and recovered), and reset lab state if the drill created tickets: `POST /ops/reset` with `Bearer $OPS_TOKEN`.
