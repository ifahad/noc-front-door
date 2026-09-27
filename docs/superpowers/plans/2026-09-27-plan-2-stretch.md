# NOC Front Door — Plan 2: Stretch Goals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this project every task is implemented by **OpenCode on a Telnyx-hosted model** (AGENTS.md), driven by the architect; Claude reviews.

**Goal:** Add the stretch goals Fahad chose on 2026-09-27: actor alarms (SLA escalation ladder), a live NOC console, object-storage incident reports, Arabic mode, and a voice-model upgrade. Everything ships by Mon 2026-09-28.

**Architecture:**
- Plan 1's topology is unchanged: noc-edge serves `/dv`, `/tools/*`, `/mcp`, `/ops/*` and `/demo`.
- The real `SiteState`/`RegionState` logic runs inside the one working actor instance (`Counter/demo` on noc-actor-canary, the "mux host") because of DEBUGLOG #4.
- Plan 2 adds:
  1. host-level alarm scheduling to the mux;
  2. the §12.1 escalation ladder in `RegionState`;
  3. a live NOC wall on the public `/demo` page, backed by a cached public `/ops/board`;
  4. a Cloud Storage binding for incident reports;
  5. an Arabic node in the workflow;
  6. a measured voice-model change.

**Tech Stack:** TypeScript on Telnyx Edge Compute (`@telnyx/edge-runtime@0.15.3`), vitest, Telnyx AI Assistants API (config-as-code via `scripts/apply.mjs`), Telnyx Cloud Storage (S3-compatible, `[storage.cloudstorage.*]` binding).

