# DOGFOODING.md

What it is like to build this project with OpenCode on Telnyx-hosted models. Facts recorded per task; no invented numbers.

## Setup

- `npm i -g opencode-ai@1.18.32` on linux aarch64 (DGX Spark) works natively. The npm global prefix bin directory (`~/.hermes/node/bin`) is not on PATH, so the binary was symlinked into `~/.local/bin`.
- `opencode plugin @telnyx/opencode`, run inside the git repo, writes `.opencode/opencode.json` and `.opencode/tui.json` with `"plugin": ["@telnyx/opencode"]`, scope local.
- `opencode auth login --provider telnyx --method "API Key"`: `--method` takes the literal method name "API Key". (A user who passed the key there got the error "Unknown method … Available: API Key" — and that error ECHOES the key.) The flow asks for the key twice: first a plain-text prompt (the plugin, used to fetch models), then the models choice, then a masked prompt. OpenCode stores the credential in `~/.local/share/opencode/auth.json`.
- "All hosted Telnyx models" enabled 17 models including Kimi-K3 and GLM-5.3. The plugin default list excludes Kimi-K3: `opencode run --model 'telnyx/moonshotai/Kimi-K3'` fails on the default list until the models are enabled.

## Model choice

- Pricing, per 1M tokens in / cached / out: Kimi-K3 2.70/0.27/13.50 · GLM-5.3 1.25/0.24/4.00 · GLM-5.3-Flash 0.135/0.027/0.45 · DeepSeek-V4-Flash 0.13/0.03/0.26.
- `opencode stats --models` shows $0.00 cost for Telnyx models (no pricing metadata), so spend must be measured from the Telnyx balance.
- Default routing for this repo: GLM-5.3-Flash for mechanical tasks (scaffold, boilerplate, docs), per spec §14.4. Known risk on this model: see "What didn't" below (silent stop with `reason=length`).

## Per-task log

