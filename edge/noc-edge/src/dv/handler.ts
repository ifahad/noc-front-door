import { isFresh, verifyTelnyxSignature } from "../../../shared/src/ed25519";
import { sessionKey, traceId } from "../../../shared/src/ids";
import { kvKey } from "../../../shared/src/kvkeys";
import { mask } from "../../../shared/src/mask";
import { openTicketNote } from "../../../shared/src/readback";
import { deadline, type DeadlineResult } from "../../../shared/src/timing";
import type { Contact } from "../../../shared/src/types";
import type { SeedAdapter } from "../../../shared/src/itsm";
import { logEvent } from "../log";
import type { ActorPort } from "../services/actorPort";
import { read as readFlags, type Flags } from "../services/flags";
import { lookup } from "../services/directory";
import type { KvPort } from "../services/kvPort";
import { putDv, linkConversation, type DvSession } from "../services/sessions";
import { routeHint } from "./route";
import type { IncidentProjection } from "../services/incidents";

const MSP_NAME = "Najd Networks";
const KEYLESS_SKETCH = "your site";
const KEYLESS_ORG = "your organisation";
const ACTOR_RACE_MS = 400;
const KEY_LOG_LIMIT = 5;

const SAFE_FLAGS: Flags = {
  deflection_enabled: true,
  require_pin: true,
  demo_caller: null,
  fault_open_ticket: null,
  fault_dv_delay_ms: null,
};

const ORDINALS: Record<number, string> = {
  2: "second",
  3: "third",
  4: "fourth",
  5: "fifth",
  6: "sixth",
  7: "seventh",
  8: "eighth",
  9: "ninth",
  10: "tenth",
  11: "eleventh",
  12: "twelfth",
  13: "thirteenth",
  14: "fourteenth",
  15: "fifteenth",
};

const SENTINELS = new Set(["none", "unknown"]);

function usable(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !SENTINELS.has(value) &&
    !value.includes("{{")
  );
}

