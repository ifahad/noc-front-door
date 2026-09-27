import { kvKey } from "../../../shared/src/kvkeys";
import { REGIONS } from "../../../shared/src/seed";
import type { SeedAdapter } from "../../../shared/src/itsm";
import { deadline } from "../../../shared/src/timing";
import { logEvent } from "../log";
import type { ActorPort } from "../services/actorPort";
import { syncProjection } from "../services/incidents";
import type { KvPort } from "../services/kvPort";
import { read as readFlags } from "../services/flags";
import { handleMcp } from "../mcp/server";

// KV on this account takes ~1.5 s per read from the edge binding (LIVE
// EVIDENCE, DEBUGLOG #6): slow is not down, so give each check room and
// judge health by success, reporting slowness separately.
const CHECK_DEADLINE_MS = 4000;
const SLOW_THRESHOLD_MS = 1000;
const SUMMARY_INTERVAL_MS = 60_000;

export interface HealthChecks {
  kv_ms: number;
  actor_ms: number;
  mcp_ms: number;
  sync_ms: number;
}

export interface DeepHealth {
  ok: boolean;
  degraded: boolean;
  slow: string[];
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
  const results = await Promise.all(
    REGIONS.filter((seed) => seed.region !== "lab").map((seed) =>
      deadline(
        syncProjection({ actors: deps.actors, kv: deps.kv }, seed.region, deps.trace_id),
        CHECK_DEADLINE_MS,
        `health.sync.${seed.region}`,
      ),
    ),
  );
  return { ms: Date.now() - started, ok: results.every((r) => r.ok) };
}

export async function runDeepHealth(deps: HealthDeps): Promise<DeepHealth> {
  const started = Date.now();
  // Keep-warm for the flags memo (spec §11.4): the external prober hits this
  // endpoint every 10 s, so its read keeps flags hot for /dv. Value ignored.
  const warmP = deadline(readFlags(deps.kv, deps.now), CHECK_DEADLINE_MS, "health.warm");
  const [kv, actor, mcp, sync, warm] = await Promise.all([
    kvCheck(deps.kv, deps.now),
    actorCheck(deps.actors),
    mcpCheck(deps),
    syncCheck(deps),
    warmP,
  ]);
  void warm;
  const ok = kv.ok && actor.ok && mcp.ok && sync.ok;
  const checks: HealthChecks = {
    kv_ms: kv.ms,
    actor_ms: actor.ms,
    mcp_ms: mcp.ms,
    sync_ms: sync.ms,
  };
  const slow = slowNames([
    ["kv", kv],
    ["actor", actor],
    ["mcp", mcp],
    ["sync", sync],
  ]);
  // The heartbeat write must not sit on the response path when KV is slow:
  // it is fired through deadline (which attaches .catch) and left running.
  deadline(writeHeartbeat(deps, ok, checks), CHECK_DEADLINE_MS, "health.heartbeat");
  logCanary(ok, checks, deps, Date.now() - started);
  return { ok, degraded: slow.length > 0, slow, checks };
}

type CheckOutcome = { ms: number; ok: boolean };

function slowNames(checks: Array<[string, CheckOutcome]>): string[] {
  return checks
    .filter(([, c]) => c.ok && c.ms > SLOW_THRESHOLD_MS)
    .map(([name]) => name);
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
