# NOC Front Door

A 24/7 AI voice line for Najd Networks, a fictional managed-services provider in Saudi Arabia. Calls are handled by a Telnyx Voice AI assistant (Conversation Workflows) backed by Telnyx Edge Compute functions, KV and Stateful Actors, with a custom MCP server exposing the internal tools. See `docs/superpowers/specs/2026-09-26-noc-front-door-design.md` for the binding design.

## Built with

Every shipped artifact (code, config, tests, scripts, README, DEMO) is authored through OpenCode + `@telnyx/opencode` on Telnyx-hosted models. Claude writes the spec, the plans and the task prompts, and reviews; it never hand-edits product code. This is disclosed here and in the interview.
