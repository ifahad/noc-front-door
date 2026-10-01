# DEBUGLOG.md

Blocking findings from the build, with evidence. One entry per finding.

## Entry template

```
## #<n> — <date> — <one-line title>
- Symptom: what is visibly wrong
- Signal: the exact message, code path or metric that surfaced it
- Evidence: where it can be reproduced (log line, portal screen, command)
- Hypothesis: best current explanation
- Fix: what was done, or the action in flight
- Verification: how the fix was proven, or what is still pending
```

## #1 — 2026-09-26 — No phone number can be ordered on the trial account (KSA origin)

- Symptom: The Telnyx Portal number search cannot order any number for the project; the account is trial with a Saudi Arabia origin.
- Signal: The Portal number search says: "Worldwide number coverage is only available to verified users. Your account is trial and only able to search and purchase local numbers in Saudi Arabia." Choosing Saudi Arabia returns "Telnyx does not have search coverage in this country." So no number can be ordered.
- Evidence: the Portal messages (screens seen by Fahad during the number search).
- Hypothesis: Trial accounts are limited to local numbers in Saudi Arabia, but Telnyx has no search coverage there, so ordering is impossible until the account is verified.
- Fix: Emailed Telnyx Team asking for Verified status on the account.
- Verification: Pending Telnyx Team's reply (email sent 2026-09-26). Workaround in the meantime: web calls (the trial account supports web calls only anyway).
- Also: the brief's CLI URL (`telnyx-edge-linux-amd64`) does not match this aarch64 host; the v0.5.4 linux-arm64 asset was used instead.

## #2 — 2026-09-26 — OpenCode silent stop: exit 0 with no work done

- Symptom: `opencode run` (Task 2 attempt 1) exited 0 but produced no work — no files written, no commits.
- Signal: step finish `reason=length`, `output=0`, `reasoning=8193` (~20.6K tokens) — the model burned the whole output budget on reasoning tokens and emitted nothing.
- Evidence: `@telnyx/opencode` plugin 0.1.5 `dist/index.js`: `output.maxOutputTokens = void 0` (L280) strips the request's max output tokens, so the server default (~8192) applies; `THINKING_CAPABLE_MODELS` (L19-25) omits GLM-5.3/GLM-5.3-Flash/Kimi-K3, so thinking is on by default for these models and unbounded relative to the cap; the `thinking`/`no-thinking` variants are only defined for the listed models.
- Hypothesis: reasoning tokens consume the output budget before any tool call or text is produced; forcing the `no-thinking` variant stops the silent truncation.
- Fix: run with `--variant no-thinking`; architect wrapper `oc-run.sh` added, which fails loudly on silent truncation (non-empty output / finish-reason check); terse-agent rule added to AGENTS.md (cap ~8K output tokens; no plan dumps in chat); sessions resumed with `opencode run --session <id>` after truncation.
- Verification: subsequent tasks completed normally on GLM-5.3-Flash — Task 2 attempt 2c: 43 steps, 42 tool calls, commit `4297baf` (8/8 tests); Tasks 3-5 also completed with non-empty output.

## #3 — 2026-09-26 — `opencode run` hangs 40 minutes with zero events

- Symptom: resuming Task 2 hung 40 minutes with zero events and was killed by timeout (exit 124).
- Signal: exit 124 after a 40-minute timeout; no step/tool events at all.
- Evidence: isolated to a flag pair — not `--title`, not `--auto` (hang reproduced with both removed). The harness runs `opencode run` with stdin as an open socket (`/proc/self/fd/0` → socket), and `opencode run` reads non-TTY stdin as extra prompt input, waiting forever for EOF that never comes.
- Hypothesis: `opencode run` blocks on stdin EOF when stdin is a non-TTY socket; earlier successful runs were incidental (stdin happened to close).
- Fix: always invoke with `< /dev/null`.
- Verification: the identical command completes in 6 s and 3 s with stdin redirected from `/dev/null`.

## #4 — 2026-09-26 — Actor RPC fails with 502 after ~30 s (resolved by the mux workaround)

- Symptom: every `ProbeActor` RPC from `noc-probe` (armAlarm/ping/status) fails; smoke checks 4.3/4.4 blocked. Non-actor routes on the same function are unaffected.
- Signal: `actor invocation <account>__ProbeActor/probe1.<method> returned 502: bad gateway` after ~30 s; non-actor routes answer in ~4 ms; the ProbeActor actor type shows status ready/owner while its revision is stuck "deploying". ~10 function-runtime boots in 38 s were observed during the rollout (scale-out/restarts).
- Evidence: `noc-probe` logs (30 s invocation durations vs 4 ms non-actor routes; 502 per every method). Bisection table of hypotheses:
  | Hypothesis | Result |
  |---|---|
  | A — actor runtime rollout stuck / platform-side | Falsified (not a rollout phase issue) |
  | C — platform/account-level actor breakage | Falsified: the stock CLI-scaffold `Counter` canary (deployed as `noc-actor-canary`) serves actor RPCs on the same account |
  | B1 — MCP SDK import in our bundle breaks the actor runtime | Falsified: the canary loads the MCP SDK too and works |
  | B2 — bundle size | Falsified: canary 3.18 MB vs probe 3.20 MB — a 20 KB delta cannot gate loading |
  | D-KV — KV binding on the owner function | Falsified: experiment A (owner with KV + SDK) works (deploy 34 min) |
  | D-secret — `[[secrets]]` binding on the owner function | Experiment E pending (owner + `[[secrets]]` OPS_TOKEN) |
  - Discovery during bisection: actor types are **account-scoped** — a second function declaring the same actor type registers as a `reference` binder, not a duplicate owner. This made the B branch confound into a reference-binder experiment.
