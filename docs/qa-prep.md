# Q&A prep — one page for the panel

Crisp answers, each with the doc that backs it. **Q&A slot: 5 min.**

**Q: Isn't mux a global lock / SPOF? Does the mux race test prove per-site isolation?**
Mux was a deliberate contingency (DEBUGLOG #4 — no new actor instance could activate on the Trial account), flag-switchable behind one `ActorPort` seam with zero business-logic change. The race test proves the *atomicity* claim (serialized turns: 10 opens → 1 ticket; re-run in per-entity mode 2026-10-01 with the same 1 vs 10). The *failure-domain* concern is real and that is why the per-entity flip ran: flipped 05:34:28Z on 2026-10-01 — pings answered per-entity (pong 195–227 ms, 4/4) but `verify_site` 500'd on live calls (`recordPinAttempt is not a function`). Root cause, reproduced offline the same morning — **ours, not the platform's**: our timing wrapper `timedApi` (`edge/noc-edge/src/tools/common.ts:151-175`) builds the timed port by enumerating methods with `Object.getOwnPropertyNames`, but the SDK's per-entity actor stub is `new Proxy({}, { get, has })` (`@telnyx/edge-runtime` `dist/actor-namespace.js:512-538`) — no own property names — so the wrapped port exposed no business methods to tools/MCP, while `/ops/actor-ping` used the raw port and answered. Reverted to mux at 05:54:53Z (DEBUGLOG #21); live runs mux. The wrapper fix (Proxy `get` trap or explicit method lists) is prepared on a branch — a `noc-edge` redeploy alone would not fix it — and the re-flip waits for after demo day; mux stays the instant fallback. → [docs/decisions.md](decisions.md) #1, #19, [race-test.txt](evidence/race-test.txt)

**Q: What happens to a live call when KV is slow or down?**
Call #8 was the bug: the actor accepted the PIN in 430 ms but `verify_site` waited on failing KV and timed out. The shipped fix makes the **site actor the PIN authority** — `verify_site` awaits only the actor, every KV op on the tool path is bounded at 2500 ms, `open_ticket`/`join_incident` authorise from the actor's own PIN record (`openIfVerified`), unproven calls get a uniform 403, and `/dv` still fails open to safe defaults. MCP session tools fall back (honest "no data") while KV is down. → [DEBUGLOG.md](../DEBUGLOG.md) #19, [docs/decisions.md](decisions.md) #10

**Q: How reliable is the EN→AR handoff? Is a verified caller re-asked for the PIN?**
Proven live: call #6 kept the conversation, history and variables, and call #9 was the **first verified EN→AR handoff** — `s_ar_open` routed the verified caller to `n_ar_confirm` with **no PIN re-ask**, as designed (DEBUGLOG #22). The handoff fires only on an explicit Arabic request (after the #7a false positive — "r u h one one four" was read as Arabic), and it now plays a bridge speak node first (`s_to_ar` — "Sure, switching you to Arabic now. One moment, please.") — that removed the silent switch **on our side**, but it did not remove the dead air: the platform hand-off itself was still **silent on 2 of the 3 live handoff calls** (caveat (b)). Two honest caveats: (a) with Arabic MCP attached, the first Arabic word took 40–80 s (Telnyx's second MCP handshake ~41 s after the first; our `/mcp` answered ≤1.3 s) — Arabic MCP is OFF for the demo (`mcp_servers []`, built and tested, one line to re-attach); (b) the platform **intermittently loses the Arabic assistant's first turn after the handoff** (#11 opened ~1 s after the bridge line; #12/#13 went silent >20–30 s under identical config, with the Arabic DV webhook answering 1.3–1.5 s every time) — the caller hears the bridge line, then silence until the platform recovers; being reported to Telnyx — which is exactly why the direct Arabic entry (the front page's «اتصل بالعربي» button) is the **primary Arabic path**; phone callers still reach Arabic through the handoff. → [DEBUGLOG.md](../DEBUGLOG.md) #18, #20, #22; [docs/decisions.md](decisions.md) #6–#9, #16–#18

**Q: What did it cost to build, and what does a call cost?**
$31.44 total spend since 2026-09-26 ($27.22 of it Telnyx inference); edge-compute $0.95 (09-27) / $0.25 (09-28); the voice assistant $0.70 / $0.10 — the phone line and browser calls are pennies. The warning case: one ~11-minute Kimi-K3 implementer run burned ≈ **$11** (10M cache-read tokens), took the balance to −$0.75 and **suspended inference + Cloud Storage** for ~2 days. Lesson: a credit floor before long lanes (R18). → [DOGFOODING.md](../DOGFOODING.md) cost table

**Q: LLM vs expression edges; append vs replace; tool scoping when MCP ignores `tools_mode`.**
Facts route by expression, meaning routes by LLM (19 expr / 26 llm / 16 default edges). EN prompt nodes **append** (base persona kept), AR prompt nodes **replace** (own assistant, safety rules restated). MCP tools ignore node `tools_mode` — proven live — so scoping is three layers: per-node `shared_tool_ids`, prompt instructions ("you do not need find_site here"), and **server-side authz** in the MCP server itself (session scope, NEED_VERIFY, own-site checks). The Arabic assistant has no MCP for the demo (detached — decisions #9, DEBUGLOG #22). → [docs/decisions.md](decisions.md) #3–#4 + tool matrix

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

## Reviewer probes — one honest answer each

**P: The site lock is a DoS surface — the site IDs are public, so anyone can lock a branch out of ticketing.**
Yes. 6 wrong PINs from ≥2 distinct calls lock a site for 15 min (`SiteState.recordPinAttempt`), and the site codes are published for this demo. The lock is short, self-clearing and visible on the event feed (`pin_attempt` events), but a determined caller can keep re-locking a site. Production fixes: rate-limit by calling number *before* the PIN tier, scope the abuse lock to the caller rather than the site, and alert on lock storms. The demo accepts the surface because the sites are fictional. → [spec §6.1](superpowers/specs/2026-09-26-noc-front-door-design.md), [edge/noc-actors/src/SiteState.ts](../edge/noc-actors/src/SiteState.ts)

**P: You identify callers by their phone number — caller ID is spoofable.**
Correct, and we do not treat it as auth. Caller ID here is convenience (personalisation and the incident advisory); identity still comes from Telnyx's signed body (C13), and the from-number is **not STIR/SHAKEN-verified** on this trial line. The PIN is the authority: with `require_pin=true` the route hint is `unverified` for everyone (`dv/route.ts`) and ticket writes authorise from the actor's own PIN record (`openIfVerified`). The demo runs `flag/require_pin=false` so identified callers can skip the PIN (the 4:05 beat); the fail-open default is `require_pin=true`. Known gap, next fix: `canWrite` (`edge/shared/src/authz.ts`) accepts `identified` for ticket writes — it should honour `require_pin`. → [docs/decisions.md](decisions.md) #10, [DEBUGLOG.md](../DEBUGLOG.md) #19

**P: How does a page actually reach a human?**
In the demo it is a **desktop notification** on the operator's box: `RegionState` mints the page (`INC-<id>:p<N>`, monotonic `pageSeq`) and the external prober claims and sends it (30 s cycle). Next: **Telnyx SMS/voice paging to the on-call rota** — the page *minting* and ladder are already platform-side, so this is a delivery upgrade, not a redesign. → [README.md](../README.md) "Production path", [docs/runbook.md](runbook.md) §6

**P: Where does our data live — what is the PDPL position?**
Straight answer: the demo's data path is **US-region Telnyx** (transcripts/insights hold the PIN as spoken; PII redaction is not enabled), the demo collects no real customer PII, and a strict PDPL residency reading would require caller voice content to stay in-Kingdom or ride an agreed cross-border basis. The per-class table and the production changes (KSA region when available, one-time per-call PINs, redaction, retention windows): [docs/sovereignty.md](sovereignty.md).

**P: What happens when the site ID is misheard?**
The digits fallback resolves only a unique 3-digit match (or a known branch name); an ambiguous or misheard ID simply does not resolve — by design the caller then reaches a **human** (`s_ar_handover`/`s_handover` from intake) rather than being stranded in a retry loop. The next improvement is a re-ask with different phrasing before the handover. → [docs/decisions.md](decisions.md) #17, [DEBUGLOG.md](../DEBUGLOG.md) #22

**P: The race harness drops failed opens — doesn't that flatter the 1-vs-10 result?**
Yes: `/diag/race` counts only opens that answered within the 8 s deadline (`race.ts` skips `!outcome.ok` outcomes), so a fully timed-out run would report 0 created, not "10 attempted, 0 answered". The recorded per-entity/mux runs had all 10 opens answer; the earlier 5/5-timed-out run is disclosed as inconclusive (DEBUGLOG #6). Next: report failures in the result, not just `created_count`. → [docs/evidence/race-test.txt](evidence/race-test.txt)

**P: 952 tests, and none caught the Proxy-shaped stub — how?**
Because every one of them wrapped in-memory fakes whose methods `Object.getOwnPropertyNames` can see — nothing exercised the SDK's actual per-entity stub shape, so `timedApi`'s enumeration assumption was never contracted anywhere. Next: a **contract test in CI** that wraps a Proxy-shaped stub (ideally the real SDK stub) and calls a business method through the wrapped port — that test would have caught #21 before the flip. → [DEBUGLOG.md](../DEBUGLOG.md) #21

**P: What happens to the escalation loop if nobody acknowledges?**
It is bounded: each unacknowledged due date escalates exactly one level and re-arms (L1→L3, a fresh `:p<N>` page per level via the monotonic `pageSeq` — an upgrade can never reset it). At L3 the alarm is deleted and **no further pages are minted**; the incident stays open on the board until it is acked or resolved. → [edge/noc-actors/src/RegionState.ts](../edge/noc-actors/src/RegionState.ts) (`escalateIfDue`), [DEBUGLOG.md](../DEBUGLOG.md) #14

**P: Severity from caller count, not from network telemetry?**
Yes — P2 at the second distinct branch, P1 at the third is a **caller-count proxy**, chosen because the demo has no NMS/device feed. It is deliberately conservative (only verified, de-duplicated site reports count, one per site in the actor) and production would join NMS alarms as the primary severity signal at the same `reportSite` seam. → [docs/decisions.md](decisions.md) #2, [docs/architecture.md](architecture.md)

**P: Who buys this?**
The managed-services provider's service-delivery/NOC leadership — not the branch callers. Their costs are duplicate reports and SLA clocks that start late; Sanad removes the duplicates and starts the clock at the first call, so the buyer is the NOC that pays for the queue. The enterprise customer experiences it as the 24/7 front door their SLA is measured against.

**P: DEBUGLOG #4 — was the root cause ever confirmed?**
No — honestly unconfirmed. The bisection falsified every hypothesis except the `[[secrets]]` binding on the actor-owner function (experiment E never ran to completion), and the binding-free owner + reference-binder topology fixed it in practice while also being better architecture (actor processes get no secrets). The block lifted by itself on 2026-09-30 with no Telnyx explanation; mux stays the instant fallback. → [DEBUGLOG.md](../DEBUGLOG.md) #4

**P: In mux, is `/ops/tick` really an independent fallback for the alarm?**
No — in mux, `alarm()` and `tick()` both run the same fan-out inside the same single instance, so if that instance is hung the fallback hangs with it (exactly the 09-28 shape). Known cost of the contingency: the prober's 10 s deep health is what detects "neither path works", and the per-entity re-flip (after the wrapper fix) is what separates the instances. → [DEBUGLOG.md](../DEBUGLOG.md) #15, [edge/noc-actor-host/src/MuxHost.ts](../edge/noc-actor-host/src/MuxHost.ts)

**P: Helper code is duplicated between packages.**
Known debt: `sha256Hex` and `constantTimeEqual` exist in both `edge/shared/src/ids.ts` and `edge/noc-probe/src/util.ts` (the probe function keeps standalone copies so it never imports product code), and the mux host carries its own prefixed-storage helpers. Accepted for bundle independence; the cleanup is to import the shared module everywhere. → [edge/noc-probe/src/util.ts](../edge/noc-probe/src/util.ts), [edge/shared/src/ids.ts](../edge/shared/src/ids.ts)

## What we'd do next

1. **Redo the per-entity flip**: land the prepared `timedApi` wrapper fix (it must see Proxy-shaped stubs — a `noc-edge` redeploy alone fixes nothing), call `recordPinAttempt` on a test site before flipping, make the flag fallback keep the last known mode (DEBUGLOG #21); mux stays the instant fallback.
2. **Voice A/B by live calls**: TTS "Ultra" shortlist vs `af_heart`; STT `deepgram/flux` vs nova-3; Cohere/humain for streaming Arabic STT.
3. **Move heal + paging into the platform** (RegionState alarms / scheduled edge job) so the dev-box prober becomes optional.
4. **Record the live edge-case matrix**: P7 wrong-then-correct PIN, P8 DMM-011 lockout → transfer, one spelled-ID call; the EN→AR verified skip is already recorded (call #9).
5. **A real ITSM behind the `itsm.ts` seam** (the datastore is a seeded fixture) plus a tenant admin view.
