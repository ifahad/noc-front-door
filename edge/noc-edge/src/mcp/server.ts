import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { SeedAdapter } from "../../../shared/src/itsm";
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
import { MCP_HOP, TOOL_SCHEMAS, registerMcpTools } from "./tools";

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
  const convId = conversationIdOf(parsedBody);
  if (convId === null) return null;
  try {
    const k = await byConversation(deps.kv, convId);
    if (k === null) return null;
    return await getSession(deps.kv, k);
  } catch {
    return null;
  }
}

export async function handleMcp(request: Request, deps: McpDeps): Promise<Response> {
  const scope = bearerScope(
    request.headers.get("authorization"),
    deps.mcpToken,
    deps.opsToken,
  );
  logEvent("mcp.auth", {
    hop: MCP_HOP,
    scope: scope ?? "none",
    outcome: scope === null ? "denied" : "ok",
  });
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
  logWire(request, cleaned);

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