- Hypothesis: remaining suspect is the `[[secrets]]` binding on the actor-owner function (experiment E in flight). The reference-binder path is already proven viable by B: a clean binding-free owner function plus a reference binder holding secrets/KV serves actor RPCs.
- Fix (in flight): run experiment E to confirm/refute the secrets-binding cause. Workaround adopted regardless of the root cause: a binding-free owner function (`noc-actors`, classes only) plus `noc-edge` as a reference binder holding KV, secrets, routes and MCP — which also delivers least privilege (actor processes get no secrets).
- Verification: pending — experiment E result, then re-run smoke 4.3/4.4 against the workaround topology.
- Update (2026-09-27): the workaround is live — mux mode since 05:20 UTC+3 (`flag/actor_mode=mux`): all actor calls route through the one working instance (`Counter/demo` on noc-actor-canary, now shipped as `edge/noc-actor-host`), which multiplexes the real `SiteState`/`RegionState` classes. `Counter/demo` **survived the identical rebuild** (experiment G: value 45→46), so rebuilding the owner does not kill the contingency. A 9-hour recovery watcher (ended 11:04; last probe 10:53) saw **no recovery** — a fresh actor type still returned 502 after 30 s. Escalated to Telnyx. Live in mux mode: `/ops/actor-ping` → site RUH-114 pong 220–454 ms, region riyadh-north pong 220 ms.
- Update (2026-09-27, shipped-edge smoke, from the plan-1 SDD ledger): with the mux workaround live, the smoke checks that were blocked by the 502s now pass: `GET /ops/status` → 200; unsigned `POST /dv` → 403; `POST /mcp` without a bearer → 401; `GET /mcp` → 405. The actor-level smoke (4.3/4.4) is covered by `/ops/actor-ping` returning `mode:"mux"` with pongs.
- Update (2026-09-30): new instances work again — two fresh `Counter` instances (probe-0930-a/-b) answered in 1.0–1.4 s, so the new-instance block appears lifted (for the Counter type at least). The switch to per-entity mode was attempted next; it was flipped and reverted on 2026-10-01 — see #21. Mux stays the instant flag fallback.

## #5 — 2026-09-27 — Flag-read budget wrong for real KV latency: every request fell back

