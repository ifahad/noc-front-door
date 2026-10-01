# DEMO.md

Presenter notes, in slide order. Slide numbers match the deck.

**Live:** https://noc-edge-41d2a334-7.telnyxcompute.com/ (browser call), or dial **+1 512 980 6105**. Operator console: backtick key or `#console`.

**Five minutes before:** check that the prober is running ([runbook](docs/runbook.md) §6). Open three panes: the prober, `telnyx-edge logs noc-edge --tail` (runtime lines carry `trace_id` and `route_hint`), and `/ops/status`. Run `export KV_ID=…` with the `noc-kv` id from `telnyx-edge storage kv list`; it is not in `.env`.

| Site | Region | PIN | Use |
|---|---|---|---|
| RUH-114 (Al Yasmin) | Riyadh North | 5944 | joins the incident |
| JED-007 | Jeddah | 7985 | opens a new ticket |
| DMM-011 | Dammam | — | lockout: three different wrong PINs, then hand-over |

## 1. Opening  ·  slides 01–03
01 Sanad · 02 Try it live · 03 The problem

- **01** Sanad picks up Najd Networks' fault line at any hour: it confirms who is calling, keeps one ticket per site, and escalates.
- **02** Three ways in from one page: a browser call in English, «اتصل بالعربي» for Arabic, or the phone line. The map beside them is live.
- **03** When a region goes down, each branch reports it separately and the desk spends SLA time merging duplicates. Sanad links the reports into one incident at the second branch, goes P1 at the third, and pages if nobody acknowledges (a desktop alert here; Telnyx SMS or voice in production).

## 2. How it's built  ·  slides 04–06
04 How it works · 05 The platform · 06 The codebase

- **04** Caller → `sanad-noc` (Kimi-K2.6) → a 25-node workflow → `noc-edge` (`/dv`, `/tools/*`, `/mcp`) → KV and Stateful Actors. Arabic runs as its own assistant, `sanad-noc-ar`, reached directly or by a one-way hand-off.
- **05** Actors: PIN attempts, tickets, escalation. KV: flags, sessions, the incident projection. Function: nothing durable. Cloud Storage: closed-incident reports. → [decisions](docs/decisions.md)
- **06** Six files tell the story: `assistant/assistant.json` and `scripts/apply.mjs` (the assistant as code), `edge/noc-edge/src/dv/handler.ts`, `edge/noc-edge/src/tools/verifySite.ts`, `edge/noc-actors/src/SiteState.ts`, `edge/noc-actors/src/RegionState.ts`. → [walkthrough](docs/walkthrough.md)

## 3. Running it for real  ·  slides 07–10
07 Observability · 08 The hardest bug · 09 Lessons from production · 10 AI-assisted build

