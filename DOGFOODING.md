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
| 2 (repo scaffold) | telnyx/zai-org/GLM-5.3-Flash | — | — | see task-2 report |

Smoke command: `opencode run --model telnyx/moonshotai/Kimi-K3 "Say hello in one sentence."` → 3.7 s wall; 6.9K input tokens for a one-line prompt (OpenCode system prompt + tool schemas resent every call).

## What worked

- OpenCode installs natively on linux aarch64; no Rosetta/emulation needed.
- The plugin scaffolds local config in the repo with a single command.
- Auth login completed end to end; the masked prompt path stores the credential in `auth.json` as expected.
- The smoke run on Kimi-K3 answered correctly (one sentence) with fast wall time.

## What didn't

- DEBUG #2: GLM-5.3-Flash silent stop — exit 0, 3 tool calls, step_finish reason=length output=0 reasoning=8193 (20.6K tokens). Plugin 0.1.5 `dist/index.js`: `output.maxOutputTokens = void 0` (L280); `THINKING_CAPABLE_MODELS` (L19-25) lacks GLM-5.3*/Kimi-K3; variants thinking/no-thinking only defined for listed models.
- The auth-login error for a wrong `--method` value echoes the API key back in the terminal — a real secret-leak surface; avoid mistyping `--method`.
- Kimi-K3 is absent from the plugin default model list until "All hosted Telnyx models" is enabled.
