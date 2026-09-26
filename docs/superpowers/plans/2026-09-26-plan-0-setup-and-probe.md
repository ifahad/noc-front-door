# Plan 0: Setup + Platform Probe (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development *pattern*, adapted per the user's requirement:
> - **Implementer:** OpenCode + `@telnyx/opencode` on a Telnyx-hosted model, dispatched headlessly by the architect (`opencode run … --format json --auto`).
> - **Architect (Claude):** writes the prompts, reviews each task's diff, runs the tests, and executes account operations.
> - **Checkboxes:** steps use `- [ ]` for tracking.
> - **Legend:** 👤 = Fahad does it (credentials, interactive auth, calls). 🏗 = architect (Claude) runs a command. 🤖 = OpenCode task.
>
> **Deliberate deviation from the plan template:** this plan gives behaviour, interfaces and acceptance tests, not implementation code. The integrity line (spec §14.1) requires that all shipped code, *including test code*, is written by OpenCode on Telnyx inference.

**Goal:** A working toolchain (OpenCode on Telnyx inference, the Edge CLI, the repo guardrails) and **measured answers** to every blocking platform unknown (spec §17.1) before any core code is written.

**Architecture:**
- A throwaway-but-kept `noc-probe` umbrella function (actor + KV + secrets). It logs everything it receives on `/dv`, `/tools/echo` and `/mcp`.
- The account's single assistant, `sanad-noc`, is configured with a **probe workflow**. One web call exercises about 10 unknowns at once.
- The results update the spec's fallbacks.

**Tech Stack:**
- TypeScript
- `@telnyx/edge-runtime@0.15.3` (exact)
- `@modelcontextprotocol/sdk@1.30.1` (exact)
- `zod@^3.25`
- Node 22 locally
- `telnyx-edge` v0.5.4 linux-arm64
- OpenCode (latest) + `@telnyx/opencode@0.1.5`
- `tsx` for scripts

**Spec:** `docs/superpowers/specs/2026-09-26-noc-front-door-design.md` (v2). Read §2, §5, §7, §8.1 and §17 before starting.

## Global Constraints

