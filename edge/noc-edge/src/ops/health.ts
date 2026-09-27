import { parsePublicKey } from "../../../shared/src/ed25519";
import { kvKey } from "../../../shared/src/kvkeys";
import { REGIONS, SITES } from "../../../shared/src/seed";
import type { SeedAdapter, SeedLocalConfig } from "../../../shared/src/itsm";
import { deadline } from "../../../shared/src/timing";
import { logEvent } from "../log";
import type { ActorPort } from "../services/actorPort";
import { syncProjection, type SyncResult } from "../services/incidents";
import type { KvPort } from "../services/kvPort";
import { read as readFlags } from "../services/flags";
import { handleMcp } from "../mcp/server";

// KV on this account takes ~1.5 s per read from the edge binding (LIVE
// EVIDENCE, DEBUGLOG #6). Each check gets a deadline of 4 s; hitting the
// deadline means the check is SLOW, not broken — slow is not down (README:91),
// so a timeout keeps ok true and is reported separately. Per-check slow
// thresholds sit just under the deadline at the measured baseline: kvCheck
// runs a put and a get back to back (~2–4 s), syncProjection runs one actor
// call plus one KV write per region (~2–3 s), one actor call is ~1–2 s, and
// the in-process MCP tools/list carries the same platform jitter budget.
const CHECK_DEADLINE_MS = 4000;
const CHECK_NAMES = ["kv", "actor", "mcp", "sync"] as const;
type CheckName = (typeof CHECK_NAMES)[number];
const SLOW_THRESHOLD_MS: Record<CheckName, number> = {
  kv: 3500,
  actor: 3000,
  mcp: 3000,
  sync: 3000,
};
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
  timed_out: string[];
  config_problems: string[];
  checks: HealthChecks;
}

export interface HealthDeps {
  kv: KvPort;
  actors: ActorPort;
  adapter: SeedAdapter;
  now: number;
  opsToken: string;
  mcpToken: string;
  publicKey: string | null;
  seedLocal: SeedLocalConfig;
  trace_id: string;
}

let lastOutcome: boolean | null = null;
let lastSummaryAt = 0;

export function resetCanaryCounters(): void {
  lastOutcome = null;
  lastSummaryAt = 0;
}

interface CheckResult {
  ms: number;
  ok: boolean;
  timed_out: boolean;
}

type Raced<T> =
  | { kind: "value"; value: T }
  | { kind: "rejected" }
  | { kind: "timeout" };

// Like shared deadline(), but distinguishes a rejection from a timeout so a
// slow check can be reported as slow-and-working instead of failed. The race
// keeps a rejection handler on p for its whole lifetime, so a late rejection
// after the timer wins is swallowed (no floating-promise crash).
function raceCheck<T>(p: Promise<T>, budgetMs: number): Promise<Raced<T>> {
  return new Promise<Raced<T>>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "timeout" });
    }, budgetMs);
    p.then(
      (value: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "value", value });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "rejected" });
      },
    );
  });
}

async function kvCheck(kv: KvPort, now: number): Promise<CheckResult> {
  const started = Date.now();
  const value = String(now);
  const key = kvKey("ops", "healthcheck");
  const raced = await raceCheck(
    (async () => {
      await kv.put(key, value);
      return kv.get(key);
    })(),
    CHECK_DEADLINE_MS,
  );
  if (raced.kind === "timeout") {
    return { ms: Date.now() - started, ok: true, timed_out: true };
  }
  const ok = raced.kind === "value" && raced.value === value;
  return { ms: Date.now() - started, ok, timed_out: false };
}

async function actorCheck(actors: ActorPort): Promise<CheckResult> {
  const started = Date.now();
  const raced = await raceCheck(
    actors.site("TST-001").getTicket({ trace_id: "none" }),
    CHECK_DEADLINE_MS,
  );
  if (raced.kind === "timeout") {
    return { ms: Date.now() - started, ok: true, timed_out: true };
  }
  return { ms: Date.now() - started, ok: raced.kind === "value", timed_out: false };
}

