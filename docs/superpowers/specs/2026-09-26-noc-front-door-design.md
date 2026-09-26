# NOC Front Door: Design Spec (v2)

> **Architect artifact.** Written by Claude (architect and reviewer) with Fahad. All shipped code, config and docs are authored through OpenCode on Telnyx-hosted models (§14).
> **Status:** v2, for user review · **Date:** 2026-09-26 · **Submission due:** Wed 2026-09-30
> **Evidence base:** `research/PLATFORM_BRIEF.md` (`PB §n`) and its notes. v2 incorporates a 5-lens adversarial review: 60 findings raised, 59 confirmed, 1 refuted (`research/spec-review-2026-09-26.json`). Review IDs are cited as `[R:id]`.

## v2 changelog (why things changed)

- **Tool scoping.** `shared_tool_ids: null` inherits *every* assistant tool, so only `capture_details` is attached at the assistant level. Tool nodes reference their shared tools directly. [R:platform-tool-scope-leak, workflow-02]
- **Call identity.** Every webhook tool now carries `call_control_id`, `call_key` and `trace_id` in its **signed body** via `preset_body_fields`. We never hash an empty value, and web calls with no call control id get a minted `call_key`. [R:platform-ccid-header-unverified, security-04, state-04, rubric-webcall-no-ccid-shared-keys]
- **PIN flow.** `verify_site` returns HTTP 200 for every business outcome, and deterministic `verify_result` edges route it. The PIN is wiped after each attempt, so there is no stale-transcript loop. [R:workflow-01, platform-verify-reentry-loop, security-03]
- **Incident join.** Joining an incident is a **tool node** (`t_join_incident`) with a verbatim read-back, not an LLM-chosen MCP call. The MCP tool `report_affected_site` is replaced by `find_site`. [R:workflow-03]
- **Recovery.** Region-report recovery is real (`regionReported` flag), and the KV projection is always re-synced *from the actor*. [R:security-07, state-01, state-02]
- **Race test.** It runs through an ops-only `/diag/race?mode=actor|kv` against a lab site. [R:race-test ×5]
- **Trial reality** (C1): transfers only to the verified number, 10-minute calls, $5 credit, no orderable number. Budget and demo are adjusted. [R:platform-trial-*, rubric-trial-*, rubric-inference-and-voice-budget]
- **Smaller fixes:**
  - a second customer, for testable tenant isolation
  - two MCP credentials
  - IDs unique across sites
  - per-call and site-wide PIN lockout tiers
  - the duration edge declared *after* intent edges and guarded by `escalated`
  - transfer voicemail detection
  - a split session (one writer per key)
  - an alarm idempotency ladder
  - secret hygiene for committed OpenCode artifacts
  - detection in under 30 s
  - a timed demo
  - serialised ships

---

## 1. Summary

**NOC Front Door** is a 24/7 AI voice line for a fictional KSA managed-services provider, **Najd Networks**. When a branch network fails, the enterprise customer calls. The assistant, **Sanad**, does the following:

- **Identifies** the caller (caller ID, or site ID + PIN).
- **Announces a known regional incident** verbatim and deterministically, before any LLM step.
- **Triages** new faults and **corroborates** them against live network status (MCP).
- **Opens exactly one ticket per site**, even under concurrent calls.
- **Declares a regional incident** when 2 or more sites are down in a region, and **upgrades it to P1** at 3 or more.
- **Reads the ticket back** verbatim.
- **Escalates** to a human (on request, after 300 s, on lockout, or when a system is unavailable). If the escalation fails, it takes a callback message.

**Panel story.** KSA wholesale SLAs start the repair clock "from receipt of fault report". A fault that is not reported per procedure voids SLA penalties (stc Reference Offer Annex I §1.4.2, §1.5.3). At 02:00 that moment is a person answering a phone. Downtime costs more than $300k/h for 90% of enterprises (ITIC 2024). The Telnyx KSA AE brief says: *"lead with an AI agent that operates your SOC or NOC workflow"*.

**Customers (fictional):** **Al-Waha Pharmacies** (main; branches carry POS and e-prescription traffic) and **Rawda Cafés** (second tenant, used to prove isolation).

### 1.1 Success criteria

1. Every core requirement (brief §1-7) is demonstrable live with evidence (§1.2).
2. Every path in the §13.2 matrix passes. Evidence is Portal node labels plus `trace_id` logs.
3. `/diag/race`: 20 concurrent opens give **exactly 1 ticket** in actor mode and **more than 1** in naive KV mode. The output is committed.
4. A synthetic failure is detected in **≤ 30 s** and diagnosed from logs by `trace_id`.
5. Stretch goals by Mon 2026-09-28 EOD: **8/8 if the account is Paid+ by Sunday noon; otherwise 7/8**. On Trial, "Arabic mode" is shown but not claimed as multi-assistant.
6. `DEBUGLOG.md` has at least one real bug with its full evidence trail. `DOGFOODING.md` has OpenCode + Telnyx inference findings with cost and time numbers.

### 1.2 Requirement map

| Brief item | Where |
|---|---|
| 1. Assistant + workflow (prompt, speak, conditional edges; callable by phone) | §4. Callable by phone is **blocked on the account tier** (C1); web calls until then. |
| 2. MCP server with ≥3 tools | §8: 5 tools |
| 3. Dynamic webhook variables on an Edge Function, influencing routing | §5: `route_hint` drives the speak start node's edges |
| 4a/4b/4c. Function / KV / Actor read-modify-write | §3, §6.3, §6.1-6.2 |
| 5. Observability | §11 |
| 6. Telnyx Inference via OpenCode | §14 |
| 7. Public deployment + docs | §3, §16 |
| Stretch: multi-assistant | §12.4 (tier-conditional) |
| Stretch: variable-comparison edges | §4: `telnyx_conversation_duration_secs`, `telnyx_last_tool_status_code`, `verify_result` (core) |
| Stretch: alarms | §12.1 (not claimed if the `tick()` fallback is used) |
| Stretch: object storage | §12.3 |
| Stretch: KV feature flags | §6.3 `flag/*` (core) |
| Stretch: shared actors | §12.2 |
| Stretch: custom DV routing variables | §5 `route_hint` (core) |
| Stretch: distributed tracing | §11.2 (core) |

---

## 2. Platform constraints

| # | Constraint | Consequence |
|---|---|---|
| C1 | **Trial account, KSA origin.** Verified in the Portal 2026-09-26: "only able to search and purchase local numbers in Saudi Arabia", and Saudi Arabia has "no search coverage", so there is **no orderable number**. Other Trial limits: 1 assistant, 1 API key, inbound calls **and transfers only to/from the one verified number**, 10-minute call cap, **$5 credit** (PB §1.9). | Telnyx Team is emailed with this evidence. Until the tier changes: **web calls** (Portal test call, `supports_unauthenticated_web_calls`), escalation demoed from a web call to the verified phone, `time_limit_secs: 600`, and a credit budget (§14.4). |
| C2 | Actors require a `telnyx.toml` umbrella project in TypeScript. | `noc-edge` is `telnyx.toml` |
| C3 | The dynamic-variables (DV) webhook holds the greeting. Timeout is 1-10000 ms, default 1500. The measured actor-function cold start is 13-14 s. | Defaults are a production path (§5.4). Keep warm (§11.4). Timeout rule in §5.5. |
| C4 | MCP on Edge is stateless POST JSON only: SSE is buffered and GET returns 405. | §8.1 |
| C5 | KV: no CAS, last write wins; read-your-writes only per location; keys must match `^[-/_=.a-zA-Z0-9]+$`. | KV never holds invariants. One writer per key (§6.3). |
| C6 | Actor turn lock is held across `await`. 30 s budget. A turn commits atomically. Alarms are at-least-once. No re-entrancy. | No network I/O in actor methods. Methods are idempotent. No cross-actor transactions. |
| C7 | Workflow API defaults both modes to `replace`. `shared_tool_ids: null` inherits **all** assistant tools, and `tools_mode` is ignored when it is null. | Both modes are set explicitly on every node. Assistant `tool_ids` = `[capture_details]` only (§4.1). |
| C8 | A tool node needs a **shared** tool. MCP cannot back a tool node. A `handoff` tool blocks workflows. | Must-happen actions are webhook shared tools. Multi-assistant uses assistant-target edges. |
| C9 | Voice variables are strings. `telnyx_last_tool_status_code` is `"200"` on voice and `200` on chat. | DV returns only strings. Status edges use `or` over both types. Sentinels are `"none"`/`"unknown"`, never `""`. |
| C10 | Voice LLMs are limited to Kimi-K2.6/K2.5/GLM-5.2. | `moonshotai/Kimi-K2.6`. Logic lives in code. |
| C11 | No local actor runtime. | Unit tests use fakes. Integration runs against deployed functions. |
| C12 | One instance per tool type (except webhook, function, client_side_tool). | One each of `update_dynamic_variables`, `transfer`, `hangup`. |
| C13 | `x-telnyx-call-control-id` is documented for async webhooks only. The signature covers only `"{timestamp}\|{body}"`. | Identity comes from the **signed body** (`preset_body_fields`). The header is only a cross-check. |

