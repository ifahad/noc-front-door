# Key decisions — NOC Front Door

The ~60 build rulings live in the gitignored `.superpowers/` SDD ledgers; this file publishes the ones a reviewer is likely to probe, with the alternatives we weighed, the reasoning, and what it would have cost to be wrong. Ruling ids: `R*` (plan 1), `P2-R*` (plan 2), `P3-R*` (plan 3) — from the ledgers; platform constraints `C*` from the spec.

## Decision table

| # | Decision | Alternatives considered | Why | Cost if wrong | Ruling |
|---|---|---|---|---|---|
| 1 | **Mux host**: the same `SiteState`/`RegionState` classes multiplexed inside the one working actor instance (`Counter/demo`), behind one `ActorPort` seam | Wait for the platform fix; drop actors from the demo | DEBUGLOG #4 — no new actor instance could activate on this Trial account (fresh ids 502, stock scaffold too). Mux keeps tickets/PIN/incidents live with zero business-logic change; per-entity stays the default behind `flag/actor_mode` | ~1 task of effort; the per-entity path stayed untouched. Accepted risk: one sick instance takes every entity down (DEBUGLOG #15) | R16; DEBUGLOG #4 |
| 2 | **Actors own the invariants; KV never does** (one ticket per site, PIN tiers, P2→P1) | Counters in KV; external DB | KV is last-write-wins with no compare-and-swap (C5); actor turns are single-threaded and commit atomically (C6). Live race: 10 concurrent opens → **1 ticket** in actor mode, 10 duplicates in KV ([race-test.txt](evidence/race-test.txt)) | Duplicate tickets / lost PIN locks — the product promise breaks | spec §6; C5+C6 |
| 3 | **Facts route by expression; meaning routes by LLM** (19 expression / 26 llm / 15 default edges, EN) | LLM everywhere; expressions everywhere | `telnyx_last_tool_status_code`, `duration>=300` and `route_hint` exits must be deterministic; intent (triage, human request, Arabic request) cannot be enumerated. Spec §4.4 | A mis-set edge strands a caller or sends them the wrong way — see #7 for the live example | spec §4.4; P3-R10 |
| 4 | **`instructions_mode`/`tools_mode` per node**: EN prompt nodes `append`; AR prompt nodes `replace` with restated safety rules | One mode for all nodes | EN nodes add context on top of the base persona (append). Arabic runs in its own assistant whose base instructions are Arabic-only; carried English history must not steer it, so each AR prompt node restates the rules and `replace` is correct | One DRIFT line on read-back if the API ever strips modes (R19); a missing restated rule would let English history leak into Arabic replies (call #7a) | R19; P3-R2 |
| 5 | **Mandatory actions are tool nodes** (transfer, end_call), never an LLM tool call in the same turn as a spoken line | Prompt node speaks, LLM calls the tool | Probe P0-3f found Kimi-K2.6 unreliable at "say, then call the tool"; `flow-validate.mjs` now enforces it on every apply | One extra caller turn before transfer/hangup | P2-R6, P2-R10 |
| 6 | **One-way English → Arabic handoff** (no AR→EN edges) | Two-way handoff | An assistant-target back to `sanad-noc` restarts at `s_open`, whose `route_hint=="arabic"` edge would bounce the caller straight back — a loop | A caller who switches to Arabic stays in Arabic for the rest of the call (documented) | P3-R2 |
| 7 | **Handoff fires on an explicit request only** | LLM edge "asks for Arabic **or just spoke in Arabic**" | Call #7a: the LLM edge matched *"…the site is gonna be r u h one one four"* ("ruh" is an Arabic word) and handed a spelled site ID off mid-sentence. The condition now says site IDs are spelled letters (RUH/JED/DMM) and requires an explicit Arabic request | A caller who merely sounds Arabic no longer triggers the switch; they must ask | P3-R10 |
| 8 | **Arabic fixed lines are speak nodes** (`s_ar_handover`, `s_ar_verify_unavailable`, `s_ar_goodbye`) | Prompt node speaks the line, LLM edge routes | Speak delivers verbatim and the default edge guarantees the tool call; on #7a the prompt-node handover **hallucinated "Your identity is verified"** and called a non-existent tool | None (a tool node follows deterministically) | P3-R10 |
| 9 | **Arabic gets MCP tools** via a second registration `noc-mcp-ar` → `${EDGE_URL}/mcp?lang=ar` | Keep the Arabic assistant MCP-free (P3-4a removed them) | The server renders spoken results in Saudi Arabic for `lang=ar`; server-side guards (NEED_VERIFY, own-site checks) already make misuse harmless; product decision (P3-R13). Arabic prompt rule: lookups only after verification | Arabic nodes can reach MCP (it ignores `tools_mode` anyway) — mitigated server-side | P3-R13 |
| 10 | **KV-free voice path: the site actor is the PIN authority** (`openIfVerified` reads the actor's own per-call PIN record; every KV wait on the tool path bounded behind a `deadline()`) | Bounded KV only; stateless HMAC auth token carried in dynamic variables | Call #8: the actor accepted the PIN in 430 ms but `verify_site` waited on failing KV and timed out. The actor already holds the per-call record, so auth + one-ticket-per-site are **atomic in one actor turn**; KV auth becomes a best-effort cache (2500 ms budgets, 250 ms router flags budget, bounded retry for identified callers) | Phone-identified callers (no PIN) get a bounded retry then a 403 → re-verify while KV is slow; MCP session tools still fall back without KV | P3-R11/R12 + red-team rulings R-A…R-E; DEBUGLOG #19 |
| 11 | **MCP runs in-process in `noc-edge`** | Separate function/host | A module boundary, not a deployment boundary (spec §8): a second edge function adds a second cold start (13–14 s measured) for zero isolation benefit; C4 semantics preserved — a fresh server + transport per request, POST-only, GET → 405 | MCP shares the edge function's latency domain; public URL unchanged | spec §8 |
| 12 | **Presigned URLs rejected for reports** | Presign GETs for reviewers | Presigning needs an API key inside the function; reports are read via ops-token routes and the board's `last_report` pointer, written only after a successful put | Reviewers need the ops token to read a report (acceptable; the presenter shows it) | P2-R12 |
| 13 | **Health: a hang = down** (`actor_hung`), board cached 30 s from settle, flag-read cooldown, page polling pauses idle | Keep "slow is not down" everywhere | The 09-28 incident's dominant failure mode (30 s hangs) was counted healthy for ~5.5 h; the board was 68% of actor traffic with a 67% cache miss; the flags memo filled only on success | Outage-time load stays higher than ideal; nothing on the happy path | P3-R7; DEBUGLOG #15 |
| 14 | **The 150 ms secret-cap regression → revert** (`a94722c`); retries keep no per-attempt cap | Keep the reviewer-suggested per-attempt timeout | Ruling P3-R6 adopted a 150 ms per-attempt cap on `SECRETS.get` without measuring it — the call takes >150 ms on this platform, so every secret read failed and signed routes + MCP auth **failed closed for ~1 h**. Fix: retry on error/empty (3 attempts, 50/100 ms), in-flight sharing, no per-attempt cap | The regression itself was the ~1 h outage window (DEBUGLOG #17) | P3-R6 → `a94722c` |
| 15 | **Fail-closed auth, uniform 403s** (unproven `join_incident` / `open_ticket` → 403, never a distinguishing 422; proof window = PIN window) | Softer 422s that reveal site existence | Signed routes must never fail open (C13); an unproven caller must not learn whether a site exists; compare tokens in constant time | Slightly less specific errors; no security loss | R13 (plan 1); P3-R15 |

## Per-node tool matrix

Tools reach a node two ways: **shared tools** via `shared_tool_ids` + `tools_mode` (explicit on every prompt node, C7) and **MCP tools** via the assistant's `mcp_servers`. **MCP ignores a node's `tools_mode`** — proven live on call #6 when `add_ticket_note` ran on `n_ar_intake` (DEBUGLOG #18) — so prompt-node *instructions* also say when not to look things up, and the server enforces the real authz (session scope resolves the caller's session; unverified callers get NEED_VERIFY; cross-site reads are denied server-side).

`sanad-noc` (English) — assistant-level `tool_ids: [capture_details]`; MCP `noc-mcp` (5 tools):

| Node | Type | Shared tools | MCP (5 tools) |
|---|---|---|---|
| `s_open`, `s_advisory`, `s_join`, `s_pin_retry`, `s_locked`, `s_verify_unavailable`, `s_one_moment`, `s_confirm`, `s_goodbye`, `s_handover` | speak | — (speak nodes carry none) | — |
| `n_advisory_followup` | prompt | `[]` / replace | reachable (by design) |
| `n_verify` | prompt | `[capture_details]` / replace — "You do not need find_site here" | reachable |
| `n_triage`, `n_collect`, `n_status` | prompt | inherit `[capture_details]` / append — `n_collect` also calls `find_site`/`get_site_status`; `n_status` calls `get_ticket_status` by default | reachable |
| `n_ticket_failed`, `n_wrapup` | prompt | `[]` / replace | reachable |
| `n_take_message` | prompt | `[capture_details]` / replace | reachable |
| `t_verify`, `t_open_ticket`, `t_join_incident`, `t_callback`, `t_transfer`, `t_hangup` | tool | one each: `verify_site`, `open_ticket`, `join_incident`, `log_callback`, `transfer_oncall`, `end_call` | n/a |

`sanad-noc-ar` (Arabic) — assistant-level `tool_ids: [capture_details]`; MCP `noc-mcp-ar` → `/mcp?lang=ar` (P3-R13):

| Node | Type | Shared tools | MCP (5 tools, Arabic replies) |
|---|---|---|---|
| `s_ar_open`, `s_ar_verify_unavailable`, `s_ar_handover`, `s_ar_goodbye` | speak | — | — |
| `n_ar_intake`, `n_ar_pin_retry`, `n_ar_take_message` | prompt | `[capture_details]` / replace | reachable |
| `n_ar_advisory`, `n_ar_confirm` | prompt | `[]` / replace | reachable |
| `n_ar_triage` | prompt | inherit `[capture_details]` / append | reachable |
| `t_ar_verify`, `t_ar_open_ticket`, `t_ar_join`, `t_ar_callback`, `t_ar_transfer`, `t_ar_hangup` | tool | one each: `verify_site`, `open_ticket`, `join_incident`, `log_callback`, `transfer_oncall`, `end_call` | n/a |

## State → primitive

| State | Primitive | Writer | Why this primitive |
|---|---|---|---|
| Per-site PIN attempts + per-call/per-site locks, one-ticket-per-site, dedupe cache, per-call verification proof | **Stateful Actor** `SiteState` (per site) | the actor alone | Read-modify-write over shared state needs a lock; a serialized actor turn *is* the lock (C6), and the KV-free path keeps auth + ticket-write atomic |
| Regional incident (P2→P1 at 3 sites), escalation ladder, page minting | **Stateful Actor** `RegionState` (per region) | the actor alone | Same; plus actor alarms schedule the SLA ladder with no external scheduler |
| Sessions (`call/<k>/dv`, `call/<k>/auth`, `conv/<id>`), incident projection, feature flags (`flag/*`) | **KV** `noc-kv` | edge, one writer per key (spec §6.3) | TTL'd, best-effort cache/config; the prober re-syncs the projection from actor truth — never an invariant lives here (C5) |
| Resolved-incident report JSON | **Cloud Storage** bucket `noc-reports-fb8131` | edge, on resolve | A durable artifact that should outlive actor/KV state; read via ops-token routes + the board's `last_report` pointer |
| Operator-console ops token | **Page `sessionStorage`** | the browser page | Stays in that tab; sent only to this site's `/ops` routes; never in code or the repo |