- Symptom: after T13-lite shipped, every request logged `flags.fallback`; `/ops/actor-ping` still answered per-entity although `flag/actor_mode=mux` was set. Found by our own logs within a minute.
- Signal: `flags.fallback` on every request — the live KV flags read (6 gets) exceeded the 250 ms `FLAGS_BUDGET_MS`, including 3 MCP requests 0.4 s apart (the per-binding memo never warmed). Measured flag/mode reads: 1341–2000 ms (`actor_mode.read` total_ms 1690/2000/1341).
- Evidence: noc-edge runtime logs 05:13–05:25; the `actor_mode.read` log line added by the fix.
- Hypothesis: the 250 ms flags budget assumed fast KV (DEBUG #6); on this account a KV burst costs seconds, so every read timed out and fell back to per-entity mode with safe defaults.
- Fix: `selectActorPort` takes a per-route budget — `/dv` 250 ms (C3 margin), all other routes 2000 ms; a module-level last-known-good mode is used on timeout; `actor_mode.read` logged with `total_ms` so KV latency is measured, not guessed.
- Verification: re-review 4/4 addressed (noc-edge 262 tests); live round 2 (05:47–05:52): `/ops/actor-ping` → `{"mode":"mux"}`, site RUH-114 pong 220–454 ms, region riyadh-north pong 220 ms — first live actor success.

## #6 — 2026-09-27 — KV latency ~1.1–2.0 s per op breaks latency-shaped routes

- Symptom: KV is slow on this account. `/dv` almost always missed its internal deadline and fell back to generic defaults; `/ops/health/deep` answered `ok:false` (6.7–8.8 s total; `kv_ms` 1500 + `sync_ms` 1500 deadlines hit); `/diag/race?mode=actor` n=5 → `created_count 0` (all 5 openers exceeded the 1500 ms race deadline — a latency artifact, not correctness); `/ops/status` took ~9.7 s.
- Signal: `actor_mode.read` total_ms 1690/2000/1341 at the edge; REST GET of the same key from the dev box **1.07–1.17 s**; edge KV ops **1.3–2.0 s**. The spec assumed a fast read projection.
- Evidence: live logs (T13-lite rounds 1–2, health checks at 11:2x); `telnyx-edge storage kv key get` timings from the dev box.
- Hypothesis: sequential chains of KV ops on caller-facing paths blow every budget at this latency; the race deadline and health deadlines were sized for a fast KV.
- Fix: Task 12b (single-flight + 60 s flags memo; adapter-first directory — the seed is in memory; concurrent `/dv`: flags ∥ contact → incident/session/conv ∥, actor after flags; actor port from the same flags read; health checks concurrent with 4 s deadlines, degraded/slow ≠ down; race deadline 8 s) + Task 12c (concurrent KV in the tool webhooks, observable `mcp.session` reason, verify timeout 5000→8000 ms) + Task 12d (concurrent status reads, 6219→<3000 ms; public `/demo`).
- Verification (before→after, under a 1000 ms/op fake KV unless noted): `/dv` key path 1014 ms (vs old sequential); `verify_site` 5428→2010 ms; `open_ticket` 4830→1618 ms; `callback` 2410→1409 ms; `/ops/status` reads 6219→<3000 ms. Live: voice call #2 `verify_site` 3579 ms (was 7869, DEBUG #8); call #3 verify 3646 ms, join 2559 ms. Health now answers `degraded:true, slow:["kv"]` instead of `ok:false`; the prober treats degraded as not-an-outage (runbook).

## #7 — 2026-09-27 — Live assistant apply: keyterm shape and tool read-back normaliser

- Symptom: the first live apply of `sanad-noc` failed `400/10026 "Expected string type"` at `/body/transcription/settings/keyterm`; after fixing that, all 7 shared-tool read-backs printed `DRIFT got=null` although the tools were created.
- Signal: apply run 20:00:57 → 400/10026; real `GET /v2/ai/tools/{id}` shape is `{id,type,display_name,tool_definition:{…},timeout_ms,created_at}` — we send `{type,<type>:{…}}`, and `normaliseToolReadback` never mapped `tool_definition` back under `got[got.type]`, so the subset diff found nothing → `got=null`.
- Evidence: apply output (idempotency proven by rerun: everything found by name, no duplicates); the tools GET response.
- Hypothesis: (a) keyterm must be a comma-separated string ("Keyterm Boost accepts a comma-separated list"), not a list; (b) the read-back normaliser was written from an assumed shape.
- Fix: keyterm → comma-separated string; `validateAssistant` requires a string keyterm; `normaliseToolReadback` maps `tool_definition` → `got[got.type]` (tests from the real shapes); `telnyx()` error messages carry `errors[0].detail` and `source.pointer` — the missing detail cost a scratch diagnostic.
- Verification: re-apply at 20:05:01 → assistant APPLIED (version 20260927T170510849210): 24 nodes / 51 edges, start `s_open`, DV → `/dv` 2500 ms, tool_ids `[capture_details]`, MCP `noc-mcp` (5 tools); read-back `validateAssistant []` and zero DRIFT.

## #8 — 2026-09-27 — Voice call #1: correct PIN still escalated (7869 ms > 5000 ms tool timeout)

- Symptom: voice call #1 (Fahad, 17:10 UTC, trace `t-5d419f3a98a3240f`): `verify_site` returned `verify_result "ok"` for the correct PIN but took total_ms **7869 > 5000 ms** tool timeout — Telnyx treated verification as a failure and ran the designed escalation path: transfer to the on-call engineer (unanswered) → take a message → `log_callback` (2.8 s, `page.raised`). The DV webhook had also fallen back at 2200 ms (`kv` 2195) → generic greeting. Escalation/fallback paths proven live; the happy path was blocked by KV latency (DEBUG #6).
- Signal: trace by `trace_id`: `tool.verify_site` total_ms 7869; `dv.route` outcome=fallback.
- Hypothesis: sequential KV work inside the tool webhooks (DEBUG #6).
- Fix: Task 12c — concurrent KV in the tools (verify_site 5428→2010 ms, open_ticket 4830→1618 ms under a 1000 ms/op fake KV) and `verify_site` timeout 5000→8000 ms as a safety net.
- Verification: call #2 (18:05 UTC, trace `t-128d0766…`): `verify_site` **3579 ms ok** (was 7869) → `join_incident` 2638 ms → NJD-1401; the incident stayed P2/1 site **by design** — `RegionState` ignores reports older than 6 h, so the 05:47 staged reports were pruned (demo lesson: run `/ops/reset` → `/ops/stage-incident` pre-flight, spec §16). Call #3 (18:14 UTC, trace `t-c01949fafca2a42e`): verify 3646 ms ok → join 2559 ms → NJD-1402 → **INC-1002 now P1 / 3 sites**, confirmed on `/ops/status`. Core demo path proven live over voice — see `docs/evidence/voice-calls.md`.

## #9 — 2026-09-27 — Chat is not a valid test channel for this flow

- Symptom: in `/chat`, `capture_details` (the `update_dynamic_variables` shared tool) is **"not available on this channel"** — the flow cannot reach `t_verify` in chat; the LLM then improvised MCP `get_site_status`/`check_known_incidents` with no session → `SESSION_FALLBACK`. DV fires on **every** chat turn at 1.5–2.2 s (`kv_ms` ≈ total; DEBUG #6 again).
- Signal: chat smoke conversation `cad930bd…`: disclosure + greeting + "site ID and PIN" prompt OK; then the channel error on `capture_details`.
- Evidence: the chat transcript (Portal conversation `cad930bd…`); noc-edge logs showing the per-turn DV calls and the MCP fallback.
- Hypothesis: `update_dynamic_variables` is voice-only, so chat is not a valid test channel for this flow.
- Fix: validation moved to voice calls (DEBUG #8); follow-up T12c logs `mcp.session` `{outcome, reason: no_conv_id|no_conv_link|no_session|timeout}` — the MCP fallback previously gave no reason in the logs (observability gap found live).
- Verification: voice calls #2/#3 validate the flow end-to-end. Chat remains usable for disclosure/greeting checks only.

## #10 — 2026-09-27 — The public /demo page rendered no call launcher

- Symptom: the `/demo` page loaded and the widget connected (login ok, agent connected, EU fr5) but no launcher button appeared — the visitor could not start a call.
- Signal: headless Chromium (playwright-core + cached chromium): the `telnyx-ai-agent` element had no shadow-DOM launcher; the assistant read-back had `widget_settings: null`.
- Evidence: the live page vs the assistant read-back; `apply.mjs` output showing the assistant config with no `widget_settings` block.
- Hypothesis: `widget_settings` was never part of the assistant config, so the widget had no launcher settings to render.
- Fix: added `widget_settings` via config-as-code (`scripts/apply.mjs` — never patch the assistant outside `apply.mjs`); commit `aaa8eec`.
- Verification: after the apply, headless Chromium confirms the "Talk to Sanad" launcher renders (bottom-right, dark) and the agent connects (EU fr5).

## #11 — 2026-09-27 — Incident vanished from the board ~2 h after its last sync

- Symptom: INC-1002 was still held by the actor but had disappeared from `/ops/status` and the NOC wall ~2 h after its last sync.
- Signal: the KV projection is written with `PROJECTION_TTL_SECONDS = 7200` (2 h TTL); with **no prober running**, nothing re-synced it from actor truth — the heal loop is load-bearing, not optional.
- Evidence: `edge/noc-edge/src/services/incidents.ts` (TTL 7200); the board's stale/absent projection while `RegionState` still held the incident.
- Hypothesis: the projection's TTL assumed the heal loop runs continuously; the design intent was that the prober's deep-health sync re-writes projections every ~10 s.
- Fix: operational — the prober now runs continuously (`nohup`, `~/code/telnyx-fde/ops-logs/prober.log`); the runbook says "keep the prober running". Re-staged INC-1003 (P2, 2 branches) at 23:30.
- Verification: with the prober running, projections stay fresh (deep-health `syncCheck` heals every region from actor truth; README "Try it" warns reviewers).

## #12 — 2026-09-28 — Actor alarms work although new instances cannot be created

- Symptom: given DEBUG #4 (new actor instances cannot activate on this account), it was reasonable to assume actor alarms would also not fire.
- Signal: the live INC-1004 test (2026-09-27 21:46:50Z stage → 21:51:4xZ escalation; all times UTC): the ladder escalated to L1 and minted page `INC-1004:p1` while **every** `/ops/tick` in the window reported `fired:0` (incl. 21:51:51Z, 4 s before the claim) — so the escalation was driven by the **platform alarm** on the mux host, fanned out to the entity (not the tick fallback).
- Evidence: [docs/evidence/alarms-live.md](docs/evidence/alarms-live.md); the prober claimed and "sent" the page at 21:51:53Z (PAGE banner, `page.sent` log, pending 0).
- Hypothesis: the mux host (`Counter/demo`) is the one pre-existing instance, and its own alarm — set via `ctx.storage.setAlarm` — is delivered by the platform; the host's `alarm()` fans out to the entities.
- Fix: none needed — this is the finding: the mux host's alarm path is live.
- Verification: live alarm test (see the evidence file); the tick fallback stays as a belt-and-braces path.

## #13 — 2026-09-28 — Cloud Storage binding missing `region` (caught before ship)

- Symptom: the P2-4 incident-report feature would not bind — the CLI rejects the manifest, and at runtime a region-less bucket binding is silently skipped (the function ships without the binding).
- Signal: `telnyx.toml` `[cloudstorage]` block lacked `region`; CLI validation error on ship; the runtime binding list skipped the block.
- Evidence: P2-4 review (2 lenses + skeptics) confirmed the Critical before any deploy; the fix is commit `9772a47`.
- Hypothesis: the architect's prompt snippet for the binding omitted the required `region` field.
- Fix: `region = "us-central-1"` added to the `cloudstorage` block (the architect-provided snippet was the defect source; the review caught it before ship).
- Verification: dry-run validation passes. **Live (2026-09-28 01:36Z):** resolving INC-1004 wrote `incidents/INC-1004-2026-09-27T21-46-42Z.json` (926 B) to bucket `noc-reports-fb8131`; `GET /ops/reports` lists it, `GET /ops/reports/<key>` returns it, and `/ops/board` carries the `last_report` pointer — built **and** live. (Cloud Storage itself was suspended 2026-09-30 while the balance was negative, and restored with the 2026-10-01 top-up.)

## #14 — 2026-09-28 — Page-id collision after a P2→P1 upgrade (page never delivered)

- Symptom: after an incident upgraded P2→P1, the post-upgrade page shared its id with an already-sent page, so the new page was never delivered (claim/mark-sent hit the stale entry), and the prober's `claimedIds` cache masked it forever.
- Signal: page id was `incidentId + ":" + level`; a P2→P1 upgrade resets `esc.level`, so the id `INC-x:p1` was minted twice.
- Evidence: P2-2 review (2 lenses + skeptics) — CONFIRMED Critical, reproduced by the reviewer.
- Hypothesis: deriving the page id from a field that can reset makes the id non-unique over an incident's lifetime.
- Fix: persisted monotonic per-incident page counter for ids (`INC-x:p1`, `:p2`, … — `pageSeq`), with the level kept as a separate field; per-region isolation in pending pages; one JSON warn log per paging failure (never the token). Commits `2d1a3b3` + `85cfaf9`.
- Verification: regression test pins that an upgrade after a sent P2 page yields a fresh id; re-review 4/4 addressed, no new issues.

## #15 — 2026-09-28/29 — Telnyx platform incident: actor runtime and KV data plane down/flapping

- Symptom: from 06:14:44Z the actor runtime cycled 30 s hangs and fast 500/502/503s; from 19:06Z the KV data plane degraded and from 20:45:33Z was hard down (100% of get/put/list/delete → 500 in ~0.42 s). Voice tools returned 500s, the board and health flapped. The prober only went DOWN at 08:45:04.9Z, once failures became fast — hangs had been counted as healthy.
- Evidence (verbatim strings and counts from fully paged log windows): first error 06:14:44Z — `/ops/tick` 500 `deleteAlarm: Dapr returned 500 ERR_ACTOR_REMINDER_DELETE ... keepalive ping failed to receive ACK within timeout`; sustained `Counter/demo.* returned 502: bad gateway` from 06:15:55; `cron is closed`; `dial tcp <scheduler>:50006 connection refused`; `did not find address for actor <acct>__Counter/demo` ×4,270; `503 actor directory unavailable` ×6,647 (1,904 of them in the 12:00 hour, after a same-code host redeploy that changed nothing); actor state store `server login has been failing / the database system is shutting down` ×1,014 (15:27–15:34); KV `500 {code 10007 "Unexpected error"}`; `context canceled` at 13:33 and 20:57; secret-read timeouts 654 at 21:12–21:24. **Reproduces on paths our code cannot touch:** a brand-new actor id (`verified-probe-1417` hung 30.6 s then 502), the host's own increment (500/502 in 216–254 ms while the pod served), and direct KV REST from the dev box (18/18 key GETs + list → 500/10007, while the namespace metadata GET returned 200 `provision_ok` — control plane up, data plane down). Neither onset tracked our load (onset ran at prober-only ~0.7 actor calls/s; the same load had run clean before; our peak was ≤ ~27% of the instance's observed ~11–13 calls/s capacity). Corrections after the multi-agent recount over fully paged windows: 22:08–22:13 held ~400–500 KV failures (two counts: 411 and 504) and 404 actor 502s — not the 94 and 93 from a single 250-record page (runtime logs ran ~200 lines/min during the outage).
- Root cause: Telnyx-side, two independent data-plane failures — (1) the actor runtime (Dapr scheduler, placement, actor directory, pgbouncer-backed state store; host pod churn: 24 process starts / 19 SIGTERMs in 24 h) and (2) the KV data plane. Our code did not start it and could not end it. Our amplifiers (none provably prolonged it): `MuxHost.reconcileAlarm` deleted the Dapr reminder on every 30 s tick inside the single serialized turn (~2,880 needless reminder deletes/day plus 5,760 `sched/` lists; ticks stalled 18.9 s and 26.4 s); the board was 68% of actor traffic (~119k of 175k calls/24 h), its 8 s TTL measured from request start (67% cache miss, ~99% in hang hours) with no circuit breaker (~3 calls/s into a dead backend, ~90–100 calls hung at a time); the flags memo filled only on success (19× reads during failures); a `/demo` tab polling since 19:41Z drove ~60% of KV traffic; health counted a 30 s hang as ok-slow, hiding ~5.5 h of total hang.
- Fix (edge-only — the host was **frozen**): a hang that outlives two consecutive probes is **down** (`actor_hung`), not "slow"; the health sync check runs at most every 30 s; the board is cached 30 s from settle (10 s when degraded) — no stale-while-revalidate; a failed flag read enters a 30 s cooldown that rejects fast (`flags_cooldown`) instead of re-reading KV or serving synthetic flags; the public page polls every 15 s only while visible, the console every 10 s, failures back off to 60 s, and polling pauses after 10 min idle. Deliberately **not** changed during the incident: no actor-host redeploy (the ~12:00 same-code redeploy had changed nothing).
- Outcome (2026-09-29): the incident ended ~13:05Z per the prober (the KV error cluster ran 13:04–13:05 in the paged RCA); a 20:21Z account check confirmed full recovery — KV direct GET 200 in ~0.8–1.1 s, actors 6/6, deep health `ok:true`, prober `state=ok`.
- Lesson: count log events by paging the logs API with narrow start/end windows — a single capped page undercounts by an order of magnitude during an outage.
- Links: [runbook — During a platform incident](docs/runbook.md); [architecture — load semantics](docs/architecture.md); DEBUGLOG #17 (a self-inflicted regression inside this window), #19 (the voice-path bug the incident exposed).

## #16 — 2026-09-28 — Call #5: "the Arabic switch was weird" — the English voice spoke Arabic

- Symptom: PSTN call #5 (19:42:02Z, KSA mobile → `+1 512 980 6105`, conversation `f2964f73-1a3d-4568-add9-b818a645d301`): number routing worked (opening disclosure played), but when the caller said "can you switch to the arabic version" in `n_wrapup`, the **English** assistant answered in Arabic with the **English Kokoro voice** — no handoff (Fahad: "the arabic switch was weird"). Also: premature "I'm ready." / "I have JED." while the caller was still spelling, and `find_site` answered "not found for your organisation" three times for JED-007.
- Evidence: read-only workflow analysis (`wf_c4d263ef-2a6`) over the transcript: 4 of 8 English prompt nodes (`n_wrapup`, `n_take_message`, `n_status`, `n_ticket_failed`) had **no Arabic exit**, and a leftover instruction told the English model to continue in Arabic → English Kimi + Kokoro spoke Arabic. nova-3's unpunctuated fragments hit the 1.5 s default endpointing → the premature "I'm ready."/"I have JED." A session whose `customer_id` is null makes `find_site` answer NOT_FOUND ("for your organisation") → re-spell loop (JED-007 **is** c-alwaha). Paging the logs API around the call surfaced a new P0 the transcript could not show: `/dv` 403 at 19:42:04Z in us-east-1, 72 ms, `dv.sig_fail reason no_key` — `SECRETS.get` failed on a cold instance; earlier DVs from the same region were 200 (transient), and the catch had swallowed the cause.
- Root cause: the Arabic sub-flow had been designed inside one assistant with "continue in Arabic" text, and the split into two assistants left both the instruction and four missing exits; plus the endpointing, org-scoping and cold-instance-secret defects above.
- Fix: Arabic exits from **every** English prompt node, enforced by the new `requireArabicExits` validator rule (`scripts/lib/flow-validate.mjs` — proven to fail on the old config); English-only instructions with the fixed hand-off line "Sure. Please go ahead in Arabic."; a calmer `start_speaking_plan` for spelled IDs; `find_site` asks for verification instead of "not found" when the session has no organisation. (Same window: the outbound voice profile whitelist that caused the call's transfer 403 `D13` gained SA — see [docs/setup.md](docs/setup.md).) Applied live 20:35Z (commit `00e8d13`, the P3-3a lane's `d99f151` cherry-picked).
- Lesson: a language handoff needs an exit from every conversational node, not just the happy-path ones; and when a live call behaves oddly, page the logs API with a time window — the 403 `no_key` was invisible in the transcript.
- Links: [voice-calls.md](docs/evidence/voice-calls.md) (#5); `assistant/assistant.json`; DEBUGLOG #18 (the handoff itself, one call later).

## #17 — 2026-09-28 — Self-inflicted regression during the incident: 150 ms per-attempt cap broke every secret read

- Symptom: revision `07ed3775` (commit `cf59e27`) live at 21:23Z — the new `secret.read_failed` logging showed **every** secret read (`TELNYX_PUBLIC_KEY`, `PIN_PEPPER`, `MCP_TOKEN`, `DEMO_GUIDE`, `OPS_TOKEN`) timing out at the 150 ms per-attempt cap on all 3 attempts (0 `read_recovered`) → `getSecret` null → `/dv` and `/tools/*` signature checks and MCP auth **failed closed** for ~20:5xZ–22:0xZ (about an hour). Found within minutes of going live by our own logging.
- Evidence: `secret.read_failed` lines for all five secrets in the live logs; post-revert verification: `/ops/health/deep` 200 with `OPS_TOKEN`, MCP `initialize` 200 with `MCP_TOKEN`, `/mcp` unauth 401.
- Root cause: Ruling P3-R6 adopted a reviewer's finding (no per-attempt timeout on `SECRETS.get`) by adding a **150 ms** per-attempt cap — without measuring the platform call's real latency, which is **> 150 ms** on this account. A review suggestion with an unmeasured number is still a guess.
- Fix: rollback to `37c6a2d4a672` was attempted twice and **the rollback API timed out** both times (the compute API was degraded by #15) — so a revert-forward shipped: commit `a94722c` restores `env.ts` + `env.test.ts` to the `a552e02` state (the `find_site` change kept), 411 edge tests green, revision `72fbf5ea1993` active by ≤ 22:06Z.
- Lesson: measure a platform call's latency distribution before putting a timeout on it — and the logging added alongside the regression is what caught it within minutes.
- Links: commit `a94722c`; DEBUGLOG #15 (the surrounding platform incident); [runbook — During a platform incident](docs/runbook.md) (rollback can time out).

## #18 — 2026-09-28 — Multi-assistant handoff: facts learned live on call #6

- Symptom: none — this entry records the platform semantics of the English → Arabic `assistant-target` handoff, learned live on call #6 (22:08Z, PSTN, conversation `2661d125`, plus the read-only analysis of both handoff calls' logs and transcripts).
- Evidence — what the live call proved:
  - **The handoff keeps the conversation, history and variables** — same conversation id, metadata lists both assistant ids, same `call_control_id`; in call #6 the Arabic LLM wrote a ticket note using details it only had from the English turns.
  - **Carried values win over the target's dynamic-variables webhook** — `e_nari_1` fired although the handoff DV had just returned `site_id "unknown"` (inferred from this call; the flow now routes on state both sides agree on).
  - **The webhook re-fires with the same `call_control_id`** — the same session key `k`, so `call/<k>/auth` stays reachable across the handoff.
  - **The target speaks first at its start node** — the English bridge line is never spoken.
  - **MCP tools ignore a node's `tools_mode`** — `add_ticket_note` was called on `n_ar_intake`, which exposes only `capture_details`; node-level `tools_mode` does not filter MCP tools.
  - **Omitting `mcp_servers` on an assistant update keeps the platform's previous value** — the Arabic assistant still had MCP after an apply that left the key out; subset diff only compares sent keys, so the drift was invisible. Send an explicit `[]` (now sent, with a read-back check).
- Root cause: undocumented platform semantics; on the second handoff call the carried `pin` re-fired `e_nari_1` and the Arabic re-verify hit an actor 502 (see #15), bouncing a verified caller to a human — the skip-on-entry design below fixes that symptom.
- Fix: the Arabic workflow starts at a speak node (`s_ar_open`) and routes by carried state — verified → triage, known incident → advisory, ticket open → confirm, otherwise intake — so a caller verified in English is never asked for the PIN again (configured and unit-tested; not exercised end-to-end while actors were down); MCP removed from the Arabic assistant. (Update 2026-10-01: the Arabic assistant got its own MCP registration `noc-mcp-ar` → `${EDGE_URL}/mcp?lang=ar`, with the server rendering spoken results in Saudi Arabic — ruling P3-R13; the explicit-`[]` lesson stands. Later that day the registration was detached for the demo — see #22.)
- Lesson: design for whichever wins, carried state or DV response; when clearing a platform list, send an explicit empty array.
- Links: `assistant/assistant-ar.json`; [voice-calls.md](docs/evidence/voice-calls.md) (#6); README "Architecture" (two assistants).

## #19 — 2026-09-29 — Call #8: the actor verified the PIN in 430 ms but the tool still timed out → the KV-free voice path

- Symptom: web call #8 (02:28Z, "Can't verify the pin code and transfer me to an engineer"): `verify_site` told the caller "The request timed out" → `s_verify_unavailable` → transfer ("Origination hangup while transferring"). The PIN was correct and the actor had already accepted it.
- Signal: the actor `recordPinAttempt` answered **ok in 430 ms** (actors were partly back), but the tool kept waiting on the failing KV data plane (hard down since 09-28 20:45:33Z, #15): `conv/<id>` put → 500 `10007`; the invocation log shows `/tools/verify-site` at **7,797 ms** while the handler logged `total_ms 9,597` with `kv_ms` Σ **55,236** — over the 8000 ms tool timeout (#8's safety net), so the platform treated a *verified* caller as a failure.
- Evidence: the call's `tool.verify_site` log line and the invocation log (both numbers above); the KV "is it our side?" checklist — namespace `provision_ok`, TTLs ≥ 3600 s, no invariants in KV, bindings declared — with the decisive test: direct REST GET of `flag/actor_mode` on `noc-kv` → HTTP 500 after 5.4 s ×3, and a fresh probe namespace stuck `pending` → `provision_FAILED`.
- Hypothesis: the voice path still had unbounded KV waits; with KV failing, a correct actor answer could never reach the caller. KV was the single point of failure for verification — the one thing the actor had already proven.
- Fix (rulings P3-R11/R12 + the red-team corrections): **the site actor is the PIN authority**. `SiteState.openIfVerified` derives authorisation from the actor's own per-call PIN record, so the auth decision and the one-ticket-per-site invariant are **atomic in one actor turn** (denial writes nothing, uniform 403 — ruling P3-R15); `verify_site` awaits only the actor and every other KV op runs behind a `deadline()` (2500 ms enrichment/tool budgets, 1500 ms callback, 250 ms router flags budget); `open_ticket`/`join_incident` fall back to the actor proof when KV grants nothing, with a bounded retry for phone-identified callers; the KV auth cache stays best-effort. Commits `bbc2b7b` (actors), `5642712` (edge), `1c9ce61` (uniform 403, proof window = PIN window); shipped 2026-10-01 05:24–05:25Z (noc-actors + host, then noc-edge, all at `e6c9772`).
- Verification: 952 tests green as of 2026-10-01 (edge 476, scripts 206, shared 167, actors 73, host 30), including latency tests — verify answers under ~3.5 s and open-via-actor-proof under ~4.5 s when every KV op takes 5000 ms. At ship time no live call had run since inference was restored; live calls resumed on 2026-10-01 (call #9 verified ok — see #21/#22 and [voice-calls.md](docs/evidence/voice-calls.md)).
- Lesson: a proof that lives on one primitive must not need a second primitive to be *used*; bound or remove every wait that is not doing the proving.
- Links: [docs/decisions.md](docs/decisions.md) #10; [voice-calls.md](docs/evidence/voice-calls.md) (#8); #15, #17 (the same incident window).

## #20 — 2026-09-29 — Calls #7a/#7b: false-positive Arabic handoff, English replies in Arabic, hallucinated verification, cold-instance secret failures

- Symptom: two web calls "still not consistent". **#7a (01:47Z)** — right after the caller said *"yeah so the site is gonna be r u h one one four"*, the call **handed off to Arabic mid-spelling**; the Arabic side replied **in English** ("Go ahead." — mimicking the English history); `verify_site` 500 (actor 502) sent the call to `n_ar_handover`, a prompt node that **hallucinated "Your identity is verified"** and then called a non-existent tool `check_incidents`. **#7b (01:50Z)** — a cold instance in ap-southeast-2 failed every secret read: `config.seed_local_invalid read_failed`, `mcp.auth denied` (401), `tool.sig_fail no_key` (403).
- Signal: #7a — the handoff edge's LLM condition matched *"…or just spoke in Arabic"*: "ruh" is an Arabic word, so a spelled site ID triggered it. #7b — the secret store failing on cold instances (platform, #15's window) with our retry reverted (#17) meant `SECRETS.get` returned nothing on a fresh isolate.
- Evidence: the two calls' transcripts + the paged log lines above; the #7a condition text in the pre-fix assistant config.
- Root cause: #7a was ours — an under-specified LLM edge condition plus prompt nodes carrying lines that must be verbatim; #7b was platform, but our post-#17 code had no retry to absorb it.
- Fix (ruling P3-R10): the handoff condition is **explicit-request-only** (the instructions note site IDs are spelled letters — RUH/JED/DMM); Arabic fixed lines became **speak nodes** (`s_ar_handover`, `s_ar_verify_unavailable`, `s_ar_goodbye`) with default edges to tool nodes; every Arabic prompt node gained "reply only in Arabic" (+ `assistant/instructions-ar.md`); the English handoff line became "Sure, switching you to Arabic now."; "Go ahead." is allowed only while spelling in pieces. Applied live 02:04Z. For #7b (ruling P3-7b): `getSecret` retries on error/empty only (3 attempts, 50/100 ms sleeps, **no per-attempt cap**), with in-flight sharing and `secret_name` logging — shipped `noc-edge` revision `3d6371b6`, live 02:24Z.
- Verification: zero `secret.read_failed` after the ship; the Arabic beats in DEMO.md now run on the fixed config. The verified EN→AR PIN skip remained unit-tested only until call #9 recorded it live (2026-10-01, #22).
- Lesson: an LLM edge needs a condition tight enough that only the intended utterance can match it — and anything that must be said verbatim belongs in a speak node, because a prompt node will improvise under pressure.
- Links: #16, #18 (the earlier handoff work); [docs/decisions.md](docs/decisions.md) #6–#8; [voice-calls.md](docs/evidence/voice-calls.md) (#7a/#7b).

## #21 — 2026-10-01 — Per-entity flip: ping answered, business methods didn't — reverted to mux in 20 minutes

- Symptom: `flag/actor_mode` was flipped to per-entity at 05:34:28Z (KV REST, no redeploy). `/ops/actor-ping` answered per-entity — `SiteState/RUH-114` and `RegionState/riyadh-north` ponged at ~195–227 ms (4/4) — and the race test in per-entity mode reproduced actor 1/10 vs KV 10/10. But the two live calls at 05:52:21Z failed: `verify_site` returned 500 `"pre.deps.actors.site(...).recordPinAttempt is not a function"`.
- Signal: the per-entity stubs reached through `noc-edge`'s actor binding answered ping but not the business methods.
- Evidence: the live calls' `verify_site` errors (05:52:21Z); the per-entity `actor-ping` outputs; the per-entity race-test run ([docs/evidence/race-test.txt](docs/evidence/race-test.txt)); the offline reproduction below.
- Root cause (confirmed offline 2026-10-01): our own timing wrapper. `timedApi` (`edge/noc-edge/src/tools/common.ts:151-175`) collects method names with `Object.getOwnPropertyNames` up the prototype chain; the SDK's per-entity actor stub is `new Proxy({}, {get, has})` with no `ownKeys` trap (`@telnyx/edge-runtime` `dist/actor-namespace.js:512-538`), so the wrapped port has **no business methods** — `recordPinAttempt is not a function`. `/ops/actor-ping` and `/dv` use the raw port, so ping passed. Reproduced offline 2026-10-01: a Proxy-shaped stub through `timedApi` — the direct method is a function, the wrapped one is `undefined`.
- Second risk found during the window: a failed or slow `flag/actor_mode` read falls back to the **last known mode**, else `ACTOR_MODE_DEFAULT=mux` (router.ts `selectActorPort`) — so a cold instance with KV failing would answer mux mid-flight while warm instances answer per-entity, splitting calls between modes.
- Fix: reverted `flag/actor_mode` to mux at 05:54:53Z; live traffic runs mux. The key now holds `mux` with **no expiry** (re-written 2026-10-01 07:4xZ).
- Verification: mux serves live traffic (`/ops/actor-ping` shows the mode). Next step: wrap the port via a Proxy `get` trap or the explicit method lists (fix prepared on a branch, tested with a Proxy-shaped stub; not deployed on submission day), then re-flip per-entity after demo day. A `noc-edge` redeploy would **not** fix it.
- Lesson: the pre-flip check exercised the raw port — ping and `/dv` don't go through `timedApi`; the tool webhooks do. Check the exact path the calls use.

## #22 — 2026-10-01 — The Arabic voice path: MCP A/B (40–80 s), the s_to_ar bridge, the digits resolver, handoff variance, direct Arabic entry

- Symptom: three Arabic-path problems in one morning, all found on live calls #9–#13 (05:58–06:43Z) plus a text test at 06:54Z: (a) with `noc-mcp-ar` attached, the EN→AR handoff took **40–80 s before the first Arabic word**; (b) the English model often took the Arabic transition **without speaking** — the caller heard ~10 s of dead air; (c) Arabic STT never returns spelled site letters, so spoken site codes could not be resolved.
- Signal / evidence:
  - **MCP A/B** — attached: calls #9 (05:58) and #10 (06:07) each waited 40–80 s for the first Arabic word; Telnyx made a **second MCP handshake ~41 s after the first**; our `/mcp` answered every request in ≤1.3 s. Detached (A/B call 06:15): ~10 s. The delay is the platform's handshake on the target assistant, not our server.
  - **Handoff variance (platform)** — identical config: call #11 (06:25) Arabic opening ~1 s after the bridge line; #12 (06:39) silent >20 s; #13 (06:43) silent >30 s with a different Arabic voice (`Humain.sara-ar`, an experiment, reverted to `Telnyx.Bayan.Reem`) — so the voice is not the cause. In every call the Arabic DV webhook answered in 1.3–1.5 s, and text chat with the same Arabic assistant always answers. Conclusion: the Telnyx voice runtime intermittently loses the Arabic assistant's first turn after an assistant-target handoff; to be reported to Telnyx with the conversation ids (not in the repo).
  - **Digits over Arabic STT** — `soniox/stt-rt-v5` writes the spoken "آر يو إتش واحد واحد أربعة" as "Are you H114؟" or "Are you Edge 114".
- Fix:
  - **Arabic MCP OFF for the demo** (product-owner decision): `sanad-noc-ar` ships `mcp_servers []`; the `noc-mcp-ar` registration and the `/mcp?lang=ar` Saudi-Arabic catalog stay built and tested — re-attaching is one config line. English keeps `noc-mcp`.
  - **Bridge node** — speak node `s_to_ar` ("Sure, switching you to Arabic now. One moment, please.") with one default edge to the Arabic assistant; the 8 llm "Arabic" edges now target `s_to_ar`; `e_sopen_ar` (`route_hint=="arabic"`) still targets the assistant directly. The English workflow is now 25 nodes / 61 edges.
  - **Digits fallback** — `resolveSiteGlobal` final fallback: a 3-digit group (ASCII or Arabic-Indic) that matches exactly one non-hidden site's number resolves to it (the PIN is still required, so no authentication weakening); the Arabic intake and PIN-retry prompts pass what they hear to `capture_details` and accept branch names (الياسمين = RUH-114, الملقا = RUH-121, حطين = RUH-133).
  - **Direct Arabic entry (mitigation)** — the front page has a third hero button «اتصل بالعربي» that starts a browser call straight to `sanad-noc-ar` (its own widget element; only the widget in use is shown). The Arabic first line is now neutral so it fits both entries: «حيّاك الله، معك سند، المساعد الذكي من نجد نتووركس. للعلم، المكالمة مسجّلة.» Phone callers still reach Arabic through the handoff.
  - **Widget settings are page-wide, not per-widget** — the page's two widgets share ONE page-wide settings store: the widget library is fed by each assistant's connection, and the last to connect sets the labels for both — so the English launcher showed «كلّم سند». Fix shipped: `sanad-noc-ar`'s `widget_settings` now equal the English ones exactly ("Talk to Sanad"); the Arabic language is carried by the hero button «اتصل بالعربي».
- Verification: call #9 is the **first verified EN→AR handoff** — verify ok → advisory → join P1 NJD-1403 → MCP `get_ticket_status` → "can we continue in Arabic" → `s_ar_open` routed to `n_ar_confirm` (re-verification skipped, as designed) → the Arabic assistant then went silent on the caller's next turn (the platform variance above). Direct-entry **text** test (06:54): greeting → intake → "Are you H114" → RUH-114 → asks for the PIN. Direct-entry **voice** test (2026-10-01 06:59Z, headless Chromium with a fake microphone on the live page): «اتصل بالعربي» → call active 3.0 s after the click → the Arabic opening «حيّاك الله، معك سند، المساعد الذكي من نجد نتووركس. للعلم، المكالمة مسجّلة.» spoken at 5.6 s → Sanad asks for the site ID and PIN; the English button on the same page reached the English assistant (English greeting).
- Lesson: a handoff the platform may drop needs a way around the handoff — the direct Arabic entry is that way around — and when a platform feature (MCP on the target assistant) costs 40–80 s, measure it A/B before shipping it.
- Links: [voice-calls.md](docs/evidence/voice-calls.md) (#9–#13, direct entry); [docs/decisions.md](docs/decisions.md) #9, #16–#19.

