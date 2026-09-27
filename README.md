# NOC Front Door — Sanad, the 24/7 AI fault line

**Sanad** is the 24/7 AI fault line of Najd Networks, a fictional KSA managed-services provider: it verifies, de-duplicates, escalates and pages — engineers get one clean ticket instead of a queue of duplicates.

[Live demo](https://noc-edge-41d2a334-7.telnyxcompute.com/demo) · [Live board](https://noc-edge-41d2a334-7.telnyxcompute.com/ops/status?format=html) · [DEMO.md](DEMO.md) · [Architecture](docs/architecture.md) · [Setup](docs/setup.md)

## What it is

A KSA managed-services provider's NOC takes 24/7 outage calls from branch staff of its enterprise customers — the **Al-Waha Pharmacies** and **Rawda Cafés** chains. During a regional outage (an ISP or Telnyx event hitting a whole area) every affected branch calls separately, so the queue fills with **duplicate reports** — fresh interruptions for the on-call engineer.

**Sanad** verifies the caller by site + PIN, recognises the regional incident, opens or joins tickets, escalates P2→P1 at the third branch, pages on-call if the P1 is not acknowledged, and hands over to a human on request — on-call engineers receive **verified, de-duplicated, prioritised** tickets and pages. Telnyx Voice AI (Conversation Workflows) + Edge Compute (Functions, KV, Stateful Actors) + a custom MCP server. Binding design: [spec](docs/superpowers/specs/2026-09-26-noc-front-door-design.md).

## Try it

1. Open the **NOC wall**: **https://noc-edge-41d2a334-7.telnyxcompute.com/demo**
2. Press **Start call** (`C`; `B` board, `1`–`3` scenarios; PIN chips copy on click — served from the `DEMO_GUIDE` secret, no PIN literal in code).
3. Run **scenario 1** as RUH-114 and watch the board: verify → advisory → **join** → the incident flips **P2→P1** when the third branch hits.

| Site | Region | PIN | Scenario |
|---|---|---|---|
| RUH-114 — "the Al Yasmin branch" | Riyadh North | 5944 | Join the incident |
| JED-007 | Jeddah | 7985 | Fresh ticket |

Scenario 2 — **lockout**: call the reserved **DMM-011** (*site D M M zero one one*), wrong PIN ×3 → locked for phone verification → escalation to an engineer; never RUH-114/JED-007 — six failures from two calls lock a site **site-wide for 15 min**. Scenario 3: ask for a human (transfer; else callback — logged, page raised). One-shot per staging — re-stage first ([pre-flight](docs/setup.md)); the **prober must be running** (DEBUGLOG #11). Full script: [DEMO.md](DEMO.md).

### Live endpoints

Base origin: `https://noc-edge-41d2a334-7.telnyxcompute.com`.

| URL | What it is | Auth |
|---|---|---|
| `/demo` | NOC wall + call widget + operator drawer | none |
| `/ops/board`, `/ops/status` (JSON or `?format=html`) | public read-only (masked) views of actor truth | none |
| `/dv`, `/tools/*` (`verify-site`, `open-ticket`, `join-incident`, `callback`) | runtime webhooks from the assistant; identity from the signed body (C13) | Ed25519 — unsigned → 403, fail closed |
| `/mcp` | MCP server: 5 tools, stateless, `GET` → 405 (C4) | bearer (`401` without; sample in [docs/setup.md](docs/setup.md)) |

Other `/ops/*` routes (reset, stage-incident, ack, resolve, unlock, tick, pages, reports, health, diag) are operator-only — ops bearer via `node scripts/ops.mjs`, not published. **Phone number: not available on this Trial account** (none can be ordered — KSA origin, no local coverage; DEBUGLOG #1; verification request pending since 2026-09-26); web calls are the substitute. The MCP bearer is shared privately with reviewers in the submission email (spec §16).

## Architecture

```mermaid
flowchart LR
  caller["Caller<br/>(branch staff, browser web call)"]
  asst["Telnyx AI Assistant sanad-noc<br/>model moonshotai/Kimi-K2.6<br/>voice Telnyx.KokoroTTS.af_heart · STT deepgram/nova-3<br/>DV webhook · MCP integration"]
  wf["Conversation Workflow<br/>37 nodes · 93 edges"]
  edge["Edge Function noc-edge<br/>/dv · /tools/* · /mcp · /ops/* · /demo"]
  mcp["MCP server noc-mcp<br/>5 tools, stateless<br/>(runs in-process in noc-edge)"]
  kv[("KV noc-kv<br/>flags · sessions · projections")]
  actors["Stateful Actors<br/>SiteState per site · RegionState per region<br/>mux mode: both inside Counter/demo on noc-actor-canary")]
  tcs[("Telnyx Cloud Storage<br/>bucket noc-reports-fb8131, us-central-1<br/>incident report JSON on resolve")]
  prober["External prober<br/>(dev box, outside the failure domain)"]

  caller --> asst
  asst --> wf
  wf -->|"① POST /dv at call start (signed, fail-open ≤ 2500 ms)"| edge
  wf -->|"② POST /tools/* from tool nodes"| edge
  wf -->|"③ POST /mcp from prompt nodes"| mcp
  mcp -.->|"in-process"| edge
  edge -->|"read / write"| kv
  edge -->|"read-modify-write"| actors
  actors -.->|"best-effort projections"| kv
  edge -.->|"incident report on resolve"| tcs
  prober -.->|"health every 10 s (heals projections)<br/>paging every 30 s (tick, claim, send)"| edge
```

- **Actors own the invariants** (C6) — 1 ticket per site, P1 at 3 branches, alarm ladder; 10 concurrent opens → **1 ticket** ([race test](docs/evidence/race-test.txt)).
- **KV only projects / caches / flags** (C5) — no invariant lives there; the prober re-syncs projections.
- **Mux mode** (DEBUGLOG #4) — same classes in the one working instance behind `ActorPort` + `flag/actor_mode=mux`.
- **`/dv` fail-open** (C3) within its 2500 ms budget; identity from the signed body (C13); unsigned → 403.
- **One trace_id per call** — `/dv` → tools → MCP → actors via `scripts/trace.sh`.

Full rationale: [docs/architecture.md](docs/architecture.md).

## How it meets the brief

| Requirement | Where | Evidence |
|---|---|---|
| Conversation Workflow — prompt/speak/tool nodes, `llm`/`expression`/`default` edges | `assistant/assistant.json` + `scripts/apply.mjs` | Zero DRIFT 2026-09-27 (DEBUGLOG #7); Arabic 2026-09-28 00:18 UTC+3; [voice calls](docs/evidence/voice-calls.md) |
| Callable — web call + `/demo` | `edge/noc-edge/src/demo/page.ts` | [/demo](https://noc-edge-41d2a334-7.telnyxcompute.com/demo) — no phone on Trial (DEBUGLOG #1) |
| Custom MCP server, ≥3 tools | `edge/noc-edge/src/mcp/` — 5 tools (C4) | Live `tools/list` = 5 (DEBUGLOG #9) |
| DV webhook from an Edge Function, influencing routing | `edge/noc-edge/src/dv/` → `route_hint` | Signed; DEBUGLOG #6; `flag/demo_caller` ([runbook](docs/runbook.md)) |
| Edge Functions | `noc-edge`, `noc-actors`, `noc-actor-host` | Live 2026-09-27 (DEBUGLOG #4) |
| KV | `edge/noc-edge/src/services/` | Flags live: `deflection_enabled`, `require_pin`, `actor_mode`, `flag/fault/*` |
| Stateful Actors, read-modify-write | `SiteState`/`RegionState` + mux host (C11) | [Race test](docs/evidence/race-test.txt): 10 opens → 1 ticket vs KV 10 |
| Observability — logs, signal, minute answer | `edge/shared/src/log.ts`, `scripts/prober.mjs`, `/ops/health/deep` | 10 s probes ≈ ≤30 s ([runbook](docs/runbook.md)) |
| A real debugging story | DEBUGLOG.md #5–#14 | Found within a minute (#5); voice-call chain (#8) |
| OpenCode + Telnyx Inference | [opencode.jsonc](opencode.jsonc) | [DOGFOODING.md](DOGFOODING.md) — 57 commits, ≈$0.25–0.30/run |
| Public deployment + docs | [/demo](https://noc-edge-41d2a334-7.telnyxcompute.com/demo), [/ops/status](https://noc-edge-41d2a334-7.telnyxcompute.com/ops/status) | Live since 2026-09-27 |

Stretch goals (statuses as of 2026-09-28):

| Goal | Status | Evidence |
|---|---|---|
| Variable-comparison edges (19 English core / 33 total; DUR, last-tool-status) | Built & live | P1 at 3 sites live (voice call #3) |
| DV webhook steering identified callers | Built & live | DEBUGLOG #6/#8; [runbook](docs/runbook.md) |
| KV feature flags (incl. `flag/fault/*` injection) | Built & live | Fault drills ([runbook](docs/runbook.md)) |
| Shared actors — one instance, two functions | Built & live | `/ops/actor-ping` |
| Distributed tracing — one `trace_id` end-to-end | Built & live | `scripts/trace.sh` |
| Actor alarms, fanned out by the mux host | Built & live | Page `INC-1004:p1` sent 21:51:53Z ([alarms-live.md](docs/evidence/alarms-live.md)) |
| Incident reports → Cloud Storage `noc-reports-fb8131` | Built, deploy pending | No live write yet (DEBUGLOG #13) |
| Arabic mode — 13-node sub-flow; `Telnyx.Bayan.Reem` + `soniox/stt-rt-v5` | Built, config live (no Arabic call recorded yet) | Applied 2026-09-28 00:18 UTC+3 |
| Live NOC console — the `/demo` NOC wall | Built & live | Live 2026-09-27 23:28 UTC+3 |
| Voice-model upgrade — TTS "Ultra"; `deepgram/flux` vs nova-3 | Evaluation pending (A/B by live calls) | Needs live calls (no credit spent) |

Full-fidelity map with every evidence link: [docs/architecture.md](docs/architecture.md) (appendix).

## Observability

### Know within a minute

The external prober (dev box, outside the failure domain) probes `GET /ops/health/deep` every 10 s and alerts after **2 consecutive failures** — worst case ≈ 30 s. Covers the edge function + dependencies (KV, actors, the MCP server, projection sync); assistant-level failures surface in the Portal conversation labels, the invocation log, the per-call trace. `degraded` with `slow:["kv"]` is **not** an outage (DEBUGLOG #6). First look: the invocation log (`telnyx-edge logs noc-edge --tail --type invocations`), then `scripts/trace.sh t-<trace_id>` — order in [docs/runbook.md](docs/runbook.md).

### A real bug, end to end

At 17:10 UTC on 2026-09-27, voice call #1 (trace `t-5d419f3a98a3240f`): the PIN was **correct** (`verify_result "ok"`) but `verify_site` took **7869 ms** — over its 5000 ms timeout — so Telnyx treated verification as *failed*: the default edge ran the designed escalation (transfer unanswered → message → `log_callback`, 2.8 s, page raised); the call ended safely, but no ticket opened. The same trace showed `/dv` falling back at 2200 ms (`kv` 2195) — the designed fail-open path. Root cause (DEBUGLOG #6): KV ops cost ~1.1–2.0 s on this account and the tool webhooks ran them in sequence. Fix: concurrent KV in the tools (verify_site 5428→2010 ms, open_ticket 4830→1618 ms under a 1000 ms/op fake KV; verify timeout 5000→8000 ms). Proof: call #2 (18:05 UTC, `t-128d0766…`) verified in **3579 ms**, joined NJD-1401 (`join_incident` 2638 ms); call #3 (18:14 UTC, `t-c01949fafca2a42e`) verified in 3646 ms, joined in 2559 ms → NJD-1402; INC-1002 went **P1 at 3 sites** on `/ops/status`. Found by our own logs within a minute (DEBUGLOG #5, #8); full table in [docs/evidence/voice-calls.md](docs/evidence/voice-calls.md).

## Challenges & solutions

- **No new actor instances on Trial** (DEBUGLOG #4) → mux host runs the same classes in the one working instance; its single real alarm is fanned out (DEBUGLOG #12).
- **KV ~1–2 s/op** (DEBUGLOG #6) → concurrency + deadlines everywhere; the prober heals projections (DEBUGLOG #11).
- **Voice model skipped "say, then call the tool"** → mandatory actions are **tool nodes**, enforced by `flow-validate` before every apply.
- **No phone number** (DEBUGLOG #1) → public web-call widget; identified callers via `flag/demo_caller` ([runbook](docs/runbook.md)).
- **One assistant, never deleted** (C1) → config-as-code (`scripts/apply.mjs`) with read-back `DRIFT`.

## Setup

Prerequisites: a Telnyx account + API key (Trial is fine), the [`telnyx-edge` CLI](https://telnyx.com/products/edge-infra), **Node 22**. Full version — every `.env` key and secret, bucket, deploy timings, tests, troubleshooting — in [docs/setup.md](docs/setup.md).

1. `npm ci && npm --prefix edge/shared ci && npm --prefix edge/noc-actors ci && npm --prefix edge/noc-edge ci && npm --prefix edge/noc-actor-host ci`
2. `cp .env.example .env` — fill `TELNYX_API_KEY`, `MCP_TOKEN`, `OPS_TOKEN`, `PIN_PEPPER`, `NOC_OPS_TOKEN`, `TELNYX_PUBLIC_KEY`, `EDGE_URL`, `ONCALL_NUMBER`.
3. `bash scripts/setup-edge.sh` — idempotent: creates the **KV namespace `noc-kv`**, generates missing secrets, fetches the public key, pushes the Edge secrets.
4. `telnyx-edge secrets add` the per-function secrets — `ONCALL_NUMBER`, `SEED_LOCAL` (demo PINs live only here), `DEMO_GUIDE` (PIN chips on `/demo`) — and set the Cloud Storage bucket (`noc-reports-fb8131`, `us-central-1`) in `edge/noc-edge/telnyx.toml`.
5. Ship owner → host → edge: `telnyx-edge ship` in `edge/noc-actors`, `edge/noc-actor-host`, `edge/noc-edge` (each deploy builds client-side, **15–35 min**).
6. On DEBUGLOG #4 accounts: `telnyx-edge storage kv key put "$KV_ID" flag/actor_mode mux`; verify via `node scripts/ops.mjs GET '/ops/actor-ping?site=TST-001'` → `mode`.
7. Apply the assistant: `EDGE_URL=<origin> node scripts/apply.mjs --dry-run`, then without `--dry-run` — PATCHes `sanad-noc` in place, prints `DRIFT` (empty = clean).
8. Start the prober (`node scripts/prober.mjs`; keep it running) and pre-flight: `node scripts/ops.mjs POST /ops/reset`, then `POST '/ops/stage-incident?region=riyadh-north'` — staged P2, escalation due in 5 min.

## Code walkthrough

Eight ordered stops (`file:lines — what to show — why it matters`): config-as-code, the fail-open `/dv` webhook, tool webhooks with signed identity, `SiteState` (1 ticket/site, PIN lock), `RegionState` (regional escalation), the mux host, the stateless MCP server, health + prober: [docs/walkthrough.md](docs/walkthrough.md).

## How it was built

Claude is architect and reviewer — spec, plans, task prompts; every implementer task independently reviewed before merge. Every shipped artifact (code, config, tests, scripts, README, demo) is authored through **OpenCode on Telnyx Inference** (`telnyx/zai-org/GLM-5.3-Flash` default; other models per task) via the `@telnyx/opencode` plugin — see [`opencode.jsonc`](opencode.jsonc). [`DOGFOODING.md`](DOGFOODING.md) records per-task cost and what review caught.

**Exceptions** (`git log --grep "Co-Authored-By: Claude"`), besides docs (spec, plans, AGENTS.md): (1) CLI scaffolds committed by the architect — `1465810` (noc-actors/noc-edge/shared: `package.json`, lockfiles, `telnyx.toml`, `tsconfig`, READMEs), `aaec5bf`/`3eab224`/`37df71d` (noc-probe scaffold, dep pins, KV id); (2) the `/demo` visual layer (`edge/noc-edge/src/demo/page.ts` + tests) — `bf53117` + `05159c6`, `ae2feac`, `277f439` (announcement bar, shortcuts, SRI, DMM-011 scenario, Unlock) — written by **Claude** at the product owner's request after two OpenCode versions (GLM-5.3, then Kimi-K3) were rejected as generic (P2-R5/P2-R8). The board endpoint behind it (`/ops/board`, `ops/board.ts`, `demo/guide.ts`, router) is OpenCode-authored; the split is disclosed in the commits, the page source and DOGFOODING.md.

## Repo map

```
assistant/            37-node workflow (English + Arabic), tools, MCP server; applied by scripts/apply.mjs
edge/noc-edge/         Edge Function: /dv, /tools/*, /mcp, /ops/*, /demo; services; ActorPort seam
edge/noc-actors/       SiteState + RegionState classes (binding-free owner)
edge/noc-actor-host/   Mux-mode host: same classes inside the one working instance
edge/noc-probe/        Plan-0 diagnostics probe (DEBUGLOG #2–#4)
edge/shared/           Pure libs: ids, KV keys, deadline(), Ed25519 verify, logging, masking, authz, seed adapter
scripts/               apply.mjs, prober.mjs, ops.mjs, trace.sh, race-test.mjs, preflight.mjs, secret-scan
docs/                  Spec, plans, runbook, evidence, setup, architecture, walkthrough
```

## Known limitations

- **No phone number on Trial** (DEBUGLOG #1) — demos run as browser web calls from `/demo`.
- **No new actor instances** (DEBUGLOG #4) → mux mode behind `flag/actor_mode=mux`; `/ops/actor-ping` shows the mode.
- **KV ~1–2 s/op** (DEBUGLOG #6) → latency-shaped routes; greeting falls back to safe defaults on anonymous web calls; `degraded` ≠ down; keep the prober running (DEBUGLOG #11).
- **Voice-model A/B pending** — TTS "Ultra" shortlist, STT `deepgram/flux` vs nova-3; needs live calls (no credit spent).
