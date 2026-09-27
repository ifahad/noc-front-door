import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { NocEdgeEnv } from "../../src/actors";
import { route } from "../../src/router";
import { FakeKv } from "../fakes/kv";
import { CONV, MCP_TOKEN, OPS_TOKEN } from "./helpers";

const MCP_URL = "https://noc-edge.telnyxcompute.com/mcp";

function makeEnv(secrets: (name: string) => Promise<string | null>): NocEdgeEnv {
  return {
    CACHE: new FakeKv(),
    SITES: { idFromName: () => ({}) },
    REGIONS: { idFromName: () => ({}) },
    SECRETS: { get: secrets },
  } as unknown as NocEdgeEnv;
}

function makeEnvWithTokens(): NocEdgeEnv {
  return makeEnv(async (name) => {
    if (name === "MCP_TOKEN") return MCP_TOKEN;
    if (name === "OPS_TOKEN") return OPS_TOKEN;
    if (name === "PIN_PEPPER") return ["p", "e", "pp", "er"].join("");
    throw new Error(`unknown_secret_${name}`);
  });
}

function clientFor(env: NocEdgeEnv, token: string): { client: Client; transport: StreamableHTTPClientTransport } {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: async (url: string | URL, init?: RequestInit) =>
      route(new Request(url, init), env),
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "vitest-client", version: "1.0.0" });
  return { client, transport };
}

describe("MCP route wiring", () => {
  it("returns 405 for GET /mcp", async () => {
    const env = makeEnvWithTokens();
    const response = await route(new Request(MCP_URL, { method: "GET" }), env);
    expect(response.status).toBe(405);
  });

  it("returns 405 for DELETE /mcp", async () => {
    const env = makeEnvWithTokens();
    const response = await route(new Request(MCP_URL, { method: "DELETE" }), env);
    expect(response.status).toBe(405);
  });

  it("returns 401 for a POST without a bearer", async () => {
    const env = makeEnvWithTokens();
    const response = await route(
      new Request(MCP_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("returns 401 when the secrets cannot be read", async () => {
    const env = makeEnv(async () => {
      throw new Error("secrets_unavailable");
    });
    const response = await route(
      new Request(MCP_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("serves a full client session through the route", async () => {
    const env = makeEnvWithTokens();
    const { client, transport } = clientFor(env, MCP_TOKEN);
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(5);
    await client.close();
  });

  it("rejects ops requests that carry _meta with 403", async () => {
    const env = makeEnvWithTokens();
    const response = await route(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${OPS_TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: { telnyx_conversation_id: CONV } },
        }),
      }),
      env,
    );
    expect(response.status).toBe(403);
  });

  it("returns 404 for unknown paths", async () => {
    const env = makeEnvWithTokens();
    const response = await route(new Request("https://noc-edge.telnyxcompute.com/nope", { method: "GET" }), env);
    expect(response.status).toBe(404);
  });
});