| Task | Model | Wall time | Cost | Notes |
|---|---|---|---|---|
| 1 (probe smoke) | telnyx/moonshotai/Kimi-K3 | 3.7 s | $0.00 in stats; balance not yet read | 6.9K input tokens for a one-line prompt: OpenCode system prompt + tool schemas resent every call |
| 2 (repo scaffold, attempt 2c) | telnyx/zai-org/GLM-5.3-Flash | — | ≈$0.07 | 43 steps, 42 tools; tokens in=150166 cache_read=1604864 out=20325; 8/8 tests; commit `4297baf`. Attempt 1 (silent stop, DEBUG #2) and attempt 2b (stdin hang, DEBUG #3) produced no work |
| 2 fix round 1/5 | telnyx/zai-org/GLM-5.3-Flash | — | (included in balance totals) | 1 Important addressed (bearer regex case-sensitivity), 0 open; commits `4297baf..735b479` |
| 3 (secrets + setup scripts) | telnyx/zai-org/GLM-5.3-Flash | — | ≈$0.04 | 33 steps, 1 auto-continuation; tokens in=98721 cache=785920 out=21413; 17/17 tests; commit `54d71a2` |
| 3 fix round 1/5 | telnyx/zai-org/GLM-5.3-Flash | — | (included in balance totals) | 1 Important addressed (unguarded stderr path), 0 open; commits `54d71a2..d2e36b7` |
| 4 (edge function) | telnyx/zai-org/GLM-5.3-Flash | — | ≈$0.12 | 61 steps, 68 tools; tokens in=211578 cache=2693504 out=42912; 41 vitest + tsc clean; commit `86baa8f` |
| 5 (assistant-as-code) | telnyx/zai-org/GLM-5.3-Flash | — | ≈$0.05 | 28 steps; tokens in=129317 cache=816768 out=28195; 46/46 root tests; commit `0f4cffa` |
| Re-run adjustment (R13) | — | — | (included in balance totals) | Task 4 implementation started before Task 3's run step: Task 4 only needs the KV id at ship time (placeholder in manifest); ship waits for `setup-edge.sh` |

Preflight (T3 S4) balance read 2026-09-26: $4.78 remaining from a $5.00 start — measured spend ≈$0.22 for T1–T5 including fix rounds and debug runs.

Smoke command: `opencode run --model telnyx/moonshotai/Kimi-K3 "Say hello in one sentence."` → 3.7 s wall; 6.9K input tokens for a one-line prompt (OpenCode system prompt + tool schemas resent every call).

## What worked

- OpenCode installs natively on linux aarch64; no Rosetta/emulation needed.
- The plugin scaffolds local config in the repo with a single command.
- Auth login completed end to end; the masked prompt path stores the credential in `auth.json` as expected.
- The smoke run on Kimi-K3 answered correctly (one sentence) with fast wall time.
- The independent-review loop (Claude reviewers over OpenCode implementer output) caught real defects: Task 2's review found a case-sensitive bearer regex (lowercase/uppercase `bearer` not detected in the secret scanner); Task 3's review found an unguarded stderr path (possible secret echo on CLI failure). Both were fixed in one fix round each; Tasks 4 and 5 came back Approved with 0 Critical/Important.
- GLM-5.3-Flash cost: ≈$0.22 for all of Plan 0 coding (balance $5.00 → $4.78), covering Tasks 2–5 including fix rounds and debug runs.

## What didn't

- DEBUG #2: GLM-5.3-Flash silent stop — exit 0, 3 tool calls, step_finish reason=length output=0 reasoning=8193 (20.6K tokens). Plugin 0.1.5 `dist/index.js`: `output.maxOutputTokens = void 0` (L280); `THINKING_CAPABLE_MODELS` (L19-25) lacks GLM-5.3*/Kimi-K3; variants thinking/no-thinking only defined for listed models.
- The auth-login error for a wrong `--method` value echoes the API key back in the terminal — a real secret-leak surface; avoid mistyping `--method`.
- DEBUG #3: `opencode run` hung 40 minutes with zero events (exit 124) — harness stdin is an open socket and `opencode run` reads non-TTY stdin as extra prompt, waiting for EOF forever. Fix: always run with `< /dev/null`.
- The model ran a script it was told not to (Task 3: executed `preflight.mjs` without `.env` → the harmless missing-key path; process deviation, no code defect, no account touch). Future prompts state prohibitions as "must not run under any circumstances".

## Plan 1 build (2026-09-26 → 27)

OpenCode-authored commits on this repo: `git log --grep "Assisted-by: OpenCode" --oneline | wc -l` → **41**.

Per-task findings caught by the independent reviewers (from the SDD ledgers):

| Task | Review findings |
|---|---|
| T4 SiteState | 2 CRITICAL: the site-wide PIN lock was never persisted when one attempt crossed both the per-call and site thresholds (if/else) → a valid PIN passed a should-be-locked site; `recordCall` idempotency used the 10-item display list → a repeat caller was double-counted after 10 other callers/day |
| T5 RegionState | Important: `declare` hard-coded P2 even at ≥3 sites; no never-downgrade regression test; multi-key writes outside `ctx.storage.transaction()` (rejected on evidence — turns commit atomically) |
| T6 services | Important: the projection summary read raw site ids to the caller; the `flags.read` memo was not keyed by the KV port (proven leak) |
| T7 /dv | Important: a signed-but-malformed body → 400 instead of fail-open 200 with defaults (reviewer verified the budget arithmetic adversarially) |
| T8 tool webhooks | Important: `open_ticket` mixed 403/422 for a missing site; re-review found a NEW CRITICAL regression: `join_incident` no-session → 422 instead of 403 |
| T9 MCP | Important: duplicate `auth.denied` on one denial; `mcp.tool` outcome always "ok" for denials/fallbacks (zero trace). Tenant isolation held on every probed vector |
| T10 ops/health | Important: the sync healed only projection keys already present in `kv.list` — a never-written projection was never healed (must iterate regions via actor truth) |
| T11 assistant-as-code | 2 Important: inherit nodes lacked an explicit `tools_mode` (C7) — accepted; `incident_note` treated as a dead field — rejected (it is a real response field) |
| T11b mux mode | CRITICAL: `/dv` could return 500 when KV threw (violating C3 fail-open), and a fresh KV port per call defeated the flags memo (12 KV gets per `/dv`) |
| T12 prober/runbook | 3 Important (2 confirmed as cross-task contract items delivered by T12b, 1 refuted by the skeptic) |
| T12b recalibration | The implementer report **falsely claimed a test existed** for the `/dv` SAFE_FLAGS fallback branch — the fix added the missing router test |
| T12c concurrency | 0 Critical/Important; the callback latency threshold was tightened 2500→2000 ms (the specced bound could not fail on the old code) |

Spend: the $5.00 promo was exhausted by ~05:52 (balance $0.26 at the hard stop; the R18 credit floor stopped dispatches at $0.35/$0.25); Fahad topped up **$25** (resulting balance $25.24). Measured ≈ **$0.25–0.30** per GLM-5.3-Flash implementer run (T11: 527k fresh input + 6.16M cached + 60k out tokens); fix rounds **$0.02–$0.14**.

What worked:

- Terse AGENTS.md rule 11 (8K output cap, no plan dumps in chat) + `--variant no-thinking` — no silent length stops after DEBUG #2.
- Auto-continue on step finish `reason=length`; always `< /dev/null` for stdin (DEBUG #3).
- Headless implementer runs in parallel git worktrees (R17/R27): T11b, T12, T12b and T12c were built concurrently on disjoint files and cherry-picked onto one integration branch.

What didn't:

- Silent length stops: exit 0 with zero output (DEBUG #2) — caught only by the wrapper's finish-reason check.
- Long continuations on big tasks: T11 needed 527k fresh input + 6.16M cached tokens in one session; fresh, tightly scoped fix sessions were cheaper and more reliable.
- Implementer reports sometimes overstate test coverage (T3: a "compliant" file had a raw phone-digit literal; T12b: a claimed test did not exist) — reviews treat reports as unverified claims and verify against the diff.

## Plan 2 build (2026-09-27 → 28)

Stretch goals: actor alarms, live NOC console, object-storage reports, Arabic mode. Same process: architect (Claude) plans and rules, OpenCode implements, independent lens reviews confirm/refute before merge.

- **Parallel lanes in git worktrees (R2):** Lane A (edge/actors: P2-1 alarms → P2-2 paging → P2-3 console → P2-4 reports) and Lane B (assistant: P2-5 Arabic → P2-6 voice) ran simultaneously in worktrees `wt-p2a`/`wt-p2c`/`wt-t12…`-style branches on disjoint files (only `router.ts` was lane-A-only), then integrated onto main. Same pattern as Plan 1's R17/R27, applied at plan scale.
- **Models used:** GLM-5.3-Flash for the default implementer lanes; the NOC wall page got an explicit model upgrade — first `telnyx/zai-org/GLM-5.3` (dark wall, committed), then Kimi-K3 for a redesign (R5/R7: Langfuse-dark + real fonts); **both versions were rejected by the product owner** ("AI awful look"), so per R8 the final visual layer (`src/demo/page.ts` + tests) was designed and written by **Claude** on top of the tested OpenCode backend. Kimi-K3's Langfuse run was stopped before it wrote anything. The rest of the stack stayed OpenCode-authored.
- **Review catches worth telling:**
  - **P2-2 CRITICAL — page-id collision:** page ids were `incidentId:level`, and a P2→P1 upgrade resets `esc.level` → the post-upgrade page shared an id with an already-sent page and was never delivered; the prober's `claimedIds` cache masked it permanently. Fixed with a persisted monotonic `:pN` counter + regression test (DEBUGLOG #14).
  - **P2-4 CRITICAL — missing `region`:** the Cloud Storage binding needed `region`; the CLI validates it and the runtime silently skips a region-less bucket block. The architect's own prompt snippet omitted the field — the review caught it before ship (DEBUGLOG #13).
  - **P2-5 — mandatory actions as LLM tool calls:** the architect's Arabic flow design let transfer/hangup depend on the LLM calling the tool in the same turn as the spoken line — exactly the pattern probe P0-3f had already found unreliable on Kimi-K2.6. An architect design flaw, not an implementer defect, caught by review and fixed with deterministic tool-node exits (R6/R10).
  - **P2-3 — board cache TTL counted from build start:** a build slower than 8 s was abandoned while a second concurrent build re-hit the single mux actor (load amplification on the one working instance). Fixed: pending builds are always joined; the window starts when a build settles.
  - **The driver-agent answered the user's chat instead of running its task:** during Plan 2 an interactive OpenCode agent session started conversing with the user instead of executing the dispatch. The fix was to launch OpenCode directly (`opencode run` per task) rather than through an agent driver.
- **Spend:** balance **18.71 USD** at 01:0x on 2026-09-28 after the 25 USD top-up.

## Plan 3 build (2026-09-28 → 29)

The account became **verified**, unlocking the phone line and the second assistant. OpenCode-authored commits on top of c7943f8: **12** (89 of 112 total as of `e6c9772`). Same architect/implementer/reviewer split; GLM-5.3 (Flash) implementer lanes, plus one Kimi-K3 lane for the KV-free fix.

- **Verified-account work:** bought the US number (balance 12.45 → 11.35 USD), built `sanad-noc-ar` as a true second assistant reached by a one-way workflow handoff, applied both assistants live, and shipped the production front page with its hidden operator console.
- **Parallel lanes:** P3-3a (assistant config/validator) and P3-3b (edge) ran concurrently in worktrees `wt-p3-3a`/`wt-p3-3b`; P3-4a/b/c (Arabic opening + prober hang classification / edge throttles / flags cooldown) launched together from `11e7296` — same pattern as Plan 1's R17/R27 and Plan 2's lanes.
- **The reviews and live applies caught real issues:**
  - **Null keyterm on readback:** the first live apply of `sanad-noc-ar` failed its own read-back — `validateAssistant` rejected `transcription.settings.keyterm = null` (the platform echoes `null` for every unset STT setting), and apply exited 1 before touching the English assistant. Fix: treat `null` exactly like absent; still reject `""`/non-string (ruling P3-R4).
  - **The Arabic hangup:** the architect's 13-node Arabic flow had no end-call exit — an Arabic call would idle until `user_idle_timeout` (60 s). Caught as an implementer doubt before apply; `t_ar_hangup` added (ruling P3-R1).
  - **The MCP key that must be sent as `[]`:** live finding — omitting `mcp_servers` on an assistant update keeps the platform's previous value (the Arabic assistant still had MCP after the apply), and the subset diff only compares sent keys, so the drift was invisible. Fix: send an explicit `[]` with a read-back check (ruling P3-R8).
  - **The flags-cooldown contract:** a review confirmed the negative flags memo resolved with **synthetic flags** — callers would lose the degraded/fallback signal entirely. Fix: the cooldown **rejects fast** (`flags_cooldown`, no KV, no synthetic flags); callers' existing safe fallbacks run unchanged; the unbounded-age `FALLBACK_FLAGS` fallback was dropped (ruling P3-R9).
  - **The 150 ms regression that came from a review suggestion:** the secret-read review finding ("no per-attempt timeout") was fixed with a **150 ms** cap nobody had measured — `SECRETS.get` really takes > 150 ms, so every secret read failed and the signed routes + MCP auth failed closed for ~1 h (DEBUGLOG #17). Caught within minutes by the new `secret.read_failed` logging; the rollback API timed out twice, so a revert-forward (`a94722c`) shipped.
- **Multi-agent root-cause analysis:** during the Telnyx platform incident (DEBUGLOG #15) a read-only multi-agent RCA (workflow `wf_9af00a79-9ff`) pulled the full 24 h of logs (20,536 invocations, 109,897 runtime lines), split platform cause (actor runtime + KV data plane) from our amplifiers, and ran a dedicated **challenger lane** whose corrections were folded back in — it caught an undercount of ~4–5× (single 250-record page vs paged windows), a misread host log, and rejected several planned fixes that would have broken the documented detection contract (10 s prober cadence and 30 s paging kept; 60 s sync throttle reduced to 30 s).
- **Spend — inference is the cost driver** (usage reports): 2026-09-27 inference **13.10 USD**, edge-compute 0.95, ai-voice-assistant 0.70; 2026-09-28 inference **1.06**, edge-compute 0.25, ai-voice-assistant 0.10. The overnight balance drop was OpenCode authoring, **not** the 10 s prober — keep the prober. Latest ledger balance: **11.35 USD** after buying the number.

## Cost table, the Kimi-K3 burn, and the credit floor

Where the money actually went (usage reports; total spend since 2026-09-26 is **$31.44**, of which **$27.22** is Telnyx inference):

| Date | Inference (OpenCode) | Edge Compute | AI voice assistant | Balance notes |
|---|---|---|---|---|
| 2026-09-26 | ≈$0.22 measured (T1–T5 + fix rounds) | — | — | $5.00 promo → $4.78 |
| 2026-09-27 | **13.10** | 0.95 (prober, calls) | 0.70 (browser calls #1–#4) | $25 top-up → 25.24 |
| 2026-09-28 | **1.06** | 0.25 | 0.10 (PSTN calls #5/#6) | number bought 12.45 → 11.35 |
| 2026-09-29 | **≈$11 in one ~11-min Kimi-K3 lane** (88 steps, 10.0M cache-read tokens) | — | — (inference suspended) | 10.69 → **−0.75** → suspended |

- **Per call:** the 09-28 usage report billed $0.10 of AI voice-assistant for a day that included PSTN calls #5/#6 and the browser handoff calls — the voice line costs pennies per call; edge-compute for the same day was $0.25 (the prober included). Inference for *coding*, not voice, is the cost driver.
- **The Kimi-K3 suspension:** the KV-free lane (P3-8) ran on `telnyx/moonshotai/Kimi-K3` per the product decision; the ~11-minute run burned ≈ **$11** and took the balance from 10.69 to **−0.75 USD**. The account was then refused inference for **all** models (403 20015 "User account is not enabled for inference" — so the voice assistants could not run either), and Cloud Storage returned `403 UserSuspended` (09-30 10:43Z). Both restored with the 2026-10-01 04:51Z top-up (balance 34.21 USD); the lane was finished by GLM-5.3.
- **Lesson — set a credit floor:** Plan 1 already had one for *cheap* lanes (R18: stop dispatching below $0.35, hard stop below $0.25). That floor is meaningless against a single expensive model: an unattended 11-minute run exceeded the entire remaining balance. Standing practice now: a **~$10 floor** for any OpenCode lane, model-aware (check pricing before dispatch — K3's per-token price is ~20× the Flash lane), and read the balance after every lane.

## Model choices (coding lanes)

- **GLM-5.3-Flash** — the default implementer for mechanical tasks (scaffolds, tests, config, docs): ≈$0.25–0.30 per run, fix rounds $0.02–0.14. The workhorse for Plans 1–2 and most of Plan 3.
- **GLM-5.3** — design- and prose-sensitive lanes (the NOC wall backend, README v2, this documentation lane): ~10× the Flash price, visibly better structured output.
- **Kimi-K3** — one lane (the KV-free voice path), chosen by product decision for its reasoning depth; the pricing lesson above came from it.
- **Voice model** — `moonshotai/Kimi-K2.6` on the assistants is a **platform constraint of this challenge (C10)**, not a coding-model choice; the Arabic line's voice (`Telnyx.Bayan.Reem`) and STT (`soniox/stt-rt-v5`) are picks, and the English TTS/STT A/B is still queued (no credit spent on it).
