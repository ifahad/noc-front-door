# noc-actors

The **actor owner** for the NOC Front Door project: it declares and ships the
StatefulActor classes, with no bindings of its own.

## What lives here

| File | Purpose |
| --- | --- |
| `src/SiteState.ts` | Per-site state: ticket open/attach, PIN verification (per-call and site-wide lockout tiers), call history |
| `src/RegionState.ts` | Per-region state: incident declaration, P2→P1 upgrade at 3 sites, SLA escalation ladder, pages |
| `src/index.ts` | Function entry point; re-exports the actor classes so the owner function ships with them |

Owner vs reference binder: this function declares `SITES`/`REGIONS` in
`telnyx.toml` but holds no KV, secrets or routes — `edge/noc-edge` binds the
same classes by reference and is the only caller that carries secrets (least
privilege). On this Trial account new actor instances cannot activate
(DEBUGLOG #4), so production runs in **mux mode**: `edge/noc-actor-host` runs
these identical classes inside the one working `Counter/demo` instance.

## Deploy

```sh
npm install
telnyx-edge ship
```

Unit tests live in `test/` and run against in-memory storage fakes (C11 — there
is no local actor runtime).
