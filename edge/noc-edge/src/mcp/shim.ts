import { constantTimeEqual } from "../../../shared/src/ids";
import { parseBearer } from "../auth";
import { logEvent } from "../log";

export type McpScope = "session" | "ops";

export function bearerScope(
  header: string | null,
  mcpToken: string,
  opsToken: string,
): McpScope | null {
  const token = parseBearer(header);
  if (token === null) return null;
  if (constantTimeEqual(token, mcpToken)) return "session";
  if (constantTimeEqual(token, opsToken)) return "ops";
  return null;
}

export function normalizeRequest(request: Request, raw: Uint8Array): Request {
  const headers = new Headers(request.headers);
  headers.set("accept", "application/json, text/event-stream");
  return new Request(request.url, {
    method: "POST",
    headers,
    body: raw.slice().buffer as ArrayBuffer,
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

interface WireInfo {
  method: string;
  jsonrpc_method: string;
  header_names: string;
  accept: string;
  protocol_version: string;
  meta: string;
}

export function wireInfo(request: Request, parsedBody: unknown): WireInfo {
  const body = (parsedBody ?? null) as {
    method?: unknown;
    params?: { _meta?: unknown };
  } | null;
  const meta = body?.params?._meta;
  return {
    method: request.method,
    jsonrpc_method: typeof body?.method === "string" ? body.method : "none",
    header_names: Array.from(request.headers.keys()).join(","),
    accept: request.headers.get("accept") ?? "none",
    protocol_version: request.headers.get("mcp-protocol-version") ?? "none",
    meta: typeof meta === "object" && meta !== null ? Object.keys(meta).join(",") : "none",
  };
}

export function logWire(request: Request, parsedBody: unknown): void {
  logEvent("mcp.wire", { hop: "mcp", outcome: "ok", ...wireInfo(request, parsedBody) });
}

export function conversationIdOf(parsedBody: unknown): string | null {
  const body = parsedBody as {
    method?: unknown;
    params?: { _meta?: { telnyx_conversation_id?: unknown } };
  } | null;
  if (typeof body?.method !== "string" || body.method !== "tools/call") return null;
  const convId = body.params?._meta?.telnyx_conversation_id;
  if (
    typeof convId !== "string" ||
    convId.length === 0 ||
    convId === "none" ||
    convId === "unknown"
  ) {
    return null;
  }
  return convId;
}

export function opsMetaViolation(parsedBody: unknown): boolean {
  const body = parsedBody as { params?: { _meta?: unknown } } | null;
  const meta = body?.params?._meta;
  if (meta === undefined || meta === null) return false;
  if (typeof meta !== "object" || Array.isArray(meta)) return true;
  return Object.keys(meta as Record<string, unknown>).length > 0;
}
