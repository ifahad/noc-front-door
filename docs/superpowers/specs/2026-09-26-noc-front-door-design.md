# NOC Front Door: Design Spec

> **Architect artifact.** Written by Claude (as architect and reviewer) together with Fahad. Product code, config and docs that ship are authored through OpenCode on Telnyx-hosted models (see §14).
> Status: DRAFT for review · Date: 2026-09-26 · Submission due: Wed 2026-09-30
> Evidence base: `../../../research/PLATFORM_BRIEF.md`, cited as `PB §n`, and its research notes (outside this repo).

---

## 1. Summary

**NOC Front Door** is a 24/7 AI voice line for a fictional KSA managed-services provider, **Najd Networks**. Enterprise customers call it when a branch network fails. The assistant, **Sanad**:

- identifies the caller from caller ID (or a site ID + PIN);
- tells callers about a known regional incident verbatim, deterministically, before any LLM step;
- triages new faults;
- corroborates them against live network status (MCP);
- opens **exactly one ticket per site**, even when several people call at once;
- declares a **regional incident** when 2 or more sites in a region report, and upgrades it to **P1 at 3 or more sites**;
- reads the ticket back verbatim;
- escalates to a human on request, after 300 s, or when a site is locked out.

**Why it matters (the panel story).** KSA wholesale SLAs start the repair clock "from receipt of fault report". A fault that is not reported per procedure voids the SLA penalties (stc Reference Offer Annex I §1.4.2, §1.5.3). At 02:00 that moment is a person answering a phone. Downtime costs more than $300k/h for 90% of enterprises (ITIC 2024). The Telnyx KSA AE brief says to lead with *"an AI agent that operates your SOC or NOC workflow"*.

**Customer (fictional):** Al-Waha Pharmacies, a pharmacy chain with branches in Riyadh, Jeddah and Dammam. Branch connectivity carries POS and e-prescription traffic.

### 1.1 Success criteria

1. Every core requirement (brief §1–7) can be shown live, with evidence (see the table in §1.2).
2. Every path in the §13.2 test matrix passes on a real call, and each pass has trace evidence.
3. The race test (§13.3) shows 20 concurrent open-ticket requests for one site give exactly 1 ticket through `SiteActor`, and more than 1 through the naive KV path.
4. A synthetic failure is detected in under 60 s and diagnosed from logs by `trace_id`.
5. All 8 stretch goals are implemented by Monday 2026-09-28 EOD (the §15 cut order applies if we slip).
6. `DEBUGLOG.md` holds at least one real bug with its full evidence trail. `DOGFOODING.md` holds OpenCode + Telnyx inference findings with numbers.

### 1.2 Requirement map

| Brief item | Where it is satisfied |
|---|---|
| 1. Assistant + Conversation Workflow (prompt, speak, conditional edges, phone) | §4: 17 nodes; speak nodes for disclosure, advisory, lockout, read-back; LLM + expression + default edges |
| 2. MCP server, ≥3 tools | §8: 5 tools on `noc-edge /mcp` |
| 3. Dynamic Webhook Variables on an Edge Function, influencing routing | §5: `/dv` returns `route_hint`, which routes the speak start node |
| 4a. Edge Function via `telnyx-edge ship` | §3: `noc-edge` |
| 4b. KV | §6.3: incident projection, directory cache, flags, call sessions |
| 4c. Stateful Actor with read-modify-write | §6.1–6.2: `SiteActor` (get-or-create ticket, PIN lockout), `RegionActor` (incident declaration) |
| 5. Observability | §11: JSON logs, trace, latency, canary, README answer, DEBUGLOG |
| 6. Telnyx Inference via OpenCode | §14 |
| 7. Public deployment + docs | §3, §16 |
| Stretch: multi-assistant | §12.4: Arabic specialist assistant |
| Stretch: variable comparison edges | §4: `telnyx_conversation_duration_secs >= 300`, `telnyx_last_tool_status_code` (core) |
| Stretch: alarms | §12.1: SLA acknowledgement escalation ladder |
| Stretch: object storage | §12.3: incident reports in Telnyx Cloud Storage |
| Stretch: KV feature flags | §6.3 `flag/*` (core) |
| Stretch: shared actors | §12.2: `noc-console` binds actors by reference |
| Stretch: custom DV routing vars | §5 `route_hint` (core) |
| Stretch: distributed tracing | §11.2 `trace_id` across Assistant → Function → KV/Actor → MCP (core) |

---

## 2. Platform constraints (verified in research; the probe re-verifies)

