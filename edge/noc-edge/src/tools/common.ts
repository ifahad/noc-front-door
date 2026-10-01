import { sessionKey, traceId } from "../../../shared/src/ids";
import type { SeedAdapter } from "../../../shared/src/itsm";
import { CUSTOMERS } from "../../../shared/src/seed";
import { deadline } from "../../../shared/src/timing";
import type { Session } from "../../../shared/src/types";
import { parseProjection } from "../dv/handler";
import { verifySigned } from "../lib/signed";
import { logEvent } from "../log";
import type { ActorPort } from "../services/actorPort";
import type { IncidentProjection } from "../services/incidents";
import type { Flags } from "../services/flags";
import { read as readFlags } from "../services/flags";
import type { KvPort } from "../services/kvPort";
import { emptySession, get, linkConversation } from "../services/sessions";
import { kvKey } from "../../../shared/src/kvkeys";

// KV budgets for the tool path (kvfree design E2/E6, R-E). While KV fails or
// hangs, every tool still answers inside its webhook timeout: the actor is
// the authority for PIN verification, KV is a best-effort cache.
export const ENRICH_BUDGET_MS = 2500;
export const TOOL_KV_BUDGET_MS = 2500;
export const CALLBACK_KV_BUDGET_MS = 1500;
// A denied open wrote nothing, so a 403 may be retried once with the KV
// session if the first read timed out (ruling R-E) — bounded at this age
// since the handler started.
export const RETRY_SESSION_BUDGET_MS = 4500;

export interface ToolDeps {
  kv: KvPort;
  actors: ActorPort;
  adapter: SeedAdapter;
  publicKey: string;
  pinPepper: string;
  now: () => number;
}

export const SAFE_FLAGS: Flags = {
  deflection_enabled: true,
  require_pin: true,
  demo_caller: null,
  fault_open_ticket: null,
  fault_dv_delay_ms: null,
  actor_mode: "per-entity",
};

const SENTINELS = new Set(["none", "unknown"]);

export function usable(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !SENTINELS.has(value) &&
    !value.includes("{{")
  );
}

export function str(value: string | null | undefined, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function customersName(customerId: string): string | null {
  return CUSTOMERS.find((c) => c.customer_id === customerId)?.name ?? null;
}

export async function flagsOf(deps: ToolDeps): Promise<Flags> {
  try {
    return await readFlags(deps.kv, deps.now());
  } catch {
    return SAFE_FLAGS;
  }
}

export async function flagsBounded(deps: ToolDeps, ms: number): Promise<Flags> {
  const r = await deadline(flagsOf(deps), ms, "tool.flags");
  return r.ok ? r.value : SAFE_FLAGS;
}

export interface SessionRead {
  session: Session;
  fromKv: boolean;
  timedOut: boolean;
  // The still-pending KV read, kept so a 403 can be retried once with the
  // real session (ruling R-E). Never rejects unhandled: deadline() attached
  // a catch before it was handed out.
  pending: Promise<Session> | null;
}

export async function readSessionBounded(
  kv: KvPort,
  k: string,
  ms: number,
): Promise<SessionRead> {
  const p = get(kv, k);
  const r = await deadline(p, ms, "tool.session");
  if (r.ok) {
    return { session: r.value, fromKv: true, timedOut: false, pending: null };
  }
  return { session: emptySession(k), fromKv: false, timedOut: true, pending: p };
}

// Waits for the session read that timed out earlier, but only until
// RETRY_SESSION_BUDGET_MS has elapsed since the handler started. Returns
// null when the read cannot answer in time (or failed), so the caller
// rethrows its original denial.
export async function retryKvSession(
  pending: Promise<Session>,
  deps: ToolDeps,
  started: number,
): Promise<Session | null> {
  const remaining = RETRY_SESSION_BUDGET_MS - (deps.now() - started);
  if (remaining <= 0) return null;
  const r = await deadline(pending, remaining, "tool.session_retry");
  return r.ok ? r.value : null;
}

export async function readProjection(
  kv: KvPort,
  region: string,
): Promise<IncidentProjection | null> {
  try {
    return parseProjection(await kv.get(kvKey("incident", "active", region)));
  } catch {
    return null;
  }
}

export interface PreludeOk {
  ok: true;
  body: Record<string, unknown>;
  k: string | null;
  callKey: string;
  trace_id: string;
  started: number;
  convPending: Promise<boolean> | null;
  deps: ToolDeps;
  kvMs: () => number;
  actorMs: () => number;
}

export type PreludeResult = PreludeOk | { ok: false; response: Response };

export interface Timers {
  kv: number;
  actor: number;
}

export function newTimers(): Timers {
  return { kv: 0, actor: 0 };
}

function timedApi<T extends object>(api: T, now: () => number, timers: Timers): T {
  const names = new Set<string>();
  for (let o: object | null = api; o !== null; o = Object.getPrototypeOf(o)) {
    for (const name of Object.getOwnPropertyNames(o)) {
      if (name === "constructor") continue;
      if (typeof (o as Record<string, unknown>)[name] === "function") names.add(name);
    }
  }
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const fn = (api as unknown as Record<string, unknown>)[name] as (
      ...args: unknown[]
    ) => unknown;
    out[name] = async (...args: unknown[]) => {
      const started = now();
      try {
        return await fn.apply(api, args);
      } finally {
        timers.actor += now() - started;
      }
    };
  }
  return out as T;
}

