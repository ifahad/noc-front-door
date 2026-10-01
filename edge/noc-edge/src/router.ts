import { bearerOk, type SecretGetter } from "./auth";
import { logEvent } from "./log";
import { type NocEdgeEnv } from "./actors";
import { bindingKvPort, type KvPort } from "./services/kvPort";
import { bindingActorPort, type ActorPort } from "./services/actorPort";
import { muxActorPort } from "./services/muxActorPort";
import {
  ACTOR_MODE_DEFAULT,
  readDetailed,
  type ActorMode,
  type Flags,
} from "./services/flags";
import { getSecret, loadSeedLocal, makeAdapter } from "./env";
import { handleDv, SAFE_FLAGS } from "./dv/handler";
import { handleVerifySite } from "./tools/verifySite";
import { handleOpenTicket } from "./tools/openTicket";
import { handleJoinIncident } from "./tools/joinIncident";
import { handleCallback } from "./tools/callback";
import { handleMcp } from "./mcp/server";
import { renderDemoPage } from "./demo/page";
import { loadDemoGuide } from "./demo/guide";
import { renderStatusHtml } from "./ops/status";
import { getBoard, statusPayloadOf } from "./ops/board";
import { runDeepHealth } from "./ops/health";
import { listReports, readReport } from "./services/reports";
import {
  OpsActionError,
  OpsBadRequestError,
  ackIncident,
  claimRegionPage,
  markRegionPageSent,
  pageClaimInput,
  pageSentInput,
  pendingPages,
  resetAll,
  resolveIncident,
  stageIncident,
  tickRegions,
  unlockSite,
  type ActionDeps,
} from "./ops/actions";
import { RaceError, runRace, type RaceDeps } from "./ops/race";
import type { ToolDeps } from "./tools/common";
import { deadline } from "../../shared/src/timing";

export const DEFAULT_SITE = "RUH-114";
export const DEFAULT_REGION = "riyadh-north";

const opsTokenGetters = new WeakMap<NocEdgeEnv, SecretGetter>();

// actor_mode is a KV flag (flag/actor_mode): "mux" routes every actor call
// through the single working Counter instance on noc-actor-canary (the
// DEBUGLOG #4 contingency); anything else uses the per-entity bindings.
// A KV failure must never take a route down: fail open to the last
// known-good mode, or to the deploy-time ACTOR_MODE_DEFAULT (mux — the mode
// that works on this account) when nothing is known yet. Tool and ops
// webhooks allow seconds; /dv chooses its actor port from the flags read
// handleDv performs inside its own budget (see routeDv).
const FLAGS_BUDGET_MS = 2000;
// Tool webhooks cannot afford the full flags budget before the handler even
// starts (ruling R-B): 250 ms here keeps /tools/verify-site inside ~3.5 s
// and /tools/open-ticket inside ~4.5 s when KV hangs. A miss falls back to
// lastKnownMode ?? ACTOR_MODE_DEFAULT (mux — the only working mode), and the
// in-flight read keeps filling the memo for later calls.
const TOOL_FLAGS_BUDGET_MS = 250;

let lastKnownMode: ActorMode | null = null;
// Quiet canary (final review F26): actor_mode.read is logged only on a memo
// miss or a mode change, not on every route that picks a port.
const loggedModeByKv = new WeakMap<KvPort, ActorMode>();

export function __resetActorModeForTests(): void {
  lastKnownMode = null;
}

