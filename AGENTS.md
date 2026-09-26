# AGENTS.md: Standing rules for the coding model

> **Architect artifact.** Written by the project architect (Claude) for the coding agent (OpenCode on Telnyx-hosted models). These rules apply to every task. If they conflict with a task prompt, stop and ask.

## Project

**NOC Front Door** is a 24/7 AI voice line for a fictional KSA managed-services provider, *Najd Networks*. It runs on Telnyx Voice AI (Conversation Workflows), Telnyx Edge Compute (Functions, KV and Stateful Actors) and a custom MCP server.

- **Binding spec:** `docs/superpowers/specs/2026-09-26-noc-front-door-design.md`
- **Current plan:** `docs/superpowers/plans/`

Read the sections a task names before you start.

## Platform constraints (from spec §2; never violate)

| # | Constraint |
|---|---|
| C1 | **Trial account:** 1 assistant (`sanad-noc`, updated in place, **never deleted**), 1 API key, web calls only, limited credit. |
| C2 | Anything with actors is a `telnyx.toml` umbrella project in TypeScript (not `func.toml`). |
| C3 | The dynamic-variables webhook blocks the greeting. It must answer fast and **fail open** to safe defaults. |
| C4 | The MCP server is stateless: POST only, JSON responses, a new server and transport per request, and GET/DELETE return 405. |
| C5 | KV is last-write-wins with no compare-and-swap. **Never** keep counters, locks or invariants in KV. Key charset: `^[-/_=.a-zA-Z0-9]+$`, so no `+` or `:`. |
| C6 | Actor methods do **no network I/O**. Pass results in as arguments. Methods are idempotent. There are no cross-actor transactions. |
| C7 | Every workflow prompt node sets `instructions_mode` and `tools_mode` explicitly (the API defaults both to `replace`). |
| C8 | Tool nodes use shared tools only. MCP cannot back a tool node. Never configure a `handoff` tool. |
| C9 | Dynamic-variable and webhook values are **strings**. Sentinels are `"none"` / `"unknown"`, never `""`. |
| C10 | The assistant's voice model is `moonshotai/Kimi-K2.6`. |
| C11 | There is no local actor runtime. Unit-test actors against an in-memory storage fake. |
| C12 | At most one instance per tool type (except webhook, function, client_side_tool) per assistant. |
| C13 | Caller identity comes from the **signed body** (`preset_body_fields`), never from a header alone, and never from LLM-supplied arguments. |

## Engineering rules

1. **TDD for logic.** For every piece of pure logic:
   1. Write the failing test.
   2. Run it and see it fail.
   3. Implement it.
   4. Run it and see it pass.

   Tests assert real behaviour, never implementation details. Name tests after the behaviour.
2. **Exact dependency pins:** `@telnyx/edge-runtime@0.15.3`, `@modelcontextprotocol/sdk@1.30.1`, `zod@3.25.76`. Install with `npm i -E`. Commit the lockfiles.
3. **Logging:** exactly one JSON object per line: `{ts, lvl, svc, hop, evt, trace_id, …, total_ms, outcome}` (spec §11.1).
   - **Never** log PINs, PIN fingerprints, API keys, bearer tokens or secret values.
   - Mask phone numbers as `+1312****309` (first 5 characters, `****`, last 3 digits).
4. **No floating promises.** Every promise is awaited before the response, or passed through a `deadline()` helper that attaches `.catch`. An unhandled rejection crashes the whole function.
5. **One writer per KV key** (spec §6.3).
6. **Security:**
   - Never add a bypass for signature verification or auth, not even "for testing".
   - Signed routes **fail closed** with HTTP 403.
   - Compare tokens in constant time.
7. **Secrets:**
   - Never print, log, echo or commit a secret or a real phone number.
   - Never read `.env`, `seed.local.json` or OpenCode's `config.json`.
   - Never run `git push`, `opencode debug config`, `telnyx-edge secrets …`, `telnyx-edge ship` or `telnyx-edge delete-func`. The architect runs deployments and account operations.
   - Test fixtures that look like secrets or phone numbers must be **assembled at runtime** (string concatenation), so no literal secret-shaped string exists in the source. The pre-commit scanner blocks literals.
8. **Scope:** do exactly what the task asks. No extra features, files or refactors. If something in the task is ambiguous or seems wrong, stop and report it.
9. **Commits:** conventional messages (`feat:`, `fix:`, `test:`, `chore:`, `docs:`), each ending with the trailer:
   `Assisted-by: OpenCode (telnyx/<model id you are running as>)`

   Never use `--no-verify`. If the pre-commit hook blocks a commit, fix the cause.
10. **Report:** when you finish, write a short report stating what you changed (files), the exact test command and its output, and any doubts.
