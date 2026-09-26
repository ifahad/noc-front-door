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
