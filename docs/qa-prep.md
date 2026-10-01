# Q&A prep — one page for the panel

Crisp answers, each with the doc that backs it. **Q&A slot: 5 min.**

**Q: Isn't mux a global lock / SPOF? Does the mux race test prove per-site isolation?**
Mux was a deliberate contingency (DEBUGLOG #4 — no new actor instance could activate on the Trial account), flag-switchable behind one `ActorPort` seam with zero business-logic change. The race test proves the *atomicity* claim (serialized turns: 10 opens → 1 ticket); the *failure-domain* concern is real and that is why the per-entity flip (same code, per-entity storage) is being switched on today, with mux kept as the instant fallback. → [docs/decisions.md](decisions.md) #1, [race-test.txt](evidence/race-test.txt)

**Q: What happens to a live call when KV is slow or down?**
Call #8 was the bug: the actor accepted the PIN in 430 ms but `verify_site` waited on failing KV and timed out. The shipped fix makes the **site actor the PIN authority** — `verify_site` awaits only the actor, every KV op on the tool path is bounded at 2500 ms, `open_ticket`/`join_incident` authorise from the actor's own PIN record (`openIfVerified`), unproven calls get a uniform 403, and `/dv` still fails open to safe defaults. MCP session tools fall back (honest "no data") while KV is down. → [DEBUGLOG.md](../DEBUGLOG.md) #19, [docs/decisions.md](decisions.md) #10

**Q: How reliable is the EN→AR handoff? Is a verified caller re-asked for the PIN?**
The handoff is proven on live PSTN call #6: same conversation, history and variables; the Arabic voice takes over at `s_ar_open`, which routes by carried state — verified → triage, known incident → advisory, ticket open → confirm — so a caller verified in English is *designed* never to be re-asked. That skip is configured and unit-tested; end-to-end live proof is still pending (TODO-LIVE). The handoff fires only on an explicit Arabic request after the #7a false positive ("r u h one one four" was read as Arabic). → [DEBUGLOG.md](../DEBUGLOG.md) #18, #20; [docs/decisions.md](decisions.md) #6–#8

**Q: What did it cost to build, and what does a call cost?**
$31.44 total spend since 2026-09-26 ($27.22 of it Telnyx inference); edge-compute $0.95 (09-27) / $0.25 (09-28); the voice assistant $0.70 / $0.10 — the phone line and browser calls are pennies. The warning case: one ~11-minute Kimi-K3 implementer run burned ≈ **$11** (10M cache-read tokens), took the balance to −$0.75 and **suspended inference + Cloud Storage** for ~2 days. Lesson: a credit floor before long lanes (R18). → [DOGFOODING.md](../DOGFOODING.md) cost table

**Q: LLM vs expression edges; append vs replace; tool scoping when MCP ignores `tools_mode`.**
Facts route by expression, meaning routes by LLM (19 expr / 26 llm / 15 default edges). EN prompt nodes **append** (base persona kept), AR prompt nodes **replace** (own assistant, safety rules restated). MCP tools ignore node `tools_mode` — proven live — so scoping is three layers: per-node `shared_tool_ids`, prompt instructions ("you do not need find_site here"), and **server-side authz** in the MCP server itself (session scope, NEED_VERIFY, own-site checks). → [docs/decisions.md](decisions.md) #3–#4 + tool matrix

**Q: The prober runs on your dev box and is load-bearing — what if it dies?**
It sits outside the failure domain on purpose. If it dies: the KV projection ages out (~2 h TTL) and the board goes stale (DEBUGLOG #11), and page *delivery* stalls — the ladder itself keeps running in `RegionState` (platform alarms; `/ops/tick` is only the fallback). `/ops/status` and `/ops/board` stay public either way. Roadmap: move the heal + paging into the platform (RegionState alarms / a scheduled edge job). → [docs/runbook.md](runbook.md) §6, "What we'd do next" below

**Q: Why is MCP in-process in `noc-edge`?**
The spec's line: a module boundary, not a deployment boundary. A second edge function would add a second cold start (13–14 s measured) for zero isolation benefit; the MCP contract (C4) is preserved per request — a fresh server + transport, POST-only, GET → 405, stateless. → [docs/decisions.md](decisions.md) #11, [docs/walkthrough.md](walkthrough.md) stop 7

**Q: Why Kimi-K2.6 for voice? What voice/STT for Saudi Arabic?**
The voice model is a platform constraint of this challenge (C10), not a free pick. The Arabic line pairs `Telnyx.Bayan.Reem` (Saudi female) with STT `soniox/stt-rt-v5` (auto language detection, Arabic–English code-switching for spoken site IDs). The English A/B is a queued next step: TTS "Ultra" shortlist vs `af_heart`; STT `deepgram/flux` vs nova-3; for Arabic STT, `cohere/ar-stt` (batch — latency risk) or streaming alternatives. → [README.md](../README.md) Known limitations, [DOGFOODING.md](../DOGFOODING.md) model choice

**Q: Are incident reports actually landing in Cloud Storage?**
Yes — live: resolving INC-1004 (2026-09-28) wrote `incidents/INC-1004-2026-09-27T21-46-42Z.json` (926 B) to bucket `noc-reports-fb8131`; `/ops/reports` lists and fetches it and the board carries the `last_report` pointer. (Storage was suspended 09-30 while the balance was negative and restored with the 10-01 top-up.) → [DEBUGLOG.md](../DEBUGLOG.md) #13, [docs/architecture.md](architecture.md) stretch table

**Q: How did you prove the 09-28/29 outage was Telnyx's?**
It reproduced on three paths our code cannot touch: a brand-new actor id, the host's own increment, and direct KV REST from the dev box (18/18 GETs → 500/10007 while the namespace metadata said `provision_ok`). Onset ran at prober-only load, ~27% of the instance's observed capacity. Our amplifiers were real and fixed (board cache, flag cooldown, hang=down) but started nothing. → [DEBUGLOG.md](../DEBUGLOG.md) #15

## What we'd do next

1. **Flip per-entity actors** (in progress today): ship → `flag/actor_mode=per-entity` → re-run race-test + the paging drill; mux stays the instant fallback.
2. **Voice A/B by live calls**: TTS "Ultra" shortlist vs `af_heart`; STT `deepgram/flux` vs nova-3; Cohere/humain for streaming Arabic STT.
3. **Move heal + paging into the platform** (RegionState alarms / scheduled edge job) so the dev-box prober becomes optional.
4. **Record the live edge-case matrix**: P7 wrong-then-correct PIN, P8 DMM-011 lockout → transfer, P16 EN→AR verified skip, one spelled-ID call.
5. **A real ITSM behind the `itsm.ts` seam** (the datastore is a seeded fixture) plus a tenant admin view.