function str(value: string | undefined | null, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export interface DvDeps {
  kv: KvPort;
  actors: ActorPort;
  adapter: SeedAdapter;
  publicKey: string;
  now: () => number;
  timeoutMs: number;
}

export function repeatNote(callsToday: number): string {
  if (callsToday < 2) return "none";
  const word = ORDINALS[callsToday] ?? `${callsToday}th`;
  return `I can see this is your ${word} call today about this branch.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let keyLogBudget = KEY_LOG_LIMIT;

export async function handleDv(request: Request, deps: DvDeps): Promise<Response> {
  const started = deps.now();
  let raw: string;
  try {
    raw = await request.text();
  } catch (err) {
    logEvent("dv.sig_fail", {
      hop: "dv",
      outcome: "denied",
      reason: "body_error",
      err: String(err),
    });
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const sigResult = await verifyTelnyxSignature(request.headers, raw, deps.publicKey ?? "");
  const fresh = isFresh(request.headers.get("telnyx-timestamp"), Math.floor(deps.now() / 1000));
  if (deps.publicKey === "" || sigResult !== "valid" || !fresh) {
    logEvent("dv.sig_fail", {
      hop: "dv",
      outcome: "denied",
      reason: deps.publicKey === "" ? "no_key" : sigResult !== "valid" ? sigResult : "stale",
    });
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logEvent("error", { hop: "dv", outcome: "error", err: String(err) });
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const data = (parsed as { data?: unknown } | null)?.data;
  const dataKeys = data !== null && typeof data === "object" ? Object.keys(data) : [];
  const payload =
    data !== null && typeof data === "object"
      ? ((data as { payload?: unknown }).payload as Record<string, unknown> | undefined)
      : undefined;
  if (payload === undefined || payload === null || typeof payload !== "object") {
    logEvent("error", { hop: "dv", outcome: "error", reason: "no_payload" });
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const convId = usable(payload.telnyx_conversation_id)
    ? payload.telnyx_conversation_id
    : null;
  const ccid = usable(payload.call_control_id) ? payload.call_control_id : null;
  const call_key = ccid ?? convId ?? crypto.randomUUID();
  let k = await sessionKey({ call_control_id: ccid ?? undefined, call_key });
  if (k === null) k = await sessionKey({ call_key });
  if (k === null) {
    throw new Error("unreachable_call_key");
  }
  const trace_id = traceId(k);
  const endUserTarget = usable(payload.telnyx_end_user_target)
    ? payload.telnyx_end_user_target
    : null;

  logEvent("dv.request", {
    hop: "dv",
    trace_id,
    k,
    conv_id: convId ?? undefined,
    event_type: str(
      typeof (data as { event_type?: unknown }).event_type === "string"
        ? ((data as { event_type?: unknown }).event_type as string)
        : undefined,
      "unknown",
    ),
    outcome: "ok",
    ...(keyLogBudget > 0
      ? { keys: { data: dataKeys, payload: Object.keys(payload) } }
      : {}),
  });
  if (keyLogBudget > 0) keyLogBudget -= 1;

  const internalBudget = Math.max(0, deps.timeoutMs - 300);
  const internalEnd = started + internalBudget;
  const remaining = () => Math.max(0, internalEnd - deps.now());
  let kvMs = 0;
  let actorMs = 0;
  let degraded = false;

  const flagsStart = deps.now();
  const flagsR = await deadline(readFlags(deps.kv, deps.now()), remaining(), "dv.flags");
  const flags = flagsR.ok ? flagsR.value : SAFE_FLAGS;
  if (!flagsR.ok) degraded = true;
  kvMs += deps.now() - flagsStart;

  const dirStart = deps.now();
  const dirR = await deadline(
    lookup({ kv: deps.kv, adapter: deps.adapter, flags }, endUserTarget),
    remaining(),
    "dv.dir",
  );
  const contact: Contact | null = dirR.ok ? dirR.value : null;
  if (!dirR.ok) degraded = true;
  kvMs += deps.now() - dirStart;

  let incident: IncidentProjection | null = null;
  if (contact !== null && flags.deflection_enabled) {
    const incStart = deps.now();
    const incR = await deadline(
      deps.kv.get(kvKey("incident", "active", contact.region)),
      remaining(),
      "dv.incident",
    );
    if (incR.ok) incident = parseProjection(incR.value);
    if (!incR.ok) degraded = true;
    kvMs += deps.now() - incStart;
  }

  let callsToday = 1;
  let openTicket: string | null = null;
  if (contact !== null) {
    const aStart = deps.now();
    const race = Math.min(ACTOR_RACE_MS, remaining());
    const callR = await deadline(
      deps.actors.site(contact.site_id).recordCall({
        k,
        trace_id,
        at: deps.now(),
      }),
      race,
      "dv.recordCall",
    );
    actorMs = deps.now() - aStart;
    if (callR.ok) {
      callsToday = callR.value.callsToday;
      openTicket = callR.value.openTicket;
    } else {
      degraded = true;
      callsToday = 1;
      openTicket = null;
    }
  }

  const dvSession: DvSession = {
    trace_id,
    identified: contact !== null,
    contact_id: contact?.contact_id ?? null,
    customer_id: contact?.customer_id ?? null,
    sites: contact !== null ? [contact.site_id] : [],
    region: contact?.region ?? null,
  };
  const wStart = deps.now();
  const putP = deadline(putDv(deps.kv, k, dvSession), remaining(), "dv.session");
  const convP: Promise<DeadlineResult<void>> =
    convId !== null
      ? deadline(linkConversation(deps.kv, convId, k), remaining(), "dv.conv")
      : Promise.resolve({ ok: true, value: undefined });
  const [putR, convR] = await Promise.all([putP, convP]);
  const sessionWritten = putR.ok;
  if (!sessionWritten || !convR.ok) degraded = true;
  kvMs += deps.now() - wStart;

  const hint = routeHint({ sessionWritten, flags, contact, incident });

  const variables: Record<string, string> = {
    msp_name: MSP_NAME,
    route_hint: hint,
    caller_name: str(contact?.name, "there"),
    customer_name: str(contact?.customer_name, KEYLESS_ORG),
    site_id: str(contact?.site_id, "unknown"),
    site_label: str(contact?.site_label, KEYLESS_SKETCH),
    incident_region: str(incident?.region_label, "your area"),
    incident_started: str(incident?.started_local, "earlier today"),
    incident_summary: str(incident?.summary, "a network incident"),
    incident_eta: str(incident?.eta_local, "shortly"),
    open_ticket_note: openTicketNote(openTicket === null ? null : { id: openTicket }),
    repeat_note: repeatNote(callsToday),
    calls_today: String(callsToday),
    trace_id,
    call_key,
  };

  let faultInjected = false;
  const delayMs = flags.fault_dv_delay_ms;
  if (delayMs !== null && delayMs > 0) {
    faultInjected = true;
    await sleep(delayMs);
  }

  const total = deps.now() - started;
  const body = {
    dynamic_variables: variables,
    conversation: { metadata: { trace_id, call_key } },
  };
  logEvent("dv.route", {
    hop: "dv",
    trace_id,
    k,
    conv_id: convId ?? undefined,
    caller: endUserTarget !== null ? mask(endUserTarget) : undefined,
    site: contact?.site_id,
    region: contact?.region,
    route_hint: hint,
    kv_ms: kvMs,
    actor_ms: actorMs,
    total_ms: total,
    outcome: degraded ? "fallback" : "ok",
    fault_injected: faultInjected || undefined,
  });
  if (total > deps.timeoutMs - 200 || faultInjected) {
    logEvent("dv.late", {
      hop: "dv",
      trace_id,
      total_ms: total,
      outcome: degraded ? "fallback" : "ok",
      fault_injected: faultInjected,
    });
  }
  return Response.json(body, { status: 200 });
}

function parseProjection(raw: string | null): IncidentProjection | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<IncidentProjection>;
    if (typeof value.id !== "string" || value.id.length === 0) return null;
    return {
      id: value.id,
      version: typeof value.version === "number" ? value.version : 0,
      region_label: str(value.region_label, ""),
      started_local: str(value.started_local, ""),
      summary: str(value.summary, ""),
      eta_local: str(value.eta_local, ""),
      priority: str(value.priority, "P2"),
      site_count: typeof value.site_count === "number" ? value.site_count : 0,
    };
  } catch {
    return null;
  }
}
