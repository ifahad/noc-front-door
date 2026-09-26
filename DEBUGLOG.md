# DEBUGLOG.md

Blocking findings from the build, with evidence. One entry per finding.

## Entry template

```
## #<n> — <date> — <one-line title>
- Symptom: what is visibly wrong
- Signal: the exact message, code path or metric that surfaced it
- Evidence: where it can be reproduced (log line, portal screen, command)
- Hypothesis: best current explanation
- Fix: what was done, or the action in flight
- Verification: how the fix was proven, or what is still pending
```

## #1 — 2026-09-26 — No phone number can be ordered on the trial account (KSA origin)

- Symptom: The Telnyx Portal number search cannot order any number for the project; the account is trial with a Saudi Arabia origin.
- Signal: The Portal number search says: "Worldwide number coverage is only available to verified users. Your account is trial and only able to search and purchase local numbers in Saudi Arabia." Choosing Saudi Arabia returns "Telnyx does not have search coverage in this country." So no number can be ordered.
- Evidence: the Portal messages (screens seen by Fahad during the number search).
- Hypothesis: Trial accounts are limited to local numbers in Saudi Arabia, but Telnyx has no search coverage there, so ordering is impossible until the account is verified.
- Fix: Emailed Telnyx Team asking for Verified status on the account.
- Verification: Pending Telnyx Team's reply. Workaround in the meantime: web calls (the trial account supports web calls only anyway).
- Also: the brief's CLI URL (`telnyx-edge-linux-amd64`) does not match this aarch64 host; the v0.5.4 linux-arm64 asset was used instead.

## #2 — 2026-09-26 — OpenCode silent stop: exit 0 with no work done

- Symptom: `opencode run` (Task 2 attempt 1) exited 0 but produced no work — no files written, no commits.
- Signal: step finish `reason=length`, `output=0`, `reasoning=8193` (~20.6K tokens) — the model burned the whole output budget on reasoning tokens and emitted nothing.
- Evidence: `@telnyx/opencode` plugin 0.1.5 `dist/index.js`: `output.maxOutputTokens = void 0` (L280) strips the request's max output tokens, so the server default (~8192) applies; `THINKING_CAPABLE_MODELS` (L19-25) omits GLM-5.3/GLM-5.3-Flash/Kimi-K3, so thinking is on by default for these models and unbounded relative to the cap; the `thinking`/`no-thinking` variants are only defined for the listed models.
- Hypothesis: reasoning tokens consume the output budget before any tool call or text is produced; forcing the `no-thinking` variant stops the silent truncation.
- Fix: run with `--variant no-thinking`; architect wrapper `oc-run.sh` added, which fails loudly on silent truncation (non-empty output / finish-reason check); terse-agent rule added to AGENTS.md (cap ~8K output tokens; no plan dumps in chat); sessions resumed with `opencode run --session <id>` after truncation.
- Verification: subsequent tasks completed normally on GLM-5.3-Flash — Task 2 attempt 2c: 43 steps, 42 tool calls, commit `4297baf` (8/8 tests); Tasks 3-5 also completed with non-empty output.

## #3 — 2026-09-26 — `opencode run` hangs 40 minutes with zero events

- Symptom: resuming Task 2 hung 40 minutes with zero events and was killed by timeout (exit 124).
- Signal: exit 124 after a 40-minute timeout; no step/tool events at all.
- Evidence: isolated to a flag pair — not `--title`, not `--auto` (hang reproduced with both removed). The harness runs `opencode run` with stdin as an open socket (`/proc/self/fd/0` → socket), and `opencode run` reads non-TTY stdin as extra prompt input, waiting forever for EOF that never comes.
- Hypothesis: `opencode run` blocks on stdin EOF when stdin is a non-TTY socket; earlier successful runs were incidental (stdin happened to close).
- Fix: always invoke with `< /dev/null`.
- Verification: the identical command completes in 6 s and 3 s with stdin redirected from `/dev/null`.

## #4 — 2026-09-26 — Actor RPC fails with 502 after ~30 s (IN PROGRESS)

- Symptom: every `ProbeActor` RPC from `noc-probe` (armAlarm/ping/status) fails; smoke checks 4.3/4.4 blocked. Non-actor routes on the same function are unaffected.
- Signal: `actor invocation <account>__ProbeActor/probe1.<method> returned 502: bad gateway` after ~30 s; non-actor routes answer in ~4 ms; the ProbeActor actor type shows status ready/owner while its revision is stuck "deploying". ~10 function-runtime boots in 38 s were observed during the rollout (scale-out/restarts).
- Evidence: `noc-probe` logs (30 s invocation durations vs 4 ms non-actor routes; 502 per every method). Bisection table of hypotheses:
  | Hypothesis | Result |
  |---|---|
  | A — actor runtime rollout stuck / platform-side | Falsified (not a rollout phase issue) |
  | C — platform/account-level actor breakage | Falsified: the stock CLI-scaffold `Counter` canary (deployed as `noc-actor-canary`) serves actor RPCs on the same account |
  | B1 — MCP SDK import in our bundle breaks the actor runtime | Falsified: the canary loads the MCP SDK too and works |
  | B2 — bundle size | Falsified: canary 3.18 MB vs probe 3.20 MB — a 20 KB delta cannot gate loading |
  | D-KV — KV binding on the owner function | Falsified: experiment A (owner with KV + SDK) works (deploy 34 min) |
  | D-secret — `[[secrets]]` binding on the owner function | Experiment E pending (owner + `[[secrets]]` OPS_TOKEN) |
  - Discovery during bisection: actor types are **account-scoped** — a second function declaring the same actor type registers as a `reference` binder, not a duplicate owner. This made the B branch confound into a reference-binder experiment.
- Hypothesis: remaining suspect is the `[[secrets]]` binding on the actor-owner function (experiment E in flight). The reference-binder path is already proven viable by B: a clean binding-free owner function plus a reference binder holding secrets/KV serves actor RPCs.
- Fix (in flight): run experiment E to confirm/refute the secrets-binding cause. Workaround adopted regardless of the root cause: a binding-free owner function (`noc-actors`, classes only) plus `noc-edge` as a reference binder holding KV, secrets, routes and MCP — which also delivers least privilege (actor processes get no secrets).
- Verification: pending — experiment E result, then re-run smoke 4.3/4.4 against the workaround topology.

