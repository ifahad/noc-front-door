import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { SeedAdapter } from "../../../shared/src/itsm";
import { traceId } from "../../../shared/src/ids";
import { deadline } from "../../../shared/src/timing";
import { logEvent } from "../log";
import type { ActorPort } from "../services/actorPort";
import type { KvPort } from "../services/kvPort";
import { byConversation, get as getSession } from "../services/sessions";
import type { Session } from "../../../shared/src/types";
import {
  bearerScope,
  conversationIdOf,
  logWire,
  normalizeParsedBody,
  normalizeRequest,
  opsMetaViolation,
} from "./shim";
import { MCP_HOP, TOOL_SCHEMAS, registerMcpTools, type McpLang } from "./tools";

export interface McpDeps {
  kv: KvPort;
  actors: ActorPort;
  adapter: SeedAdapter;
  now: () => number;
  mcpToken: string;
  opsToken: string;
}

const MCP_NAME = "noc-mcp";
const MCP_VERSION = "1.0.0";
const SESSION_DEADLINE_MS = 4500;

interface CallBody {
  method?: unknown;
  id?: unknown;
  params?: { name?: unknown; arguments?: unknown };
}

function callBodyOf(parsedBody: unknown): CallBody | null {
  const body = parsedBody as CallBody | null;
  if (body === null || typeof body !== "object") return null;
  if (body.method !== "tools/call") return null;
  return body;
}

function langOf(request: Request): McpLang {
  try {
    return new URL(request.url).searchParams.get("lang") === "ar" ? "ar" : "en";
  } catch {
    return "en";
  }
}

function logRejectedToolCall(
  deps: McpDeps,
  session: Session | null,
  body: CallBody,
  reason: "unknown_tool" | "bad_args",
): void {
  const name = typeof body.params?.name === "string" ? body.params.name : "none";
  logEvent("mcp.tool", {
    hop: MCP_HOP,
    tool: name,
    trace_id: session !== null ? session.trace_id : "none",
    outcome: "error",
    reason,
    total_ms: 0,
  });
}

async function resolveSession(deps: McpDeps, parsedBody: unknown): Promise<Session | null> {
  const startedAt = deps.now();
  const convId = conversationIdOf(parsedBody);
  if (convId === null) {
    logEvent("mcp.session", {
      hop: MCP_HOP,
      outcome: "fallback",
      reason: "no_conv_id",
      trace_id: "none",
      kv_ms: 0,
      actor_ms: 0,
    });
    return null;
  }
  let failed = false;
  let knownK: string | null = null;
  const MISS = Symbol("miss");
  const lookup = (async () => {
    const k = await byConversation(deps.kv, convId);
    if (k === null) return null;
    knownK = k;
    return await getSession(deps.kv, k);
  })().catch((err: unknown) => {
    failed = true;
    return MISS;
  });
  const result = await deadline(lookup, SESSION_DEADLINE_MS, "mcp.session");
  const kvMs = Math.max(0, deps.now() - startedAt);
  const trace = knownK !== null ? traceId(knownK) : "none";
  const conv = convId.slice(0, 8);
  if (!result.ok || typeof result.value === "symbol") {
    logEvent("mcp.session", {
      hop: MCP_HOP,
      outcome: "fallback",
      reason: failed ? "error" : "timeout",
      trace_id: trace,
      kv_ms: kvMs,
      actor_ms: 0,
      conv,
    });
    return null;
  }
  if (result.value === null) {
    logEvent("mcp.session", {
      hop: MCP_HOP,
      outcome: "fallback",
      reason: "no_conv_link",
      trace_id: trace,
      kv_ms: kvMs,
      actor_ms: 0,
      conv,
    });
    return null;
  }
  logEvent("mcp.session", {
    hop: MCP_HOP,
    outcome: "ok",
    trace_id: result.value.trace_id,
    kv_ms: kvMs,
    actor_ms: 0,
    conv,
  });
  return result.value;
}

// The always-on deep-health canary calls handleMcp in-process every 10 s
// (spec §11.1 quiet-canary rule); quiet skips the per-request mcp.auth and
// mcp.wire lines so health checks never crowd out call hops. Real /mcp
// requests omit quiet and keep logging both.
export async function handleMcp(
  request: Request,
  deps: McpDeps,
  opts: { quiet?: boolean } = {},
): Promise<Response> {
  const scope = bearerScope(
    request.headers.get("authorization"),
    deps.mcpToken,
    deps.opsToken,
  );
  if (!opts.quiet) {
    logEvent("mcp.auth", {
      hop: MCP_HOP,
      trace_id: "none",
      scope: scope ?? "none",
      outcome: scope === null ? "denied" : "ok",
      kv_ms: 0,
      actor_ms: 0,
    });
  }
  if (scope === null) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const raw = new Uint8Array(await request.arrayBuffer());
  let parsedBody: unknown;
  let parsed = false;
  try {
    parsedBody = JSON.parse(new TextDecoder().decode(raw));
    parsed = true;
  } catch {
    parsedBody = undefined;
  }
  const cleaned = normalizeParsedBody(parsedBody);
  if (!opts.quiet) {
    logWire(request, cleaned);
  }

  if (scope === "ops" && opsMetaViolation(cleaned)) {
    logEvent("auth.denied", {
      hop: MCP_HOP,
      trace_id: "none",
      outcome: "denied",
      reason: "ops_meta",
    });
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const session =
    scope === "session" ? await resolveSession(deps, cleaned) : null;

  const body = callBodyOf(cleaned);
  if (body !== null) {
    const name = typeof body.params?.name === "string" ? body.params.name : "";
    const schema = TOOL_SCHEMAS[name];
    if (schema === undefined) {
      logRejectedToolCall(deps, session, body, "unknown_tool");
    } else {
      const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
      if (!schema.safeParse(args).success) {
        logRejectedToolCall(deps, session, body, "bad_args");
      }
    }
  }

  const normalized = normalizeRequest(request, raw);
  const server = new McpServer({ name: MCP_NAME, version: MCP_VERSION });
  registerMcpTools(server, {
    scope,
    kv: deps.kv,
    actors: deps.actors,
    adapter: deps.adapter,
    now: deps.now,
    session,
    lang: langOf(request),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(
      normalized,
      parsed ? { parsedBody: cleaned } : undefined,
    );
  } finally {
    await server.close().catch(() => {});
  }
}