async function selectActorPort(
  env: NocEdgeEnv,
  budgetMs: number,
): Promise<{ port: ActorPort; mode: ActorMode }> {
  const kv = bindingKvPort(env.CACHE);
  const started = Date.now();
  const raced = await deadline(readDetailed(kv, started), budgetMs, "actor.flags");
  if (!raced.ok) {
    const mode: ActorMode = lastKnownMode ?? ACTOR_MODE_DEFAULT;
    logEvent("flags.fallback", {
      lvl: "warn",
      hop: "actor-mode",
      outcome: "fallback",
      mode,
      total_ms: Date.now() - started,
      budget_ms: budgetMs,
    });
    return {
      port: mode === "mux" ? muxActorPort(env) : bindingActorPort(env),
      mode,
    };
  }
  const mode: ActorMode =
    raced.value.flags.actor_mode === "mux" ? "mux" : "per-entity";
  lastKnownMode = mode;
  if (!raced.value.memo_hit || loggedModeByKv.get(kv) !== mode) {
    loggedModeByKv.set(kv, mode);
    logEvent("actor_mode.read", {
      lvl: "info",
      hop: "actor-mode",
      outcome: "ok",
      total_ms: Date.now() - started,
      mode,
    });
  }
  return mode === "mux"
    ? { port: muxActorPort(env), mode }
    : { port: bindingActorPort(env), mode };
}

export function makeOpsTokenGetter(env: NocEdgeEnv): SecretGetter {
  let getter = opsTokenGetters.get(env);
  if (getter === undefined) {
    getter = () => getSecret(env, "OPS_TOKEN");
    opsTokenGetters.set(env, getter);
  }
  return getter;
}

async function pingOne(
  name: string,
  call: () => Promise<{ pong: true; name: string }>,
): Promise<{ pong: true; name: string; actor_ms: number }> {
  const started = Date.now();
  const reply = await call();
  return { ...reply, actor_ms: Date.now() - started };
}

export async function routeOpsActorPing(
  request: Request,
  env: NocEdgeEnv,
  opsToken: SecretGetter,
): Promise<Response> {
  const url = new URL(request.url);
  const site = url.searchParams.get("site") ?? DEFAULT_SITE;
  const region = url.searchParams.get("region") ?? DEFAULT_REGION;

  const header = request.headers.get("authorization");
  const expected = await opsToken();
  if (typeof expected !== "string" || !bearerOk(header, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const { port, mode } = await selectActorPort(env, FLAGS_BUDGET_MS);
    const siteResult = await pingOne(site, () => port.site(site).ping());
    const regionResult = await pingOne(region, () => port.region(region).ping());
    return Response.json({ mode, site: siteResult, region: regionResult });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logEvent("actor_ping_failed", {
      lvl: "error",
      hop: "ops/actor-ping",
      error: detail,
    });
    return Response.json({ error: "actor", detail }, { status: 502 });
  }
}

export async function withErrorHandling(
  hop: string,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logEvent("error", { lvl: "error", hop, outcome: "error", error: detail });
    return Response.json({ error: "internal" }, { status: 500 });
  }
}

async function routeDv(request: Request, env: NocEdgeEnv): Promise<Response> {
  const [adapter, publicKey] = await Promise.all([
    makeAdapter(env),
    getSecret(env, "TELNYX_PUBLIC_KEY"),
  ]);
  // The /dv actor port is chosen from the SAME flags read handleDv performs
  // (no separate actor-mode read). Timed-out flags arrive as SAFE_FLAGS, so
  // fall back to the last-known-good mode, or the deploy-time default, without
  // overwriting it.
  const actorsFor = (flags: Flags): ActorPort => {
    if (flags === SAFE_FLAGS) {
      const mode = lastKnownMode ?? ACTOR_MODE_DEFAULT;
      return mode === "mux" ? muxActorPort(env) : bindingActorPort(env);
    }
    lastKnownMode = flags.actor_mode;
    return flags.actor_mode === "mux" ? muxActorPort(env) : bindingActorPort(env);
  };
  return handleDv(request, {
    kv: bindingKvPort(env.CACHE),
    actors: bindingActorPort(env),
    actorsFor,
    adapter,
    publicKey: publicKey ?? "",
    now: () => Date.now(),
    timeoutMs: 2500,
  });
}

