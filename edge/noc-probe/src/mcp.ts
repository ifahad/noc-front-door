import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { logEvent } from "./log";
import { bufferOf, constantTimeEqual } from "./util";

const MAX_SLOW_MS = 25000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bearerStatus(
  request: Request,
  token: string
): "valid" | "invalid" | "absent" {
  const header = request.headers.get("authorization");
  if (!header) return "absent";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return "invalid";
  return constantTimeEqual(match[1], token) ? "valid" : "invalid";
}

interface WireInfo {
  method: string;
  jsonrpcMethod: string;
  headerNames: string[];
  accept: string;
  mcpProtocolVersion: string;
  paramsMeta: unknown;
}

function wireInfo(request: Request, parsedBody: unknown): WireInfo {
  const body = (parsedBody ?? null) as {
    method?: unknown;
    params?: { _meta?: unknown };
  } | null;
  return {
    method: request.method,
    jsonrpcMethod: typeof body?.method === "string" ? body.method : "none",
    headerNames: [...request.headers.keys()],
    accept: request.headers.get("accept") ?? "none",
    mcpProtocolVersion: request.headers.get("mcp-protocol-version") ?? "none",
    paramsMeta: body?.params?._meta ?? "none",
  };
}

function normalizeRequest(request: Request, raw: Uint8Array): Request {
  const headers = new Headers(request.headers);
  headers.set("accept", "application/json, text/event-stream");
  return new Request(request.url, {
    method: "POST",
    headers,
    body: bufferOf(raw),
  });
}

export function normalizeParsedBody(parsedBody: unknown): unknown {
  const meta = (
    parsedBody as { params?: { _meta?: { progressToken?: unknown } } } | null
  )?.params?._meta;
  if (meta && "progressToken" in meta && meta.progressToken === null) {
    delete meta.progressToken;
  }
  return parsedBody;
}

export async function handleMcp(
  request: Request,
  mcpToken: string
): Promise<Response> {
  const auth = bearerStatus(request, mcpToken);
  logEvent("mcp.auth", { auth });
  if (auth !== "valid") {
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

  logEvent("mcp.wire", { ...wireInfo(request, parsedBody), body_parsed: parsed });

  const normalized = normalizeRequest(request, raw);
  const cleaned = normalizeParsedBody(parsedBody);

  const server = new McpServer({ name: "noc-probe", version: "0.1.0" });
  server.registerTool(
    "echo_probe",
    {
      description: "Echo probe: returns the given text prefixed with 'echo: '.",
      inputSchema: { text: z.string() },
    },
    async (args, extra) => {
      logEvent("mcp.tool_echo", { meta: extra?._meta ?? "none" });
      return { content: [{ type: "text", text: `echo: ${args.text}` }] };
    }
  );
  server.registerTool(
    "slow_probe",
    {
      description: "Slow probe: sleeps min(ms, 25000) then returns.",
      inputSchema: { ms: z.number() },
    },
    async (args) => {
      const ms = Math.min(args.ms, MAX_SLOW_MS);
      await sleep(ms);
      return { content: [{ type: "text", text: `slept ${ms}ms` }] };
    }
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(
      normalized,
      parsed ? { parsedBody: cleaned } : undefined
    );
  } finally {
    await server.close().catch(() => {});
  }
}
