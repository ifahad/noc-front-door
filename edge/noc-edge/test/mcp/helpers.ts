import { vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SeedAdapter } from "../../../shared/src/itsm";
import type { SeedLocalConfig } from "../../../shared/src/itsm";
import { sessionKey, traceId } from "../../../shared/src/ids";
import type { KvPort } from "../../src/services/kvPort";
import type { ActorPort } from "../../src/services/actorPort";
import type { McpDeps } from "../../src/mcp/server";
import { FakeKv } from "../fakes/kv";
import { FakeActorPort } from "../fakes/actors";
import { putAuth, putDv, linkConversation } from "../../src/services/sessions";

export const MCP_TOKEN = ["m", "cp", "-tok", "en"].join("");
export const OPS_TOKEN = ["o", "ps", "-tok", "en"].join("");
export const BAD_TOKEN = ["b", "ad", "-tok", "en"].join("");
export const PIN = String(4000 + 114);
export const CCID = "CC-MCP-1";
export const CONV = "conv-mcp-1";
export const T0 = Date.UTC(2026, 8, 26, 6, 0, 0);

export const SEED_LOCAL: SeedLocalConfig = {
  pins: { "RUH-114": PIN },
  contacts: [],
};

export interface LogLine extends Record<string, unknown> {
  evt: string;
  lvl?: string;
}

let logs: string[] = [];
let spy: { mockRestore: () => void } | null = null;

export function startLogs(): void {
  logs = [];
  spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  }) as unknown as { mockRestore: () => void };
}

export function stopLogs(): void {
  spy?.mockRestore();
  spy = null;
  logs = [];
}

export function eventsWith(evt: string): LogLine[] {
  return logs.map((l) => JSON.parse(l) as LogLine).filter((l) => l.evt === evt);
}

export function newKv(): FakeKv {
  const kv = new FakeKv();
  kv.setNow(T0);
  return kv;
}

export function makeAdapter(now: () => number = () => T0): SeedAdapter {
  return new SeedAdapter({ seedLocal: SEED_LOCAL, pepper: ["p", "e", "pp", "er"].join(""), now });
}

export function makeDeps(opts?: {
  kv?: KvPort;
  actors?: ActorPort;
  adapter?: SeedAdapter;
  now?: () => number;
}): McpDeps {
  return {
    kv: opts?.kv ?? newKv(),
    actors: opts?.actors ?? new FakeActorPort(),
    adapter: opts?.adapter ?? makeAdapter(opts?.now),
    now: opts?.now ?? (() => T0),
    mcpToken: MCP_TOKEN,
    opsToken: OPS_TOKEN,
  };
}

export interface SessionSeed {
  customer_id?: string | null;
  sites?: string[];
  identified?: boolean;
  verified?: boolean;
  region?: string | null;
}

export async function seedSession(kv: KvPort, seed: SessionSeed = {}): Promise<string> {
  const k = await sessionKey({ call_control_id: CCID });
  if (k === null) throw new Error("no session key");
  await putDv(kv, k, {
    trace_id: traceId(k),
    identified: seed.identified ?? true,
    contact_id: "c-ahmed",
    customer_id: seed.customer_id ?? "c-alwaha",
    sites: seed.sites ?? ["RUH-114"],
    region: seed.region ?? "riyadh-north",
  });
  if (seed.verified ?? true) {
    const siteId = (seed.sites ?? ["RUH-114"])[0];
    await putAuth(kv, k, {
      verified: true,
      site_id: siteId,
      customer_id: seed.customer_id ?? "c-alwaha",
      at: T0,
    });
  }
  await linkConversation(kv, CONV, k);
  return k;
}

export async function connectClient(deps: McpDeps, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL("https://noc-edge.telnyxcompute.com/mcp"),
    {
      fetch: async (url: string | URL, init?: RequestInit) => {
        const { handleMcp } = await import("../../src/mcp/server");
        return handleMcp(new Request(url, init), deps);
      },
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    },
  );
  const client = new Client({ name: "vitest-client", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
  convId: string | null = CONV,
): Promise<CallToolResult> {
  const params: Record<string, unknown> = { name, arguments: args };
  if (convId !== null) {
    params._meta = { telnyx_conversation_id: convId };
  }
  const promise = client.request(
    { method: "tools/call", params } as Parameters<Client["request"]>[0],
    CallToolResultSchema,
  );
  return promise as Promise<CallToolResult>;
}

export function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first !== undefined && first.type === "text" ? first.text : "";
}

export async function seedTicket(
  actors: ActorPort,
  k: string,
  at: number = T0,
): Promise<string> {
  const opened = await actors.site("RUH-114").openOrAttach({
    k,
    trace_id: traceId(k),
    callerRef: "c-ahmed",
    symptom: "loss of connectivity",
    impact: "site_down",
    serviceAffecting: true,
    priority: "P2",
    at,
    siteCode: "14",
  });
  return opened.ticket.id;
}