async function routeTool(
  request: Request,
  env: NocEdgeEnv,
  handler: (request: Request, deps: ToolDeps) => Promise<Response>,
): Promise<Response> {
  const [adapter, publicKey, pinPepper] = await Promise.all([
    makeAdapter(env),
    getSecret(env, "TELNYX_PUBLIC_KEY"),
    getSecret(env, "PIN_PEPPER"),
  ]);
  return handler(request, {
    kv: bindingKvPort(env.CACHE),
    actors: (await selectActorPort(env, TOOL_FLAGS_BUDGET_MS)).port,
    adapter,
    publicKey: publicKey ?? "",
    pinPepper: pinPepper ?? "",
    now: () => Date.now(),
  });
}

async function routeMcp(request: Request, env: NocEdgeEnv): Promise<Response> {
  const [mcpToken, opsToken, adapter] = await Promise.all([
    getSecret(env, "MCP_TOKEN"),
    getSecret(env, "OPS_TOKEN"),
    makeAdapter(env),
  ]);
  return handleMcp(request, {
    kv: bindingKvPort(env.CACHE),
    actors: (await selectActorPort(env, FLAGS_BUDGET_MS)).port,
    adapter,
    now: () => Date.now(),
    mcpToken: mcpToken ?? "",
    opsToken: opsToken ?? "",
  });
}

function opsTraceId(): string {
  return `t-ops-${crypto.randomUUID().slice(0, 8)}`;
}

interface OpsCtx {
  kv: ReturnType<typeof bindingKvPort>;
  actors: ActorPort;
  mode: ActorMode;
  now: number;
  trace_id: string;
}

async function opsCtx(env: NocEdgeEnv): Promise<OpsCtx> {
  const { port, mode } = await selectActorPort(env, FLAGS_BUDGET_MS);
  return {
    kv: bindingKvPort(env.CACHE),
    actors: port,
    mode,
    now: Date.now(),
    trace_id: opsTraceId(),
  };
}

async function actionCtx(env: NocEdgeEnv): Promise<ActionDeps> {
  const ctx = await opsCtx(env);
  const adapter = await makeAdapter(env);
  return {
    kv: ctx.kv,
    actors: ctx.actors,
    adapter,
    now: ctx.now,
    trace_id: ctx.trace_id,
    reports: env.REPORTS ?? null,
  };
}

async function raceCtx(env: NocEdgeEnv): Promise<RaceDeps> {
  const ctx = await opsCtx(env);
  const adapter = await makeAdapter(env);
  return { kv: ctx.kv, actors: ctx.actors, adapter, now: ctx.now, trace_id: ctx.trace_id };
}

async function routeOps(
  request: Request,
  env: NocEdgeEnv,
  hop: string,
  handler: () => Promise<Response>,
): Promise<Response> {
  const token = await makeOpsTokenGetter(env)();
  if (typeof token !== "string" || !bearerOk(request.headers.get("authorization"), token)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return await handler();
  } catch (err) {
    if (err instanceof OpsActionError || err instanceof RaceError) {
      logEvent("ops.error", {
        hop,
        trace_id: opsTraceId(),
        outcome: "error",
        error: err.message,
      });
      return Response.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof OpsBadRequestError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    const detail = err instanceof Error ? err.message : String(err);
    logEvent("error", { lvl: "error", hop, outcome: "error", error: detail });
    return Response.json({ error: "internal" }, { status: 500 });
  }
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new OpsBadRequestError("invalid_json");
  }
}

