import { env as importedEnv } from "@telnyx/edge-runtime";
import { logEvent } from "./log";
import {
  constantTimeEqual,
  findValue,
  keyPaths,
  pickCallKey,
  pickToolCallKey,
  sha256Hex,
} from "./util";
import { verifyTelnyxSignature, type SigResult } from "./ed25519";
import { handleMcp } from "./mcp";

export { ProbeActorV2 } from "./probe-actor";

const INSTANCE_ID = crypto.randomUUID();
const STARTED_AT = Date.now();

type ProcLike = {
  on?: (evt: string, cb: (reason: unknown) => void) => void;
  version?: string;
};

const proc = (globalThis as { process?: ProcLike }).process;
const hasProcessOn = typeof proc?.on === "function";
if (hasProcessOn && proc?.on) {
  proc.on("unhandledRejection", (reason: unknown) => {
    logEvent("unhandled_caught", { reason: String(reason) });
  });
}
logEvent("boot", { hasProcessOn });

type SecretName = "OPS_TOKEN" | "MCP_TOKEN" | "TELNYX_PUBLIC_KEY";
const secretCache = new Map<SecretName, string>();

async function getSecret(env: Env, name: SecretName): Promise<string> {
  const cached = secretCache.get(name);
  if (cached !== undefined) return cached;
  const value = await env.SECRETS.get(name);
  secretCache.set(name, value);
  return value;
}

type AuthStatus = "valid" | "invalid" | "absent";

async function diagAuth(request: Request, env: Env): Promise<AuthStatus> {
  const header = request.headers.get("authorization");
  if (!header) return "absent";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return "invalid";
  let token = "";
  try {
    token = await getSecret(env, "OPS_TOKEN");
  } catch {
    token = "";
  }
  return constantTimeEqual(match[1], token) ? "valid" : "invalid";
}

interface KvLike {
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  get(key: string): Promise<string | null>;
}

async function kvProbe(e: unknown): Promise<string> {
  const ns = (e as { CACHE?: KvLike } | null)?.CACHE;
  if (!ns) return "absent";
  try {
    await ns.put("diag/probe", "ok", { expirationTtl: 300 });
    const value = await ns.get("diag/probe");
    if (value === "ok") return "ok";
    if (value === null) return "miss";
    return "error:unexpected_value";
  } catch (err) {
    return `error:${String(err)}`;
  }
}

function healthLiveness(): Response {
  const uptimeMs = Date.now() - STARTED_AT;
  logEvent("health.liveness", { instance: INSTANCE_ID, uptime_ms: uptimeMs });
  return Response.json({
    ok: true,
    instance: INSTANCE_ID,
    startedAt: STARTED_AT,
    uptimeMs,
    node: proc?.version ?? "unknown",
  });
}

async function diagBindings(
  env: Env,
  status: AuthStatus
): Promise<Response> {
  const importedKeys = Object.keys(importedEnv ?? {});
  const fetchArgKeys = Object.keys(env ?? {});
  const kvViaImported = await kvProbe(importedEnv);
  const kvViaFetchArg = await kvProbe(env);
  logEvent("diag.bindings", {
    authorization: status,
    importedKeys,
    fetchArgKeys,
    kvViaImported,
    kvViaFetchArg,
  });
  return Response.json({ importedKeys, fetchArgKeys, kvViaImported, kvViaFetchArg });
}

async function diagArm(env: Env, status: AuthStatus): Promise<Response> {
  const token = crypto.randomUUID();
  const result = await env.PROBE.idFromName("probe1").armAlarm(10000, token);
  logEvent("diag.arm", {
    authorization: status,
    armedFor: result.armedFor,
    token: result.token,
  });
  return Response.json({ armedFor: result.armedFor, token: result.token });
}

async function diagStatus(env: Env, status: AuthStatus): Promise<Response> {
  const res = await env.PROBE.idFromName("probe1").status();
  logEvent("diag.status", {
    authorization: status,
    armed: res.armed !== null,
    fired: res.fired !== null,
    pendingAlarm: res.pendingAlarm,
  });
  return Response.json(res);
}

async function diagPing(env: Env, status: AuthStatus): Promise<Response> {
  const t0 = Date.now();
  await env.PROBE.idFromName("probe1").ping();
  const actorMs = Date.now() - t0;
  logEvent("diag.ping", { authorization: status, actor_ms: actorMs });
  return Response.json({ actor_ms: actorMs });
}

async function diagUnhandled(status: AuthStatus): Promise<Response> {
  setTimeout(() => {
    Promise.reject(new Error("probe"));
  }, 50);
  logEvent("diag.unhandled", { authorization: status, instance: INSTANCE_ID });
  return Response.json({ scheduled: true, instance: INSTANCE_ID });
}