export function timingKv(kv: KvPort, now: () => number, timers: Timers): KvPort {
  return {
    get: async (key) => {
      const started = now();
      try {
        return await kv.get(key);
      } finally {
        timers.kv += now() - started;
      }
    },
    put: async (key, value, opts) => {
      const started = now();
      try {
        await kv.put(key, value, opts);
      } finally {
        timers.kv += now() - started;
      }
    },
    delete: async (key) => {
      const started = now();
      try {
        await kv.delete(key);
      } finally {
        timers.kv += now() - started;
      }
    },
    list: async (prefix) => {
      const started = now();
      try {
        return await kv.list(prefix);
      } finally {
        timers.kv += now() - started;
      }
    },
  };
}

export function timingActors(
  actors: ActorPort,
  now: () => number,
  timers: Timers,
): ActorPort {
  return {
    site: (siteId) => timedApi(actors.site(siteId), now, timers),
    region: (region) => timedApi(actors.region(region), now, timers),
  };
}

function headerTrace(request: Request): string {
  return str(request.headers.get("x-trace-id"), "t-none");
}

export async function prelude(
  request: Request,
  deps: ToolDeps,
  evt: string,
): Promise<PreludeResult> {
  const started = deps.now();
  const timers = newTimers();
  const kv = timingKv(deps.kv, deps.now, timers);
  const actors = timingActors(deps.actors, deps.now, timers);
  const instrumented: ToolDeps = { ...deps, kv, actors };
  let raw: string;
  try {
    raw = await request.text();
  } catch (err) {
    logEvent("tool.sig_fail", {
      hop: "tool",
      trace_id: headerTrace(request),
      outcome: "denied",
      reason: "body_error",
      err: String(err),
      kv_ms: timers.kv,
      actor_ms: timers.actor,
    });
    return { ok: false, response: Response.json({ error: "forbidden" }, { status: 403 }) };
  }
  const sig = await verifySigned(request, raw, deps.publicKey, deps.now());
  if (sig !== "ok") {
    logEvent("tool.sig_fail", {
      hop: "tool",
      trace_id: headerTrace(request),
      outcome: "denied",
      reason: sig,
      kv_ms: timers.kv,
      actor_ms: timers.actor,
    });
    return { ok: false, response: Response.json({ error: "forbidden" }, { status: 403 }) };
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    logEvent(evt, {
      hop: "tool",
      trace_id: headerTrace(request),
      outcome: "error",
      reason: "bad_json",
      kv_ms: timers.kv,
      actor_ms: timers.actor,
      total_ms: deps.now() - started,
    });
    return { ok: false, response: Response.json({ error: "bad_json" }, { status: 422 }) };
  }

  const ccid = usable(body.call_control_id) ? body.call_control_id : null;
  const bodyKey = usable(body.call_key) ? body.call_key : null;
  const k = await sessionKey({
    call_control_id: ccid ?? undefined,
    call_key: bodyKey ?? undefined,
  });
  const bodyTrace =
    usable(body.trace_id) && body.trace_id !== "t-none" ? body.trace_id : null;
  const trace_id =
    k !== null ? traceId(k) : bodyTrace ?? headerTrace(request);
  const headerCcid = str(request.headers.get("x-telnyx-call-control-id"), "");
  if (ccid !== null && headerCcid !== "" && headerCcid !== ccid) {
    logEvent("tool.ccid_mismatch", {
      hop: "tool",
      trace_id,
      k: k ?? "none",
      lvl: "warn",
      header_present: true,
      matches: false,
      kv_ms: timers.kv,
      actor_ms: timers.actor,
    });
  }
  const convId = usable(body.conversation_id) ? body.conversation_id : null;
  let convPending: Promise<boolean> | null = null;
  if (k !== null && convId !== null) {
    convPending = deadline(linkConversation(kv, convId, k), 4000, "tool.conv").then(
      (r) => r.ok,
    );
  }
  return {
    ok: true,
    body,
    k,
    callKey: ccid ?? bodyKey ?? "none",
    trace_id,
    started,
    convPending,
    deps: instrumented,
    kvMs: () => timers.kv,
    actorMs: () => timers.actor,
  };
}

export function fail(
  evt: string,
  deps: ToolDeps,
  pre: PreludeOk,
  status: 422 | 500,
  reason: string,
  extra: Record<string, unknown> = {},
): Response {
  logEvent(evt, {
    hop: "tool",
    trace_id: pre.trace_id,
    k: pre.k ?? "none",
    outcome: "error",
    reason,
    kv_ms: pre.kvMs(),
    actor_ms: pre.actorMs(),
    total_ms: deps.now() - pre.started,
    ...extra,
  });
  return Response.json({ error: reason }, { status });
}

export function toolError(
  evt: string,
  deps: ToolDeps,
  pre: PreludeOk,
  err: unknown,
): Response {
  logEvent(evt, {
    hop: "tool",
    trace_id: pre.trace_id,
    k: pre.k ?? "none",
    outcome: "error",
    error: err instanceof Error ? err.message : String(err),
    kv_ms: pre.kvMs(),
    actor_ms: pre.actorMs(),
    total_ms: deps.now() - pre.started,
  });
  return Response.json({ error: "internal" }, { status: 500 });
}