**Spec:** `docs/superpowers/specs/2026-09-26-noc-front-door-design.md` (§12 stretch designs; §18 overrides; DEBUGLOG #4–#7 live findings).

## Global Constraints

- AGENTS.md C1–C13 and rules 1–11 apply to every task. Exact pins: `@telnyx/edge-runtime@0.15.3`, `@modelcontextprotocol/sdk@1.30.1`, `zod@3.25.76`.
- **Trial account:** exactly one assistant, `sanad-noc`, updated in place and never deleted. No phone number, so demos are web calls (the Portal Test button or the public `/demo` widget).
- **Actors:** no new actor type or instance can be created (DEBUGLOG #4). All actor state lives in the mux host (`flag/actor_mode=mux`). Code must keep working in per-entity mode too, so it goes through the `ActorPort` seam.
- **KV is slow** (1.1–2.0 s per op, DEBUGLOG #6):
  - Never put a sequential chain of KV ops on a caller-facing path.
  - KV deadlines are ≥ 4000 ms off the `/dv` path.
  - Writes that the response doesn't depend on go through `deadline()`.
- **Pages and reports never contain PINs, PIN fingerprints, tokens or unmasked phone numbers.**
- **Console DOM updates use `textContent` only, never `innerHTML`, for data** (spec §12.2).

## Review Focus

1. **Duplicate or late alarm delivery:** a redelivered alarm, or an alarm after resolve, must not add a page or re-open anything.
2. **Two probers claiming the same page at once:** exactly one wins, so a page is sent once.
3. **Mux alarm fan-out:** one entity's alarm handler throwing must not lose other entities' alarms or the host's re-arm.
4. **Console with slow KV / actors:** the page renders a stale-but-labelled board, never a blank or error page, and never leaks masked data.
5. **Arabic mode on a web call:** the caller can switch back to English, and safety rules (no PIN echo, human exit) still hold in Arabic.

---

### Task P2-1: Alarm support in the mux host

**Files:**
- Modify: `edge/noc-actor-host/src/MuxHost.ts`, `src/prefixedStorage.ts`.
- Test: `edge/noc-actor-host/test/MuxAlarms.test.ts`.
- (Moved to P2-2: `POST /ops/tick` in noc-edge — P2-1 stays inside edge/noc-actor-host.)

**Interfaces:**
- **Produces:**
  - `prefixedStorage(storage, prefix, alarms)`, whose `setAlarm/getAlarm/deleteAlarm` read/write the host schedule entry `sched/<kind>/<name>` (value = dueAt ms).
  - `Counter.alarm()`: fans out to every due entity.
  - `Counter.tick(now)`: the same fan-out, callable over RPC as the fallback driver.
- **Consumes:** the real `SiteState`/`RegionState` `alarm()` methods (P2-2).

**Behaviour:**
- **Scheduling.** A derived entity's `setAlarm(when)` writes `sched/<kind>/<name>`, then sets the host's real alarm to the earliest scheduled time (`this.ctx.storage.setAlarm(min)`). `deleteAlarm` removes the entry and re-arms to the new minimum, or deletes the host alarm when none are left.
- **Fan-out.** `alarm()` lists `sched/`. For each entry with `dueAt <= now + 1000` it:
  1. deletes the entry;
  2. constructs the entity;
  3. calls its `alarm()` inside try/catch, logging on failure;
  4. collects whatever the entity re-armed.

  After the loop it sets the host alarm to the new minimum. **A throwing entity never prevents the others.** Never rethrow, because a failing handler loses its alarm (Telnyx alarms docs).
- **`tick(now)`:** identical fan-out, for when platform alarms don't fire on this account. The prober calls `POST /ops/tick` every 30 s.
- **Tests:**
  - two entities with different due times;
  - one entity throws;
  - duplicate `alarm()` delivery;
  - `deleteAlarm` re-arms to the next minimum;
  - `tick` equals `alarm`.

### Task P2-2: SLA escalation ladder (`RegionState`) + paging

**Files:**
- Modify: `edge/noc-actors/src/RegionState.ts` (+ tests).
- Modify: `edge/noc-edge/src/ops/{actions,status}.ts`, router: `POST /ops/tick` (Bearer OPS_TOKEN → mux host `tick(now)`; per-entity mode → each region's `tick`), `GET /ops/pages/pending`, `POST /ops/pages/claim`, `POST /ops/pages/sent`; the prober calls `/ops/tick` every 30 s.
- Modify: `scripts/prober.mjs` (claim → "send" = banner + `notify-send` + log `page.sent` → mark sent).

**Behaviour (spec §12.1, verbatim semantics):**
- **Arming.** Declare and upgrade set `esc={level:0,dueAt:now+ackWindow}` (P1 120 s, P2 300 s) and `setAlarm(dueAt)`.
- **Escalation.** `alarm()` and `tick()` call `_escalateIfDue(now)` inside a catch-all that never throws:
  - Return early if there is no incident, it's acked, or `now < esc.dueAt − 1000`.
  - Otherwise `level++`, append page `{id: incId+":"+level, level, claimedBy:null, claimedAt:null, sentAt:null}`, set the next `dueAt`, and re-arm while `level < 3`.
- **Stopping.** `ack`, `resolve` and `reset` call `deleteAlarm()`.
- **Claiming.** `claimPage(pageId, claimer, now)` is a read-modify-write:
  - It succeeds if the page is unclaimed, or its claim is older than 60 s.
  - Otherwise it returns `{claimed:false}`.
  - `markPageSent(pageId, now)` then records the send.
- **Tests:** duplicate delivery; upgrade mid-ladder; alarm after resolve; concurrent claim (exactly one wins); ack stops the ladder.

### Task P2-3: Live NOC wall on `/demo` (redefined 2026-09-27, ruling P2-R3)

Fahad chose the "Live NOC wall" direction: the public `/demo` page becomes the dark-theme demo centrepiece and the live console in one. The full visual and behaviour spec is the dispatch prompt `.superpowers/sdd/2026-09-27-plan-2-stretch/p2-3-prompt.md`.

**Files:**
- Create: `edge/noc-edge/src/ops/board.ts`: public `GET /ops/board`, the masked status plus a region per site and `actor_mode`, with a single-flight in-isolate cache reused for 8 s.
- Create: `edge/noc-edge/src/demo/guide.ts`: the demo PINs from Edge secret `DEMO_GUIDE`, never source literals.
- Rewrite: `edge/noc-edge/src/demo/page.ts`.
- Modify: router, `telnyx.toml`.

**Behaviour:**
- **Left column:** a call orb that clicks the widget launcher; scenario cards with PIN chips; a "how it works" ribbon.
- **Right column:** KPI tiles; region cards (quiet / P2 / P1); a client-side event feed built by diffing successive board snapshots.
- **Operator drawer:** the OPS token is held in `sessionStorage` only.
- **Rendering and polling:** `textContent` only, and no `innerHTML` at all. Polls every 5 s with no overlap. Shows a "stale" badge and never goes blank.
- **Follow-up once P2-2 lands:** `/ops/board` also carries the escalation (`esc`, `pages`) and the report link from P2-4.

### Task P2-4: Incident reports in Telnyx Cloud Storage

**Files:**
- Modify: `edge/noc-edge/telnyx.toml` (`[storage.cloudstorage.REPORTS]`, bucket `noc-reports-<suffix>` created by the architect).
- Create: `edge/noc-edge/src/services/reports.ts` (+ tests).
- Modify: `ops/actions.ts` resolve.
- Modify: `/ops/status` (a presigned-link field, minted via `POST /v2/storage/buckets/{bucket}/{object}/presigned_url` with the account API key held as an Edge secret).

**Behaviour:**
- **Writing the report.** On resolve, build `incidents/<INC-id>-<declaredAt>.json` from actor truth:
  - region, sites, tickets, priorities, trace ids;
  - the escalation timeline;
  - time-to-ack.

  It contains **no PINs, fingerprints, tokens or unmasked phone numbers.** Write it through the binding with `deadline(…, 8000)`. A failure is logged `report.write_failed`; it never fails the resolve.
- **Linking.** Presigned links (5-min TTL on Trial) are minted lazily when the console asks for them.
- **Tests:** report shape; masking; a write failure doesn't fail resolve.

### Task P2-5: Arabic mode (Trial path of §12.4)

**Files:**
- Modify: `assistant/assistant.json` (node `n_arabic` + edges), `assistant/instructions.md`.
- Modify: `edge/noc-edge/src/dv/handler.ts` (`route_hint:"arabic"` when the identified contact's `preferred_language` is `ar`).
- Modify: `scripts/lib/flow-validate.mjs` (+ tests).

**Behaviour:**
- **The node.** `n_arabic` is a prompt node with node-level `transcription` and `voice_settings` overrides: a Saudi Arabic STT and a `Telnyx.Bayan.*` Saudi voice. The exact ids are read from the Telnyx model/voice list and pinned in the brief. Its Arabic instructions (`replace`) restate the safety rules: no PIN echo, the human exit, the recording notice.
- **Edges:**
  - `s_open` gets an expression edge `route_hint == "arabic"`.
  - `n_triage`, `n_verify` and `n_advisory_followup` get an LLM edge "The caller asked to continue in Arabic".
  - `n_arabic` has an LLM edge back to English, and the human exit.
- **Labelling.** It is labelled "Arabic mode", **not** multi-assistant.
- **If Telnyx Team raises the assistant limit,** a follow-up converts it to a second assistant "Sanad - Arabic" with `target:{type:"assistant", voice_mode:"distinct"}`.

### Task P2-6: Voice model upgrade (measured, last)

**Files:**
- Modify: `assistant/assistant.json` (`voice_settings`, `transcription`).
- Create: `docs/evidence/voice-model-ab.md`.

**Behaviour:**
- **Shortlist.** Read Telnyx's current STT (`/v2/ai/...` model list and docs) and TTS voice catalogues. Shortlist 2 STT × 2 TTS options for Gulf-accented English and Saudi Arabic (e.g. Deepgram Nova-3 vs Flux; KokoroTTS vs a Telnyx NaturalHD/Ultra voice).
- **Measure.** Run the same scripted demo call per candidate. Record latency to first word, mis-recognitions of the site id and PIN, and naturalness notes. Pick the winner by evidence.
- **Ship.** Apply it via `apply.mjs`. Keep the old values in the evidence file for rollback.

### Task P2-7: Docs + final review for Plan 2

- **Docs:** README stretch section; runbook (tick fallback, paging drill, console); DEBUGLOG for any new live finding.
- **Review:** a final whole-branch review on the most capable model, one fix wave, then Fahad's sign-off.