// Public viewer route. It rides the same single-flight board cache as
// /ops/board (one build per ~30 s window per isolate), so a curl loop or an
// auto-refreshing tab cannot load the single mux actor through /ops/status
// (final review F2).
async function routeOpsStatus(request: Request, env: NocEdgeEnv): Promise<Response> {
  const url = new URL(request.url);
  const board = await getBoard(env, {
    kv: bindingKvPort(env.CACHE),
    selectActor: () => selectActorPort(env, FLAGS_BUDGET_MS),
    now: Date.now(),
  });
  const payload = statusPayloadOf(board);
  if (url.searchParams.get("format") === "html") {
    return new Response(renderStatusHtml(payload), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return Response.json(payload);
}

// Public, viewer-facing read of the live board. The single-flight cache in
// getBoard (keyed on env) protects the single actor instance from one build
// per viewer; build failures fall through to withErrorHandling's 500 so the
// page keeps its last snapshot.
async function routeOpsBoard(request: Request, env: NocEdgeEnv): Promise<Response> {
  const payload = await getBoard(env, {
    kv: bindingKvPort(env.CACHE),
    selectActor: () => selectActorPort(env, FLAGS_BUDGET_MS),
    now: Date.now(),
  });
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return Response.json(payload, { headers });
}

async function routeOpsHealth(env: NocEdgeEnv, opsToken: string): Promise<Response> {
  const ctx = await opsCtx(env);
  const adapter = await makeAdapter(env);
  const [mcpToken, publicKey, seedLocal] = await Promise.all([
    getSecret(env, "MCP_TOKEN"),
    getSecret(env, "TELNYX_PUBLIC_KEY"),
    loadSeedLocal(env),
  ]);
  const result = await runDeepHealth({
    kv: ctx.kv,
    actors: ctx.actors,
    adapter,
    now: ctx.now,
    opsToken,
    mcpToken: mcpToken ?? "",
    publicKey,
    seedLocal,
    trace_id: ctx.trace_id,
  });
  return Response.json(result);
}

// The demo page, served identically at / and /demo: same render, same
// headers, same 405 for every other method.
async function routeDemo(request: Request, env: NocEdgeEnv): Promise<Response> {
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(renderDemoPage(await loadDemoGuide(env)), { status: 200, headers });
}

export async function route(
  request: Request,
  env: NocEdgeEnv,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/dv") {
    return withErrorHandling("dv", () => routeDv(request, env));
  }
  if (request.method === "POST" && url.pathname === "/tools/verify-site") {
    return withErrorHandling("tools/verify-site", () =>
      routeTool(request, env, handleVerifySite),
    );
  }
  if (request.method === "POST" && url.pathname === "/tools/open-ticket") {
    return withErrorHandling("tools/open-ticket", () =>
      routeTool(request, env, handleOpenTicket),
    );
  }
  if (request.method === "POST" && url.pathname === "/tools/join-incident") {
    return withErrorHandling("tools/join-incident", () =>
      routeTool(request, env, handleJoinIncident),
    );
  }
  if (request.method === "POST" && url.pathname === "/tools/callback") {
    return withErrorHandling("tools/callback", () =>
      routeTool(request, env, handleCallback),
    );
  }
  if (url.pathname === "/mcp") {
    if (request.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }
    return withErrorHandling("mcp", () => routeMcp(request, env));
  }
  if (request.method === "GET" && url.pathname === "/ops/actor-ping") {
    return withErrorHandling("ops/actor-ping", () =>
      routeOpsActorPing(request, env, makeOpsTokenGetter(env)),
    );
  }
  if (request.method === "GET" && url.pathname === "/ops/status") {
    return withErrorHandling("ops/status", () => routeOpsStatus(request, env));
  }
  if (url.pathname === "/ops/board") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }
    return withErrorHandling("ops/board", () => routeOpsBoard(request, env));
  }
  if (url.pathname === "/" || url.pathname === "/demo") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }
    return withErrorHandling("demo", () => routeDemo(request, env));
  }
  if (request.method === "GET" && url.pathname === "/ops/health/deep") {
    return routeOps(request, env, "ops/health", async () => {
      const opsToken = (await makeOpsTokenGetter(env)()) ?? "";
      return routeOpsHealth(env, opsToken);
    });
  }
  if (request.method === "POST" && url.pathname === "/ops/reset") {
    return routeOps(request, env, "ops/reset", async () =>
      Response.json(await resetAll(await actionCtx(env))),
    );
  }
  if (request.method === "POST" && url.pathname === "/ops/stage-incident") {
    return routeOps(request, env, "ops/stage-incident", async () => {
      const ctx = await actionCtx(env);
      const region = new URL(request.url).searchParams.get("region") ?? "riyadh-north";
      return Response.json(await stageIncident(ctx, region));
    });
  }
  if (request.method === "POST" && url.pathname === "/ops/resolve") {
    return routeOps(request, env, "ops/resolve", async () => {
      const ctx = await actionCtx(env);
      const region = new URL(request.url).searchParams.get("region") ?? "";
      return Response.json(await resolveIncident(ctx, region));
    });
  }
  if (request.method === "POST" && url.pathname === "/ops/ack") {
    return routeOps(request, env, "ops/ack", async () => {
      const ctx = await actionCtx(env);
      const region = new URL(request.url).searchParams.get("region") ?? "";
      return Response.json(await ackIncident(ctx, region));
    });
  }
  if (request.method === "POST" && url.pathname === "/ops/unlock") {
    return routeOps(request, env, "ops/unlock", async () => {
      const ctx = await actionCtx(env);
      const site = new URL(request.url).searchParams.get("site") ?? "";
      return Response.json(await unlockSite(ctx, site));
    });
  }
  if (request.method === "POST" && url.pathname === "/ops/tick") {
    return routeOps(request, env, "ops/tick", async () => {
      const ctx = await opsCtx(env);
      const mux = ctx.mode === "mux" ? env.MUX : null;
      return Response.json(await tickRegions(ctx, mux));
    });
  }
  if (request.method === "GET" && url.pathname === "/ops/pages/pending") {
    return routeOps(request, env, "ops/pages-pending", async () => {
      const ctx = await opsCtx(env);
      return Response.json({ mode: ctx.mode, pages: await pendingPages(ctx) });
    });
  }
  if (request.method === "POST" && url.pathname === "/ops/pages/claim") {
    return routeOps(request, env, "ops/pages-claim", async () => {
      const ctx = await opsCtx(env);
      const input = pageClaimInput(await readJsonBody(request));
      return Response.json(await claimRegionPage(ctx, input));
    });
  }
  if (request.method === "POST" && url.pathname === "/ops/pages/sent") {
    return routeOps(request, env, "ops/pages-sent", async () => {
      const ctx = await opsCtx(env);
      const input = pageSentInput(await readJsonBody(request));
      return Response.json(await markRegionPageSent(ctx, input));
    });
  }
  if (request.method === "GET" && url.pathname === "/ops/reports") {
    return routeOps(request, env, "ops/reports", async () => {
      const out = await listReports(env.REPORTS ?? null);
      if (out.degraded) {
        return Response.json({ reports: [], degraded: true }, { status: 502 });
      }
      return Response.json({ reports: out.reports });
    });
  }
  if (request.method === "GET" && url.pathname.startsWith("/ops/reports/")) {
    return routeOps(request, env, "ops/reports-get", async () => {
      const raw = url.pathname.slice("/ops/reports/".length);
      let key: string;
      try {
        key = decodeURIComponent(raw);
      } catch {
        return Response.json({ error: "invalid_key" }, { status: 400 });
      }
      const out = await readReport(env.REPORTS ?? null, key);
      if (out.status === "invalid_key") {
        return Response.json({ error: "invalid_key" }, { status: 400 });
      }
      if (out.status === "missing") {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      if (out.status === "error") {
        return Response.json({ error: "storage" }, { status: 502 });
      }
      return Response.json(out.report);
    });
  }
  if (request.method === "POST" && url.pathname === "/diag/race") {
    return routeOps(request, env, "diag/race", async () => {
      const ctx = await raceCtx(env);
      const params = new URL(request.url).searchParams;
      return Response.json(
        await runRace(ctx, params.get("mode"), params.get("n"), params.get("run")),
      );
    });
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}