- **Account is Trial:**
  - exactly **1 assistant**, named `sanad-noc`. It is created once, then **updated in place and never deleted**.
  - **1 API key** (Fahad's; never pasted into chat, never committed)
  - **no phone number**, so web calls only
  - **$5 credit** until the promo is confirmed
- The Edge CLI uses **OAuth** (`telnyx-edge auth login`). The token expires about hourly; on an auth error, 👤 re-runs login.
- **Secrets never enter git.** `.env` is gitignored. `opencode.jsonc` uses only `{env:VAR}` substitution. A pre-commit secret scan runs on every commit.
- **DV / webhook values are strings only.** Sentinels are `"none"` / `"unknown"`, never `""` (spec C9).
- **Logs:** one JSON object per line, with no PINs, no API keys, no bearer tokens, and phone numbers masked as `+1312****309` (spec §11.1, §10).
- **Pinned names:**

  | Resource | Name |
  |---|---|
  | KV namespace | `noc-kv` (reused by core) |
  | Probe function | `noc-probe` |
  | Integration secret | `noc_mcp_token` |
  | MCP server | `noc-mcp-probe` |
  | Shared tools | `probe_echo`, `probe_capture`, `probe_hangup` |

- **Edge secrets** (`telnyx-edge secrets add`, org-wide; **re-ship to apply**): `TELNYX_PUBLIC_KEY`, `MCP_TOKEN`, `OPS_TOKEN`, `PIN_PEPPER`.
- **OpenCode environment for every run:** `OPENCODE_DISABLE_CLAUDE_CODE=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`.
- **Model routing:**
  - mechanical tasks → `telnyx/zai-org/GLM-5.3` (or `-Flash`)
  - reasoning-heavy tasks → `telnyx/moonshotai/Kimi-K3`
  - these IDs are replaced by whatever `opencode models telnyx` actually lists (Task 1)

## Review Focus

Uncovered failure modes most likely to bite, and the check that pins each one:

1. **A secret leaks into a commit or an OpenCode transcript** (API key, MCP/OPS token). Expected: blocked. → Task 2 secret-scan test cases, plus raw transcripts gitignored.
2. **The probe's public URL exposes diagnostics or accepts forged calls.** Expected: `/diag/*` requires `OPS_TOKEN`, `/mcp` requires `MCP_TOKEN`, and `/dv` and `/tools/echo` log signature validity. → Task 4 smoke checks 4.6-4.8.
3. **Trial credit runs out mid-build**, which would stop OpenCode and calls. Expected: the balance is known before any inference-heavy step. → Task 1 Step 1 and Task 3 preflight.
4. **PII in probe logs:** real caller numbers on web calls, or Fahad's number. Expected: masked. → Task 4 behaviour B-LOG, checked in Task 6.
5. **Mistaking "DV didn't fire" for "edges ignored"** (or similar confounds). Expected: every probe observation has an independent witness (our log line *and* the transcript). → Task 6 decision table.

---

## File structure (Plan 0)

| Path | Responsibility | Author |
|---|---|---|
| `AGENTS.md` | Standing rules for the coding model | 🏗 architect |
| `.gitignore`, `.env.example`, `package.json` (root, scripts only) | Repo hygiene; `tsx` script runner | 🤖 |
| `opencode.jsonc` | OpenCode config with the Telnyx plugin active (brief deliverable) | 🤖 |
| `.githooks/pre-commit`, `scripts/secret-scan.mjs`, `scripts/secret-scan.test.mjs` | Secret guardrail + tests | 🤖 |
| `scripts/preflight.mjs` | Balance, models and auth status, with no secrets printed | 🤖 |
| `scripts/setup-edge.sh` | Idempotent KV namespace and Edge secrets setup | 🤖 |
| `scripts/lib/telnyx.mjs` | Tiny authenticated fetch helper for the Telnyx REST API | 🤖 |
| `edge/noc-probe/**` | Probe umbrella function (actor, KV, secrets, `/dv`, `/tools/echo`, `/mcp`, `/diag/*`) | 🤖 (scaffold via 🏗 CLI) |
| `assistant/probe/*.json`, `scripts/probe-apply.mjs` | Probe assistant, tools and MCP registration as code | 🤖 |
| `README.md` (stub), `DEBUGLOG.md`, `DOGFOODING.md`, `docs/evidence/probe-results.md` | Evidence documents | 🤖 (from facts supplied in prompts) |

---

### Task 1: Toolchain: OpenCode + Telnyx plugin + models

**Files:** none in the repo, except `.opencode/opencode.json` and `.opencode/tui.json`, which the plugin command generates.

**Interfaces:**
- Produces: a working `opencode` on `PATH`, the Telnyx credential stored, `~/.config/opencode/telnyx-models.json`, and the list of real model IDs used by every later task.

- [ ] **Step 1 👤: Check the balance and promo credit.** Portal → Billing (or Account → Balance). Tell the architect the balance and whether any promo credit appears.
  **Gate:** if the balance is under about $5 and no promo credit shows, add a small top-up before Step 6. Inference and web calls both draw on it.
- [ ] **Step 2 🏗: Check the npm prefix, then install OpenCode.**
  1. Run `npm config get prefix`. If it is user-writable, run `npm i -g opencode-ai@latest`. Otherwise run `curl -fsSL https://opencode.ai/install | bash`, which installs to `~/.opencode/bin`.
  2. Run `opencode --version`. **Expected:** a version string, with no "exec format error" (arm64).
- [ ] **Step 3 🏗: Install the plugin from inside the repo.** Run `cd ~/code/telnyx-fde/noc-front-door && opencode plugin @telnyx/opencode`. **Expected:** `.opencode/opencode.json` and `.opencode/tui.json` exist and list `@telnyx/opencode`.
- [ ] **Step 4 👤: Authenticate in your own terminal**, not through `!`, because it prompts interactively:
  1. `cd ~/code/telnyx-fde/noc-front-door && opencode auth login --provider telnyx --method "API Key"`
  2. At "Which Telnyx models…?", choose **All hosted Telnyx models**.
  3. **Note:** the first prompt echoes the key in plain text, so make sure no one is watching the screen.
- [ ] **Step 5 🏗: Enable the models and verify.**
  1. Write `~/.config/opencode/telnyx-models.json` with `{"version":1,"enabledModels":[…]}`, listing `moonshotai/Kimi-K3`, `zai-org/GLM-5.3`, `zai-org/GLM-5.3-Flash`, `deepseek-ai/DeepSeek-V4-Flash-0731` and `moonshotai/Kimi-K2.6`.
  2. Run `opencode auth list`. **Expected:** `telnyx` is present.
  3. Run `opencode models telnyx`. **Expected:** `telnyx/<org>/<model>` IDs are listed. **Record the exact list.**
  4. If the list is empty, the plugin silently failed to fetch `GET /v2/ai/models`. That points to a key or tier problem: stop and debug using the plugin's `--print-logs`.
- [ ] **Step 6 🏗: Smoke test.** Run `OPENCODE_DISABLE_CLAUDE_CODE=1 opencode run --model telnyx/moonshotai/Kimi-K3 "Say hello in one sentence."`. **Expected:** one sentence, no errors. Record the wall time.
- [ ] **Step 7 🏗: Record** the versions, model list, timings and any friction in the architect's notes, which become the input for `DOGFOODING.md` in Task 2. **No commit** (nothing tracked has changed yet, apart from `.opencode/`, which is committed in Task 2).

---

### Task 2: Repo scaffold + guardrails (first OpenCode task)

**Files:**
- 🏗 Create: `AGENTS.md`
- 🤖 Create: `.gitignore`, `.env.example`, `package.json`, `opencode.jsonc`, `.githooks/pre-commit`, `scripts/secret-scan.mjs`, `scripts/secret-scan.test.mjs`, `README.md`, `DEBUGLOG.md`, `DOGFOODING.md`

**Interfaces:**
- Produces:
  - `npm run scan` (secret scan over staged files)
  - `npm test` (runs `node --test scripts/*.test.mjs`)
  - `git config core.hooksPath .githooks` active
  - `.env` variables: `TELNYX_API_KEY`, `MCP_TOKEN`, `OPS_TOKEN`, `PIN_PEPPER`, `NOC_OPS_TOKEN` (the same value as `OPS_TOKEN`, used by OpenCode)

- [ ] **Step 1 🏗: Write `AGENTS.md`** (architect artifact; commit it separately first). It states:
  - the project summary
  - the pointer to the spec
  - constraints C1-C13 (verbatim one-liners from spec §2)
  - "TDD for pure logic: write the failing test, see it fail, implement, see it pass"
  - the log schema (spec §11.1)
  - "no network I/O inside actor methods"
  - "DV and webhook values are strings; sentinels none/unknown"
  - "no floating promises; use deadline()"
  - "one writer per KV key"
  - "**never** add a signature-verification bypass"
  - "never print, log or commit secrets or phone numbers"
  - "never run `git push`, `opencode debug config`, `telnyx-edge secrets` or `cat .env`"
  - "exact dependency pins: `@telnyx/edge-runtime@0.15.3`, `@modelcontextprotocol/sdk@1.30.1`"
  - "commit with conventional messages ending with the trailer `Assisted-by: OpenCode (telnyx/<model>)`"

  Commit with message `docs: AGENTS.md (architect rules for the coding model)`.
- [ ] **Step 2 🤖: Dispatch.** Run with `--model telnyx/zai-org/GLM-5.3`. The prompt includes this task's spec (Steps 3-6), plus the Task 1 facts for `DOGFOODING.md` and these facts for `DEBUGLOG.md` entry #1:

  > 2026-09-26: Trial account, KSA origin. The Portal number search says: "Worldwide number coverage is only available to verified users. Your account is trial and only able to search and purchase local numbers in Saudi Arabia." Choosing Saudi Arabia returns "Telnyx does not have search coverage in this country." So no number can be ordered. Evidence: the Portal messages. Action: emailed Telnyx Team asking for Verified. Workaround: web calls. Also: the brief's CLI URL (`telnyx-edge-linux-amd64`) does not match this aarch64 host; the v0.5.4 linux-arm64 asset was used instead.

- [ ] **Step 3 (spec for 🤖): `.gitignore` and `.env.example`.**
  - `.gitignore` covers: `node_modules/`, `.env`, `.env.*` except `.env.example`, `seed.local.json`, `.opencode-runs/raw/`, `.opencode/config.json`, `config.json` at any depth under `.opencode`, `dist/`, `telnyx-env.d.ts` is **tracked** (not ignored), `*.log`.
  - `.env.example` lists the variable names above with empty values and one comment line each.
- [ ] **Step 4 (spec for 🤖): `opencode.jsonc`** at the repo root.
  - `$schema`: `https://opencode.ai/config.json`
  - `plugin`: `["@telnyx/opencode@0.1.5"]`
  - `model`: `telnyx/moonshotai/Kimi-K3` (or the Task 1 equivalent)
  - `small_model`: `telnyx/zai-org/GLM-5.3-Flash`
  - `instructions`: `["AGENTS.md"]`
  - `permission`:
    - `edit: "allow"`
    - `read`: allow `*`, deny `*.env` and `.env.*`, allow `.env.example`
    - `bash`: catch-all `"ask"`; allow `npm *`, `npx *`, `node *`, `git status*`, `git diff*`, `git log*`, `git add*`, `git commit*`, `telnyx-edge types*`, `telnyx-edge logs*`, `telnyx-edge inspect*`, `telnyx-edge list*`, `telnyx-edge metrics*`; deny `git push*`, `rm -rf *`, `opencode debug config*`, `telnyx-edge secrets*`, `cat .env*`, `cat *seed.local*`
    - `external_directory: "deny"`
  - `mcp`: `noc-mcp` as a remote entry, `enabled:false` for now, `url` `https://REPLACE_AFTER_CORE_SHIP/mcp`, `headers.Authorization` `Bearer {env:NOC_OPS_TOKEN}`
  - **No literal secrets anywhere.**
- [ ] **Step 5 (spec for 🤖): the secret scan.** Write the failing tests first in `scripts/secret-scan.test.mjs` (node:test). `scanText(text, {envSecrets})` must return findings for:

  | # | Input | Expected |
  |---|---|---|
  | a | a line containing the literal value of any env secret passed in `envSecrets` (e.g. `"abc123SECRETvalue"`) | finding `env-secret` |
  | b | `KEY01234567890ABCDEFGHIJ_abcdef` (Telnyx-style `KEY` prefix + 20 or more characters) | finding `telnyx-key` |
  | c | `Authorization: Bearer 3f9a8b7c6d5e4f3a2b1c` | finding `bearer` |
  | d | `+966501234567` and `+13125550199` | finding `e164`, **except** in `+1312****309` masked form, which must pass |
  | e | a clean file | `[]` |
  | f | the strings `{env:NOC_OPS_TOKEN}` and `Bearer {env:X}` | `[]` (substitution syntax allowed) |

  Then implement `scripts/secret-scan.mjs`:
  - It exports `scanText` and provides a CLI that scans `git diff --cached --name-only` files (text only), reading `envSecrets` from `.env` if it exists.
  - It exits with 1 and prints `file:line:kind` (**never the matched value**).
  - `.githooks/pre-commit` runs it.
  - `package.json` adds `"scan"` and `"test"` scripts and devDependencies `tsx`, `typescript`, `@types/node` (exact versions, with the lockfile committed).
- [ ] **Step 6 (spec for 🤖): documents.**
  - `README.md` stub: title, one paragraph, and a "Built with" section that includes the build-split disclosure sentence from spec §14.1.
  - `DEBUGLOG.md`: the entry template (Symptom / Signal / Evidence / Hypothesis / Fix / Verification) plus entry #1.
  - `DOGFOODING.md`: a sections skeleton (Setup · Model choice · Per-task log · What worked · What didn't) plus the Task 1 facts.
- [ ] **Step 7 🏗: Verify.**
  1. `npm install && npm test`. **Expected:** all 6 scan tests pass.
  2. `git config core.hooksPath .githooks`.
  3. Stage a temp file containing `Bearer 3f9a8b7c6d5e4f3a2b1c` and run `git commit`. **Expected:** blocked. Unstage and delete it.
  4. `grep -rn "KEY0\|Bearer [A-Za-z0-9]\{12,\}" opencode.jsonc .opencode/`. **Expected:** nothing.
- [ ] **Step 8 🤖/🏗: Commit** with `chore: repo scaffold, secret-scan guardrail, evidence docs` (plus the trailer). Save the OpenCode transcript to `.opencode-runs/raw/`. Record the model, time and cost from `opencode stats --models` in the architect's notes.

---

### Task 3: Preflight + Edge resources

**Files (🤖):** `scripts/lib/telnyx.mjs`, `scripts/preflight.mjs`, `scripts/setup-edge.sh`

**Interfaces:**
- Consumes: `.env` (Task 2 names)
- Produces:
  - `telnyx(path, {method, body})`, an authenticated JSON fetch that reads `TELNYX_API_KEY`, throws on non-2xx with the status and the Telnyx `errors[0].code/title`, and **never includes the key in errors or logs**
  - the `noc-kv` namespace ID (printed; goes into `telnyx.toml` files)
  - the Edge secrets set

- [ ] **Step 1 👤: Create `.env`** at the repo root from `.env.example`. Paste the API key into `TELNYX_API_KEY`, and leave the other values empty (Step 4 fills them).
- [ ] **Step 2 🤖: Dispatch** with `--model telnyx/zai-org/GLM-5.3` and this spec:
  - **`preflight.mjs`** prints:
    - the balance (`GET /v2/balance` → `data.balance`, `data.currency`, `data.credit_limit`, if present)
    - the count and IDs of the chat models (`GET /v2/ai/openai/models`)
    - whether an assistant named `sanad-noc` exists (`GET /v2/ai/assistants`)
    - `telnyx-edge auth status` (parsed to Authenticated / Expired)

    It exits non-zero when the balance is under 2.00.
  - **`setup-edge.sh`** (bash, `set -euo pipefail`, idempotent):
    1. If `telnyx-edge storage kv list` has no `noc-kv`, run `telnyx-edge storage kv create --name noc-kv`, then print the ID.
    2. Wait until the namespace is ready (poll the list or get for a status that is not pending; KV is `pending` for up to about 20 s).
    3. For each of `MCP_TOKEN`, `OPS_TOKEN` and `PIN_PEPPER`: if it is empty in `.env`, generate it with `openssl rand -hex 32` and write it back with `sed` (**never echo the value**). Set `NOC_OPS_TOKEN` equal to `OPS_TOKEN`.
    4. Fetch `GET /v2/public_key` → `data.public` (**not** `data.public_key`) into `TELNYX_PUBLIC_KEY` in `.env`.
    5. For each of the 4 secrets, run `telnyx-edge secrets add NAME "$VALUE"`. If it already exists, delete and re-add (or use the update verb shown by `telnyx-edge secrets --help`). **Never print values.**
    6. Finish with `telnyx-edge secrets list`, which shows names only.
- [ ] **Step 3 🏗: Review the diff.** Specifically grep the scripts for any `echo`/`console.log` of secret variables. **Expected:** none.
- [ ] **Step 4 🏗: Run** `node scripts/preflight.mjs`, then `bash scripts/setup-edge.sh`. **Expected:**
  - a balance line
  - more than 0 chat models
  - `sanad-noc` absent
  - `noc-kv` ID printed
  - `secrets list` showing the 4 names
- [ ] **Step 5 🤖/🏗: Commit** with `chore: preflight + idempotent edge setup scripts`. Append the balance and model count to the architect's notes.

---

### Task 4: `noc-probe` function

**Files:**
- 🏗 scaffold: `telnyx-edge new-func --actor -n noc-probe`, run inside `edge/`. It registers the function remotely and writes `func_id`.
- 🤖 then edits: `edge/noc-probe/{telnyx.toml,package.json,package-lock.json,tsconfig.json,src/index.ts,src/probe-actor.ts,src/mcp.ts,src/ed25519.ts,src/log.ts,telnyx-env.d.ts}`

**Interfaces:**
- Consumes: the `noc-kv` ID; the secrets `TELNYX_PUBLIC_KEY`, `MCP_TOKEN`, `OPS_TOKEN`.
- Produces: `PROBE_URL = https://noc-probe-<first 10 of func_id>.telnyxcompute.com` and the behaviours below.

- [ ] **Step 1 🏗: Scaffold.** `mkdir -p edge && cd edge && telnyx-edge new-func --actor -n noc-probe`, then `cd noc-probe && npm i -E @telnyx/edge-runtime@0.15.3 @modelcontextprotocol/sdk@1.30.1 zod@3.25.76`, then commit the untouched scaffold (`chore(probe): scaffold`), so the diff of the OpenCode work is clean.
- [ ] **Step 2 🤖: Dispatch** with `--model telnyx/moonshotai/Kimi-K3`. The prompt gives the manifest and behaviours below and AGENTS.md; it does **not** include research code.

  **Manifest:**
  - Keep `name`, `main` and `compatibility_date`, and the `[edge_compute]` section as scaffolded.
  - Replace the Counter actor with `[[actors]] binding="PROBE" type="ProbeActor"`.
  - Add `[storage.kv.CACHE] id="<noc-kv id>"`.
  - Add `[[secrets]]` for `TELNYX_PUBLIC_KEY`, `MCP_TOKEN` and `OPS_TOKEN` (binding = name).
  - Run `telnyx-edge types` and commit the generated `telnyx-env.d.ts`.

  **Behaviours** (every route logs exactly one `log.ts` JSON line `{ts,lvl,svc:"noc-probe",evt,…}`; B-LOG applies to all of them):

  | ID | Route | Behaviour |
  |---|---|---|
  | B-LOG | all | Phone-like strings (`+` followed by 8-15 digits) are masked as `+NNNN****NNN` (first 4 and last 3 digits kept) wherever they appear in logged values. `authorization` headers are logged only as `present`/`absent`/`valid`/`invalid`. The signature header values are logged as `present`/`absent`. |
  | B-HEALTH | `GET /health/liveness` | Returns `{ok:true, instance, startedAt, uptimeMs, node: process.version}`. `instance` is a module-level `crypto.randomUUID()` created at module load, so a changed `instance` reveals a restart or cold start. |
  | B-UNH | module load | Registers `process.on('unhandledRejection', …)` if `process.on` exists, logging `evt:"unhandled_caught"`. Logs `evt:"boot"` with `hasProcessOn`. |
  | B-AUTH | `/diag/*` | Requires `Authorization: Bearer <OPS_TOKEN>` (constant-time compare, via `crypto.subtle` or `timingSafeEqual`). Otherwise 401 `{error:"unauthorized"}`. Secrets are read via `env.SECRETS.get(name)`, memoised per instance only after a successful read. |
  | B-BIND | `GET /diag/bindings` | Returns `{importedKeys, fetchArgKeys, kvViaImported, kvViaFetchArg}`. The KV probes put `diag/probe` (TTL 300) and read it back through each env; values are `"ok"`, `"miss"`, `"absent"` or `"error:<msg>"`. |
  | B-ARM | `GET /diag/arm` | `PROBE.idFromName("probe1").armAlarm(10000, token)`. The actor stores `alarm_armed {when, token, armedAt}`, calls `this.ctx.storage.setAlarm(when)`, logs `evt:"actor_log_probe" where:"armAlarm"`, and returns `{armedFor, token}`. |
  | B-ALARM | actor `alarm(info)` | Stores `alarm_fired {firedAt, lagMs, retryCount, token}` and logs `evt:"actor_log_probe" where:"alarm"`. |
  | B-STATUS | `GET /diag/status` | Returns the actor's `{armed, fired, pendingAlarm: await getAlarm(), actorEnvKeys}`. |
  | B-PING | `GET /diag/actor-ping` | Returns `{actor_ms}`, the wall time of one `ping()` RPC (which returns `Date.now()`). |
  | B-UNHTEST | `GET /diag/unhandled` | Creates an **unawaited** `Promise.reject(new Error("probe"))` after a 50 ms timer, then immediately returns `{scheduled:true, instance}`. (The next `/health/liveness` shows whether the instance survived.) |
  | B-DV | `POST /dv` | Reads the raw body. Verifies Ed25519 over `` `${telnyx-timestamp}\|${raw}` `` with `TELNYX_PUBLIC_KEY` (base64, raw 32-byte key; WebCrypto `Ed25519`), but **does not enforce**: it logs `sig: valid\|invalid\|absent\|error`. Logs `evt:"dv.probe"` with the **key paths** of the body (e.g. `data.payload.call_control_id`) and the values of `event_type`, `telnyx_conversation_channel` and `assistant_id`, plus the masked caller. `call_key` = `data.payload.call_control_id` if it is a non-empty string, else `"dv-" + uuid.slice(0,8)`. Returns HTTP 200 `{dynamic_variables:{probe_route:"b", probe_num:"3", greet_name:"Fahad", call_key, trace_id:"t-"+(sha256 hex of call_key).slice(0,16)}, conversation:{metadata:{call_key, trace_id}}}`. |
  | B-ECHO | `POST /tools/echo` | Verifies and logs the signature exactly like B-DV (not enforced). Logs `evt:"tool.echo"` with all request header **names** plus the values of `x-telnyx-call-control-id`, `x-trace-id` and `content-type`, and the body with every value shown **verbatim except masked phones**. That shows whether the preset `{{…}}` values arrived resolved or literal. Returns 200 `{result:"stored", call_key: <body.call_key if non-empty, not "none", and not containing "{{"; else "tool-"+uuid8>}`. |
  | B-MCP | `POST /mcp` | A bearer `MCP_TOKEN` check (401 otherwise; log `auth` status). Then a **wire-log line** (method, jsonrpc `method`, header names, `accept`, `mcp-protocol-version`, `params._meta` verbatim). Then normalise: set `accept: application/json, text/event-stream`, delete `params._meta.progressToken` if it is `null`. Then a new `McpServer` + `WebStandardStreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true})` per request, with `handleRequest(normalized, {parsedBody})`. GET and DELETE → 405. Tools: `echo_probe({text})` returns text `"echo: <text>"` and logs `extra._meta`; `slow_probe({ms})` sleeps `min(ms, 25000)` and then returns. |

- [ ] **Step 3 🏗: Review the diff** against the table above: B-LOG masking, no secret values logged, B-UNHTEST really unawaited, and no floating promise anywhere else. Then run `npx tsc --noEmit`. **Expected:** it passes.
- [ ] **Step 4 🏗: Ship.** `telnyx-edge ship` (about 2-3 min). Then `telnyx-edge inspect noc-probe` to capture `PROBE_URL`. Record the ship time as T0.
- [ ] **Step 5 🏗: Smoke checks**, using `source .env` without echoing:
  - **4.1** `curl -si $PROBE_URL/health/liveness`. Expected: 200 JSON plus an `x-envoy-upstream-service-time` header. (A bare Go `404 page not found` on a Ready function means issue #12: stop and escalate.)
  - **4.2** `curl -s -H "Authorization: Bearer $OPS_TOKEN" $PROBE_URL/diag/bindings`. Expected: which env carries KV. **Record this.**
  - **4.3** `/diag/arm`, then `sleep 20`, then `/diag/status`. Expected: `fired` present and `pendingAlarm` null means **prod alarms work**. **Record this.**
  - **4.4** `telnyx-edge logs noc-probe --since 10m -n 250 --json | grep actor_log_probe`. Present means actor logs are visible. **Record this.**
  - **4.5** `/diag/unhandled`, then `sleep 2`, then `/health/liveness`. The same `instance` means the rejection was survived. Also grep the logs for `unhandled_caught`. **Record this.**
  - **4.6** `curl -s -o /dev/null -w "%{http_code}" $PROBE_URL/diag/bindings` (no token). Expected: `401`.
  - **4.7** `curl -s -X POST $PROBE_URL/mcp -d '{}'` (no token). Expected: `401`.
  - **4.8** Unsigned `POST /dv` with `{"data":{"payload":{}}}`. Expected: 200, with a log line showing `sig:"absent"`.
- [ ] **Step 6 🏗: Measure cold start.** At ≥ 15 min idle after the last request: `curl -s -o /dev/null -w "total=%{time_total}\n" -D - $PROBE_URL/health/liveness | grep -i x-envoy`. Take ≥ 2 samples across the day, and note whether `instance` changed. **This sets `dynamic_variables_webhook_timeout_ms`** (spec §5.5).
- [ ] **Step 7 🤖/🏗: Commit** with `feat(probe): noc-probe diagnostics function` (the source only; the smoke results go to Task 6).

---

### Task 5: Probe assistant as code

**Files (🤖):** `assistant/probe/tools.json`, `assistant/probe/mcp.json`, `assistant/probe/assistant.json`, `scripts/probe-apply.mjs`

**Interfaces:**
- Consumes: `telnyx()` from `scripts/lib/telnyx.mjs`, `PROBE_URL`, `.env` `MCP_TOKEN`.
- Produces: `.state/probe.json` (gitignored; add `.state/` to `.gitignore`) holding the IDs of the integration secret, the MCP server, the 3 tools and the `sanad-noc` assistant.

- [ ] **Step 1 🤖: Dispatch** with `--model telnyx/moonshotai/Kimi-K3`. **`probe-apply.mjs` behaviour:**
  - Idempotent, keyed by name. It looks up existing resources by name before creating any. `sanad-noc` is created once and afterwards **updated** with `POST /v2/ai/assistants/{id}`.
  - After every write, it **GETs the resource back** and diffs the fields it sent (deep-equal on the sent subset). Any mismatch is printed as `DRIFT <path> sent=<v> got=<v>`. This catches silently ignored fields.
  - It replaces `${PROBE_URL}` placeholders in the JSON.
  - It prints only IDs.

  **Resources to create:**

  1. **Integration secret:** `POST /v2/integration_secrets {identifier:"noc_mcp_token", type:"bearer", token: MCP_TOKEN}`. If the identifier already exists, skip; tokens aren't readable back.
  2. **MCP server:** `POST /v2/ai/mcp_servers {name:"noc-mcp-probe", type:"http", url:"${PROBE_URL}/mcp", api_key_ref:"noc_mcp_token", allowed_tools:["echo_probe","slow_probe"]}`.
  3. **Shared tools** (`POST /v2/ai/tools`):
     - `probe_capture`: `{type:"update_dynamic_variables", display_name:"probe_capture", update_dynamic_variables:{name:"probe_capture", description:"Save the caller's word.", updatable_variables:[{name:"probe_word", type:"string", description:"The single word the caller said."}]}}`
     - `probe_echo`: `{type:"webhook", display_name:"probe_echo", timeout_ms:5000, webhook:{name:"probe_echo", description:"Echo the saved word to the server.", url:"${PROBE_URL}/tools/echo", method:"POST", body_parameters:{type:"object", properties:{probe_word:{type:"string", description:"The saved word."}}, required:["probe_word"]}, preset_body_fields:{call_control_id:"{{call_control_id}}", call_key:"{{call_key}}", trace_id:"{{trace_id}}", conv_probe:"{{telnyx_conversation_id}}"}, headers:[{name:"X-Trace-Id", value:"{{trace_id}}"}], store_fields_as_variables:[{name:"echo_result", value_path:"result"},{name:"call_key", value_path:"call_key"}]}}`
     - `probe_hangup`: `{type:"hangup", display_name:"probe_hangup", hangup:{description:"End the call."}}`

     Record whether each creation succeeds. **This is probe item P0-3c-bis: can hangup be a shared tool via the API?**
  4. **Assistant `sanad-noc`:**
     - `model`: `moonshotai/Kimi-K2.6`
     - `instructions`: "You are a probe assistant. Follow the current step's instructions exactly. Keep every reply under 15 words."
     - `greeting`: `"<assistant-speaks-first-with-model-generated-message>"`
     - `voice_settings`: `{voice:"Telnyx.KokoroTTS.af_heart"}`
     - `transcription`: `{model:"deepgram/nova-3", language:"en"}`
     - `interruption_settings`: `{disable_greeting_interruption:true}`
     - `telephony_settings`: `{time_limit_secs:300, supports_unauthenticated_web_calls:true}`
     - `dynamic_variables_webhook_url`: `"${PROBE_URL}/dv"`
     - `dynamic_variables_webhook_timeout_ms`: `5000`
     - `dynamic_variables`: `{probe_route:"a", probe_num:"0", greet_name:"default-name", probe_word:"none", echo_result:"none", call_key:"none", trace_id:"t-none"}`
     - `tool_ids`: `[<probe_capture id>]` **only**
     - `mcp_servers`: `[{id:<mcp id>, allowed_tools:["echo_probe","slow_probe"]}]`
     - `conversation_flow`: the table below

  **Probe workflow nodes** (IM = `instructions_mode`, STI = `shared_tool_ids`, TM = `tools_mode`):

  | id | type | content | IM | STI / TM |
  |---|---|---|---|---|
  | `s_start` (**start**) | speak | "Probe start. Hello {{greet_name}}. Route {{probe_route}}, number {{probe_num}}." | n/a | n/a |
  | `s_num` | speak | "Numeric edge fired." | n/a | n/a |
  | `s_str` | speak | "String edge fired." | n/a | n/a |
  | `s_def` | speak | "Default edge fired." | n/a | n/a |
  | `n_word` | prompt | "Ask the caller to say any single word. When they say it, call probe_capture to save it as probe_word, then say: saved." | append | `[probe_capture id]` / replace |
  | `t_echo` | tool | `shared_tool_id`: probe_echo, which is **not in tool_ids** | n/a | n/a |
  | `s_echo` | speak | "Echo result {{echo_result}}. Word {{probe_word}}. Key {{call_key}}." | n/a | n/a |
  | `n_mcp_null` | prompt | "Call the MCP tool echo_probe with text null-node, then tell the caller exactly what it returned." | append | `null` |
  | `n_mcp_replace` | prompt | "Call the MCP tool echo_probe with text replace-node. If no such tool is available to you, say: no tool available." | append | `[probe_capture id]` / replace |
  | `s_end` | speak | "Probe complete. Goodbye." | n/a | n/a |
  | `t_hang` | tool | `shared_tool_id`: probe_hangup (not in tool_ids) | n/a | n/a |

  **Probe workflow edges** (in order):

  | from | condition | to |
  |---|---|---|
  | `s_start` | 1. expr `probe_num >= 3` (**number_literal**) | `s_num` |
  |  | 2. expr `probe_route == "b"` (**string_literal**) | `s_str` |
  |  | 3. default | `s_def` |
  | `s_num`, `s_str`, `s_def` | default | `n_word` |
  | `n_word` | expr `probe_word != "none"` | `t_echo` |
  | `t_echo` | 1. expr `or(telnyx_last_tool_status_code == "200", telnyx_last_tool_status_code == 200)` | `s_echo` |
  |  | 2. default | `s_end` |
  | `s_echo` | default | `n_mcp_null` |
  | `n_mcp_null` | llm "The assistant has told the caller what echo_probe returned, or said it could not call it." | `n_mcp_replace` |
  | `n_mcp_replace` | llm "The assistant has said the echo_probe result or said no tool is available." | `s_end` |
  | `s_end` | default | `t_hang` |

- [ ] **Step 2 🏗: Review.** Check that the JSON matches the tables exactly, that apply is idempotent (run it twice; the second run creates nothing) and that the DRIFT check works. **Expected:** the second run prints `exists` for every resource, and no DRIFT lines. Any DRIFT line is a finding: record it, and fix the config shape if the API renamed a field.
- [ ] **Step 3 🏗: Run** `node scripts/probe-apply.mjs`. If a tool node referencing a tool **not** in `tool_ids` is **rejected at write time**, that answers P0-3c ("no"). Record the error, add `probe_echo` and `probe_hangup` to `tool_ids`, and continue.
- [ ] **Step 4 🤖/🏗: Commit** with `feat(probe): probe assistant, tools and MCP registration as code`.

---

### Task 6: Run the probe and decide

**Files (🤖, from the facts the architect supplies):** `docs/evidence/probe-results.md`, `DEBUGLOG.md` (new entries), `DOGFOODING.md` (the per-task log so far)

- [ ] **Step 1 🏗: Start a live log capture.** `telnyx-edge logs noc-probe --tail --json > ~/code/telnyx-fde/research/probe/run1.jsonl` in the background. This is raw data outside the repo, because it may contain unmasked platform data.
- [ ] **Step 2 👤: Web call #1.** Portal → AI Assistants → `sanad-noc` → **Test / call in browser**.
  1. Listen to the opening and note it word for word.
  2. When asked, say one word, e.g. **"banana"**.
  3. Listen to the echo line.
  4. Let it run through both MCP steps and the goodbye.
  5. Afterwards, open the conversation in the Portal and note the **node labels** per message and the **Dynamic Variable Webhook Logs** tab.
  6. Tell the architect what you heard, in order.
- [ ] **Step 3 🏗: Collect the platform-side evidence.**
  1. `GET /v2/ai/conversations?limit=5` (newest), then `GET /v2/ai/conversations/{id}/messages`. Extract `role`, `text`, `tool_calls`, `metadata.flow_node_id` for each message, and the conversation `metadata`.
  2. `grep` `run1.jsonl` for `dv.probe`, `tool.echo`, `mcp.*`, `sig`.
- [ ] **Step 4 🏗: Fill in the decision table.** Each row needs two independent witnesses: our log *and* the transcript.

  | # | Question | Witnesses | If YES | If NO |
  |---|---|---|---|---|
  | P0-3a-1 | DV fired on the web call? | `dv.probe` log + DV Webhook Logs tab | Web calls are a full test channel | P12-style defaults only on web; spec C14 holds; test DV routing only once a number exists (tell Telnyx Team) |
  | P0-3a-2 | DV payload keys: `call_control_id` present on web? A conversation-id key? | `dv.probe` key paths | Set the spec's `call_key` source order | Keep the minted-key path (spec §5.1) |
  | P0-3a-3 | `sig: valid` on `/dv`? | log | Enforce 403 in core as designed | **Stop.** Debug the key format (base64 vs PEM) before core. |
  | P0-3b | Tool echo: `x-telnyx-call-control-id` header present? Preset `{{call_control_id}}`, `{{call_key}}`, `{{trace_id}}`, `{{telnyx_conversation_id}}` resolved (not literal)? `sig` valid? | `tool.echo` log | Spec §7 identity sources confirmed | Use `call_key` only. The conversation join relies on the Conversations API (spec §6.4). |
  | P0-3c | Tool node ran a shared tool **not** in `tool_ids`? | `tool.echo` log exists + `t_echo` label in transcript | Keep spec §4.1 (`tool_ids = [capture_details]`) | Use spec §4.1 fallback (a) or (b), depending on P0-3d |
  | P0-3d | Does `replace` hide MCP? `echo_probe text=replace-node` absent from `mcp.*` logs **and** "no tool available" spoken, while `null-node` **is** present? | `mcp.*` logs + transcript | Keep MCP nodes at `STI: null` (the spec as written) | MCP survives `replace`: explicit per-node lists become possible. Record it as a README finding either way. |
  | P0-3e | Which `s_start` edge fired: numeric (string "3" coerced) / string / default? | label after `s_start` + words heard | numeric → `number_literal` is usable on DV strings; string → **strings only** (spec default) | default → speak-start expression edges are ignored → the spec §4.1 greeting fallback |
  | P0-3f | Turn model: which node's label is on the reply to "banana"? Did `n_word` speak unprompted after `s_num`? | transcript labels | Documented in the spec §4.4 note | same |
  | P0-3g | Did `s_echo` say "stored" and the minted/DV `call_key`? (`store_fields` → speak) Did `probe_word` interpolate? | words heard + transcript | `s_confirm`/`s_pin_retry` stay speak nodes | They become prompt nodes (spec §4.4 fallback) |
  | P0-3h | Was the first thing heard the `s_start` text (greeting sentinel works)? Could you talk over it? | words heard | Keep the sentinel | Spec §4.1 greeting fallback |
  | P0-2 | KV env / alarms / actor logs / unhandled / cold start | Task 4 Step 5-6 records | — | — |

  Actions by result:
  - **KV env:** use the env the probe proved works.
  - **Alarms:** if they don't fire, the §12.1 `tick()` fallback, unclaimed.
  - **Actor logs:** if invisible, return diagnostics, as designed.
  - **Unhandled rejections:** if the process doesn't survive them, `deadline()` discipline is critical. Add a lint rule.
  - **Cold start:** sets `timeout_ms` per spec §5.5.
- [ ] **Step 5 👤 (only if needed): Web call #2.** Re-run once if any row is ambiguous (e.g. a network blip). Change **one** variable per re-run via `probe-apply` (e.g. `probe_num` returned as `"2"` to isolate the string edge).
- [ ] **Step 6 🏗: Update the spec.** Add §18 "Probe results (2026-09-26)" with the resolved rows. Edit every section a fallback was triggered for, and commit as an architect artifact (`docs: spec §18 probe results; fallbacks resolved`).
- [ ] **Step 7 🤖: Dispatch** with `--model telnyx/zai-org/GLM-5.3`. It writes `docs/evidence/probe-results.md` (the decision table with the witness lines quoted, masked). It appends `DEBUGLOG.md` entries for any surprise found (symptom → signal → evidence → decision), and appends the per-task log to `DOGFOODING.md`. Commit with `docs: probe evidence and decisions`.
- [ ] **Step 8 🏗: Hand off.** Plan 1 (core) is finalised with these results, and the probe function stays deployed until core ships (then `telnyx-edge delete-func noc-probe`, after exporting its logs).

---

## Self-review (architect)

- **Spec coverage:**
  - §17.1 P0-1 → T1 S1 + T3.
  - P0-2 → T4 S5-S6.
  - P0-3a…h → T5 + T6.
  - §14.2 setup, deny rules, env → T1 + T2.
  - §10 secret hygiene → T2 S5.
  - C1 evidence → T2 DEBUGLOG #1.
  - Not covered in Plan 0, by design (build-time, spec §17.2): MCP tool timeout (`slow_probe` is available for it), transfer, fraud prefix, phone-call headers (no number exists).
- **Placeholders:** none. The model IDs are resolved by T1 S5, and the KV ID by T3.
- **Name consistency:**
  - Tools: `probe_capture`, `probe_echo`, `probe_hangup`.
  - Secret identifier: `noc_mcp_token`.
  - Assistant: `sanad-noc`.
  - Env: `MCP_TOKEN`, `OPS_TOKEN`, `NOC_OPS_TOKEN`, `PIN_PEPPER`, `TELNYX_PUBLIC_KEY`.
  - These names are used identically in T2-T6.
- **Review Focus:** items 1-5 map to T2 S5/S7, T4 S5 (4.6-4.8), T1 S1/T3, T4 B-LOG/T6 S1, and T6 S4 respectively.
