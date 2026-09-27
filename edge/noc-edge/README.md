# noc-edge

The front-door Edge Function of the NOC Front Door project. Not a scaffold:
`src/` holds the full HTTP router and the services behind it.

## Routes (see `src/router.ts`)

| Route | Purpose |
| --- | --- |
| `POST /dv` | Dynamic-variables webhook (Ed25519-signed, fail-open to safe defaults) |
| `POST /tools/verify-site`, `/tools/open-ticket`, `/tools/join-incident`, `/tools/callback` | The assistant's four webhook tools (signed-body caller identity) |
| `POST /mcp` | The custom MCP server — 5 tools, two bearer scopes, stateless (a new server + transport per request; `GET` → 405) |
| `GET /demo` | The public NOC wall (call widget + operator drawer) |
| `GET /ops/board`, `GET /ops/status` | Public read-only views (board is single-flight cached) |
| `/ops/*` (health, reset, stage-incident, ack, resolve, unlock, tick, pages, reports, actor-ping, diag/race) | Operator routes, ops bearer |

## Bindings (`telnyx.toml`)

- **Reference binder** for the actors: `SITES` (SiteState) and `REGIONS` (RegionState) — the owner class ships in `edge/noc-actors`. The extra `MUX` (Counter) binding is the mux-mode contingency for DEBUGLOG #4: when `flag/actor_mode=mux`, every actor call routes through the one working `Counter/demo` instance on noc-actor-canary (shipped as `edge/noc-actor-host`).
- **KV** `CACHE` namespace: flags, sessions, incident projections.
- **Cloud Storage** `REPORTS` bucket `noc-reports-fb8131`: incident reports on resolve.
- **Secrets** (`[[secrets]]`): `TELNYX_PUBLIC_KEY`, `MCP_TOKEN`, `OPS_TOKEN`, `PIN_PEPPER`, `ONCALL_NUMBER`, `SEED_LOCAL`, `DEMO_GUIDE`. This function holds every secret; the actor owner deliberately holds none (least privilege).

## Deploy

```sh
npm install
telnyx-edge ship
```

Owner vs reference: `edge/noc-actors` declares the actor classes with no bindings; `noc-edge` binds them by reference. Generate types with `telnyx-edge types`.
