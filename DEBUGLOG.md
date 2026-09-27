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
- Update (2026-09-27): the workaround is live — mux mode since 05:20 UTC+3 (`flag/actor_mode=mux`): all actor calls route through the one working instance (`Counter/demo` on noc-actor-canary, now shipped as `edge/noc-actor-host`), which multiplexes the real `SiteState`/`RegionState` classes. `Counter/demo` **survived the identical rebuild** (experiment G: value 45→46), so rebuilding the owner does not kill the contingency. A 9-hour recovery watcher (ended 11:04; last probe 10:53) saw **no recovery** — a fresh actor type still returned 502 after 30 s. Escalated to Telnyx. Live in mux mode: `/ops/actor-ping` → site RUH-114 pong 220–454 ms, region riyadh-north pong 220 ms.

## #5 — 2026-09-27 — Flag-read budget wrong for real KV latency: every request fell back

- Symptom: after T13-lite shipped, every request logged `flags.fallback`; `/ops/actor-ping` still answered per-entity although `flag/actor_mode=mux` was set. Found by our own logs within a minute.
- Signal: `flags.fallback` on every request — the live KV flags read (6 gets) exceeded the 250 ms `FLAGS_BUDGET_MS`, including 3 MCP requests 0.4 s apart (the per-binding memo never warmed). Measured flag/mode reads: 1341–2000 ms (`actor_mode.read` total_ms 1690/2000/1341).
- Evidence: noc-edge runtime logs 05:13–05:25; the `actor_mode.read` log line added by the fix.
- Hypothesis: the 250 ms flags budget assumed fast KV (DEBUG #6); on this account a KV burst costs seconds, so every read timed out and fell back to per-entity mode with safe defaults.
- Fix: `selectActorPort` takes a per-route budget — `/dv` 250 ms (C3 margin), all other routes 2000 ms; a module-level last-known-good mode is used on timeout; `actor_mode.read` logged with `total_ms` so KV latency is measured, not guessed.
- Verification: re-review 4/4 addressed (noc-edge 262 tests); live round 2 (05:47–05:52): `/ops/actor-ping` → `{"mode":"mux"}`, site RUH-114 pong 220–454 ms, region riyadh-north pong 220 ms — first live actor success.

## #6 — 2026-09-27 — KV latency ~1.1–2.0 s per op breaks latency-shaped routes

- Symptom: KV is slow on this account. `/dv` almost always missed its internal deadline and fell back to generic defaults; `/ops/health/deep` answered `ok:false` (6.7–8.8 s total; `kv_ms` 1500 + `sync_ms` 1500 deadlines hit); `/diag/race?mode=actor` n=5 → `created_count 0` (all 5 openers exceeded the 1500 ms race deadline — a latency artifact, not correctness); `/ops/status` took ~9.7 s.
- Signal: `actor_mode.read` total_ms 1690/2000/1341 at the edge; REST GET of the same key from the dev box **1.07–1.17 s**; edge KV ops **1.3–2.0 s**. The spec assumed a fast read projection.
- Evidence: live logs (T13-lite rounds 1–2, health checks at 11:2x); `telnyx-edge storage kv key get` timings from the dev box.
- Hypothesis: sequential chains of KV ops on caller-facing paths blow every budget at this latency; the race deadline and health deadlines were sized for a fast KV.
- Fix: Task 12b (single-flight + 60 s flags memo; adapter-first directory — the seed is in memory; concurrent `/dv`: flags ∥ contact → incident/session/conv ∥, actor after flags; actor port from the same flags read; health checks concurrent with 4 s deadlines, degraded/slow ≠ down; race deadline 8 s) + Task 12c (concurrent KV in the tool webhooks, observable `mcp.session` reason, verify timeout 5000→8000 ms) + Task 12d (concurrent status reads, 6219→<3000 ms; public `/demo`).
- Verification (before→after, under a 1000 ms/op fake KV unless noted): `/dv` key path 1014 ms (vs old sequential); `verify_site` 5428→2010 ms; `open_ticket` 4830→1618 ms; `callback` 2410→1409 ms; `/ops/status` reads 6219→<3000 ms. Live: voice call #2 `verify_site` 3579 ms (was 7869, DEBUG #8); call #3 verify 3646 ms, join 2559 ms. Health now answers `degraded:true, slow:["kv"]` instead of `ok:false`; the prober treats degraded as not-an-outage (runbook).

## #7 — 2026-09-27 — Live assistant apply: keyterm shape and tool read-back normaliser

- Symptom: the first live apply of `sanad-noc` failed `400/10026 "Expected string type"` at `/body/transcription/settings/keyterm`; after fixing that, all 7 shared-tool read-backs printed `DRIFT got=null` although the tools were created.
- Signal: apply run 20:00:57 → 400/10026; real `GET /v2/ai/tools/{id}` shape is `{id,type,display_name,tool_definition:{…},timeout_ms,created_at}` — we send `{type,<type>:{…}}`, and `normaliseToolReadback` never mapped `tool_definition` back under `got[got.type]`, so the subset diff found nothing → `got=null`.
- Evidence: apply output (idempotency proven by rerun: everything found by name, no duplicates); the tools GET response.
- Hypothesis: (a) keyterm must be a comma-separated string ("Keyterm Boost accepts a comma-separated list"), not a list; (b) the read-back normaliser was written from an assumed shape.
- Fix: keyterm → comma-separated string; `validateAssistant` requires a string keyterm; `normaliseToolReadback` maps `tool_definition` → `got[got.type]` (tests from the real shapes); `telnyx()` error messages carry `errors[0].detail` and `source.pointer` — the missing detail cost a scratch diagnostic.
- Verification: re-apply at 20:05:01 → assistant APPLIED (version 20260927T170510849210): 24 nodes / 51 edges, start `s_open`, DV → `/dv` 2500 ms, tool_ids `[capture_details]`, MCP `noc-mcp` (5 tools); read-back `validateAssistant []` and zero DRIFT.

## #8 — 2026-09-27 — Voice call #1: correct PIN still escalated (7869 ms > 5000 ms tool timeout)

- Symptom: voice call #1 (Fahad, 17:10 UTC, trace `t-5d419f3a98a3240f`): `verify_site` returned `verify_result "ok"` for the correct PIN but took total_ms **7869 > 5000 ms** tool timeout — Telnyx treated verification as a failure and ran the designed escalation path: transfer to the on-call engineer (unanswered) → take a message → `log_callback` (2.8 s, `page.raised`). The DV webhook had also fallen back at 2200 ms (`kv` 2195) → generic greeting. Escalation/fallback paths proven live; the happy path was blocked by KV latency (DEBUG #6).
- Signal: trace by `trace_id`: `tool.verify_site` total_ms 7869; `dv.route` outcome=fallback.
- Hypothesis: sequential KV work inside the tool webhooks (DEBUG #6).
- Fix: Task 12c — concurrent KV in the tools (verify_site 5428→2010 ms, open_ticket 4830→1618 ms under a 1000 ms/op fake KV) and `verify_site` timeout 5000→8000 ms as a safety net.
- Verification: call #2 (18:05 UTC, trace `t-128d0766…`): `verify_site` **3579 ms ok** (was 7869) → `join_incident` 2638 ms → NJD-1401; the incident stayed P2/1 site **by design** — `RegionState` ignores reports older than 6 h, so the 05:47 staged reports were pruned (demo lesson: run `/ops/reset` → `/ops/stage-incident` pre-flight, spec §16). Call #3 (18:14 UTC, trace `t-c01949fafca2a42e`): verify 3646 ms ok → join 2559 ms → NJD-1402 → **INC-1002 now P1 / 3 sites**, confirmed on `/ops/status`. Core demo path proven live over voice — see `docs/evidence/voice-calls.md`.

## #9 — 2026-09-27 — Chat is not a valid test channel for this flow

- Symptom: in `/chat`, `capture_details` (the `update_dynamic_variables` shared tool) is **"not available on this channel"** — the flow cannot reach `t_verify` in chat; the LLM then improvised MCP `get_site_status`/`check_known_incidents` with no session → `SESSION_FALLBACK`. DV fires on **every** chat turn at 1.5–2.2 s (`kv_ms` ≈ total; DEBUG #6 again).
- Signal: chat smoke conversation `cad930bd…`: disclosure + greeting + "site ID and PIN" prompt OK; then the channel error on `capture_details`.
- Evidence: the chat transcript (Portal conversation `cad930bd…`); noc-edge logs showing the per-turn DV calls and the MCP fallback.
- Hypothesis: `update_dynamic_variables` is voice-only, so chat is not a valid test channel for this flow.
- Fix: validation moved to voice calls (DEBUG #8); follow-up T12c logs `mcp.session` `{outcome, reason: no_conv_id|no_conv_link|no_session|timeout}` — the MCP fallback previously gave no reason in the logs (observability gap found live).
- Verification: voice calls #2/#3 validate the flow end-to-end. Chat remains usable for disclosure/greeting checks only.

## #10 — 2026-09-27 — The public /demo page rendered no call launcher

- Symptom: the `/demo` page loaded and the widget connected (login ok, agent connected, EU fr5) but no launcher button appeared — the visitor could not start a call.
- Signal: headless Chromium (playwright-core + cached chromium): the `telnyx-ai-agent` element had no shadow-DOM launcher; the assistant read-back had `widget_settings: null`.
- Evidence: the live page vs the assistant read-back; `apply.mjs` output showing the assistant config with no `widget_settings` block.
- Hypothesis: `widget_settings` was never part of the assistant config, so the widget had no launcher settings to render.
- Fix: added `widget_settings` via config-as-code (`scripts/apply.mjs` — never patch the assistant outside `apply.mjs`); commit `aaa8eec`.
- Verification: after the apply, headless Chromium confirms the "Talk to Sanad" launcher renders (bottom-right, dark) and the agent connects (EU fr5).

## #11 — 2026-09-27 — Incident vanished from the board ~2 h after its last sync

- Symptom: INC-1002 was still held by the actor but had disappeared from `/ops/status` and the NOC wall ~2 h after its last sync.
- Signal: the KV projection is written with `PROJECTION_TTL_SECONDS = 7200` (2 h TTL); with **no prober running**, nothing re-synced it from actor truth — the heal loop is load-bearing, not optional.
- Evidence: `edge/noc-edge/src/services/incidents.ts` (TTL 7200); the board's stale/absent projection while `RegionState` still held the incident.
- Hypothesis: the projection's TTL assumed the heal loop runs continuously; the design intent was that the prober's deep-health sync re-writes projections every ~10 s.
- Fix: operational — the prober now runs continuously (`nohup`, `~/code/telnyx-fde/ops-logs/prober.log`); the runbook says "keep the prober running". Re-staged INC-1003 (P2, 2 branches) at 23:30.
- Verification: with the prober running, projections stay fresh (deep-health `syncCheck` heals every region from actor truth; README "Try it" warns reviewers).

## #12 — 2026-09-28 — Actor alarms work although new instances cannot be created

- Symptom: given DEBUG #4 (new actor instances cannot activate on this account), it was reasonable to assume actor alarms would also not fire.
- Signal: the live INC-1004 test (00:46:50 stage → 00:51:4x escalation): the ladder escalated to L1 and minted page `INC-1004:p1` while **every** `/ops/tick` in the window reported `fired:0` (incl. 21:51:51Z, 4 s before the claim) — so the escalation was driven by the **platform alarm** on the mux host, fanned out to the entity (not the tick fallback).
- Evidence: [docs/evidence/alarms-live.md](docs/evidence/alarms-live.md); the prober claimed and "sent" the page at 00:51:53 (PAGE banner, `page.sent` log, pending 0).
- Hypothesis: the mux host (`Counter/demo`) is the one pre-existing instance, and its own alarm — set via `ctx.storage.setAlarm` — is delivered by the platform; the host's `alarm()` fans out to the entities.
- Fix: none needed — this is the finding: the mux host's alarm path is live.
- Verification: live alarm test (see the evidence file); the tick fallback stays as a belt-and-braces path.

## #13 — 2026-09-28 — Cloud Storage binding missing `region` (caught before ship)

- Symptom: the P2-4 incident-report feature would not bind — the CLI rejects the manifest, and at runtime a region-less bucket binding is silently skipped (the function ships without the binding).
- Signal: `telnyx.toml` `[cloudstorage]` block lacked `region`; CLI validation error on ship; the runtime binding list skipped the block.
- Evidence: P2-4 review (2 lenses + skeptics) confirmed the Critical before any deploy; the fix is commit `9772a47`.
- Hypothesis: the architect's prompt snippet for the binding omitted the required `region` field.
- Fix: `region = "us-central-1"` added to the `cloudstorage` block (the architect-provided snippet was the defect source; the review caught it before ship).
- Verification: dry-run validation passes; the feature is deployed only after this fix (`built, deploy pending` in README until a live report write is recorded).

## #14 — 2026-09-28 — Page-id collision after a P2→P1 upgrade (page never delivered)

- Symptom: after an incident upgraded P2→P1, the post-upgrade page shared its id with an already-sent page, so the new page was never delivered (claim/mark-sent hit the stale entry), and the prober's `claimedIds` cache masked it forever.
- Signal: page id was `incidentId + ":" + level`; a P2→P1 upgrade resets `esc.level`, so the id `INC-x:p1` was minted twice.
- Evidence: P2-2 review (2 lenses + skeptics) — CONFIRMED Critical, reproduced by the reviewer.
- Hypothesis: deriving the page id from a field that can reset makes the id non-unique over an incident's lifetime.
- Fix: persisted monotonic per-incident page counter for ids (`INC-x:p1`, `:p2`, … — `pageSeq`), with the level kept as a separate field; per-region isolation in pending pages; one JSON warn log per paging failure (never the token). Commits `2d1a3b3` + `85cfaf9`.
- Verification: regression test pins that an upgrade after a sent P2 page yields a fresh id; re-review 4/4 addressed, no new issues.