---

## 3. Architecture

```
          ┌──────── Telnyx AI Assistant "Sanad" (Kimi-K2.6, Conversation Workflow §4) ────────┐
caller ─► │ s_open ─expr route_hint─► s_advisory / n_verify / n_triage ─► … tool nodes …        │
(web/phone)└──────┬────────────────────────┬──────────────────────────────┬──────────────────┘
       (1) POST /dv (signed)     (2) POST /tools/* (signed body carries    (3) POST /mcp (bearer
            at call start             call_control_id, call_key, trace_id)      MCP_TOKEN + _meta)
                ▼                        ▼                                         ▼
┌──────────────────────── noc-edge (telnyx.toml umbrella fn, TypeScript) ─────────────────────────┐
│ router ─► dv/ · tools/ · mcp/ · ops/ · diag/      services/ (tickets, incidents, sessions,       │
│ lib/ (log, trace, ed25519, kv, timing/deadline, mask, authz)      directory, severity, readback) │
│ adapters/itsm (seed CMDB/NMS: the integration seam)                                              │
│   KV noc-kv: dir/* · incident/active/* (projection) · call/<k>/dv · call/<k>/auth · conv/* · flag/* │
│   Actors: SiteActor(site_id) ─ ticket, PIN tiers, calls · RegionActor(region) ─ incident, P1, ladder │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
   ▲ external prober (10 s: keep-warm + alerting)        noc-console (stretch: shared-actor dashboard)
```

**Topology:** one umbrella function. The DV call warms the container that serves MCP and the tools (C3). MCP is a module boundary, not a deployment boundary.

### 3.1 Routes (`noc-edge`)

| Method + path | Auth | Purpose |
|---|---|---|
| `POST /dv` | Ed25519 | DV webhook (§5) |
| `POST /tools/verify-site` | Ed25519 | `t_verify` (§7.1) |
| `POST /tools/open-ticket` | Ed25519 | `t_open_ticket` (§7.2) |
| `POST /tools/join-incident` | Ed25519 | `t_join_incident` (§7.3) |
| `POST /tools/callback` | Ed25519 | `t_callback` (§7.4) |
| `POST /mcp` | Bearer: `MCP_TOKEN` (session scope) or `OPS_TOKEN` (ops read-only) | MCP (§8) |
| `GET /health/liveness` | none | Process up |
| `GET /health/deep` | `OPS_TOKEN` | KV put/get + actor RPC + in-process MCP `tools/list` + projection sync; per-check timings |
| `GET /ops/status` | none (masked, read-only) | Incidents, open tickets, recent calls (trace ids, time), heartbeat, **active fault flags (red)** |
| `POST /ops/{reset,resolve,ack,unlock,stage-incident}` | `OPS_TOKEN` | Demo/ops actions (§6.5) |
| `GET /ops/pages/pending`, `POST /ops/pages/claim` | `OPS_TOKEN` | Stretch paging (§12.1) |
| `GET /diag/bindings` | `OPS_TOKEN` | Which `env` carries which bindings |
| `POST /diag/race?mode=actor\|kv&n=20` | `OPS_TOKEN` | Race test (§13.3). Never on the call path. |

**Error handling on every route:**
- **Signed routes fail closed.** A missing, stale (>5 min), bad or erroring signature check returns **403**. A secret-read failure also returns 403. The key is memoised only after it loads successfully. [R:security-03]
- **401 is reserved for bad bearer tokens.** It is never used for business outcomes.
- **Unknown routes:** 404 JSON.
- **No floating promises.** All latency bounding goes through `lib/timing.deadline(p, ms, label)`, which attaches `.catch(log)` to `p` before racing, so late rejections never crash the process. `process.on('unhandledRejection', log)` is registered if the runtime supports it (probe). [R:security-11, platform-unhandled-rejection]

### 3.2 Module layout

```
edge/noc-edge/
  telnyx.toml package.json package-lock.json tsconfig.json vitest.config.ts eslint (no-floating-promises)
  src/index.ts  src/router.ts
  src/lib/{log,trace,ed25519,kv,timing,mask,errors,env,authz,ids}.ts
  src/adapters/itsm/{index,seed}.ts
  src/services/{directory,sessions,tickets,incidents,severity,readback,flags}.ts
  src/actors/{SiteActor,RegionActor}.ts   (+ CanaryActor for §12.1 stretch)
  src/dv/handler.ts  src/tools/{verifySite,openTicket,joinIncident,callback}.ts
  src/mcp/{server,shim,tools}.ts  src/ops/*.ts  src/diag/*.ts
  test/**/*.test.ts   (in-memory ActorStorage + KV fakes)
```

---

## 4. Conversation workflow

### 4.1 Assistant-level configuration

| Field | Value |
|---|---|
| `model` | `moonshotai/Kimi-K2.6` |
| `voice_settings.voice` | Telnyx English voice (chosen in the probe) |
| `transcription` | `deepgram/nova-3`, `en`. `settings.keyterm`: RUH, JED, DMM, Najd, Yasmin, Malqa, Hittin, Arabic |
| `greeting` | `"<assistant-speaks-first-with-model-generated-message>"`, with the speak start node delivering the opening. **Fallback** if the probe fails: a static `greeting` containing the verbatim disclosure, protected by `disable_greeting_interruption`, with the workflow starting at `n_triage` and the route-hint expression edges first (drop `s_open`). [R:platform-greeting-fallback] |
| `interruption_settings.disable_greeting_interruption` | `true` |
| `telephony_settings` | `time_limit_secs: 600` (Trial), `user_idle_timeout_secs: 60`, `recording_settings.enabled: true`, `supports_unauthenticated_web_calls: true` (Trial fallback), `fallback_destination` = on-call number (applied from a secret) |
| `dynamic_variables_webhook_url` | `https://noc-edge-<id10>.telnyxcompute.com/dv` |
| `dynamic_variables_webhook_timeout_ms` | §5.5 |
| `dynamic_variables` | All defaults from §5.3 |
| **`tool_ids`** | **`[capture_details]` only.** Tool nodes reference `verify_site`, `open_ticket`, `join_incident`, `log_callback`, `transfer_oncall` and `end_call` by `shared_tool_id`. **Probe P0-3c** confirms a tool node runs a shared tool that is not in `tool_ids`. If it doesn't: (a) if MCP survives `replace`, use explicit per-node lists + `replace` everywhere; (b) otherwise keep them attached and document the residual exposure in the README (server-side idempotency limits the damage). |
| `mcp_servers` | `[{ id: <noc-mcp>, allowed_tools: [find_site, get_site_status, check_known_incidents, get_ticket_status, add_ticket_note] }]` |

**Global `instructions`** (full text in `assistant/instructions.md`):
- Sanad, the Najd Networks NOC assistant. Calm and concise. One question at a time. Sentences under 20 words.
- Spell IDs character by character.
- **Never read a PIN back.** Never invent ETAs, causes or ticket numbers; only state what tools or variables provide.
- Out-of-scope requests: politely refuse.
- English (Arabic via §12.4).

### 4.2 Append vs replace: the decision [R:rubric-append-vs-replace]

- **Every English prompt node uses `append`.** The global persona and safety rules (no PIN read-back, no invented ETAs) must survive on every step. The API default is `replace`, which would silently drop them (C7).
- **`replace` is right when a node needs a self-contained, different persona or language.** The Trial-fallback `n_arabic` node (§12.4) uses `replace`, with an Arabic prompt that restates the safety rules. Appending Arabic guidance to "English by default" instructions would contradict itself.
- **Tools:** nodes that need MCP use `STI: null`, which is safe now that assistant `tool_ids` is only `capture_details`. Nodes that need nothing use `[]`/`replace`, and nodes that need `capture_details` use `[capture_details]`/`replace`.

### 4.3 Nodes (24)

Notation:
- `IM` = `instructions_mode`, `STI` = `shared_tool_ids`, `TM` = `tools_mode`.
- Every prompt node's instructions start with this context line, because variables reach the model only through interpolation [R:workflow-08]:
  - "The caller is {{caller_name}} from {{customer_name}}; their site is {{site_label}} ({{site_id}}). If site_id is "unknown", ask which site."

