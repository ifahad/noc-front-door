import { sessionKey, traceId } from "../../../shared/src/ids";
import type { SeedAdapter } from "../../../shared/src/itsm";
import { CUSTOMERS } from "../../../shared/src/seed";
import { parseProjection } from "../dv/handler";
import { verifySigned } from "../lib/signed";
import { logEvent } from "../log";
import type { ActorPort } from "../services/actorPort";
import type { IncidentProjection } from "../services/incidents";
import type { Flags } from "../services/flags";
import { read as readFlags } from "../services/flags";
import type { KvPort } from "../services/kvPort";
import { linkConversation } from "../services/sessions";
import { kvKey } from "../../../shared/src/kvkeys";

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
  convLinked: boolean;
}

export type PreludeResult = PreludeOk | { ok: false; response: Response };

function headerTrace(request: Request): string {
  return str(request.headers.get("x-trace-id"), "t-none");
}

export async function prelude(
  request: Request,
  deps: ToolDeps,
  evt: string,
): Promise<PreludeResult> {
  const started = deps.now();
  let raw: string;
  try {
    raw = await request.text();
  } catch (err) {
    logEvent("tool.sig_fail", {
      hop: "tool",
      outcome: "denied",
      reason: "body_error",
      err: String(err),
    });
    return { ok: false, response: Response.json({ error: "forbidden" }, { status: 403 }) };
  }
  const sig = await verifySigned(request, raw, deps.publicKey, deps.now());
  if (sig !== "ok") {
    logEvent("tool.sig_fail", { hop: "tool", outcome: "denied", reason: sig });
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
  const trace_id = usable(body.trace_id)
    ? body.trace_id
    : k !== null
      ? traceId(k)
      : headerTrace(request);
  const headerCcid = str(request.headers.get("x-telnyx-call-control-id"), "");
  if (ccid !== null && headerCcid !== "" && headerCcid !== ccid) {
    logEvent("tool.ccid_mismatch", {
      hop: "tool",
      trace_id,
      k: k ?? "none",
      lvl: "warn",
      header_present: true,
      matches: false,
    });
  }
  let convLinked = false;
  const convId = usable(body.conversation_id) ? body.conversation_id : null;
  if (k !== null && convId !== null) {
    try {
      await linkConversation(deps.kv, convId, k);
      convLinked = true;
    } catch {
      convLinked = false;
    }
  }
  return {
    ok: true,
    body,
    k,
    callKey: ccid ?? bodyKey ?? "none",
    trace_id,
    started,
    convLinked,
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
    total_ms: deps.now() - pre.started,
  });
  return Response.json({ error: "internal" }, { status: 500 });
}
