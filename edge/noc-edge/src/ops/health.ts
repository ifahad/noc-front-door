import { kvKey } from "../../../shared/src/kvkeys";
import { REGIONS } from "../../../shared/src/seed";
import type { SeedAdapter } from "../../../shared/src/itsm";
import { deadline } from "../../../shared/src/timing";
import { logEvent } from "../log";
import type { ActorPort } from "../services/actorPort";
import { syncProjection } from "../services/incidents";
import type { KvPort } from "../services/kvPort";
import { handleMcp } from "../mcp/server";

const CHECK_DEADLINE_MS = 1500;
const SUMMARY_INTERVAL_MS = 60_000;

export interface HealthChecks {
  kv_ms: number;
  actor_ms: number;
  mcp_ms: number;
  sync_ms: number;
}

export interface DeepHealth {
  ok: boolean;
  checks: HealthChecks;
}

export interface HealthDeps {
  kv: KvPort;
  actors: ActorPort;
  adapter: SeedAdapter;
  now: number;
  opsToken: string;
  mcpToken: string;
  trace_id: string;
}

let lastOutcome: boolean | null = null;
let lastSummaryAt = 0;

export function resetCanaryCounters(): void {
  lastOutcome = null;
  lastSummaryAt = 0;
}

async function kvCheck(kv: KvPort, now: number): Promise<{ ms: number; ok: boolean }> {
  const started = Date.now();
  const value = String(now);
  const key = kvKey("ops", "healthcheck");
  const raced = await deadline(
    (async () => {
      await kv.put(key, value);
      return kv.get(key);
    })(),
    CHECK_DEADLINE_MS,
    "health.kv",
  );
  const ok = raced.ok && raced.value === value;
  return { ms: Date.now() - started, ok };
}

async function actorCheck(actors: ActorPort): Promise<{ ms: number; ok: boolean }> {
  const started = Date.now();
  const raced = await deadline(
    actors.site("TST-001").getTicket({ trace_id: "none" }),
    CHECK_DEADLINE_MS,
    "health.actor",
  );
  return { ms: Date.now() - started, ok: raced.ok };
}

async function mcpCheck(deps: HealthDeps): Promise<{ ms: number; ok: boolean }> {
  const started = Date.now();
  const request = new Request("https://noc-edge.telnyxcompute.com/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${deps.opsToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const raced = await deadline(
    handleMcp(request, {
      kv: deps.kv,
      actors: deps.actors,
      adapter: deps.adapter,
      now: () => deps.now,
      mcpToken: deps.mcpToken,
      opsToken: deps.opsToken,
    }),
    CHECK_DEADLINE_MS,
    "health.mcp",
  );
  let ok = false;
  if (raced.ok) {
    try {
      const body = (await raced.value.json()) as { result?: { tools?: unknown[] } };
      ok = Array.isArray(body.result?.tools) && body.result.tools.length > 0;
    } catch {
      ok = false;
    }
  }
  return { ms: Date.now() - started, ok };
}

async function syncCheck(deps: HealthDeps): Promise<{ ms: number; ok: boolean }> {
  const started = Date.now();
  for (const seed of REGIONS) {
    if (seed.region === "lab") continue;
    const raced = await deadline(
      syncProjection({ actors: deps.actors, kv: deps.kv }, seed.region, deps.trace_id),
      CHECK_DEADLINE_MS,
      `health.sync.${seed.region}`,
    );
    if (!raced.ok) {
      return { ms: Date.now() - started, ok: false };
    }
  }
  return { ms: Date.now() - started, ok: true };
}

export async function runDeepHealth(deps: HealthDeps): Promise<DeepHealth> {
  const started = Date.now();
  const kv = await kvCheck(deps.kv, deps.now);
  const actor = await actorCheck(deps.actors);
  const mcp = await mcpCheck(deps);
  const sync = await syncCheck(deps);
  const ok = kv.ok && actor.ok && mcp.ok && sync.ok;
  const checks: HealthChecks = {
    kv_ms: kv.ms,
    actor_ms: actor.ms,
    mcp_ms: mcp.ms,
    sync_ms: sync.ms,
  };
  await writeHeartbeat(deps, ok, checks);
  logCanary(ok, checks, deps, Date.now() - started);
  return { ok, checks };
}

async function writeHeartbeat(
  deps: HealthDeps,
  ok: boolean,
  checks: HealthChecks,
): Promise<void> {
  try {
    await deps.kv.put(
      kvKey("ops", "heartbeat"),
      JSON.stringify({ at: deps.now, ok, checks }),
    );
  } catch (err) {
    logEvent("canary.heartbeat_failed", {
      hop: "ops/health",
      trace_id: deps.trace_id,
      lvl: "warn",
      outcome: "error",
      error: String(err),
    });
  }
}

function logCanary(
  ok: boolean,
  checks: HealthChecks,
  deps: HealthDeps,
  total_ms: number,
): void {
  if (ok !== lastOutcome) {
    lastOutcome = ok;
    logEvent("canary.check", {
      hop: "ops/health",
      trace_id: deps.trace_id,
      outcome: ok ? "ok" : "error",
      ok,
      total_ms,
    });
  }
  if (deps.now - lastSummaryAt >= SUMMARY_INTERVAL_MS) {
    lastSummaryAt = deps.now;
    logEvent("canary.summary", {
      hop: "ops/health",
      trace_id: deps.trace_id,
      outcome: ok ? "ok" : "error",
      ok,
      ...checks,
      total_ms,
    });
  }
}