async function diagRoute(
  request: Request,
  env: Env,
  path: string
): Promise<Response> {
  const status = await diagAuth(request, env);
  if (status !== "valid") {
    logEvent("diag.denied", { path, authorization: status });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (request.method !== "GET") {
    logEvent("diag.denied", { path, authorization: status, method: request.method });
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  switch (path) {
    case "/diag/bindings":
      return diagBindings(env, status);
    case "/diag/arm":
      return diagArm(env, status);
    case "/diag/status":
      return diagStatus(env, status);
    case "/diag/actor-ping":
      return diagPing(env, status);
    case "/diag/unhandled":
      return diagUnhandled(status);
    default:
      logEvent("diag.denied", { path, authorization: status });
      return Response.json({ error: "not_found" }, { status: 404 });
  }
}

interface SigCheck {
  sig: SigResult;
  webhookSignature: boolean;
  webhookTimestamp: boolean;
}

async function sigCheck(
  request: Request,
  env: Env,
  raw: Uint8Array
): Promise<SigCheck> {
  let publicKey = "";
  try {
    publicKey = await getSecret(env, "TELNYX_PUBLIC_KEY");
  } catch {
    publicKey = "";
  }
  const sig = await verifyTelnyxSignature({
    publicKey: publicKey || null,
    signature: request.headers.get("telnyx-signature-ed25519"),
    timestamp: request.headers.get("telnyx-timestamp"),
    rawBody: raw,
  });
  return {
    sig,
    webhookSignature: request.headers.has("webhook-signature"),
    webhookTimestamp: request.headers.has("webhook-timestamp"),
  };
}

function parseJsonObject(raw: Uint8Array): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

async function dvRoute(request: Request, env: Env): Promise<Response> {
  const raw = new Uint8Array(await request.arrayBuffer());
  const check = await sigCheck(request, env, raw);
  const body = parseJsonObject(raw);
  const callKey = pickCallKey(body);
  const traceId = `t-${(await sha256Hex(callKey)).slice(0, 16)}`;
  logEvent("dv.probe", {
    sig: check.sig,
    webhook_signature: check.webhookSignature ? "present" : "absent",
    webhook_timestamp: check.webhookTimestamp ? "present" : "absent",
    key_paths: keyPaths(body),
    event_type: findValue(body, "event_type") ?? "none",
    telnyx_conversation_channel:
      findValue(body, "telnyx_conversation_channel") ?? "none",
    assistant_id: findValue(body, "assistant_id") ?? "none",
    caller: findValue(body, "from") ?? "none",
    call_key: callKey,
  });
  return Response.json({
    dynamic_variables: {
      probe_route: "b",
      probe_num: "3",
      greet_name: "Fahad",
      call_key: callKey,
      trace_id: traceId,
    },
    conversation: { metadata: { call_key: callKey, trace_id: traceId } },
  });
}

async function echoRoute(request: Request, env: Env): Promise<Response> {
  const raw = new Uint8Array(await request.arrayBuffer());
  const check = await sigCheck(request, env, raw);
  const body = parseJsonObject(raw);
  const callKey = pickToolCallKey(body);
  logEvent("tool.echo", {
    sig: check.sig,
    webhook_signature: check.webhookSignature ? "present" : "absent",
    webhook_timestamp: check.webhookTimestamp ? "present" : "absent",
    header_names: [...request.headers.keys()],
    x_telnyx_call_control_id:
      request.headers.get("x-telnyx-call-control-id") ?? "none",
    x_trace_id: request.headers.get("x-trace-id") ?? "none",
    content_type: request.headers.get("content-type") ?? "none",
    call_key: callKey,
    body,
  });
  return Response.json({ result: "stored", call_key: callKey });
}

async function mcpRoute(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    logEvent("mcp.rejected", { method: request.method });
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  let token = "";
  try {
    token = await getSecret(env, "MCP_TOKEN");
  } catch {
    token = "";
  }
  return handleMcp(request, token);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/health/liveness" && request.method === "GET") {
        return healthLiveness();
      }
      if (path === "/mcp") return await mcpRoute(request, env);
      if (path.startsWith("/diag/")) return await diagRoute(request, env, path);
      if (path === "/dv" && request.method === "POST") {
        return await dvRoute(request, env);
      }
      if (path === "/tools/echo" && request.method === "POST") {
        return await echoRoute(request, env);
      }
      logEvent("http.fallthrough", { method: request.method, path });
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (err) {
      logEvent("http.error", {
        method: request.method,
        path,
        error: String(err),
      });
      return Response.json({ error: "internal" }, { status: 500 });
    }
  },
};
