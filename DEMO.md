# DEMO.md — the interview demo (8–10 min, web calls)

The interview is a **web call** demo: the Trial account cannot order a phone
number (KSA origin, no local coverage — DEBUGLOG #1), so every demo call is a
browser web call from **/demo**. All commands read `.env` (`EDGE_URL`,
`OPS_TOKEN`); `scripts/ops.mjs` never echoes the token. `$KV_ID` is the
`noc-kv` namespace id (`telnyx-edge storage kv list` — get it once, runbook
fault-drill preamble). The external prober must be running (runbook §6): it
heals the KV projections every 10 s and claims/sends alarm pages every 30 s.

Pre-flight (run 5 minutes before, not during): start a screen recording of the
dev box, keep `node scripts/prober.mjs` output, the invocation log
(`telnyx-edge logs noc-edge --tail --type invocations`) and `/ops/status` open
side by side.

| Time | Do | Say / show |
|---|---|---|
| 0:00–0:30 | Intro, open **/demo** | The customer (Al-Waha Pharmacies), the problem (branch outages 24/7, duplicate reports during regional outages), the stack (Voice AI + Edge Functions/KV/Stateful Actors + MCP). Point at the live NOC wall. |
| 0:30–1:30 | **Architecture** | Walk the README diagram chain top to bottom: caller → assistant **sanad-noc** (model `moonshotai/Kimi-K2.6`, voice + STT, DV webhook, MCP integration) → 37-node Conversation Workflow (speak/prompt/tool; llm/expression/default edges) → Edge Function **noc-edge** (`/dv`, `/tools/*`, `/mcp`, `/ops/*`, `/demo`) → **KV** (flags, sessions, projections) + **Stateful Actors** (`SiteState`/`RegionState` — in mux mode both run inside `Counter/demo` on noc-actor-canary) → the 5-tool **MCP server** (in-process in noc-edge), the incident-reports bucket, and the external prober. Say: actors own the invariants; KV is only a projection. |
| 1:30–2:00 | Pre-flight | `node scripts/ops.mjs POST /ops/reset` → `node scripts/ops.mjs POST '/ops/stage-incident?region=riyadh-north'`. The board shows a staged **P2 in Riyadh North, 2 branches** (RUH-121, RUH-133), escalation due in **5 min**. Leave it unacked — the alarm segment depends on that. |
| 2:00–4:00 | **Live call 1 — scenario 1 (join)** | Press `C` in /demo, click the PIN chip on scenario card 1 (RUH-114, PIN `5944`), say: *"Hi, this is Ahmed from Al-Waha Pharmacies. Our Al Yasmin branch is offline — site R U H one one four."*, give the PIN digits when asked, then *"yes, add us."* when Sanad mentions the incident. Sanad verifies (`verify_site` ok), the advisory plays, the branch **joins the incident**. The third branch flips the incident **P2 → P1** on the wall; the escalation column re-arms (P1 ack window 2 min). |
| 4:00–4:30 | `trace.sh` on that call | Copy the call's `trace_id` (`t-…`) from the invocation log, then `SINCE=10m scripts/trace.sh t-<id>`: one trace across `/dv` → tool webhooks → MCP with `total_ms` per hop. Expect `verify_site` ≈ 2–3.6 s (KV is ~1–2 s/op here — DEBUGLOG #6). |
| 4:30–6:30 | **Code walkthrough** | Three stops from README "Code walkthrough": `edge/noc-actors/src/SiteState.ts:229-416` — `recordPinAttempt` (per-call + site-wide PIN lock) and `openOrAttach` (one ticket per site, dedupe cache) — actor turns are serialised, so 10 concurrent opens give 1 ticket; `edge/noc-actors/src/RegionState.ts:169-281,507-545` — `reportSite` declares at 2 sites, upgrades **P2→P1 at the 3rd**, and `escalateIfDue` runs the SLA ladder + mints pages; `edge/noc-edge/src/dv/handler.ts:145-412` — Ed25519-verified, fail-open within the 2500 ms budget, concurrent KV. |
| 6:30–7:15 | Flag toggles live | `telnyx-edge storage kv key put "$KV_ID" flag/demo_caller c-ahmed --ttl 600s`, call again: `route_hint=known_incident` → the opening **skips PIN and plays the advisory** (allow the ~60 s flag memo). Then `telnyx-edge storage kv key put "$KV_ID" flag/deflection_enabled false --ttl 600s`, call again: the same identified caller goes **straight to triage** — same deploy, KV flag only. Clear the flag after (`telnyx-edge storage kv key delete "$KV_ID" flag/demo_caller`). If time permits: `flag/demo_caller c-khalid` routes a call to the 13-node Arabic sub-flow. |
| 7:15–7:45 | Race-test slide | Show `docs/evidence/race-test.txt`: 10 concurrent opens on one site → **actor mode created 1 ticket** (mux actor turns are serialised), naive KV get-then-put created 10 duplicates. Optional live: `node scripts/race-test.mjs` (lab site only, safe). |
| 7:45–8:15 | Alarm ladder | The L1 escalation minted ~2 min after the P1 upgrade fired **while we walked the code**: the prober claimed the page and showed the **PAGE banner** + desktop notification, pending → 0. Now **Acknowledge** from the operator drawer — the escalation column flips to `ACKED`. (`POST /ops/tick` reporting `fired:0` in that window is expected — the platform alarm drove it; DEBUGLOG #12, [alarms-live.md](docs/evidence/alarms-live.md).) |
| 8:15–9:00 | OpenCode config | Open `opencode.jsonc`: plugin `@telnyx/opencode@0.1.5`, model `telnyx/zai-org/GLM-5.3-Flash`, and the permission list that denies secrets (`git push`, `telnyx-edge secrets`, `cat .env*`, `opencode debug config`). Run `opencode models telnyx` to list the Telnyx-served models. **Never run `opencode debug config` on screen — it prints secrets.** |
| 9:00–10:00 | **Challenges** + debugging story | KV latency → concurrency: KV is ~1–2 s/op here (DEBUGLOG #6), so every route is latency-shaped (concurrent KV, deadlines) — the debugging story: a correct PIN on call #1 took **7869 ms** over the 5000 ms tool timeout, found within a minute by our own logs (`trace.sh` on `t-5d419f3a98a3240f`), fixed by concurrent KV inside the tool webhooks, proven by calls #2/#3 (3579/3646 ms, P1 at 3 sites). No new actor instances (DEBUGLOG #4) → the **mux host** runs the same SiteState/RegionState classes inside the one working instance and fans the single real alarm out to entities (DEBUGLOG #12). Mandatory actions (transfer, end-call) are **tool nodes** enforced by `scripts/lib/flow-validate.mjs` before every apply. End on the observability answer (README "know within a minute"). |

If something breaks live: follow [docs/runbook.md](docs/runbook.md) §1–5; if a
demo site reports locked, `node scripts/ops.mjs POST '/ops/unlock?site=RUH-114'`
(also resets that site's ticket/call history); re-stage with the operator
drawer or `/ops/reset` + `/ops/stage-incident`.
