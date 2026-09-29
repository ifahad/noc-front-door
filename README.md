# NOC Front Door — Sanad, the 24/7 AI fault line

**Sanad** is Najd Networks' 24/7 AI fault line: it verifies, de-duplicates, escalates and pages — engineers get one clean ticket instead of a queue of duplicates.

[Live site](https://noc-edge-41d2a334-7.telnyxcompute.com/) · [Live board](https://noc-edge-41d2a334-7.telnyxcompute.com/ops/status?format=html) · [DEMO.md](DEMO.md) · [Architecture](docs/architecture.md) · [Setup](docs/setup.md)

## What it is

A KSA managed-services provider's NOC takes 24/7 outage calls from branch staff of its enterprise customers — the **Al-Waha Pharmacies** and **Rawda Cafés** chains. During a regional outage every affected branch calls separately, so the queue fills with **duplicate reports**.

**Sanad** verifies the caller by site + PIN, recognises the regional incident, opens or joins tickets, escalates P2→P1 at the third branch, pages on-call if the P1 is unacknowledged, and hands over to a human on request. Telnyx Voice AI (Conversation Workflows) + Edge Compute (Functions, KV, Stateful Actors) + a custom MCP server. Binding design: [spec](docs/superpowers/specs/2026-09-26-noc-front-door-design.md).

## Try it

1. Open the production front page: **https://noc-edge-41d2a334-7.telnyxcompute.com/** — **Report an outage**: browser call or dial **+1 512 980 6105** (international from KSA), English or Saudi Arabic; plus the live network status map. `/demo` serves the same page.
2. Press **Start call** (`C`; `B` board, `1`–`3` scenarios; PIN chips copy on click — from the `DEMO_GUIDE` secret, no PIN literal in code).
3. Run **scenario 1** as RUH-114 and watch the board: verify → advisory → **join** → **P2→P1** when the third branch hits.

| Site | Region | PIN | Scenario |
|---|---|---|---|
| RUH-114 — "the Al Yasmin branch" | Riyadh North | 5944 | Join the incident |
| JED-007 | Jeddah | 7985 | Fresh ticket |

Scenario 2 — **lockout**: call the reserved **DMM-011** (never RUH-114/JED-007). Scenario 3: ask for a human (transfer; else callback). One-shot per staging — re-stage first ([pre-flight](docs/setup.md)); the **prober must be running** (DEBUGLOG #11). Script: [DEMO.md](DEMO.md).

The **operator console** — scenarios with the two demo PINs, detailed board, event feed, how-it-works, presenter controls — is hidden: append `#console` or press the backtick key.

### Live endpoints

| URL | What it is | Auth |
|---|---|---|
| `/`, `/demo` | front page: report an outage (browser call or `+1 512 980 6105`) + live status map; hidden operator console (`#console` / backtick) | none |
| `/ops/board`, `/ops/status` (JSON or `?format=html`) | public read-only (masked) actor views | none |
| `/dv`, `/tools/*` (`verify-site`, `open-ticket`, `join-incident`, `callback`) | assistant webhooks; identity from the signed body (C13) | Ed25519 — unsigned → 403, fail closed |
| `/mcp` | MCP server: 5 tools, stateless, `GET` → 405 (C4) | bearer (`401` without; sample in [docs/setup.md](docs/setup.md)) |

Other `/ops/*` routes are operator-only — ops bearer via `node scripts/ops.mjs`, not published. The public line **`+1 512 980 6105`** (a US Telnyx number) is live since the account was verified on 2026-09-28 — before that no number could be ordered (DEBUGLOG #1). The MCP bearer is shared privately with reviewers in the submission email (spec §16).

## Architecture

```mermaid
flowchart LR
  caller["Caller<br/>(branch staff: browser web call or +1 512 980 6105)"]
  asst["Telnyx AI Assistant sanad-noc<br/>(English) DV webhook · MCP integration"]
  wf["Conversation Workflow"]
  ar["Telnyx AI Assistant sanad-noc-ar<br/>(Saudi Arabic) no MCP tools"]
  edge["Edge Function noc-edge<br/>/dv · /tools/* · /mcp · /ops/* · / and /demo"]
  mcp["MCP server noc-mcp<br/>5 tools, stateless"]
  kv[("KV noc-kv<br/>flags · sessions · projections")]
  actors["Stateful Actors<br/>SiteState per site · RegionState per region<br/>mux mode: both inside Counter/demo on noc-actor-canary"]
  tcs[("Telnyx Cloud Storage<br/>bucket noc-reports-fb8131, us-central-1<br/>incident report JSON on resolve")]
  prober["External prober"]

  caller --> asst
  asst --> wf
  wf -->|"④ one-way assistant-target handoff<br/>(voice_mode distinct)"| ar
  wf -->|"① POST /dv at call start (fail-open ≤ 2500 ms)"| edge
  wf -->|"② POST /tools/* from tool nodes"| edge
  wf -->|"③ POST /mcp from prompt nodes"| mcp
  mcp -.->|"in-process"| edge
  edge -->|"read / write"| kv
  edge -->|"read-modify-write"| actors
  actors -.->|"best-effort projections"| kv
  edge -.->|"incident report on resolve"| tcs
  prober -.->|"health every 10 s (heals projections)<br/>paging every 30 s"| edge
```

- **Actors own the invariants** (C6) — 10 concurrent opens → **1 ticket** ([race test](docs/evidence/race-test.txt)).
- **KV only projects / caches / flags** (C5) — the prober re-syncs projections.
- **Mux mode** (DEBUGLOG #4) — same classes in the one working instance behind `ActorPort`.
- **Two assistants, one-way handoff** — `sanad-noc` (English) hands the call to `sanad-noc-ar` (Saudi Arabic: voice `Telnyx.Bayan.Reem`, STT `soniox/stt-rt-v5`, no MCP tools) via workflow `assistant-target` edges (`voice_mode: distinct`) from the opening speak node and every English prompt node (a `requireArabicExits` validator rule enforces it). The handoff keeps the conversation, history and variables; the Arabic flow starts at a speak node and routes by carried state — verified → triage, known incident → advisory, ticket open → confirm, otherwise intake — so a caller verified in English is never asked for the PIN again. Proven on live call #6 (DEBUGLOG #18).
- **`/dv` fail-open** (C3); identity from the signed body (C13); unsigned → 403.
- **One trace_id per call** (`scripts/trace.sh`).

Full rationale: [docs/architecture.md](docs/architecture.md).

## How it meets the brief

| Requirement | Evidence |
|---|---|
| Conversation Workflow — prompt/speak/tool nodes, `llm`/`expression`/`default` edges | Zero DRIFT on apply ([voice calls](docs/evidence/voice-calls.md)) |
| Callable — web call + phone | Live — browser or `+1 512 980 6105` ([PSTN call #5](docs/evidence/voice-calls.md)) |
| Custom MCP server, ≥3 tools (C4) | Live `tools/list` = 5 (DEBUGLOG #9) |
| DV webhook from an Edge Function, influencing routing | Signed and steering ([runbook](docs/runbook.md)) |
| Edge Functions | Live 2026-09-27 (DEBUGLOG #4) |
| KV | Flags live ([runbook](docs/runbook.md)) |
| Stateful Actors, read-modify-write (C11) | 10 opens → 1 ticket ([race test](docs/evidence/race-test.txt)) |
| Observability — logs, signal, minute answer | ≈ ≤30 s alert ([runbook](docs/runbook.md)) |
| A real debugging story | Found within a minute (#5) |
| OpenCode + Telnyx Inference | 77 commits as of c7943f8 ([DOGFOODING.md](DOGFOODING.md)) |
| Public deployment + docs | Live since 2026-09-27 |

Stretch goals (as of 2026-09-28):

| Goal | Status | Evidence |
|---|---|---|
| Variable-comparison edges | Built & live | P1 at 3 sites live (voice call #3) |
| DV webhook steering identified callers | Built & live | DEBUGLOG #6/#8; [runbook](docs/runbook.md) |
| KV feature flags | Built & live | Fault drills ([runbook](docs/runbook.md)) |
| Shared actors | Built & live | `/ops/actor-ping` |
| Distributed tracing | Built & live | `scripts/trace.sh` |
| Actor alarms | Built & live | Page `INC-1004:p1` sent 21:51:53Z ([alarms-live.md](docs/evidence/alarms-live.md)) |
| Incident reports → Cloud Storage | Built, deploy pending | No live write yet (DEBUGLOG #13) |
| Multi-assistant | Built & live | Second assistant live; handoff proven on live call #6 (DEBUGLOG #18) |
| Live NOC console | Built & live | Production front page + hidden operator console (`#console` / backtick), live 2026-09-28 |
| Voice-model upgrade | Evaluation pending | Needs live calls (no credit spent) |

Full detail: [docs/architecture.md](docs/architecture.md) (appendix).

## Observability

### Know within a minute

The external prober (dev box, outside the failure domain) probes `GET /ops/health/deep` every 10 s, alerts after **2 consecutive failures** (worst case ≈ 30 s), covering the edge function + KV, actors, MCP; assistant-level failures surface in the Portal + per-call trace. An actor **hang** that outlives two consecutive probes counts as **down** (`actor_hung`), not "slow" — the 2026-09-28 incident showed up as 30 s hangs (DEBUGLOG #15). `degraded` with `slow:["kv"]` is **not** an outage (DEBUGLOG #6). First look: the invocation log, then `scripts/trace.sh t-<trace_id>` — order in [docs/runbook.md](docs/runbook.md).

Load discipline ([detail](docs/architecture.md)): board cached **30 s from build completion** (10 s degraded); failed flag reads → **30 s cooldown**; public page polls **15 s, visible-only**, pauses after **10 min idle**.

### A real bug, end to end

Voice call #1 (trace `t-5d419f3a98a3240f`): **correct** PIN, but `verify_site` took **7869 ms** — over its 5000 ms timeout — verification failed, no ticket opened. Root cause (DEBUGLOG #6): sequential ~1–2 s KV ops in the tool webhooks. Fix: concurrent KV. Calls #2/#3 verified in **3.6 s**; INC-1002 went **P1 at 3 sites** — found by our own logs within a minute (DEBUGLOG #5, #8; [voice-calls.md](docs/evidence/voice-calls.md)).

## Challenges & solutions

- **No new actor instances** (DEBUGLOG #4) → mux host: same classes in the one working instance; alarm fanned out (DEBUGLOG #12).
- **KV ~1–2 s/op** (DEBUGLOG #6) → concurrency + deadlines; the prober heals projections (DEBUGLOG #11).
- **Voice model skipped "say, then call the tool"** → mandatory actions are **tool nodes**, enforced by `flow-validate` on every apply.
- **No number until verification** (DEBUGLOG #1) → verified 2026-09-28: line `+1 512 980 6105` + browser widget; identified callers via `flag/demo_caller` ([runbook](docs/runbook.md)).
- **One assistant, never deleted** (C1) → config-as-code (`scripts/apply.mjs`) with read-back `DRIFT`.

## Setup

Prerequisites: a Telnyx account + API key (Trial is fine), the [`telnyx-edge` CLI](https://telnyx.com/products/edge-infra), **Node 22**. Full version (`.env` keys, secrets, bucket, deploy timings, tests, troubleshooting): [docs/setup.md](docs/setup.md).

1. `npm ci` in the root and each `edge/*` package (`npm --prefix … ci`).
2. `cp .env.example .env` — fill the keys ([docs/setup.md](docs/setup.md)).
3. `bash scripts/setup-edge.sh` — idempotent: creates the **KV namespace `noc-kv`**, generates and pushes the Edge secrets.
4. `telnyx-edge secrets add` the per-function secrets (`ONCALL_NUMBER`, `SEED_LOCAL` — demo PINs only here — `DEMO_GUIDE`) and set the bucket (`noc-reports-fb8131`, `us-central-1`) in `edge/noc-edge/telnyx.toml`.
5. Ship owner → host → edge: `telnyx-edge ship` in `edge/noc-actors`, `edge/noc-actor-host`, `edge/noc-edge` (**15–35 min** each).
6. On DEBUGLOG #4 accounts: `telnyx-edge storage kv key put "$KV_ID" flag/actor_mode mux` (verify: `/ops/actor-ping`).
7. Apply the assistants: `EDGE_URL=<origin> node scripts/apply.mjs --dry-run`, then for real — upserts **both** by name (`sanad-noc-ar` first, then `sanad-noc` with the Arabic id), prints `DRIFT` (empty = clean).
8. Start the prober (`node scripts/prober.mjs`; keep it running) and pre-flight: `POST /ops/reset`, then `POST '/ops/stage-incident?region=riyadh-north'` — staged P2, escalation due in 5 min.

## Code walkthrough

Eight ordered stops (`file:lines — what — why`): [docs/walkthrough.md](docs/walkthrough.md).

## How it was built

Claude is architect and reviewer — spec, plans, task prompts; every implementer task is independently reviewed before merge. Shipped artifacts are authored through **OpenCode on Telnyx Inference** (`telnyx/zai-org/GLM-5.3-Flash` default) via the `@telnyx/opencode` plugin ([`opencode.jsonc`](opencode.jsonc)).

**Exceptions**, besides docs: the CLI-generated scaffolds (committed by the architect) and the Claude-written visual layer (`edge/noc-edge/src/demo/page.ts` + its tests — the production front page **and its hidden operator console**; two OpenCode versions were rejected as generic), plus one architect revert commit (`a94722c`) during a live incident (DEBUGLOG #17). Cost, review catches and the commit split: [`DOGFOODING.md`](DOGFOODING.md).

## Repo map

```
assistant/            Workflows (English + Arabic), tools, MCP server; applied by scripts/apply.mjs
edge/noc-edge/         Edge Function: /dv, /tools/*, /mcp, /ops/*, / + /demo; ActorPort seam
edge/noc-actors/       SiteState + RegionState classes (binding-free owner)
edge/noc-actor-host/   Mux-mode host (same classes, one instance)
edge/noc-probe/        Plan-0 diagnostics probe (DEBUGLOG #2–#4)
edge/shared/           Pure libs: ids, KV keys, deadline(), Ed25519 verify, logging, masking, authz
scripts/               apply.mjs, prober.mjs, ops.mjs, trace.sh, race-test.mjs, preflight.mjs, secret-scan
docs/                  Spec, plans, runbook, evidence, setup, architecture, walkthrough
```

## Known limitations

- **Telnyx platform incident 2026-09-28/29** (DEBUGLOG #15) — actor runtime broke from 06:14:44Z, KV data plane from 19:06Z; flapped for hours; reproduces on paths our code cannot touch.
- **No new actor instances** (DEBUGLOG #4) → mux mode behind `flag/actor_mode=mux`; `/ops/actor-ping` shows the mode.
- **Arabic re-verification skip** — `s_ar_open` routing is configured and unit-tested, but could not be exercised end-to-end while actors were down (DEBUGLOG #18).
- **KV ~1–2 s/op** (DEBUGLOG #6) → latency-shaped routes; `degraded` ≠ down; keep the prober running (DEBUGLOG #11).
- **Voice-model A/B pending** — TTS "Ultra" shortlist, STT `deepgram/flux` vs nova-3 (no credit spent).