- **07** A prober outside Telnyx hits deep health every 10 s; two misses in a row raise an alert, so an outage surfaces in about 30 s. Each hop writes one log line stamped with the call's `trace_id`, and `scripts/trace.sh t-<id>` lines them up.
- **08** Call #1 gave the right PIN and still failed. `trace.sh` put `verify_site` at 7.9 s, past its 5 s timeout: the KV calls ran in series at 1–2 s each. Running them concurrently fixed it ([DEBUGLOG](DEBUGLOG.md) #6, #8). Call #8 then made the actor the PIN authority (#19).
- **09** Three things only live calls revealed. A routing node with `shared_tool_ids: null` inherited every tool, so the model announced a ticket it never opened (call T4, #24). Our timing wrapper listed methods by name and found none on a Proxy-based actor stub (#21). The voice runtime sometimes swallows the Arabic assistant's first turn (#22).
- **10** `opencode.jsonc` loads `@telnyx/opencode@0.1.5`. Up to `edf6f40`, 109 of 146 commits say `Assisted-by: OpenCode`: GLM-5.3-Flash wrote code (78), GLM-5.3 handled design and docs (29), Kimi-K3 two more (2). Spend and lessons: [DOGFOODING](DOGFOODING.md).

## 4. Live demo (~9 min)  ·  slide 11
| Time | Beat                                   | Back-up slide |
|------|----------------------------------------|---------------|
| 0:00 | Front page                             | 02            |
| 0:30 | Architecture, top to bottom            | 04            |
| 1:35 | Call 1: verify → join → P2→P1 → status | 12, 15        |
| 3:35 | Trace the call                         | 07            |
| 4:05 | Calls 2–3: by name; KV flag reroutes   | 16            |
| 6:45 | Deployment, KV read, actor ping        | 17            |
| 7:25 | Saudi-Arabic assistant                 | 20            |
| 8:00 | Slack ack, or race test                | 18            |

Cues:
- **~1:10** In the console, click **Reset demo**, then **Stage Riyadh North incident**: P2, two branches.
- **1:35** Browser call, PIN chip on card 1: *"Hi, this is Ahmed from Al-Waha Pharmacies. Our Al Yasmin branch is offline, site R U H one one four."* Give the PIN, then *"yes, add us."* The third branch takes the incident to P1. Ask *"what's the status of my ticket?"*: MCP `get_ticket_status` answers.
  Once call 1 is connected (its `/dv` has already run), off-mic: `telnyx-edge storage kv key put "$KV_ID" flag/demo_caller c-ahmed --ttl 600s`. The flag names every browser caller, so it must not go in earlier, and it needs about 60 s to land before 4:05.
- **3:35** Take the `t-…` id from the log, run `SINCE=10m scripts/trace.sh t-<id>`, and read the hops in order: `/dv`, each tool, MCP.
- **4:05** Call 2 (browser): after the disclosure, Sanad greets Ahmed by name and skips the PIN (`route_hint=known_incident`); the first ring can lag up to 4.5 s. As soon as it connects, off-mic: `telnyx-edge storage kv key put "$KV_ID" flag/deflection_enabled false --ttl 600s`. If `dv.route` shows `outcome=fallback`, the call takes the PIN path: explain the KV budget (#23) on slide 16.
- **~5:40** Spend a minute on slide 16, then call 3: the same caller goes straight to triage and collect (`route_hint=verified`) and lands on call 1's ticket, one per site. Once it connects: `telnyx-edge storage kv key delete "$KV_ID" flag/demo_caller --yes` and `telnyx-edge storage kv key put "$KV_ID" flag/deflection_enabled true`.
- **6:45** `telnyx-edge deployments noc-edge` (active revision) · `telnyx-edge storage kv key get "$KV_ID" incident/active/riyadh-north` (the projection call 1 joined) · `node scripts/ops.mjs GET '/ops/actor-ping?site=RUH-114'` (actor mode, round trip).
- **7:25** «اتصل بالعربي» → `sanad-noc-ar`: disclosure, intake and PIN, all in Arabic. If someone asks, *"Can we continue in Arabic?"* also switches mid-call with the context intact, but that path is flaky on the platform today (#22), so the button leads.
- **8:00** Spare minute: acknowledge the P1 page in the console if it fired; otherwise the race test.

## 5. Design decisions  ·  slides 12–17
12 Conversation design · 13 Edge conditions · 14 Prompt and tool scoping\
15 MCP server · 16 Dynamic variables · 17 State design

- **12** 25 nodes: 11 speak, 8 prompt, 6 tool. Fixed wording (disclosure, advisory, read-backs) sits in speak nodes, where the model cannot rephrase it, and every must-happen action is a tool node. Each prompt node has a way out to Arabic, and all but two a way out to a human; `scripts/lib/flow-validate.mjs` refuses to apply a flow missing either. The Arabic workflow has 16 nodes.
- **13** 61 edges: 19 expression, 26 LLM, 16 default. Anything the system already knows routes by expression (`route_hint`, a tool's status, the verify result); what the caller means routes by LLM (wants a human, wants Arabic). The Arabic condition was once loose enough that "r u h" counted as Arabic; all eight Arabic edges now require an explicit request (call #7a).
- **14** English prompt nodes add to the base persona; Arabic nodes replace it and repeat the safety rules. Tools are scoped node by node, and routing nodes get none (`[]`). MCP ignores `tools_mode`, so its tools are also fenced by the prompt and checked again by the server. → [tool matrix](docs/decisions.md)
- **15** Five tools, no server state: each POST builds a fresh server, and GET gets 405. Two tokens: `session` is tied to the live call, while `ops` can never reach a call. It runs inside `noc-edge`, so there is no second cold start. An Arabic tool set exists but stays off: with it attached, the platform's second MCP handshake stalled the switch to Arabic for 40–80 s, while our `/mcp` answered within 1.3 s.
- **16** `/dv` rejects a bad Ed25519 signature with 403. Past that it never fails the call: within 4.5 s it returns the caller's name, site, incident details and a `route_hint` that chooses the opening path, or safe defaults if time runs out. Measured live: 1.2–2.2 s.
- **17** An actor handles one request at a time per site and per region, so "one ticket per site" and "P1 at the third branch" need no locks. Every KV key has a single writer, and the prober repairs drift. Today both actor types share one host instance (mux); the per-entity switch waits on the wrapper fix (#21).

## 6. Proof and resilience  ·  slides 18–19
18 Live race test · 19 Resilience

- **18** Ten simultaneous opens on one site: actors keep 1 ticket, KV alone makes 10 ([race test](docs/evidence/race-test.txt)).
- **19** A bad signature gets 403 on every webhook. Short of that, `/dv` always answers, with defaults if late, and a failing tool ends in a human offer or a message rather than silence (calls #1 and #5; #1 also logged a callback). Three wrong PINs reach the on-call engineer (call T5). Optional drill: `telnyx-edge storage kv key put "$KV_ID" flag/fault/open_ticket 503 --ttl 600s`, wait about 60 s, call as JED-007 → `open_ticket` fails → engineer offer; put `0` to clear.

## 7. Voice experience  ·  slide 20
- Short turns, one question each. Site IDs are read back letter by letter ("J E D zero zero seven"). Sanad waits 1 s after digits and 2 s after an unpunctuated phrase before answering.
- Arabic uses the Saudi voice `Telnyx.Bayan.Reem` with `soniox/stt-rt-v5`. The transcriber hears RUH-114 as "Are you H114", so verification matches on the digits or the branch name.

## 8. Q&A  ·  slide 21
- Keep open: [decisions](docs/decisions.md) (every choice with its cost if wrong), [DEBUGLOG](DEBUGLOG.md) #1–#24, [runbook](docs/runbook.md).

**Recovery:** runbook §1–5, or §10 if Telnyx itself is degraded. A locked demo site: `node scripts/ops.mjs POST '/ops/unlock?site=RUH-114'`; this also clears that site's ticket, so avoid it mid-demo. A wrong board: reset and stage again from the console.