| id | type | content / purpose | IM | STI / TM |
|---|---|---|---|---|
| `s_open` | speak, **start** | "Thank you for calling {{msp_name}} network operations. This call is recorded and handled by an AI assistant to log and track your fault report." | n/a | n/a |
| `s_advisory` | speak | "Hi {{caller_name}}. We're already aware of an incident affecting {{incident_region}}, reported at {{incident_started}}: {{incident_summary}}. Engineers are working on it; the next update is due by {{incident_eta}}. Is the problem at {{site_label}} part of this incident?" | n/a | n/a |
| `n_advisory_followup` | prompt | Interpret the answer to the advisory question. If different, gather a one-line description. | append | `[]` / replace |
| `s_join` | speak | "One moment while I add your branch to the incident." | n/a | n/a |
| `t_join_incident` | tool | `join_incident` | n/a | n/a |
| `n_verify` | prompt | Ask for the site ID and the 4-digit site PIN. Call `capture_details` with `site_id` (normalised, e.g. RUH-114) and `pin` (digits). Never repeat the PIN. | append | `[capture_details]` / replace |
| `t_verify` | tool | `verify_site` | n/a | n/a |
| `s_pin_retry` | speak | "That PIN didn't match. You have {{attempts_left}} attempts left. Please tell me the site ID and PIN again." | n/a | n/a |
| `s_locked` | speak | "For security, phone verification is locked for this call. I'll connect you to an engineer now." | n/a | n/a |
| `s_verify_unavailable` | speak | "I can't verify you right now. I'll connect you to an engineer." | n/a | n/a |
| `n_triage` | prompt | Greet by name. If {{open_ticket_note}} is not "none", mention it. If {{repeat_note}} is not "none", acknowledge it. Determine: new fault, existing ticket, or wants a human. After PIN verification, you may call `check_known_incidents` once. | append | `null` |
| `n_collect` | prompt | Confirm the site (use `find_site` if the caller names a branch). Ask what is wrong, since when, impact (`site_down` / `degraded` / `single_user`), and whether service is affected. Call `get_site_status` and tell the caller what the network shows. Call `capture_details` **first**, then read back a one-sentence summary, **then** ask for confirmation. [R:workflow-06] | append | `null` |
| `s_one_moment` | speak | "Thank you. One moment while I log that for you." | n/a | n/a |
| `t_open_ticket` | tool | `open_ticket` | n/a | n/a |
| `s_confirm` | speak | "{{ticket_readback}}" (server-rendered; includes the incident note) | n/a | n/a |
| `n_ticket_failed` | prompt | Apologise that the ticket system didn't respond, and offer to connect an engineer. | append | `[]` / replace |
| `n_status` | prompt | Use `get_ticket_status` (default: the caller's site). Offer `add_ticket_note` for updates. | append | `null` |
| `n_wrapup` | prompt | Ask if there is anything else. If {{ticket_id}} is not "none", restate it. | append | `[]` / replace |
| `s_goodbye` | speak | "Thank you for calling {{msp_name}}. Goodbye." | n/a | n/a |
| `t_hangup` | tool | `end_call` (no edges) | n/a | n/a |
| `s_handover` | speak | "I'm connecting you to the on-call engineer now. Please stay on the line." | n/a | n/a |
| `t_transfer` | tool | `transfer_oncall` (≤1 default edge, used on failure) | n/a | n/a |
| `n_take_message` | prompt | The engineer couldn't be reached. Capture `callback_note` via `capture_details`, then confirm the message. | append | `[capture_details]` / replace |
| `t_callback` | tool | `log_callback` (records the message, raises a page, sets `escalated=true`) | n/a | n/a |

### 4.4 Edges

Evaluated in array order; the first true edge wins; `default` comes last. Shorthand:

- **`OK`** = `or(telnyx_last_tool_status_code == "200", telnyx_last_tool_status_code == 200)`
- **`ST(x)`** = the same `or` for status `x`
- **`DUR`** = `and(telnyx_conversation_duration_secs >= 300, escalated != "true")`. It is declared **after** the intent edges, so a confirmed fault is always ticketed first. [R:workflow-07]
- LLM conditions describe **caller utterances**, not the node's own actions. [R:workflow-06]

| from | # | condition | to |
|---|---|---|---|
| `s_open` | 1 | expr `route_hint == "known_incident"` | `s_advisory` |
|  | 2 | expr `route_hint == "unverified"` | `n_verify` |
|  | 3 | default | `n_triage` |
| `s_advisory` | 1 | default | `n_advisory_followup` |
| `n_advisory_followup` | 1 | llm "The caller said their problem is part of the announced incident." | `s_join` |
|  | 2 | llm "The caller said their problem is different from the announced incident." | `n_collect` |
|  | 3 | llm "The caller asked to speak to a human engineer." | `s_handover` |
|  | 4 | expr DUR | `s_handover` |
| `s_join` | 1 | default | `t_join_incident` |
| `t_join_incident` | 1 | expr OK | `s_confirm` |
|  | 2 | expr ST(403) | `n_verify` |
|  | 3 | default | `n_ticket_failed` |
| `n_verify` | 1 | expr `and(pin != "none", site_id != "unknown")` | `t_verify` |
|  | 2 | llm "The caller said they don't have the PIN or asked for a person." | `s_handover` |
|  | 3 | expr DUR | `s_handover` |
| `t_verify` | 1 | expr `and(OK, verify_result == "ok", route_hint == "known_incident")` | `s_advisory` |
|  | 2 | expr `and(OK, verify_result == "ok")` | `n_triage` |
|  | 3 | expr `and(OK, verify_result == "locked")` | `s_locked` |
|  | 4 | expr `and(OK, verify_result == "invalid")` | `s_pin_retry` |
|  | 5 | default (5xx / timeout / 403) | `s_verify_unavailable` |
| `s_pin_retry` | 1 | default | `n_verify` |
| `s_locked` | 1 | default | `t_transfer` |
| `s_verify_unavailable` | 1 | default | `t_transfer` |
| `n_triage` | 1 | llm "The caller is reporting a new outage, fault, or degradation." | `n_collect` |
|  | 2 | llm "The caller is asking about an existing ticket or its status." | `n_status` |
|  | 3 | llm "The caller asked to speak to a human engineer." | `s_handover` |
|  | 4 | expr DUR | `s_handover` |
| `n_collect` | 1 | llm "The caller confirmed the fault summary the assistant read back and agreed to open a ticket." | `s_one_moment` |
|  | 2 | llm "The caller declined to open a ticket." | `n_wrapup` |
|  | 3 | llm "The caller asked to speak to a human engineer." | `s_handover` |
|  | 4 | expr DUR | `s_handover` |
| `s_one_moment` | 1 | default | `t_open_ticket` |
| `t_open_ticket` | 1 | expr OK | `s_confirm` |
|  | 2 | expr ST(422) | `n_collect` |
|  | 3 | expr ST(403) | `n_verify` |
|  | 4 | default | `n_ticket_failed` |
| `s_confirm` | 1 | default | `n_wrapup` |
| `n_ticket_failed` | 1 | llm "The caller accepted being connected to an engineer." | `s_handover` |
|  | 2 | llm "The caller declined to be connected." | `n_wrapup` |
| `n_status` | 1 | llm "The caller wants to report a new fault." | `n_collect` |
|  | 2 | llm "The caller asked to speak to a human engineer." | `s_handover` |
|  | 3 | llm "The caller said they have their answer and nothing else." | `n_wrapup` |
|  | 4 | expr DUR | `s_handover` |
| `n_wrapup` | 1 | llm "The caller said they have another issue." | `n_triage` |
|  | 2 | llm "The caller said there is nothing else." | `s_goodbye` |
| `s_goodbye` | 1 | default | `t_hangup` |
| `s_handover` | 1 | default | `t_transfer` |
| `t_transfer` | 1 | default (transfer failed or voicemail detected) | `n_take_message` |
| `n_take_message` | 1 | expr `callback_note != "none"` | `t_callback` |
|  | 2 | llm "The caller declined to leave a message." | `n_wrapup` |
| `t_callback` | 1 | default | `n_wrapup` |

**Design rationale (interview points):**
- Facts route by expression (`route_hint`, `verify_result`, status codes, duration). Meaning routes by LLM.
- Verbatim sentences are speak nodes (disclosure, advisory, retry, lockout, handover, read-back, goodbye).
- Must-happen actions are tool nodes routed by status. May-help lookups are MCP.
- Every prompt node has a human-request exit.
- A failed escalation leads to a callback, and never loops, because `escalated` gates `DUR`.

**Probe-dependent fallbacks (§17):**
- **Speak-start expression edges ignored:** use the greeting fallback in §4.1.
- **`store_fields_as_variables` not visible to later speak nodes:** `s_confirm` and `s_pin_retry` become prompt nodes told to say `{{…}}` verbatim.
- **Turn model has the target node answering the triggering utterance:** acceptable. The instructions assume the node may be entered mid-conversation.

---

## 5. Dynamic variables webhook (`POST /dv`)

### 5.1 Handling

1. Read the raw body. Verify Ed25519 over `"{telnyx-timestamp}|{raw_body}"` with `TELNYX_PUBLIC_KEY` (skew ≤ 5 min; **403** on any failure).
2. Parse, dispatching on the presence of `data.payload`. Log `Object.keys` at each level for the first N calls (the conversation-id key is unknown).
3. **Call key and trace:**
   - `call_key = payload.call_control_id || payload.<conversation id key> || uuid()`
   - `k = lib/ids.sessionKey({call_control_id, call_key})`, a pure function returning `sha256(…)[:16]`. It **never hashes an empty or undefined value** and never hashes a literal `{{…}}`.
   - `trace_id = "t-" + k`
   - `caller_digits` = digits of `payload.telnyx_end_user_target`
4. **Fault injection:** if `flag/fault/dv_delay_ms` is set (clamped to ≤ 12000), then **after** step 6 and before responding, `await sleep(ms)`, so the platform's timeout actually fires (P12). [R:workflow-12]
5. Within the **internal deadline** (§5.5), all via `deadline()`:
   - `flags.read()`
   - `directory.lookup(caller_digits)`, which is KV `dir/<digits>` with cache-aside to the adapter
   - `incidents.read(contact.region)`, which reads the KV projection (only if the contact exists and deflection is enabled)
   - `SiteActor(contact.site_id).recordCall({k, trace_id, at})`, raced at 400 ms, returning `callsToday` and `openTicket`
6. **Session write, awaited inside the deadline:** `call/<k>/dv` = `{trace_id, identified, contact_id, customer_id, sites[], region}`, TTL 3600. If the payload has a conversation id, also write `conv/<conv_id>` → `k`. **If the session write did not complete, `route_hint` is forced to `"unverified"`.** [R:security-02]
7. Respond:

   ```
   { dynamic_variables: {…strings…}, conversation: { metadata: { trace_id, call_key } } }
   ```

   Log `dv.route` with timings. Log `dv.late` if `total_ms > timeout - 200` or a fault was injected (`fault_injected: true`).

### 5.2 `route_hint` (pure function)

```
if !sessionWritten                                   -> "unverified"
if flags.require_pin == "true"                       -> "unverified"
if no contact                                        -> "unverified"
if flags.deflection_enabled != "false" && incident   -> "known_incident"
else                                                 -> "verified"   (identified by caller ID)
```

- `flag/require_pin` exists because caller ID can be spoofed. In production it would pair with `telnyx_shaken_stir_attestation`.
- (Stretch §12.4: `"arabic"` when the contact's `preferred_language == "ar"`.)

### 5.3 Variables

All are strings. The **declared defaults** are what the platform uses on timeout.

| variable | set by | default |
|---|---|---|
| `msp_name` | /dv | Najd Networks |
| `route_hint` | /dv, verify_site | **unverified** |
| `caller_name` | /dv, verify_site | there |
| `customer_name` | /dv, verify_site | your organisation |
| `site_id` | /dv, verify_site, capture_details | unknown |
| `site_label` | /dv, verify_site | your site |
| `incident_region` / `incident_started` / `incident_summary` / `incident_eta` | /dv, verify_site | your area / earlier today / a network incident / shortly |
| `open_ticket_note` | /dv, verify_site | none |
| `repeat_note` | /dv (e.g. "I can see this is your third call today about this branch.") | none |
| `trace_id`, `call_key` | /dv, verify_site (mints `call_key` when none exists) | t-none, none |
| `verify_result`, `attempts_left` | verify_site | none, 3 |
| `pin` | capture_details; **wiped to "none"** by every verify_site response | none |
| `symptom`, `impact`, `service_affecting` | capture_details | none, unknown, unknown |
| `ticket_id`, `priority`, `ticket_readback` | open_ticket, join_incident | none, unknown, "Your report has been logged." |
| `callback_note` | capture_details | none |
| `escalated` | log_callback | false |

Times are rendered in `Asia/Riyadh`.

### 5.4 Failure design: "the defaults are a production path"

On a timeout, cold start or error, the defaults apply:
- `route_hint = unverified` leads to PIN verification.
- `verify_site` resolves identity from the **signed body**: `call_control_id`, else `call_key`. If neither exists, it **mints** a `call_key` on success and returns it via `store_fields_as_variables`, so every later tool call is linked.
- The worst case is "please tell me your site ID and PIN": secure, functional, and counted (`dv.late`, prober).
- **MCP on a no-DV web call:** the conversation join may fail. The tools then say "I can't reach our network systems right now, but I can still log your ticket", and the flow still works through tool nodes.

### 5.5 Timeout rule (set from the probe)

- **Measured `noc-edge` cold start < 4 s:** `timeout_ms = cold_p95 + 1000` (≤ 10000).
- **Otherwise:** `timeout_ms = 2500`. Warm responses (< 300 ms) fit. A cold call fails fast to the safe defaults after 2.5 s rather than 10 s of silence. Keep-warm makes cold calls rare.
- **Internal deadline** = `timeout_ms − 300`.

---

## 6. State model

### 6.1 `SiteActor` (name = site ID)

**Owns:** at most one open ticket per site, and PIN brute-force protection.

| key | shape |
|---|---|
| `seq` | int; preserved across `reset()` [R:state-06] |
| `ticket` | `{id, priority, impact, serviceAffecting, symptom, openedAt, regionReported:boolean, reporters:[{callerRef,k,at}], notes:[{at,text,k}]}` or null |
| `pin` | `{byCall: {k: {failures:[ts]}}, site: {failures:[{k,ts}], lockedUntil}}`, pruned to 15 min |
| `calls` | `{day, count, recent:[{k, trace_id, at}] ≤10}` |
| `ops` | idempotency map `opKey → result`, bounded to 50 |
| `events` | bounded 100 |

The PIN and its fingerprint are **never** stored in `events` or `ops`, or logged.

**Methods** (public async; no I/O; each returns `{…, trace_id, actor_ms}`):

- **`recordCall({k, trace_id, at})`:** idempotent on `k`. Returns `{callsToday, openTicket}`.
- **`recordPinAttempt({k, valid, fp, trace_id, at})`:**
  - `fp = HMAC(PIN_PEPPER, k|pin)[:16]`, computed in the function; it is a dedupe key only.
  - A repeat of the same `(k, fp)` within the same call returns the prior result with `repeat:true` and is not counted again.
  - **Per-call tier:** 3 failures on one call → that call is `locked`.
  - **Site tier** (brute-force signature): ≥ 6 failures from ≥ 2 distinct `k` within 15 min → the site is locked for 15 min.
  - `valid` clears that call's failures.
  - Returns `{result: ok|invalid|locked, attemptsLeft}`. [R:state-08]
- **`openOrAttach({k, trace_id, callerRef, symptom, impact, serviceAffecting, priority, at})`:**
  - `opKey = k + hash(symptom)`, so a genuinely second issue in the same call becomes a note, not a cached replay. [R:workflow-01]
  - **Create:** `id = NJD-${siteCode}${pad2(seq)}` (unique per site via the seed's 2-digit site code) [R:state-06].
  - **Attach:** add the reporter; `priority = min(existing, incoming)`; keep the worst impact; return `priorityRaised`. [R:state-11]
- **`markRegionReported({ticketId})`**, `getTicket()`, `addNote({k, ticketId, note, at})` (idempotent on `(k, hash(note))`).
- `resolveTicket({trace_id})` → returns the ticket, so the function can withdraw the site from the region.
- `reset()`: `deleteAlarm()`, `deleteAll()`, then re-put `seq`.

### 6.2 `RegionActor` (name = region)

**Owns:** at most one active incident per region, plus deterministic thresholds.

| key | shape |
|---|---|
| `seq` | int (preserved) |
| `members` | `{siteId: {ticketId, firstAt, lastAt}}`. A site stays a member while its ticket is open; staleness cap 6 h. [R:state-05] |
| `incident` | `{id: INC-${regionCode}${pad3(seq)}, version, declaredAt, priority, sites, nextUpdateAt, ackAt, esc:{level,dueAt}, pages:[…]}` or null |
| `events` | bounded 100 |

**Methods:**

- **`reportSite({siteId, ticketId, trace_id, at})`:** idempotent on `(siteId, ticketId)`; a new `ticketId` replaces the entry.
  - `members ≥ 2` and no incident → declare at P2.
  - `members ≥ 3` → P1. It never downgrades while open.
  - `version++` on every change.
  - Returns `{incident, declared, upgraded, siteCount}`.
- **`withdrawSite({siteId, ticketId})`:** called when a site's ticket is resolved.
- **`getIncident()`**, **`resolve({trace_id})`**: `deleteAlarm()`, clear the incident and members; return the final incident for the report (§12.3).
- `ack`, `alarm`, `claimPage`, `markPageSent`: §12.1.
- `reset()`: `deleteAlarm()`, `deleteAll()`, re-put `seq`.

**Why key by region, not by incident:** two simultaneous first reports would each see "no incident" and create two. The region owns the "one active incident" invariant.

### 6.3 KV namespace `noc-kv`

Only the function writes. Each key has **exactly one writer path**. Keys are sanitised, with no `+` or `:`. [R:state-07]

| key | value | TTL | writer | role |
|---|---|---|---|---|
| `dir/<digits>` | contact record | 300 s | directory (cache-aside) | cache |
| `incident/active/<region>` | `{id, version, region_label, started_local, summary, eta_local, priority, site_count}` | 7200 s, refreshed on every sync | `incidents.syncProjection` only | **read projection** |
| `call/<k>/dv` | `{trace_id, identified, contact_id, customer_id, sites[], region}` | 3600 s | /dv only (blind put) | session (caller ID) |
| `call/<k>/auth` | `{verified:true, site_id, customer_id, at}` | 3600 s | verify_site only (blind put) | session (PIN) |
| `conv/<conv_id>` | `k` | 3600 s | /dv, or the MCP join after an API lookup | MCP join |
| `flag/deflection_enabled`, `flag/require_pin` | `"true"`/`"false"` | none | human (CLI) | feature flags |
| `flag/fault/open_ticket` (∈ {500, 503, 504}), `flag/fault/dv_delay_ms` (≤ 12000) | value | **always `--ttl 600s`** | drill scripts | fault injection (validated; shown red on `/ops/status`; cleared by reset) [R:security-12, state-10] |
| `ops/heartbeat` | `{at, ok, checks}` | none | /health/deep | canary |
| `race/<run>/ticket` | naive ticket | 600 s | /diag/race kv mode | race-test control |

- **Session readers** fetch `/dv` and `/auth` in parallel and merge them; `auth` wins for `verified` and `sites`.
- **`incidents.syncProjection(region)`** reads `RegionActor.getIncident()` (the source of truth), then puts it (fresh TTL) or deletes it. It is called:
  - after every `reportSite` that returns non-null
  - after resolve, ack and reset
  - on every `/health/deep` for regions with an active incident

  Two concurrent syncs can still land out of order under last-write-wins. The next sync (≤ 10 s via the prober) heals it, and correctness never depends on KV. [R:state-02, platform-kv-projection-lifecycle]
- Flags are read on every request, with memoisation ≤ 5 s.

### 6.4 Services

**`tickets.open(session, input)`** [R:security-07, state-01, workflow-10]:
1. `authz.canWrite(session, input.site_id)`, else **403**. Unresolvable site → **422**.
2. `priority = severity.classify(impact, serviceAffecting)`
3. `ticket = SiteActor(site).openOrAttach(...)`
4. **If** `ticket.impact == "site_down"` **and** `!ticket.regionReported`:
   - `RegionActor(region).reportSite(...)`, with 1 retry on actor error or timeout
   - then `SiteActor.markRegionReported(ticket.id)`
   - on failure: log `incidents.report_failed`. The next report for that site retries, because `regionReported` is still false.
5. `incidents.syncProjection(region)` (best-effort)
6. `readback.render(ticket, incident, created, priorityRaised)` produces speech-ready text with IDs spelled out and the incident note folded in.

Two more services:
- **`tickets.joinIncident(session)`:** like `open`, but with `impact = site_down`, `serviceAffecting = yes`, the symptom taken from the active incident, and region reporting forced.
- **`sessions.byConversation(conv_id)`:** KV `conv/<id>`, else the Conversations API (`GET /v2/ai/conversations/{id}` → `metadata.call_key` / `trace_id` / `call_control_id`) bounded at 1500 ms. Negative results are not cached.

### 6.5 Ops actions (`OPS_TOKEN`)

| Action | What it does |
|---|---|
| `/ops/reset` | For every seed site and region, plus the lab and canary actors: `deleteAlarm → deleteAll → re-put seq`. Then delete or resync the projections, delete `flag/fault/*`, restore flag defaults, and return a per-item report. |
| `/ops/stage-incident?region=riyadh-north` | Runs `tickets.open` for two scripted sites (RUH-121, RUH-133) with synthetic sessions, so the demo starts from a declared 2-site incident. [R:workflow-04] |
| `/ops/resolve`, `/ops/ack`, `/ops/unlock?site=` | As named |

---

## 7. Tool webhooks (shared tools, `type: webhook`, `POST`)

Every webhook tool is configured with:
- `preset_body_fields: {"call_control_id":"{{call_control_id}}", "call_key":"{{call_key}}", "trace_id":"{{trace_id}}"}`. These are never shown to the LLM, win over its arguments, and are **covered by the signature**.
- `headers: [{name:"X-Trace-Id", value:"{{trace_id}}"}]`.

The handler takes identity from the body; the header is cross-checked and a mismatch is logged. If there is no usable key, it returns **422** (routed by the default edges), and it never hashes an empty value. [C13]

### 7.1 `verify_site` → `/tools/verify-site`

- **Body:** `{site_id, pin}` (from variables) + presets.
- **Steps:**
  1. Normalise and resolve `site_id`.
  2. `valid = adapter.checkPin(site, pin)`: HMAC-peppered hash, constant-time compare.
  3. `SiteActor.recordPinAttempt(...)`.
  4. If `ok`: blind-put `call/<k>/auth`; compute `route_hint` and the incident variables.
- **Always HTTP 200 for business outcomes:**

  ```json
  {"verify_result":"ok|invalid|locked","attempts_left":"2","pin":"none","call_key":"<k-or-minted>",
   "route_hint":"known_incident|verified","site_id":"RUH-114","site_label":"the Al Yasmin branch",
   "caller_name":"…","customer_name":"Al-Waha Pharmacies","incident_region":"…","incident_started":"…",
   "incident_summary":"…","incident_eta":"…","open_ticket_note":"…"}
  ```

  `store_fields_as_variables` maps every field. The PIN is **wiped to `"none"` on every response**. **5xx is reserved for real failures.**
- `timeout_ms: 5000`.

### 7.2 `open_ticket` → `/tools/open-ticket`

- **Body:** `{site_id, symptom, impact, service_affecting}` + presets. The session must be identified or verified, and the site must be in `session.sites` (403 otherwise).
- **Fault flag:** `flag/fault/open_ticket` returns that status.
- **200 body:**

  ```json
  {"ticket_id":"NJD-1407","priority":"P2","created":"true","symptom":"none","impact":"unknown",
   "ticket_readback":"Your ticket number is N J D, 1 4 0 7. Priority 2. An engineer will respond by 3:15 AM Riyadh time. This is part of incident I N C 1 0 0 2 affecting Riyadh North."}
  ```

  `store_fields_as_variables` maps `ticket_id`, `priority` and `ticket_readback`, and resets `symptom` and `impact`, so a second issue is captured fresh.
- **Attach wording:** "…there's already an open ticket for this branch: N J D, 1 4 0 7, opened 12 minutes ago. I've added you to it" (plus "and raised it to priority 2" when it was raised).
- `timeout_ms: 8000`.

### 7.3 `join_incident` → `/tools/join-incident`

- **Body:** presets only.
- Runs `tickets.joinIncident(session)` and returns the same shape as 7.2, with `ticket_readback` including "I've added your branch to incident I N C …; it now affects 3 branches and has been raised to priority 1."
- **403** if the caller is not identified or verified.

### 7.4 `log_callback` → `/tools/callback`

- **Body:** `{callback_note}` + presets.
- Records `callback/<k>` in actor events: on the SiteActor if a site is known, otherwise it is logged only. The callback number is **server-side** (the session caller), not trusted from the LLM.
- Raises a page event.
- Returns `{"escalated":"true","callback_note":"none"}` via `store_fields`.

### 7.5 Other shared tools

| Tool | Definition |
|---|---|
| `capture_details` | `update_dynamic_variables` with `site_id`, `pin`, `symptom`, `impact`, `service_affecting`, `callback_note` (typed and described) |
| `transfer_oncall` | `transfer`: `targets:[{name:"On-call engineer", to:<on-call number applied from a secret by apply.ts>}]`, `from`: the assistant's number (when one exists), `voicemail_detection` → `stop_transfer` (probe that this follows the default edge) [R:workflow-09] |
| `end_call` | `hangup` |

**On Trial:** the transfer target can only be the verified phone. It is demoed from a **web call** (caller = browser). On a phone call from the verified phone, escalation ends in `n_take_message` by construction. [R:platform-trial-transfer-self]

---

## 8. MCP server (`POST /mcp`)

### 8.1 Transport

- `@modelcontextprotocol/sdk` 1.x, `WebStandardStreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true})`, with a new server and transport per request.
- GET and DELETE → 405. Notifications → 202. An unknown method is 200 + `-32601`, never HTTP 404.
- **Wire shim:** log method, headers (minus auth) and body keys; normalise `Accept`; strip `_meta.progressToken: null`.
- Registered as `noc-mcp` (`type:"http"`) with a `bearer` integration secret (`MCP_TOKEN`).

### 8.2 Identity and authorisation (enforced below the model) [R:security-05, security-10]

- **`MCP_TOKEN` (Telnyx only), session scope.**
  - `tools/call` **must** carry `_meta.telnyx_conversation_id`, then `sessions.byConversation` resolves the session.
  - If the lookup fails, the spoken reply is "I can't reach our network systems right now, but I can still log your ticket."
  - If the site is not the caller's: "I can only look up your own site."
- **`OPS_TOKEN` (OpenCode, curl), ops scope, read-only.** Only `find_site`, `get_site_status`, `check_known_incidents` and `get_ticket_status` are allowed. Requests that carry `_meta` are rejected, and mutating tools are rejected.
- **One `authz` module** is shared with the tool webhooks:
  - `canRead` = customer scope
  - `canWrite` = `session.sites` only
  - `siteOfTicket(id)` routes ticket IDs to exactly one SiteActor (the site code is embedded in the ID)
- Denials are logged as `auth.denied`.

### 8.3 Tools

Each tool returns speech-first text plus `structuredContent`. Descriptions say **when** to call it.

| tool | input | behaviour | example spoken summary |
|---|---|---|---|
| `find_site` | `{description}` | Resolves a spoken branch name or garbled ID ("the Yasmin branch", "R U H one one four") to one of the **caller's customer's** sites | "That's the Al Yasmin branch, site R U H 1 1 4." |
| `get_site_status` | `{site_id?}` (defaults to the session site) | NMS view | "The edge router at the Al Yasmin branch stopped responding at 1:52 AM; the backup LTE link is also down." |
| `check_known_incidents` | `{site_id?}` | `RegionActor.getIncident()` | "There's an active priority 2 incident in Riyadh North affecting 2 branches since 1:52 AM." |
| `get_ticket_status` | `{ticket_id?}` (defaults to the session site's ticket) | `SiteActor.getTicket()` | "Ticket N J D 1 4 0 7 is priority 2; engineer response due by 2:28 AM." |
| `add_ticket_note` | `{ticket_id?, note ≤300}` | `SiteActor.addNote()` (canWrite) | "I've added your update to ticket N J D 1 4 0 7." |

### 8.4 Per-node scoping

The platform has no per-node MCP list, so scoping is layered, and the README states this finding:

1. The assistant's `allowed_tools`.
2. MCP is reachable only from `STI: null` nodes: `n_triage`, `n_collect`, `n_status`.
3. Node instructions name the permitted tools.
4. Server-side `authz`.

---

## 9. Seed data (`adapters/itsm/seed.ts`): the integration seam

**`ItsmAdapter` methods:** `findContactByPhone`, `getSite`, `resolveSite(description, customerId)`, `checkPin`, `getNmsStatus`, `listSites`, `getOnCall`.

**Al-Waha Pharmacies** sites (2-digit code, region):

| Region | Sites | Role |
|---|---|---|
| `riyadh-north` (1) | RUH-114 Al Yasmin (14), RUH-121 Al Malqa (21), RUH-133 Hittin (33) | Demo |
| `riyadh-south` (2) | RUH-207 (27) | |
| `jeddah` (3) | JED-007 (07), **JED-015 (15)** | **Reviewer site** |
| `dammam` (4) | DMM-003 (03), **DMM-011 (11)** | **Reviewer / lockout-test site** |

**Rawda Cafés** (second tenant): JED-900 (90) in `jeddah`, with its own contact and PIN.

**Other seed contents:**
- **Lab:** `TST-001` (99) in region `lab`, hidden from the directory, for the race test.
- **PINs:** HMAC(`PIN_PEPPER`) hashes. The reviewer PINs are published in the README.
- **NMS states:** RUH-114, RUH-121 and RUH-133 `down` from 01:52 (the scenario). All others `up`.
- **Contacts:** fictional contacts, plus Fahad's verified phone as the RUH-114 contact. That phone comes from a **gitignored** `seed.local.json` and is applied as the `SEED_LOCAL` secret.

**Severity matrix:**

| impact | service-affecting: yes | service-affecting: no |
|---|---|---|
| `site_down` | P2 | P2 |
| `degraded` | P3 | P4 |
| `single_user` | P4 | P4 |

A regional incident with ≥ 3 sites is P1. Response targets: P1 15 min · P2 30 min · P3 4 h · P4 next business day.

In production, this adapter is ServiceNow, Jira SM or the customer's NMS. Filling it in is day 2 of real discovery.

---

## 10. Security and privacy

**Authentication:**
- Signed routes fail closed (403).
- Two MCP credentials, with the scopes in §8.2.
- `OPS_TOKEN` for ops and diag routes.
- `noc-console` mutations require `OPS_TOKEN` (§12.2).

**Identity:**
- Caller identity comes only from platform-set, signed data: `telnyx_end_user_target` in the DV payload, and the preset body fields.
- LLM-supplied IDs are authorised against the session (`authz`).

**PINs, stated honestly** [R:security-06, platform-pin-in-dynamic-variables]:
- `noc-edge` never logs or persists PINs or PIN fingerprints (it uses an HMAC-peppered dedupe key only).
- **On the platform, the spoken PIN persists** in the recording, the transcript, the dynamic variable (until it is wiped) and the tool-call arguments.
- The site PIN is a **low-assurance, rotatable demo factor**. The production mitigations, listed in `docs/sovereignty.md`, are DTMF capture, one-time codes, STIR/SHAKEN attestation and the `privacy_settings` / recording-retention trade-offs.

**PII:**
- MSISDNs are masked in logs, and KV keys are masked in `kv.op` logs.
- The recording disclosure is delivered verbatim.
- `docs/sovereignty.md` covers the production residency path: a +966 number, the Dubai anchorsite, Middle East data locality, UAE strict inference, and a PDPL Art. 29 transfer assessment.

**Secrets:**
- All secrets live in `telnyx-edge secrets`: `TELNYX_PUBLIC_KEY`, `MCP_TOKEN`, `OPS_TOKEN`, `PIN_PEPPER`, `ONCALL_NUMBER`, `SEED_LOCAL`.
- `.gitignore` covers `.env*`, `seed.local.json`, the OpenCode `config.json`, and `.opencode-runs/raw/`.
- The committed `opencode.jsonc` uses `{env:…}` substitution only.
- A **pre-commit secret scan** fails if a staged file contains a literal token value, a `KEY_…` string, a Bearer token or an E.164 number.
- If anything leaks, the key is rotated before reviewers get access. [R:security-09]

**Fault flags:**
- Gated by the account credential (the CLI). Demo-only, TTL-bound and validated (§6.3).

---

## 11. Observability

### 11.1 Logs

**One JSON line per event:**

```
{ts, lvl, svc, hop:"dv|tool|mcp|actor|kv|ops|canary", evt, trace_id, conv_id?, k?, caller?(masked), site?, region?,
 route_hint?, tool?, status?, kv_ms?, actor_ms?, upstream_ms?, total_ms, outcome:"ok|fallback|denied|error", fault_injected?, err?}
```

**Events:**
- DV: `dv.request`, `dv.route`, `dv.late`, `dv.sig_fail`
- Tools and MCP: `tool.*`, `tool.no_key`, `mcp.request`, `mcp.tool`, `auth.denied`
- Actors and KV: `actor.call`, `kv.op`
- Incidents: `incident.declared`, `incident.upgraded`, `incidents.report_failed`
- Tracing and health: `trace.missing_key`, `canary.state_change`, `canary.summary` (1/min), `error`

The canary logs only on a state change plus a once-a-minute summary, so health checks never crowd out call hops. [R:platform-trace-log-cap]

### 11.2 Trace

`trace_id = "t-" + k`, and it travels with the call:
- `/dv` returns it as a variable and in conversation metadata.
- The tools receive it in the signed body.
- Actors receive it as an argument and echo it.
- MCP recovers it through `conv/<id>`.

`scripts/trace.sh <trace_id>` queries `GET /v2/compute/funcs/{id}/logs?type=runtime` with a time window taken from `/ops/status` recent calls and a high limit, then filters and orders the hops with their milliseconds. Its CLI fallback is `telnyx-edge logs noc-edge --since 15m -n 250 --json`. **Live demo:** `telnyx-edge logs noc-edge --tail --json | jq 'select(.trace_id=="…")'`.

### 11.3 Signals beyond logs

1. The per-request trace with hop timings
2. Latency fields, plus native `telnyx-edge metrics` (p50/p95/p99, 5xx)
3. `dv.late` count (the platform used the defaults)
4. The synthetic canary

### 11.4 Canary and keep-warm [R:rubric-detection-not-under-60s]

**`scripts/prober.ts`** is external and runs on the dev box, outside the failure domain:
- Every **10 s**: `GET /health/deep` with a **3 s** client timeout.
- **2 consecutive failures** raise an alert. Worst-case detection is about 23 s.
- The alert is an OS notification plus a console banner, and a Telnyx SMS once a number exists.
- The same loop keeps the function and the actor runtime warm.

`/ops/status` shows green when the heartbeat is ≤ 30 s old and ok, and red otherwise. Any active fault flag also shows red.

### 11.5 README answer: "know within a minute, look first at…"

1. **Detect:** the prober alert (≤ ~23 s), `metrics --errors` 5xx, or `dv.late`.
2. **First look:** `telnyx-edge logs noc-edge --tail --type invocations`.
3. **Then:** `trace.sh <trace_id>`.
4. **Then:** the Portal conversation's node labels and its Dynamic Variable Webhook Logs tab.
5. **Then:** `telnyx-edge actors instances SiteActor`.

### 11.6 Evidence

- **`DEBUGLOG.md`:** symptom → signal → log lines → hypothesis → fix → verification. The first entry is the C1 number blocker.
- **`DOGFOODING.md`:** model bake-off, per-task cost and time, interventions.
- **`docs/evidence/`:** race-test output, drill timings, probe results.

---

## 12. Stretch designs (target: Monday)

### 12.1 Alarms: SLA-acknowledgement ladder (`RegionActor`) [R:state-09]

- **Declare and upgrade** both set `esc = {level:0, dueAt: now + ackWindow}` and call `setAlarm(dueAt)`. The ack window is P1 2 min and P2 5 min (demo values; configurable).
- **`alarm()` and `tick()`** both call `_escalateIfDue(now)` inside a catch-all that never throws:
  - Return early if there is no incident, it has been acked, or `now < esc.dueAt − 1000`. This makes duplicate deliveries harmless.
  - Otherwise: `level++`, append the page `{id: incId+":"+level, claimedBy:null, sentAt:null}`, set the new `dueAt`, and re-arm while `level < 3`.
- **Resolve and reset** call `deleteAlarm()`.
- **Paging:** only the prober sends pages. It calls `/ops/pages/pending`, then `/ops/pages/claim`, which runs `RegionActor.claimPage(pageId, claimer, now)`. That is an RMW with a 60 s re-claim window, so each page is sent exactly once; then `markPageSent`. Page loads never send.
- **Dead-man's switch:** a separate `CanaryActor` re-arms every 60 s and writes a heartbeat.
- **Fallback:** if prod alarms don't fire, the prober drives `tick()`. The alarm row is then **not claimed**.
- **Fake tests:** duplicate delivery, upgrade mid-ladder, alarm after resolve, concurrent claim.

### 12.2 Shared actors: `noc-console`

- A second `telnyx.toml` function that declares `[[actors]]` with the same types under its own bindings and **no class**. It is shipped after `noc-edge`.
- **Scope:** one read-only route that reads both actor types directly, which is the proof of shared actors, and renders a dashboard (`textContent` only, never `innerHTML`).
- **Mutations** (ack, resolve, reset) are **proxied to `noc-edge /ops/*` with `OPS_TOKEN`**. KV deletes and report writes therefore stay on one code path. [R:security-08]
- **Proof:** `telnyx-edge actors inspect SiteActor` lists both functions as binders.

### 12.3 Object storage: incident reports

- On resolve, `noc-edge` writes `incidents/<INC-id>-<declaredAt>.json` to the Telnyx Cloud Storage bucket `noc-reports-<suffix>` via `[storage.cloudstorage.REPORTS]`.
- The report holds the timeline from the actor events, the sites, tickets and trace IDs, and the time to acknowledge. It holds **no PINs or fingerprints**.
- The dashboard links a presigned URL minted via `POST /v2/storage/buckets/{bucket}/{object}/presigned_url`.

### 12.4 Multi-assistant: Arabic specialist (tier-conditional)

- **Paid+:** a second assistant, "Sanad - Arabic", with `humain/realtime` `codeswitch` STT, a `Telnyx.Bayan.<Saudi speaker>` voice, and Arabic instructions (`replace`, with the safety rules restated). It uses the same MCP server and shared tools, and its own compact workflow.
- **Routing:**
  - `s_open` expression edge: `route_hint == "arabic"`, set by `/dv` from the contact's `preferred_language`, which is toggled for the P16 demo.
  - An LLM edge "The caller asked to continue in Arabic" on `n_triage`, `n_verify` and `n_advisory_followup`.
  - Target: `target:{type:"assistant", voice_mode:"distinct"}`.
  - `s_open` gains a bilingual hint. [R:workflow-11]
- **Trial:** an `n_arabic` node with node-level `transcription` and `voice_settings` overrides (`replace` instructions). This is labelled **"Arabic mode"** and is **not claimed** as multi-assistant.

---

## 13. Testing

### 13.1 Automated tests (vitest; pure logic written TDD-first)

- **Pure logic:**
  - Ed25519 (RFC 8032 vectors plus a Telnyx-shaped fixture; 403 paths)
  - `sessionKey`: never hashes an empty or `{{…}}` value, and two keyless calls never collide
  - `route_hint`, severity, read-back, ID minting and `siteOfTicket`, normalisation, masking, KV key sanitising
  - the `deadline()` late-rejection safety
- **Actor fakes:**
  - idempotency; the PIN per-call and site tiers; repeat-fingerprint handling
  - attach raises priority
  - declare and upgrade thresholds; membership while a ticket is open
  - `regionReported` recovery
  - the alarm ladder (§12.1)
- **Services:** `tickets.open` report/retry/sync ordering. Only `site_down` reports to the region.
- **MCP:** the SDK client in-process: initialize, `tools/list`, each tool, both auth scopes, `authz` denials, the null-`progressToken` shim.
- **Security:** `/tools/*` and `/dv` reject unsigned and badly signed requests with 403.
- **Config:** `assistant/validate.ts` checks:
  - unique ids; edge endpoints exist
  - speak and tool nodes have exactly one `default` edge (hangup: none)
  - every `{{var}}` is declared
  - every prompt node sets IM and TM
  - no prompt node lacks a human-request exit
  - `tool_ids == [capture_details]`

### 13.2 Path matrix

Run on web or phone calls. Evidence = node labels + trace.

| # | Scenario | Expected |
|---|---|---|
| P1 | Known caller, no incident, new site_down fault | s_open → n_triage → n_collect (get_site_status) → s_one_moment → t_open_ticket → s_confirm → n_wrapup → s_goodbye → t_hangup |
| P2 | Second call about the same site | Attached ("already an open ticket … added you") |
| P3 | 2nd site in the region reports site_down | Incident declared P2; projection written |
| P4 | Staged 2-site incident; known RUH-114 caller | s_open → **s_advisory** → n_advisory_followup → s_join → t_join_incident → s_confirm ("…raised to priority 1") |
| P5 | Advisory, but a different problem (single_user) | → n_collect → ticket P4; region **not** reported |
| P6 | Unknown number, correct PIN (reviewer site) | n_verify → t_verify ok → n_triage |
| P7 | Wrong PIN, then correct | t_verify invalid → s_pin_retry → n_verify → t_verify ok |
| P8 | 3 wrong PINs on one call (DMM-011) | → locked → s_locked → t_transfer |
| P9 | Ticket status + note | n_status (get_ticket_status, add_ticket_note) |
| P10 | Asks for a human | → s_handover → t_transfer. On failure or voicemail: n_take_message → t_callback |
| P11 | `flag/fault/open_ticket=503` | → n_ticket_failed |
| P12 | `flag/fault/dv_delay_ms=4000` | defaults → n_verify → t_verify (minted key) → ticket linked; `dv.late fault_injected` |
| P13 | Call ≥ 300 s | DUR → s_handover (once; `escalated` prevents loops) |
| P14 | `flag/deflection_enabled=false` during an incident | no advisory → n_triage |
| P15 | Verified Al-Waha caller asks for JED-900 (Rawda) | MCP refuses; `auth.denied` |
| P16 | Arabic (stretch) | → Arabic assistant or Arabic mode |
| P17 | No PIN / wants a person at n_verify | → s_handover |
| P18 | Declines to open a ticket | n_collect → n_wrapup |
| P19 | Two issues in one call | Second issue captured fresh (note on the same ticket, or a new ticket at another site) |
| P20 | Wrong PIN, then silence | No re-fire on a stale PIN; idle timeout ends cleanly |
| P21 | Web call (no call_control_id) end to end | Minted `call_key` links verify → open_ticket; traces don't collide with another concurrent web call |

### 13.3 Race test

`POST /diag/race?mode=actor|kv&n=20` (`OPS_TOKEN`). It fires 20 in-process concurrent opens for **TST-001 / lab**, with 20 distinct synthetic keys (`sha256("race-"+run+"-"+i)`) and synthetic sessions (which bypass the session check **only inside this ops route**), after a reset and a warm-up.

- **Actor mode** calls the real `tickets.open` and must return **exactly 1** `created:true`.
- **KV mode** does a naive get-then-put and is expected to create **more than 1**.

`scripts/race-test.ts` runs both modes and commits the output to `docs/evidence/race-test.txt`. [R:race-test ×5]

### 13.4 Assistant tests

- Telnyx AI Tests (`POST /v2/ai/assistants/tests`) for paths that don't need DV.
- `POST /v2/ai/assistants/{id}/tools/{tool_id}/test` for the tool webhooks. These requests are signed by Telnyx; a missing ccid exercises the minted-key path.

---

## 14. Build process (requirement 6)

### 14.1 Integrity line

Every shipped artifact (code, config, tests, scripts, README, DEMO) is authored through **OpenCode + `@telnyx/opencode` on Telnyx-hosted models**. Claude writes the spec, the plans and the task prompts, and reviews; it never hand-edits product code. This is disclosed in the README and in the interview.

### 14.2 Setup

- Install OpenCode for linux-arm64, then run `opencode plugin @telnyx/opencode` and `opencode auth login --provider telnyx --method "API Key"`. The key is entered by Fahad and never pasted into chat.
- Enable the models in `~/.config/opencode/telnyx-models.json`.
- `opencode.jsonc`: the plugin pinned, the model and permissions, and the `noc-mcp` entry with `{env:NOC_OPS_TOKEN}`.
- **Permission deny rules:** `opencode debug config*`, `telnyx-edge secrets*`, `cat *seed.local*`, `git push*`.
- `AGENTS.md` holds the standing rules: C1-C13, TDD, the log schema, no I/O in actors, strings-only DV, no floating promises, one writer per KV key, no signature bypass.
- Environment: `OPENCODE_DISABLE_CLAUDE_CODE=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`.

### 14.3 Headless loop

```bash
opencode run --model telnyx/<model> --format json --auto "<task prompt>" > .opencode-runs/raw/<ts>-<task>.jsonl
```

- Review the diff, run tests and type-check, then `--continue`.
- Only **sanitised** exports are committed (`opencode export <id> --sanitize`, plus `scripts/redact-runs.ts`).
- **Parallelism** [R:rubric-schedule]: tasks develop in worktrees, but **every `noc-edge` change merges through one integration branch, with one ship at a time**, followed by the integration suite. Only `noc-console` and the assistant config/Arabic work are truly parallel.
- `apply.ts` PATCHes the recorded assistant ID in place and never deletes it.

### 14.4 Model choice and credit budget [R:platform-trial-credit-kimi, rubric-inference-and-voice-budget]

- **Phase 0, step 1:** record the balance and whether the promo code applied. Decide on a top-up before Phase 1.
- **Model bake-off:** run on the **first real task** (the Ed25519 verifier plus tests) with Kimi-K3 and GLM-5.3, off the critical path. Record correctness, time and cost via `opencode stats --models`.
- **Default routing:**
  - GLM-5.3 or GLM-5.3-Flash for mechanical tasks (scaffold, boilerplate, docs)
  - the bake-off winner for hard tasks (actors, services, MCP, authz)
- **Daily routine:** balance check plus `opencode stats` every evening. A pre-demo balance check Tuesday and Wednesday.
- **Budget:** reserve about 90 voice-minutes for the matrix and rehearsals.

---

## 15. Phasing and schedule

| When | Phase | Exit criteria |
|---|---|---|
| **Sat 26** | **0: Setup + probe** (§17 blocking items only). ✅ Edge CLI OAuth. ✅ Number check: blocked → Telnyx Team email. Then: balance and promo · API key · OpenCode + models · repo scaffold + AGENTS.md + hooks · KV namespace + secrets · ship `noc-probe` · assistant probe variants (sequential; 1 assistant). | Blocking probes answered in DEBUGLOG.md. §4/§5.5 fallbacks resolved. |
| **Sat-Sun** | **1: Core**, strictly in this order: lib → adapter + seed → actors → services → `/dv` → `/tools/*` → `/mcp` → `/ops` + health + diag → assistant config-as-code → deploy | Unit tests green · race test passes · P1-P15 and P17-P21 pass |
| **Sun** | **2: Harden:** prober, trace.sh, `/ops/status`, README draft, architecture diagram · **Tier decision at Sunday noon** (Arabic: multi-assistant vs mode) | **Core checkpoint Sunday night**, signed off by Fahad |
| **Mon 28** | **3: Stretch.** `noc-edge` serial: alarms → storage. Parallel: `noc-console`, Arabic. README and DEMO final. **Code freeze at 20:00.** | Stretch goals demoable |
| **Tue 29** | **4: Buffer (morning), then test and rehearse.** Full matrix · drills · 2 rehearsals · mock panel Q&A · balance check | Demo ≤ 10 min |
| **Wed 30** | **5: Submit.** Reviewer access · URLs · number or web-call link · `opencode.jsonc` · DEMO.md | Submitted |

**Cut order** (the core is never cut): Arabic → object storage → noc-console HTML (keep the read-only route) → alarms (fall back to `tick()`, unclaimed).

---

## 16. Deliverables and demo

**Deliverables:**
- A private GitHub repo with reviewer access.
- URLs: `noc-edge` (`/dv`, `/mcp`, `/ops/status`) and `noc-console`.
- A phone number, or a web-call link on Trial.
- **README:**
  - setup, architecture diagram, and the per-node tool matrix
  - how to call, plus a **Reviewer guide**: dedicated sites JED-015 / DMM-011 with their PINs, and the expected node path for each step
  - the observability answer
  - the rationale for each primitive choice
  - platform findings, including the brief errors and the per-node MCP limitation
  - the build-split disclosure
- The MCP bearer is **shared privately** with reviewers in the submission email.

**`DEMO.md` (timed, 8-10 min, ≤ 2 live calls)** [R:rubric-demo-overruns-10-min]:

| Time | Segment |
|---|---|
| 0:00-1:00 | The problem and the customer. /ops/status and `logs --tail` side by side for the rest of the demo. |
| 1:00-4:30 | **Live call 1**, from the verified phone as the RUH-114 contact, into a **pre-staged 2-site incident**: DV personalisation → deterministic advisory (speak) → join → **P1 upgrade** shown live on /ops/status (actor) → read-back (speak) · MCP `get_site_status` / `check_known_incidents` if asked |
| 4:30-5:30 | `trace.sh` on that call's `trace_id`: Function → KV → Actor → MCP, with hop timings |
| 5:30-7:30 | **Live call 2** (web call): flip `flag/deflection_enabled=false` in KV (no redeploy) → the same caller now goes to triage. Escalation → transfer to the verified phone. |
| 7:30-9:00 | Edge Compute in action: `telnyx-edge actors instances`, KV keys, metrics · the race-test slide (actor: 1 ticket; KV: duplicates) |
| 9:00-10:00 | Wrap-up: stretch highlights (the alarm ladder on the console) |

The failure drill (kill the webhook → the defaults path → detected in ≤ 23 s) and the DEBUGLOG trail go in the walkthrough section.

**Pre-flight:** `/ops/reset` → `/ops/stage-incident` → warm-up → balance check → confirm there are no fault flags.

---

## 17. Probe items

### 17.1 Blocking (Phase 0)

| # | Question |
|---|---|
| P0-1 | Balance and promo; `GET /v2/ai/openai/models` |
| P0-2 | `noc-probe` function: cold start (≥ 15 min idle) · which `env` carries KV · prod alarms fire · actor `console.log` visible · `process.on('unhandledRejection')` works |
| P0-3a | DV fires on web calls? DV payload keys (conversation-id key?) · does `{{call_control_id}}` resolve on web calls? · is there a conversation-id system variable? |
| P0-3b | Tool webhook on a web call and a phone call: headers + body; do `preset_body_fields` mustache values resolve? |
| P0-3c | Does a tool node execute a shared tool that is **not** in `tool_ids`? |
| P0-3d | Does `tools_mode:"replace"` hide MCP tools? |
| P0-3e | Speak-start expression edges; string vs number typing; `and`/`or` nesting |
| P0-3f | Turn model: which node answers the utterance that fires an LLM edge; does a prompt node speak unprompted after a speak/tool node? |
| P0-3g | `store_fields_as_variables`: visible to later speak nodes? Overwrites a `capture_details` variable (PIN wipe)? Applied on 200 only? |
| P0-3h | `greeting` sentinel + `disable_greeting_interruption` with a speak start node |

### 17.2 Folded into build and testing

- MCP wire format (protocol version, Accept, `_meta`, bearer) and tool timeout
- DUR with a 20 s threshold
- Transfer from a web call to the verified phone; voicemail `stop_transfer` → default edge
- Transfer-target mustache (the review refuted the concern; still verify)
- Whether the fraud prefix plays on inbound calls
- Shared-tool creation via the API for transfer and hangup (fallback: the Portal)
