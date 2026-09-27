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
| 0:00–1:00 | Intro, open **/demo** | The customer (Al-Waha Pharmacies), the problem (branch outages, one 24/7 AI fault line), the stack (Voice AI + Edge Functions/KV/Stateful Actors + MCP). Point at the live NOC wall. |
| 1:00–1:45 | Pre-flight | `node scripts/ops.mjs POST /ops/reset` → `node scripts/ops.mjs POST '/ops/stage-incident?region=riyadh-north'`. The board shows a staged **P2 in Riyadh North, 2 branches** (RUH-121, RUH-133), escalation due in **5 min**. Leave it unacked — the alarm segment depends on that. |
| 1:45–4:15 | **Live call 1 — scenario 1 (join)** | Press `C` in /demo, click the PIN chip on scenario card 1 (RUH-114, PIN `5944`), say: *"Hi, this is Ahmed from Al-Waha Pharmacies. Our Al Yasmin branch is offline — site R U H one one four."*, give the PIN digits when asked, then *"yes, add us."* when Sanad mentions the incident. Sanad verifies (`verify_site` ok), the advisory plays, the branch **joins the incident**. Watch the NOC wall: the third branch flips the incident **P2 → P1**, escalation column re-arms (P1 ack window 2 min). This is Stateful-Actor read-modify-write live. |
| 4:15–5:15 | `trace.sh` on that call | `telnyx-edge logs noc-edge --tail` → copy the call's `trace_id` (`t-…`), then `SINCE=10m scripts/trace.sh t-<id>`: one trace across `/dv` → tool webhooks → MCP, with `total_ms` per hop. Expect `verify_site` ≈ 2–3.6 s (KV is ~1–2 s/op here — DEBUGLOG #6). |
| 5:15–6:30 | Flip `flag/deflection_enabled` live | `telnyx-edge storage kv key put "$KV_ID" flag/demo_caller c-ahmed --ttl 600s` (identifies web callers as the RUH-114 contact; `require_pin` is already `false` after the reset). Call again: `route_hint=known_incident` → the opening **skips PIN and plays the incident advisory**. Then `telnyx-edge storage kv key put "$KV_ID" flag/deflection_enabled false --ttl 600s`, call again: the same identified caller now goes **straight to triage** (no advisory) — same deploy, KV flag only. Clear both after the demo (`telnyx-edge storage kv key delete "$KV_ID" flag/demo_caller`; the TTLs self-heal in 10 min). |
| 6:30–7:15 | Race-test slide | Show `docs/evidence/race-test.txt`: 10 concurrent opens on one site → **actor mode created 1 ticket** (mux actor turns are serialised), naive KV get-then-put created 10 duplicates. Optional live: `node scripts/race-test.mjs` (lab site only, safe). |
| 7:15–8:15 | Alarm ladder | Do **not** ack. ~2 min after the P1 upgrade the ladder escalates to **L1** and mints page `INC-<n>:p1`; within ~30 s the prober's paging cycle shows the **PAGE banner** + desktop notification and marks it sent (pending → 0). Then **Acknowledge** from the operator drawer — the escalation column flips to `ACKED`. (`POST /ops/tick` reporting `fired:0` in the window is expected — the platform alarm drove it; DEBUGLOG #12, [alarms-live.md](docs/evidence/alarms-live.md).) |
| 8:15–9:00 | Arabic mode | `telnyx-edge storage kv key put "$KV_ID" flag/demo_caller c-khalid --ttl 600s` (`c-khalid` is the Arabic-preferred contact). New web call: `route_hint=arabic` → the opening expression edge exits to the **13-node Arabic sub-flow** (voice `Telnyx.Bayan.Reem`, STT `soniox/stt-rt-v5`, Arabic prompts). Clear the flag afterwards. |
| 9:00–9:45 | Close with the debugging story | DEBUGLOG #6 + #8: a correct PIN on call #1 took **7869 ms** over the 5000 ms tool timeout, so verification was treated as failed and the call escalated — found within a minute by our own logs (`trace.sh` on `t-5d419f3a98a3240f`), fixed by concurrent KV inside the tool webhooks, proven by calls #2/#3 (3579/3646 ms, P1 at 3 sites). End on the observability answer (README "know within a minute"). |

If something breaks live: follow [docs/runbook.md](docs/runbook.md) §1–5; if a
demo site reports locked, `node scripts/ops.mjs POST '/ops/unlock?site=RUH-114'`
(also resets that site's ticket/call history); re-stage with the operator
drawer or `/ops/reset` + `/ops/stage-incident`.