async function mcpCheck(deps: HealthDeps): Promise<CheckResult> {
  const started = Date.now();
  const request = new Request("https://noc-edge.telnyxcompute.com/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${deps.opsToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const raced = await raceCheck(
    handleMcp(
      request,
      {
        kv: deps.kv,
        actors: deps.actors,
        adapter: deps.adapter,
        now: () => deps.now,
        mcpToken: deps.mcpToken,
        opsToken: deps.opsToken,
      },
      // The canary must not crowd out call hops (spec §11.1): skip the
      // per-request mcp.auth/mcp.wire lines for this in-process check.
      { quiet: true },
    ),
    CHECK_DEADLINE_MS,
  );
  if (raced.kind === "timeout") {
    return { ms: Date.now() - started, ok: true, timed_out: true };
  }
  let ok = raced.kind === "value";
  if (raced.kind === "value") {
    try {
      const body = (await raced.value.json()) as { result?: { tools?: unknown[] } };
      ok = Array.isArray(body.result?.tools) && body.result.tools.length > 0;
    } catch {
      ok = false;
    }
  }
  return { ms: Date.now() - started, ok, timed_out: false };
}

async function syncCheck(deps: HealthDeps): Promise<CheckResult> {
  const started = Date.now();
  const raced = await Promise.all(
    REGIONS.filter((seed) => seed.region !== "lab").map((seed) =>
      raceCheck(
        syncProjection(
          { actors: deps.actors, kv: deps.kv },
          seed.region,
          deps.trace_id,
        ),
        CHECK_DEADLINE_MS,
      ),
    ),
  );
  const timedOut = raced.some((r) => r.kind === "timeout");
  const failed = raced.some(
    (r) => r.kind === "rejected" || (r.kind === "value" && !(r.value as SyncResult).ok),
  );
  return { ms: Date.now() - started, ok: !failed, timed_out: timedOut };
}

// The call-path config can silently break every call while KV, actors and MCP
// stay green, so deep health validates it too (final review F28): the
// Ed25519 public key that guards /dv and /tools, the assistant's MCP bearer,
// and the local seed every verify_site PIN check depends on. Problems are
// reported as codes only — never key or token values.
function configCheck(deps: HealthDeps): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!isEd25519Key(deps.publicKey)) problems.push("public_key");
  if (deps.mcpToken.length === 0) problems.push("mcp_token");
  for (const site of SITES) {
    if (deps.seedLocal.pins[site.site_id] === undefined) {
      problems.push(`seed_pin:${site.site_id}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

function isEd25519Key(value: string | null): boolean {
  if (value === null || value.length === 0) return false;
  try {
    const { kind, bytes } = parsePublicKey(value);
    if (kind === "raw") return bytes.length === 32;
    // A DER SubjectPublicKeyInfo for Ed25519 wraps the 32-byte key.
    return bytes.length === 44;
  } catch {
    return false;
  }
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
  const config = configCheck(deps);
  if (!config.ok) {
    logEvent("config.invalid", {
      hop: "ops/health",
      trace_id: deps.trace_id,
      lvl: "error",
      outcome: "error",
      problems: config.problems,
    });
  }
  const results: Array<[CheckName, CheckResult]> = [
    ["kv", kv],
    ["actor", actor],
    ["mcp", mcp],
    ["sync", sync],
  ];
  const ok =
    results.every(([, c]) => c.ok) && config.ok;
  const checks: HealthChecks = {
    kv_ms: kv.ms,
    actor_ms: actor.ms,
    mcp_ms: mcp.ms,
    sync_ms: sync.ms,
  };
  const timedOut = results.filter(([, c]) => c.timed_out).map(([name]) => name);
  // A timed-out check is definitionally slow; the rest are slow only past
  // their measured baseline, so degraded means worse than normal.
  const slow = [
    ...timedOut,
    ...results
      .filter(([name, c]) => !c.timed_out && c.ok && c.ms > SLOW_THRESHOLD_MS[name])
      .map(([name]) => name),
  ];
  // The heartbeat write must not sit on the response path when KV is slow:
  // it is fired through deadline (which attaches .catch) and left running.
  deadline(writeHeartbeat(deps, ok, checks), CHECK_DEADLINE_MS, "health.heartbeat");
  logCanary(ok, checks, deps, Date.now() - started);
  return {
    ok,
    degraded: slow.length > 0,
    slow,
    timed_out: timedOut,
    config_problems: config.problems,
    checks,
  };
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