| # | Constraint | Consequence |
|---|---|---|
| C1 | Account is **Trial**: 1 assistant, 1 API key; inbound calls only from the verified number; number ordering is restricted by country of origin (PB §1.9) | Probe step 1 checks number options. Multi-assistant (§12.4) needs Paid or higher. Email Telnyx Team with evidence if blocked. Fallback: web calls (`supports_unauthenticated_web_calls`). |
| C2 | Actors require a **`telnyx.toml` umbrella project** in TypeScript (the brief's "func.toml" guidance is wrong) (PB §1.4) | `noc-edge` is a `telnyx.toml` project |
| C3 | The DV webhook **holds the greeting**. Timeout range 1–10000 ms, default 1500 ms. Measured cold start of an actor function is **13–14 s** (PB §2 C5) | Defaults are a production path (§5.4). Keep warm (§11.4). Timeout rule in §5.5. |
| C4 | MCP on Edge must be **stateless POST JSON**: SSE is buffered, GET returns 405 (PB §1.3) | §8.1 |
| C5 | **KV** has no CAS and is last-write-wins; read-your-writes holds within a location; keys match `^[-/_=.a-zA-Z0-9]+$` (no `+` or `:`) (PB §1.5) | KV is never used for counters or invariants. Keys are sanitised. |
| C6 | The actor turn lock is **held across `await`**. 30 s method budget. Turn-atomic commits. At-least-once alarms (PB §1.6) | No network I/O in actor methods. Idempotent methods. |
| C7 | Workflow API defaults `instructions_mode` and `tools_mode` to **`replace`** (PB §1.1) | Every node sets both explicitly |
| C8 | Tool nodes must use **shared tools**; MCP cannot back a tool node; a `handoff` tool blocks workflows (PB §1.1) | Must-happen actions are webhook shared tools. Multi-assistant uses assistant-target edges. |
| C9 | Voice stores variables as **strings**; `telnyx_last_tool_status_code` is `"200"` on voice and `200` on chat (PB §1.1) | DV returns only strings. Status edges use `or` over both types. |
| C10 | Voice LLMs are limited to Kimi-K2.6 / K2.5 / GLM-5.2 (PB §1.1) | Assistant uses `moonshotai/Kimi-K2.6`. Logic lives in code. |
| C11 | No local actor runtime (private images) (PB §1.4) | Unit tests use fakes. Integration tests run against deployed functions. |
| C12 | One instance per tool type per assistant (except `webhook`, `function`, `client_side_tool`) (PB §1.1) | One `update_dynamic_variables`, one `transfer`, one `hangup` |

---

## 3. Architecture

```
            ┌──────────── Telnyx AI Assistant "Sanad" (Kimi-K2.6, Conversation Workflow §4) ───────────┐
 caller ──► │ s_open (speak) ─expr route_hint─► advisory / verify / triage ─► collect ─► t_open_ticket … │
            └──────┬───────────────────────────┬─────────────────────────────┬────────────────────────┘
          (1) POST /dv (signed)       (2) POST /tools/* (signed,        (3) POST /mcp (bearer,
               at call start               from tool nodes)                 LLM-chosen tools)
                   ▼                           ▼                               ▼
 ┌──────────────────────── noc-edge (telnyx.toml umbrella fn, TypeScript) ────────────────────────┐
 │ router ─► dv/ · tools/ · mcp/ · ops/        services/ (tickets, incidents, directory, sessions)│
 │ lib/ (log, trace, verify-ed25519, kv, timing)   adapters/itsm (seed CMDB/NMS: the integration seam)│
 │       │ KV (noc-kv)                     │ actors                                                │
 │       ▼                                 ▼                                                       │
 │  dir/* · incident/active/* ·    SiteActor(site_id)      RegionActor(region)                     │
 │  flag/* · call/* · conv/*       ticket, PIN lockout,    incident declaration, P1 upgrade,        │
 │  (cache · projection · flags)   calls (RMW, idempotent) SLA clock (+ alarms, §12.1)             │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
      ▲ external prober (30 s, keep-warm + alerting)        noc-console (stretch: shared-actor dashboard)
```

**Topology decision:** one umbrella function, so the DV call at conversation start warms the container that serves MCP and the tools (C3). MCP is a **module** boundary (`src/mcp/`), not a deployment boundary. Splitting it into its own function is a routing change, at the cost of a second cold start.

### 3.1 Routes (`noc-edge`)

| Method + path | Auth | Purpose |
|---|---|---|
| `POST /dv` | Ed25519 | Dynamic variables webhook (§5) |
| `POST /tools/verify-site` | Ed25519 | Tool node `t_verify` (§7.1) |
| `POST /tools/open-ticket` | Ed25519 | Tool node `t_open_ticket` (§7.2) |
| `POST /mcp` | Bearer (`MCP_TOKEN`) | MCP server (§8) |
| `GET /health/liveness` | none | Process up |
| `GET /health/deep` | Bearer (`OPS_TOKEN`) | KV put/get + actor RPC + in-process MCP `tools/list`; returns per-check timings |
| `GET /ops/status` | none (masked data) | JSON: incidents, open tickets, recent calls (trace ids), heartbeat |
| `POST /ops/{reset,resolve,ack}` | Bearer (`OPS_TOKEN`) | Demo reset; resolve an incident; ack (stretch) |
| `GET /diag/bindings` | Bearer (`OPS_TOKEN`) | Which `env` carries which bindings (C-probe) |
| `POST /diag/race` | Bearer (`OPS_TOKEN`) | Naive KV-only open-ticket path for the race test (§13.3). Never on the call path. |

Unknown routes return 404 with a JSON body. Every handler is wrapped: an unhandled rejection crashes the process and drops all in-flight requests (PB §1.4).

### 3.2 Module layout

```
edge/noc-edge/
  telnyx.toml  package.json  package-lock.json  tsconfig.json  vitest.config.ts
  src/index.ts                 # default export { fetch }, re-exports actor classes
  src/router.ts
  src/lib/{log,trace,ed25519,kv,timing,mask,errors,env}.ts
  src/adapters/itsm/{index,seed}.ts      # ItsmAdapter interface + seed data
  src/services/{directory,sessions,tickets,incidents,severity,readback}.ts
  src/actors/{SiteActor,RegionActor}.ts
  src/dv/handler.ts  src/tools/{verifySite,openTicket}.ts  src/mcp/{server,shim,tools}.ts  src/ops/*.ts
  test/**/*.test.ts            # vitest; in-memory ActorStorage + KV fakes
```

---

## 4. Conversation Workflow (assistant "Sanad")

### 4.1 Assistant-level config

- `model`: `moonshotai/Kimi-K2.6`.
- `voice_settings.voice`: a Telnyx NaturalHD or Ultra English voice, chosen in the probe.
- `transcription`: `deepgram/nova-3`, `en`, with `settings.keyterm` biased to site IDs and product words ("RUH", "JED", "DMM", "Najd").
- `greeting`: `"<assistant-speaks-first-with-model-generated-message>"`, so the speak start node delivers the opening. The probe verifies this; the fallback is `""`.
- `interruption_settings.disable_greeting_interruption: true`, which protects the disclosure (probe verifies).
- `telephony_settings`:
  - `time_limit_secs: 900`
  - `user_idle_timeout_secs: 60`
  - `recording_settings.enabled: true` (disclosed)
  - `fallback_destination`: the on-call number
- `dynamic_variables_webhook_url`: `https://noc-edge-<id10>.telnyxcompute.com/dv`
- `dynamic_variables_webhook_timeout_ms`: per §5.5.
- `dynamic_variables`: the defaults in §5.3 (every variable used anywhere is declared).
- `tool_ids`: `verify_site`, `open_ticket` (webhook), `capture_details` (`update_dynamic_variables`), `transfer_oncall` (transfer), `end_call` (hangup).
- `mcp_servers`: `[{ id: <noc-mcp>, allowed_tools: [get_site_status, check_known_incidents, get_ticket_status, add_ticket_note, report_affected_site] }]`

**Global `instructions` (abridged; full text in `assistant/instructions.md`):**
- Persona: Sanad, the Najd Networks NOC assistant. Calm, concise, one question at a time. Sentences stay under 20 words.
- Spell IDs character by character ("R U H one one four").
- Never read a PIN back. Never invent ETAs, causes or ticket numbers; only state what tools or variables provide.
- If unsure which site the caller means, ask.
- Refuse out-of-scope requests politely.
- English by default (Arabic via §12.4).

### 4.2 Nodes

Notation: `IM` = `instructions_mode`, `TM` = `tools_mode`, `STI` = `shared_tool_ids`. `STI: null` inherits all assistant tools, including MCP.

| id | type | purpose | IM | STI / TM |
|---|---|---|---|---|
| `s_open` | speak (**start**) | "Thank you for calling {{msp_name}} network operations. This call is recorded and handled by an AI assistant to log and track your fault report." | n/a | n/a |
| `s_advisory` | speak | "Hi {{caller_name}}. We're already aware of an incident affecting {{incident_region}}, reported at {{incident_started}}: {{incident_summary}}. Our engineers are working on it, and the next update is due by {{incident_eta}}." | n/a | n/a |
| `n_advisory_followup` | prompt | Ask whether the problem at {{site_label}} matches. If yes, call `report_affected_site` and confirm. If no, move to collect. | append | `null` (needs MCP) |
| `n_verify` | prompt | Ask for the site ID and the 4-digit site PIN. Save `site_id` (normalised, e.g. `RUH-114`) and `pin` (digits) with `capture_details`. Never repeat the PIN. If a previous attempt failed, say so and ask again. | append | `[capture_details]` / replace |
| `t_verify` | tool | `verify_site` (args `site_id`, `pin` from variables) | n/a | n/a |
| `s_locked` | speak | "For security, phone verification for this site is temporarily locked. I'll connect you to an engineer now." | n/a | n/a |
| `n_triage` | prompt | Greet {{caller_name}} from {{customer_name}}. Mention {{open_ticket_note}} if not "none". Find out whether this is a new fault, an existing ticket, or a request for a human. After PIN verification, call `check_known_incidents` once. | append | `null` |
| `n_collect` | prompt | Collect site (if not known), symptom, since when, and impact (`site_down`/`degraded`/`single_user`) and whether service is affected (`yes`/`no`). Call `get_site_status` and tell the caller what the network shows. Save with `capture_details`. Read back a one-sentence summary and ask for confirmation. | append | `null` |
| `s_one_moment` | speak | "Thank you. One moment while I log that for you." | n/a | n/a |
| `t_open_ticket` | tool | `open_ticket` (args from variables) | n/a | n/a |
| `s_confirm` | speak | "{{ticket_readback}}" (server-rendered, §7.2) | n/a | n/a |
| `n_ticket_failed` | prompt | Apologise that the ticket system didn't respond and offer to connect an engineer. | append | `[transfer_oncall]` / replace |
| `n_status` | prompt | Use `get_ticket_status` (by ticket ID or the caller's site). Offer to add an update with `add_ticket_note`. | append | `null` |
| `n_wrapup` | prompt | Ask if there is anything else. If not, thank the caller (restate {{ticket_id}} if set) and say goodbye. | append | `[]` / replace |
| `t_hangup` | tool | `end_call`: no edges | n/a | n/a |
| `t_transfer` | tool | `transfer_oncall` to {{oncall_number}}. At most one default edge (used on failure). | n/a | n/a |
| `n_take_message` | prompt | The transfer failed. Take a callback message, add it with `add_ticket_note` if a ticket exists, and reassure the caller. | append | `null` |

### 4.3 Edges

Order matters: the first true edge wins, and `default` comes last. `DUR` = `telnyx_conversation_duration_secs >= 300` (`number_literal`). `OK` = `telnyx_last_tool_status_code == "200"` **or** `== 200`, written as a `bool_op` `or` so it works on both voice and chat.

| from | # | condition | to |
|---|---|---|---|
| `s_open` | 1 | expr `route_hint == "known_incident"` | `s_advisory` |
|  | 2 | expr `route_hint == "unverified"` | `n_verify` |
|  | 3 | default | `n_triage` |
| `s_advisory` | 1 | default | `n_advisory_followup` |
| `n_advisory_followup` | 1 | expr DUR | `t_transfer` |
|  | 2 | llm "The caller confirmed their problem is part of the announced incident and report_affected_site confirmed their site was added." | `n_wrapup` |
|  | 3 | llm "The caller said their problem is different from the announced incident." | `n_collect` |
| `n_verify` | 1 | expr DUR | `t_transfer` |
|  | 2 | llm "The caller has provided both a site ID and a PIN, and both were saved." | `t_verify` |
| `t_verify` | 1 | expr OK | `n_triage` |
|  | 2 | expr `telnyx_last_tool_status_code == "423"` (or `423`) | `s_locked` |
|  | 3 | default | `n_verify` |
| `s_locked` | 1 | default | `t_transfer` |
| `n_triage` | 1 | expr DUR | `t_transfer` |
|  | 2 | llm "The caller is reporting a new outage, fault, or degradation." | `n_collect` |
|  | 3 | llm "The caller is asking about an existing ticket or its status." | `n_status` |
|  | 4 | llm "The caller explicitly asked to speak to a human engineer." | `t_transfer` |
| `n_collect` | 1 | expr DUR | `t_transfer` |
|  | 2 | llm "The caller confirmed the fault summary, agreed to open a ticket, and the details were saved." | `s_one_moment` |
|  | 3 | llm "The caller explicitly asked to speak to a human engineer." | `t_transfer` |
| `s_one_moment` | 1 | default | `t_open_ticket` |
| `t_open_ticket` | 1 | expr OK | `s_confirm` |
|  | 2 | default | `n_ticket_failed` |
| `s_confirm` | 1 | default | `n_wrapup` |
| `n_ticket_failed` | 1 | llm "The caller accepted being connected to an engineer." | `t_transfer` |
|  | 2 | llm "The caller declined to be connected." | `n_wrapup` |
| `n_status` | 1 | expr DUR | `t_transfer` |
|  | 2 | llm "The caller wants to report a new fault." | `n_collect` |
|  | 3 | llm "The caller explicitly asked to speak to a human engineer." | `t_transfer` |
|  | 4 | llm "The caller has their answer and has nothing else to ask." | `n_wrapup` |
| `n_wrapup` | 1 | llm "The caller has another issue to report." | `n_triage` |
|  | 2 | llm "The caller has nothing else and the assistant has said goodbye." | `t_hangup` |
| `t_transfer` | 1 | default (transfer failed) | `n_take_message` |
| `n_take_message` | 1 | llm "The caller's message was taken and they have nothing else." | `n_wrapup` |

**Design rationale** (these are interview points, PB §4):
- Facts route by expression; meaning routes by LLM.
- Speak nodes carry every verbatim sentence: disclosure, advisory, lockout, and a server-rendered read-back.
- Must-happen actions (verify, open ticket, transfer, hang up) are tool nodes routed by status code. May-help lookups are MCP.
- `DUR` edges are declared first on the long nodes (the stretch goal "variable comparison edges").

**Probe-dependent fallbacks:**
- If expression edges on the speak start node are rejected or ignored, the same three routes move to the top of `n_triage`, which becomes the start node, and `s_open` becomes its predecessor.
- If `tools_mode: "replace"` hides MCP tools, nodes keep `STI: null` where MCP is needed. That is already the design.
- If `store_fields_as_variables` values are not interpolated in speak nodes, `s_confirm` becomes a prompt node that is told to read `{{ticket_readback}}` verbatim.

---

## 5. Dynamic Variables webhook (`POST /dv`)

### 5.1 Request handling

1. Read the raw body.
2. Verify Ed25519 over `"{telnyx-timestamp}|{raw_body}"` using `TELNYX_PUBLIC_KEY` (from the secret; memoised per instance). Reject timestamps more than 5 minutes old. A bad signature returns **401**. Everything else returns **200** (fail open).
3. Parse. Dispatch on the presence of `data.payload` (not on `event_type`; PB §1.2). On the first N calls, log `Object.keys` at each level (the conversation-id key is unknown).
4. Compute:
   - `ccid = payload.call_control_id`
   - `ccid_h = sha256(ccid)[:16]`
   - `trace_id = "t-" + ccid_h`
   - `caller = payload.telnyx_end_user_target`, digits only
5. Within an **internal deadline** (§5.5), in parallel:
   - `directory.lookup(digits)`: KV `dir/<digits>` with cache-aside to the ITSM adapter
   - `flags.read()`: KV `flag/*`
   - then `incident = KV incident/active/<contact.region>` (only if `contact` exists and `flag/deflection_enabled != "false"`)
   - then, raced at 400 ms, `SiteActor(contact.site_id).recordCall({ccid_h, trace_id, at})` → `callsToday`, `openTicket`
6. Write the session record `call/<ccid_h>`, TTL 3600: `{trace_id, identified, verified:false, contact_id, customer_id, sites[], region, conv_id?}`. If the payload carries a conversation id, also write `conv/<conv_id>` → `ccid_h`.
7. Respond `{ "dynamic_variables": {…strings…}, "conversation": { "metadata": { "trace_id": "…", "ccid_h": "…" } } }`.
8. Log one `dv.route` line with timings. If `total_ms > timeout - 200`, also log `dv.late`.

### 5.2 `route_hint` (pure function, unit tested)

```
if flag.require_pin == "true"                  -> "unverified"
if no contact for caller digits                -> "unverified"
if incident for contact.region (deflection on) -> "known_incident"
else                                           -> "verified"
```

A known caller ID counts as **identified**, which is enough for the advisory and for per-site MCP reads. `flag/require_pin` exists because caller ID can be spoofed; a production deployment would pair it with STIR/SHAKEN attestation (`telnyx_shaken_stir_attestation`).

### 5.3 Variables returned (all strings), with the declared defaults the platform uses on timeout

| variable | example | default (declared on the assistant) |
|---|---|---|
| `msp_name` | Najd Networks | Najd Networks |
| `route_hint` | known_incident / unverified / verified | **unverified** |
| `caller_name` | Ahmed | there |
| `customer_name` | Al-Waha Pharmacies | your organisation |
| `site_id` | RUH-114 | unknown |
| `site_label` | the Al Yasmin branch | your site |
| `incident_region` | Riyadh North | your area |
| `incident_started` | 1:52 AM | earlier today |
| `incident_summary` | loss of connectivity at 2 branches | a network incident |
| `incident_eta` | 3:30 AM Riyadh time | shortly |
| `open_ticket_note` | There's already an open ticket, N J D 4 8 2 1, for this branch. | none |
| `calls_today` | 2 | 1 |
| `trace_id` | t-9f3a1c… | t-none |
| `oncall_number` | +1… (from secret or env) | the verified on-call number |
| `ticket_id`, `ticket_readback`, `priority` | set later by `open_ticket` | none / "Your ticket has been logged." / unknown |
| `site_id`, `pin`, `symptom`, `impact`, `service_affecting` | set by `capture_details` | unknown / "" / "" / unknown / unknown |

Times are rendered in `Asia/Riyadh`.

### 5.4 Failure design: "the defaults are a production path"

On timeout, cold start or error, the platform applies the defaults. `route_hint=unverified` sends the caller to PIN verification, which works **without** `/dv` because `t_verify` creates the session from the `x-telnyx-call-control-id` header. The worst case is therefore "please tell me your site ID and PIN". That path is secure, functional, and counted (`dv.late`, plus prober latency).

### 5.5 Timeout rule (set from the probe measurement)

- If the measured cold start of `noc-edge` is < 4 s: `timeout_ms = cold_p95 + 1000`, capped at 10000.
- Otherwise: `timeout_ms = 2500`. Warm responses (expected < 300 ms) fit comfortably. Cold calls fail fast to the safe defaults after 2.5 s of silence instead of 10 s. Keep-warm (§11.4) makes cold calls rare.
- The internal deadline is `timeout_ms − 300 ms`. Anything not finished by then is dropped, and the handler responds with what it has.

---

## 6. State model

### 6.1 `SiteActor` (name = site ID, e.g. `RUH-114`)

**Invariant owned:** at most one open ticket per site; PIN brute-force protection per site.

**State (actor storage):**

| key | shape |
|---|---|
| `ticket` | `{id, priority, openedAt, symptom, impact, serviceAffecting, reporters:[{callerRef, ccid_h, at}], notes:[{at, text, ccid_h}]}` or `null` |
| `pin` | `{failures:[ts…], lockedUntil}` |
| `calls` | `{day:"YYYY-MM-DD", count, recent:[{ccid_h, trace_id, at}] (≤10)}` |
| `ops` | idempotency map `opKey → result` (bounded to 50, FIFO) |
| `events` | bounded event log (≤100) `{at, evt, trace_id, …}` |

**Methods** (all public async, no network I/O, all return `{…result, trace_id, actor_ms}`):

| Method | Behaviour |
|---|---|
| `recordCall({ccid_h, trace_id, at})` | Idempotent on `ccid_h`. Returns `{callsToday, openTicket}`. |
| `recordPinAttempt({ccid_h, valid, pinFingerprint, trace_id, at})` | The function checks PIN validity **outside** the actor (adapter lookup) and passes `valid`. If currently locked, returns `locked`. If `valid`, clears failures and returns `ok`. Otherwise appends a failure; **3 failures within 15 min lock the site for 15 min**, returning `locked`, else `invalid` with `attemptsLeft`. A duplicate `(ccid_h, pinFingerprint)` within 30 s is not double-counted. |
| `openOrAttach({ccid_h, trace_id, callerRef, symptom, impact, serviceAffecting, priority, at})` | Idempotent on `ccid_h`. If an open ticket exists, adds the reporter and returns `{created:false}`. Otherwise creates `NJD-####` and returns `{created:true}`. |
| `getTicket()` | Returns the open ticket or `null`. |
| `addNote({ccid_h, trace_id, ticketId, note, at})` | Idempotent on `(ccid_h, hash(note))`. Fails if `ticketId` does not match the open ticket. |
| `resolveTicket({trace_id})` | Ops |
| `reset()` | Ops/demo; clears state |

### 6.2 `RegionActor` (name = region, e.g. `riyadh-north`)

**Invariant owned:** at most one active incident per region; deterministic declaration and upgrade thresholds.

**State:**

| key | shape |
|---|---|
| `reports` | `{siteId: {ticketId, at}}` (rolling 60-min window) |
| `incident` | `{id:"INC-####", declaredAt, priority:"P2"\|"P1", sites:{siteId:{ticketId, at}}, nextUpdateAt, ackAt:null, escalationLevel:0}` or `null` |
| `events` | bounded event log |

**Methods:**

| Method | Behaviour |
|---|---|
| `reportSite({siteId, ticketId, trace_id, at})` | Idempotent per `siteId`. Adds to `reports` and computes the distinct sites in the window. **No incident and ≥ 2 sites:** declare an incident at P2 (`declared:true`). **Incident open and ≥ 3 sites while P2:** upgrade to P1 (`upgraded:true`). Returns `{incident, declared, upgraded, siteCount}`. |
| `getIncident()` | Returns the active incident or `null`. |
| `resolve({trace_id})` | Ops; clears the incident. |
| `ack({by, trace_id})` | Stretch (§12.1) |
| `alarm(info)` | Stretch (§12.1) |
| `reset()` | Ops/demo |

**Why region-keyed, not incident-keyed:** two first reports arriving at the same moment would each see "no incident" in KV and create two incidents. The region owns the "one active incident" invariant, so both reports serialise through `RegionActor(region)`.

### 6.3 KV namespace `noc-kv`

The function writes all keys; actors never touch KV (PB §1.5). Keys are sanitised so that `+` and `:` never appear.

| key | value | TTL | role |
|---|---|---|---|
| `dir/<digits>` | contact `{contact_id, name, customer_id, customer_name, site_id, site_label, region, region_label}` | 300 s | cache-aside over the ITSM adapter |
| `incident/active/<region>` | `{id, region_label, started_local, summary, eta_local, priority, site_count}` | 7200 s | **read projection** of `RegionActor`. Written by the function **after** `reportSite` commits; deleted on resolve. |
| `call/<ccid_h>` | session `{trace_id, identified, verified, contact_id, customer_id, sites[], region, conv_id?}` | 3600 s | caller session across webhooks and MCP |
| `conv/<conv_id>` | `ccid_h` | 3600 s | MCP → session join |
| `flag/deflection_enabled` | `"true"`/`"false"` (default true) | none | route known-incident callers to the advisory |
| `flag/require_pin` | `"true"`/`"false"` (default false) | none | force PIN for everyone |
| `flag/fault/open_ticket` | `"503"` or absent | none | **fault injection** for negative-path tests and the demo |
| `flag/fault/dv_delay_ms` | number or absent | none | **fault injection**: slow `/dv` to exercise the defaults path |
| `ops/heartbeat` | `{at, ok, checks}` | none | canary result |

Flags are read on every request with no memoisation longer than 5 s, so a flip takes effect "near-real-time" (PB §1.5). They are flipped with `telnyx-edge storage kv key put <ns> flag/… <v>`.

### 6.4 Services (the function layer that owns I/O and orchestration)

- **`tickets.open(ctx, input)`**
  1. `severity.classify(impact, serviceAffecting)`, a pure ITIL matrix (§9).
  2. `SiteActor(site).openOrAttach(...)`
  3. If created: `RegionActor(region).reportSite(...)`. If the incident was declared or upgraded, write the KV projection.
  4. `readback.render(...)`
  5. Return the result plus timings.

  A failure after step 2 leaves the ticket open and the region unreported. That is logged (`incidents.report_failed`) and retried on the next call's `openOrAttach` path (idempotent). There are **no cross-actor transactions** (C6).
- **`sessions`**: get/put `call/<ccid_h>`; resolve `conv_id → ccid_h` via KV first, then the Conversations API (`GET /v2/ai/conversations/{id}` → `metadata.call_control_id`) through the `[telnyx]` binding, then cache.
- **`directory`**: cache-aside lookups.

---

## 7. Tool webhooks (shared tools, `type: webhook`)

All requests carry Telnyx signature headers (verified) and `x-telnyx-call-control-id`, from which `ccid_h` is derived. `headers: [{name:"X-Trace-Id", value:"{{trace_id}}"}]` is configured on each tool.

### 7.1 `verify_site` → `POST /tools/verify-site`

- **Body (from variables):** `{site_id, pin}`.
- **Logic:**
  1. Normalise `site_id` (`RUH114`, `ruh 114` → `RUH-114`).
  2. `valid = adapter.checkPin(site_id, pin)` (constant-time hash compare).
  3. `SiteActor.recordPinAttempt(...)`
  4. If `ok`, update the session: `verified = true`, `sites = [site_id]`, plus customer and contact.
- **Responses:**

  | Status | Body | Meaning |
  |---|---|---|
  | **200** | `{verified:"true", site_id, site_label, customer_name, caller_note}` | Verified. `store_fields_as_variables` sets `site_id`, `site_label`, `customer_name`. |
  | **401** | `{verified:"false", attempts_left:"2"}` | Wrong PIN |
  | **423** | `{locked:"true"}` | Site locked |
  | **422** | | Missing fields |

- A PIN is never logged; only `pinFingerprint = sha256(ccid_h + pin)[:8]` is used, for dedupe.
- `timeout_ms: 5000`.

### 7.2 `open_ticket` → `POST /tools/open-ticket`

- **Body (from variables):** `{site_id, symptom, impact, service_affecting}`.
- **Authorisation:** the session must be identified or verified, and `site_id` must be in `session.sites` (or belong to the contact's customer). Otherwise **403**.
- **Fault injection:** if `flag/fault/open_ticket` is set, return that status.
- **200 body:**

  ```json
  {"ticket_id":"NJD-4821","priority":"P2","created":"true",
   "ticket_readback":"Your ticket number is N J D, 4 8 2 1. Priority 2. An engineer will respond by 3:15 AM Riyadh time.",
   "incident_note":"This is now part of incident I N C 7 7 0 2 affecting Riyadh North."}
  ```

  `store_fields_as_variables` sets `ticket_id`, `ticket_readback`, `priority`.
- When `created=false`, the read-back says "…there's already an open ticket for this branch: N J D, 4 8 2 1, opened 12 minutes ago. I've added you to it."
- `timeout_ms: 8000`.
- `messages`: none; `s_one_moment` covers the wait.

### 7.3 Other shared tools

| Tool | Definition |
|---|---|
| `capture_details` | `update_dynamic_variables` with `updatable_variables`: `site_id`, `pin`, `symptom`, `impact`, `service_affecting` (typed, described) |
| `transfer_oncall` | `transfer`: `targets:[{name:"On-call engineer", to:"{{oncall_number}}"}]`, `from`: the assistant's number. Creation via `POST /v2/ai/tools` is unverified; the fallback is the Portal. |
| `end_call` | `hangup` |

---

## 8. MCP server (`POST /mcp`)

### 8.1 Transport

- `@modelcontextprotocol/sdk` 1.x, `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`.
- A **new server and transport per request**.
- `GET`/`DELETE` → 405.
- Notifications → 202.
- Never answer HTTP 404 for an unknown method; return 200 with JSON-RPC `-32601`.
- **Wire shim** (logs first, then normalises):
  - log method and headers (minus auth), and body keys
  - set `Accept: application/json, text/event-stream`
  - strip `params._meta.progressToken === null`
- Bearer auth, compared in constant time.
- Registered in Telnyx as MCP server `noc-mcp` (`type:"http"`) with a `bearer` integration secret.

### 8.2 Identity and authorisation (enforced below the model)

1. Each tool handler reads `extra._meta.telnyx_conversation_id` (platform-set, not model-controllable).
2. `sessions.byConversation(conv_id)` → session.
3. If there is no session (for example the join failed), the tool returns the spoken text "I need to verify your site before I can look that up."
4. **Any `site_id` or `ticket_id` argument must belong to the session's customer and sites. Otherwise the tool refuses.** This is logged as `auth.denied` and counted.

Callers from other clients (OpenCode, curl) with no `_meta` get **ops scope** only when they present `OPS_TOKEN` in addition to the bearer. This lets the coding agent inspect state.

### 8.3 Tools (zod-validated inputs)

Each tool returns `content:[{type:"text", text:<one speakable sentence, then key facts>}]` plus `structuredContent`.

| tool | input | behaviour | example spoken summary |
|---|---|---|---|
| `get_site_status` | `{site_id}` | adapter NMS view: link state, last seen, active alarms, device | "The edge router at the Al Yasmin branch stopped responding at 1:52 AM; the backup LTE link is also down." |
| `check_known_incidents` | `{site_id?}` (default: session site) | `RegionActor.getIncident()` for the site's region | "There is an active P2 incident in Riyadh North affecting 2 branches since 1:52 AM." / "No known incidents in your area." |
| `get_ticket_status` | `{ticket_id?}` (default: the session site's open ticket) | `SiteActor.getTicket()` | "Ticket N J D 4 8 2 1 is priority 2, opened 1:58 AM, engineer response due by 2:28 AM." |
| `add_ticket_note` | `{ticket_id, note}` (≤ 300 chars) | `SiteActor.addNote()` | "I've added your update to ticket N J D 4 8 2 1." |
| `report_affected_site` | `{site_id?}` | `tickets.open(...)` with impact from the incident context → `RegionActor.reportSite` → projection update | "I've added the Al Yasmin branch to incident I N C 7 7 0 2. It now affects 3 branches and has been raised to priority 1." |

Descriptions state **when** to call each tool ("Call only after the caller has confirmed which site…"). STT normalisation of IDs happens server-side.

### 8.4 Per-node scoping

MCP tools are allow-listed per assistant. The platform has no per-node MCP list (C8), so the platform finding goes in the README. Scoping is layered:

1. Assistant `allowed_tools` (5 tools).
2. MCP only reachable from nodes with `STI: null`.
3. Node instructions name the only MCP tool(s) for that step.
4. The server-side authorisation above.

---

## 9. Seed data (`adapters/itsm/seed.ts`): the integration seam

- `ItsmAdapter` interface: `findContactByPhone`, `getSite`, `checkPin`, `getNmsStatus`, `listSites`, `getOnCall`.
- Seed contents:
  - **Customer:** Al-Waha Pharmacies.
  - **8 sites across 4 regions:**
    - `riyadh-north`: RUH-114 Al Yasmin, RUH-121 Al Malqa, RUH-133 Hittin
    - `riyadh-south`: RUH-207
    - `jeddah`: JED-007, JED-015
    - `dammam`: DMM-003, DMM-011
  - Site PINs, stored as hashes. Demo PINs are documented in the README.
  - **NMS states:** RUH-114 and RUH-121 `down` from 01:52 (the scenario); the others `up`.
  - **Contacts:** 3 fictional plus Fahad's demo phones, loaded from a **gitignored** `seed.local.json` (phone numbers are PII).
  - The on-call number comes from a secret.
- **Severity matrix** (`services/severity.ts`, modelled on ITIL and published KSA wholesale SLAs):

  | impact | service affecting = yes | service affecting = no |
  |---|---|---|
  | `site_down` | **P2** | P2 |
  | `degraded` | P3 | P4 |
  | `single_user` | P4 | P4 |

  A regional incident at ≥ 3 sites is **P1**. Response targets: P1 15 min, P2 30 min, P3 4 h, P4 next business day.

In production this adapter is ServiceNow, Jira SM or the customer's NMS. Discovery on day 2 of a real engagement fills it in.

---

## 10. Security

- **`/dv` and `/tools/*`:** Ed25519 verification with timestamp skew ≤ 5 min.
- **`/mcp`:** bearer token; OpenCode additionally presents `OPS_TOKEN` for ops scope.
- **`/ops` mutations and `/diag`:** `OPS_TOKEN`.
- **Secrets:** all secrets live in `telnyx-edge secrets`, never in the repo. `.gitignore` covers `.env*`, `seed.local.json`, and OpenCode `config.json` (the plugin writes API keys there; PB §6).
- **Identity:** caller identity comes only from platform data (`telnyx_end_user_target`, `x-telnyx-call-control-id`, `_meta.telnyx_conversation_id`). LLM-supplied IDs are **authorised against the session**.
- **PII:**
  - MSISDNs are masked in logs (`+1312****309`).
  - PINs are hashed and never logged.
  - The recording disclosure is delivered verbatim.
  - Production residency (not in the POC) is discussed in `docs/sovereignty.md`: +966 number, Dubai anchorsite, Middle East data locality, UAE strict inference. PDPL Art. 29 transfer assessment applies because this is GCC residency, not in-Kingdom (PB §9.13).
- **Fault-injection flags** are gated to `OPS_TOKEN` writes via the CLI, and are documented as demo-only.

---

## 11. Observability

### 11.1 Structured logs

`lib/log.ts` emits **one JSON line per event**:

```
{ts, lvl, svc:"noc-edge", hop:"dv|tool|mcp|actor|kv|ops|canary", evt, trace_id, conv_id?, ccid_h?,
 caller?(masked), site?, region?, route_hint?, tool?, status?, kv_ms?, actor_ms?, upstream_ms?, total_ms, outcome:"ok|fallback|denied|error", err?}
```

**Events:** `dv.request`, `dv.route`, `dv.late`, `dv.sig_fail`, `tool.verify`, `tool.open_ticket`, `mcp.request`, `mcp.tool`, `auth.denied`, `actor.call`, `kv.op`, `incident.declared`, `incident.upgraded`, `incidents.report_failed`, `canary.check`, `error`.

### 11.2 Trace

`trace_id` is derived at every hop from `ccid`, via `/dv`, the `x-telnyx-call-control-id` header, or the MCP session join:

- `/dv` returns it as a variable and in conversation metadata.
- The tools also receive it in the `X-Trace-Id` header.
- Actors get it as an argument and echo it in their event logs and return values.
- MCP recovers it via `conv/<id>`.

`scripts/trace.sh <trace_id>` runs `telnyx-edge logs noc-edge --since 1h --json` and prints the hop-ordered path with the ms for each hop.

### 11.3 Signals beyond logs

1. The per-request trace with hop timings.
2. Latency fields, plus native `telnyx-edge metrics` (p50/p95/p99, 5xx).
3. `dv.late` counts, which mean the platform used the defaults.
4. The synthetic canary.

### 11.4 Canary and keep-warm

- **`scripts/prober.ts` (external; runs on the dev box, outside the failure domain):**
  - Every 30 s: `GET /health/deep`, recording latency and the result.
  - After 2 consecutive failures: alert via a Telnyx SMS to the verified number (tier permitting). Otherwise an OS notification plus a log.
  - The same loop keeps the function and actor runtime **warm**.
- `/health/deep` writes `ops/heartbeat`.
- `/ops/status` shows green if the heartbeat is under 90 s old and ok, red otherwise.
- **Stretch (§12.1):** an actor-alarm dead-man's switch.

### 11.5 README "know within a minute" answer

1. **Detect:** prober alert, or `metrics --errors` 5xx, or `dv.late`.
2. **Look first:** `telnyx-edge logs noc-edge --tail --type invocations`.
3. **Then:** runtime logs filtered by `trace_id`.
4. **Then:** the Portal conversation (node labels, Dynamic Variable Webhook Logs tab).
5. **Then:** `telnyx-edge actors instances SiteActor`.

### 11.6 Evidence artifacts

- `DEBUGLOG.md`: every real bug as symptom → signal → log lines → hypothesis → fix → verification.
- `DOGFOODING.md`: OpenCode + Telnyx inference notes, including the model bake-off numbers.

---

## 12. Stretch designs (target: built Monday)

### 12.1 Alarms: SLA acknowledgement escalation (`RegionActor`)

- **On declare or upgrade:** `setAlarm(now + ackWindow)`. The ack window is P1 2 min and P2 5 min for the demo; production values are configurable.
- **`alarm()`:**
  - If `ackAt` is null: `escalationLevel++`, record an `escalated` event with the level, and re-arm until the max level (3).
  - Idempotent per level; one alarm per instance.
  - Paging is recorded in actor state and surfaced on the dashboard. An SMS to the on-call is sent by the **function** when the dashboard or prober polls pending pages. Actors do no I/O (C6).
- **Ack:** `POST /ops/ack` or the dashboard button.
- **Fallback if prod alarms don't fire (probe):** a prober-driven `tick()` RPC.

### 12.2 Shared actors: `noc-console`

A second `telnyx.toml` function that declares `[[actors]]` with the **same types** (`SiteActor`, `RegionActor`) under its own bindings, and ships **no class**. It is a reference binder, shipped after `noc-edge`.

It serves the ops dashboard, **off the call path**:
- an HTML page with incidents, tickets, SLA clocks, recent calls with trace ids, and heartbeat
- ack / resolve / reset actions

Proof: `telnyx-edge actors inspect SiteActor` lists both functions as binders.

### 12.3 Object storage: incident reports

On resolve, the function writes `incidents/<INC-id>.json` to the Telnyx Cloud Storage bucket `noc-reports-<suffix>` via the `[storage.cloudstorage.REPORTS]` binding. The report contains the timeline from the actor event logs, the sites, tickets, trace ids, and time to acknowledge. The dashboard links a presigned URL minted via `POST /v2/storage/buckets/{bucket}/{object}/presigned_url` (never the AWS SDK).

### 12.4 Multi-assistant: Arabic specialist

- A second assistant, **"Sanad - Arabic"**:
  - STT: `humain/realtime`, `language:"codeswitch"`
  - Voice: `Telnyx.Bayan.<Saudi speaker>`
  - Arabic instructions
  - The same MCP server and tools
  - Its own compact workflow: triage → collect → open ticket → confirm.
- **Routing:** an LLM edge on `n_triage` ("The caller prefers to continue in Arabic") → `target:{type:"assistant", voice_mode:"distinct"}`.
- **Requires Paid or higher** (C1). Fallback on Trial: an `n_arabic` prompt node with node-level `transcription` and `voice_settings` overrides. That is labelled "Arabic mode" and is not claimed as multi-assistant.

---

## 13. Testing

### 13.1 Automated tests (vitest)

- **Pure logic, TDD:**
  - Ed25519 verification (RFC 8032 test vectors plus a Telnyx-shaped fixture)
  - `route_hint`
  - severity matrix
  - read-back rendering
  - ID normalisation
  - masking
  - KV key sanitising
  - `trace_id`
- **Actor logic:** against an in-memory `ActorStorage` fake. Covers idempotency, lockout timing, declaration and upgrade thresholds, and window expiry.
- **MCP:** an SDK `Client` against the in-process handler. Covers `initialize`, `tools/list`, each tool, auth denial, and the null-progressToken shim.
- **Config:** `assistant/validate.ts` checks graph integrity:
  - unique ids
  - every edge endpoint exists
  - speak and tool nodes have exactly one default edge (hangup: none)
  - every `{{var}}` is declared
  - every prompt node sets `IM` and `TM`

### 13.2 Path test matrix (each run on a real or web call; evidence = Portal node labels plus trace)

| # | Scenario | Expected path / result |
|---|---|---|
| P1 | Known caller, no incident, new fault | s_open → n_triage → n_collect (get_site_status) → t_open_ticket 200 → s_confirm → n_wrapup → t_hangup; ticket P2 |
| P2 | A second call about the same site | open_ticket returns `created=false`; the read-back says the caller was added to the existing ticket |
| P3 | A fault at a 2nd site in the same region | RegionActor declares INC at P2; KV projection written |
| P4 | Known caller in a region with an active incident | s_open → **s_advisory** (expression edge) → n_advisory_followup → report_affected_site → 3 sites → **P1** |
| P5 | Advisory, but a different problem | → n_collect |
| P6 | Unknown number, correct PIN | → n_verify → t_verify 200 → n_triage |
| P7 | Wrong PIN, then correct | t_verify 401 → n_verify → t_verify 200 |
| P8 | 3 wrong PINs | t_verify 423 → s_locked → t_transfer |
| P9 | Ticket status plus a note | n_triage → n_status (get_ticket_status, add_ticket_note) |
| P10 | Asks for a human | → t_transfer. A transfer failure goes to n_take_message. |
| P11 | Ticket system down (`flag/fault/open_ticket=503`) | t_open_ticket default → n_ticket_failed |
| P12 | `/dv` slow or down (`flag/fault/dv_delay_ms` > timeout) | defaults → n_verify path works; `dv.late` logged |
| P13 | Call lasts ≥ 300 s | DUR edge → t_transfer |
| P14 | `flag/deflection_enabled=false` during an incident | no advisory → n_triage (a KV flag toggles the path, no redeploy) |
| P15 | Tenant isolation: ask for another customer's site | MCP refuses; `auth.denied` logged |
| P16 | Arabic caller (stretch) | → the Arabic specialist assistant |

### 13.3 Race test (`scripts/race-test.ts`)

Fire 20 concurrent open-ticket calls for the same site at (a) `/tools/open-ticket` (actor path) and (b) `/diag/race` (naive KV get-then-put).

**Expected:** (a) exactly 1 ticket; (b) more than 1 ticket.

The output is committed to `docs/evidence/race-test.txt`. This is the demo slide for "why an actor and not KV".

### 13.4 Assistant tests

Where DV is not required, use Telnyx AI Tests (`POST /v2/ai/assistants/tests`, rubric) for regression. Tool webhooks are tested with `POST /v2/ai/assistants/{id}/tools/{tool_id}/test`.

---

## 14. Build process (requirement 6)

**Integrity line:** every shipped artifact (code, config, tests, scripts, README, DEMO) is authored through **OpenCode + `@telnyx/opencode` on a Telnyx-hosted model**. Claude writes this spec, the plans and the task prompts, and reviews. Claude does not hand-edit product code. The split is disclosed in the README and in the interview.

- **Setup:**
  - OpenCode installed for linux-arm64.
  - `opencode plugin @telnyx/opencode`.
  - `opencode auth login --provider telnyx --method "API Key"`.
  - `~/.config/opencode/telnyx-models.json` enables `moonshotai/Kimi-K3`, `zai-org/GLM-5.3`, `zai-org/GLM-5.3-Flash`, …
  - The repo-root `opencode.jsonc` has the plugin pinned, `model`/`small_model` set, permissions, and the `noc-mcp` MCP entry.
  - `AGENTS.md` holds the standing rules (C1–C12, TDD, the logging schema, no I/O in actors, string-only DV values).
- **Model bake-off:** the same task (the Ed25519 verifier plus tests) on Kimi-K3 and on GLM-5.3. Record correctness, wall time and tokens in `DOGFOODING.md`, and pick the winner.
- **Headless loop:**

  ```bash
  opencode run --model telnyx/<model> --format json --auto "<task prompt>" | tee .opencode-runs/<ts>-<task>.jsonl
  ```

  Then review the diff, run the tests, and follow up with `--continue`. Independent tasks run in **parallel git worktrees**.
- **Config as code:** `assistant/*.json`, `assistant/apply.ts` (creates or updates shared tools, the MCP server and the assistant; then GETs them back and **diffs**), and `assistant/validate.ts`.
- **Evidence kept:** `.opencode-runs/*.jsonl`, `opencode stats`, the committed `opencode.jsonc`.

---

## 15. Phasing and schedule

| When | Phase | Exit criteria |
|---|---|---|
| **Sat 26** | **0: Setup + probe.** (1) Number/tier check → email Telnyx Team with evidence if needed. (2) API key, OpenCode, models, bake-off. (3) Edge CLI auth, KV namespace, secrets. (4) Ship `noc-probe` to measure cold start, find the KV env, test prod alarms and actor log visibility, capture the DV payload keys and the MCP client wire format, test whether `replace` hides MCP, and test speak-node expression edges and variable typing. | Every probe item answered with evidence in DEBUGLOG.md; §4/§5.5 fallbacks resolved |
| **Sat–Sun** | **1: Core.** lib → adapter + seed → actors → services → `/dv` → `/tools/*` → `/mcp` → `/ops` + health → assistant config-as-code → deploy | Unit tests green; the race test passes; P1–P15 pass |
| **Sun** | **2: Harden.** Prober/keep-warm, trace.sh, `/ops/status`, README draft, architecture diagram | **Core checkpoint (Sun night):** Fahad signs off on core |
| **Mon 28** | **3: Stretch, in parallel worktrees:** §12.1 alarms · §12.2 noc-console · §12.3 storage · §12.4 Arabic assistant. README/DEMO final. | All stretch goals demoable; P16 passes |
| **Tue 29** | **4: Test + rehearse.** Full matrix re-run, failure drills, demo rehearsal ×2, mock panel Q&A | Demo within 10 min; answers rehearsed |
| **Wed 30** | **5: Submit.** Repo access for reviewers, URLs, number, `opencode.jsonc`, demo script | Submitted |

**Cut order if behind** (core is never cut): Arabic assistant → object storage → noc-console (keep `/ops/status`) → alarms.

**External risks:**

| Risk | Response |
|---|---|
| No dialable number | Email Telnyx Team Sat with probe evidence; web-call fallback |
| Prod alarms don't fire | Prober `tick()` |
| Kimi-K3 underperforms | Switch to the bake-off runner-up |
| Actor ingress 404 (issue #12) | Escalate with evidence |

---

## 16. Deliverables (brief "Submission Requirements")

- Private GitHub repo with reviewer access.
- Live URLs: `noc-edge` (`/dv`, `/mcp`, `/ops/status`) and `noc-console`.
- The phone number (and a web-call link if needed), with demo site IDs and PINs in the README.
- README: setup, architecture diagram, how to call, observability and debugging story, primitive-choice rationale, platform findings (including the brief errors found), and the build-split disclosure.
- `DEMO.md`: the 8–10 min script (the two-phone scenario, KV flag flip, trace, race-test slide, failure drill).
- `opencode.jsonc`, `DOGFOODING.md`, `DEBUGLOG.md`.

---

## 17. Open questions (resolved by the probe; each has a fallback above)

1. Can expression edges fire on the speak start node, and are variables compared as strings or numbers? (§4 fallback)
2. Does `tools_mode:"replace"` hide MCP tools? (§8.4)
3. Are `store_fields_as_variables` values interpolated in later speak nodes? (§4 fallback)
4. Which key carries the conversation id in the DV payload, and is `call_control_id` present for web calls? (§6.4 join)
5. What is the cold-start time of `noc-edge`? (§5.5)
6. Do actor alarms fire in prod, and do actor `console.log` lines reach the logs? (§12.1 fallback)
7. Can transfer and hangup shared tools be created via the API? (§7.3 fallback: Portal)
8. Which numbers can be ordered on Trial, and can non-verified phones call in? (C1)
