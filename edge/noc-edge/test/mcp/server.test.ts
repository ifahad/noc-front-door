import { afterEach, describe, expect, it } from "vitest";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { kvKey } from "../../../shared/src/kvkeys";
import {
  connectClient,
  callTool,
  textOf,
  makeDeps,
  seedSession,
  seedTicket,
  newKv,
  makeAdapter,
  startLogs,
  stopLogs,
  eventsWith,
  CONV,
  MCP_TOKEN,
  OPS_TOKEN,
  T0,
} from "./helpers";
import { FakeActorPort } from "../fakes/actors";
import { FakeKv } from "../fakes/kv";
import { SlowActorPort, SlowKv } from "../fakes/slow";
import type { KvPort } from "../../src/services/kvPort";
import { handleMcp } from "../../src/mcp/server";
import { normalizeParsedBody } from "../../src/mcp/shim";
import type { McpDeps } from "../../src/mcp/server";

const TOOL_NAMES = [
  "find_site",
  "get_site_status",
  "check_known_incidents",
  "get_ticket_status",
  "add_ticket_note",
];

const FALLBACK =
  "I can't reach our network systems right now, but I can still log your ticket.";

const MCP_URL = "https://noc-edge.telnyxcompute.com/mcp";

function postRequest(
  headers: Record<string, string>,
  body: unknown,
): Request {
  return new Request(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function initializeBody(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1.0.0" },
    },
  };
}

let deps: McpDeps;
let client: Client | undefined;

afterEach(() => {
  stopLogs();
});

async function sessionClient(seed = {}): Promise<Client> {
  await seedSession(deps.kv, seed);
  return connectClient(deps, MCP_TOKEN);
}

describe("MCP transport", () => {
  it("lists exactly the five tools after initialize", async () => {
    deps = makeDeps();
    client = await sessionClient();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(
      tools.tools.every(
        (t) => typeof t.description === "string" && t.description.length > 0,
      ),
    ).toBe(true);
  });

  it("keeps the serverInfo name noc-mcp and version 1.0.0", async () => {
    deps = makeDeps();
    const response = await handleMcp(
      postRequest(
        { authorization: `Bearer ${MCP_TOKEN}` },
        initializeBody(),
      ),
      deps,
    );
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as {
      result?: { serverInfo?: { name?: string; version?: string } };
    };
    expect(parsed.result?.serverInfo?.name).toBe("noc-mcp");
    expect(parsed.result?.serverInfo?.version).toBe("1.0.0");
  });

  it("logs mcp.auth and mcp.wire for a normal MCP request", async () => {
    deps = makeDeps();
    startLogs();
    const response = await handleMcp(
      postRequest(
        { authorization: `Bearer ${MCP_TOKEN}` },
        initializeBody(),
      ),
      deps,
    );
    expect(response.status).toBe(200);
    expect(eventsWith("mcp.auth")).toHaveLength(1);
    expect(eventsWith("mcp.wire")).toHaveLength(1);
  });

  it("accepts params._meta.progressToken null", async () => {
    deps = makeDeps();
    client = await sessionClient();
    const params = {
      name: "get_site_status",
      arguments: {},
      _meta: { progressToken: null, telnyx_conversation_id: CONV },
    } as unknown as Parameters<typeof client.request>[0]["params"];
    const result = (await client.request(
      { method: "tools/call", params },
      CallToolResultSchema,
    )) as CallToolResult;
    expect(textOf(result)).toContain("Al Yasmin");
  });

  it("accepts notifications with 202", async () => {
    deps = makeDeps();
    const response = await handleMcp(
      postRequest(
        {
          authorization: `Bearer ${MCP_TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ),
      deps,
    );
    expect(response.status).toBe(202);
  });

  it("returns -32601 for an unknown JSON-RPC method, never 404", async () => {
    deps = makeDeps();
    client = await sessionClient();
    await expect(
      client.request({ method: "bogus/method" } as never, CallToolResultSchema),
    ).rejects.toMatchObject({ code: -32601 });
  });

  it("normalizes progressToken null in the parsed body", () => {
    const parsed = {
      params: { _meta: { progressToken: null, telnyx_conversation_id: CONV } },
    };
    const cleaned = normalizeParsedBody(parsed) as {
      params: { _meta: { progressToken?: unknown; telnyx_conversation_id?: string } };
    };
    expect("progressToken" in cleaned.params._meta).toBe(false);
    expect(cleaned.params._meta.telnyx_conversation_id).toBe(CONV);
  });

  it("rejects an absent bearer with 401 before the SDK", async () => {
    deps = makeDeps();
    const response = await handleMcp(
      postRequest({}, initializeBody()),
      deps,
    );
    expect(response.status).toBe(401);
    expect((await response.json()) as Record<string, unknown>).toHaveProperty("error");
  });

  it("rejects a wrong bearer with 401 before the SDK", async () => {
    deps = makeDeps();
    const response = await handleMcp(
      postRequest(
        { authorization: `Bearer ${["w", "rong"].join("")}` },
        initializeBody(),
      ),
      deps,
    );
    expect(response.status).toBe(401);
  });

  it("accepts a lowercase bearer scheme", async () => {
    deps = makeDeps();
    const response = await handleMcp(
      postRequest(
        { authorization: `bearer ${MCP_TOKEN}`, accept: "application/json, text/event-stream" },
        initializeBody(),
      ),
      deps,
    );
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as { result?: unknown };
    expect(parsed.result).toBeDefined();
  });
});

describe("MCP session scope", () => {
  it("speaks the fallback when tools/call carries no _meta", async () => {
    deps = makeDeps();
    client = await sessionClient();
    const result = await callTool(client, "get_site_status", {}, null);
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe(FALLBACK);
  });

  it("speaks the fallback when the conversation is not linked", async () => {
    deps = makeDeps();
    startLogs();
    client = await sessionClient();
    const result = await callTool(client, "get_site_status", {}, "conv-unknown");
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe(FALLBACK);
    expect(eventsWith("mcp.tool")[0]?.outcome).toBe("fallback");
  });

  it("speaks the default site status without arguments", async () => {
    deps = makeDeps();
    client = await sessionClient();
    const result = await callTool(client, "get_site_status", {});
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe(
      "The edge router at the Al Yasmin branch stopped responding at 1:52 AM; the backup LTE link is also down.",
    );
    expect((result.structuredContent as Record<string, unknown>)?.site_id).toBe("RUH-114");
  });

  it("speaks a healthy status for another site of the caller's customer", async () => {
    deps = makeDeps({ kv: newKv(), actors: new FakeActorPort(), adapter: makeAdapter() });
    client = await sessionClient();
    const result = await callTool(client, "get_site_status", { site_id: "JED-007" });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe("The JED-007 branch looks healthy from our side.");
  });

  it("reads another site of the caller's own customer", async () => {
    deps = makeDeps();
    client = await sessionClient();
    const result = await callTool(client, "get_site_status", { site_id: "RUH-121" });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain("Al Malqa");
  });

  it("refuses an unknown site id as not found", async () => {
    deps = makeDeps();
    client = await sessionClient();
    const result = await callTool(client, "get_site_status", { site_id: "RUH-999" });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe("I couldn't find that branch for your organisation.");
  });

  it("looks up a spoken branch name", async () => {
    deps = makeDeps();
    client = await sessionClient();
    const result = await callTool(client, "find_site", { description: "the Yasmin branch" });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe("That's the Al Yasmin branch, site R U H, 1 1 4.");
    expect((result.structuredContent as Record<string, unknown>)?.site_id).toBe("RUH-114");
  });

  it("cannot find a branch outside the caller's organisation", async () => {
    deps = makeDeps();
    client = await sessionClient();
    const result = await callTool(client, "find_site", { description: "the JED-900 branch" });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe("I couldn't find that branch for your organisation.");
  });

  it("asks for verification when the linked session has no organisation", async () => {
    deps = makeDeps();
    startLogs();
    await deps.kv.put(kvKey("conv", CONV), "kunscoped00000001");
    client = await connectClient(deps, MCP_TOKEN);
    const result = await callTool(client, "find_site", {
      description: "JED zero zero seven",
    });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe(
      "I can look up branches only after you're verified with your site ID and PIN.",
    );
    expect(eventsWith("mcp.tool")[0]?.outcome).toBe("fallback");
  });

  it("refuses another tenant's site and logs auth.denied", async () => {
    deps = makeDeps();
    startLogs();
    client = await sessionClient();
    const result = await callTool(client, "get_site_status", { site_id: "JED-900" });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe("I can only look up your own site.");
    const denials = eventsWith("auth.denied");
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ hop: "mcp", tool: "get_site_status" });
    const toolLines = eventsWith("mcp.tool");
    expect(toolLines).toHaveLength(1);
    expect(toolLines[0].outcome).toBe("denied");
  });

  it("logs no auth.denied when the session has no site to default to", async () => {
    deps = makeDeps();
    startLogs();
    await seedSession(deps.kv, { sites: [], identified: true, verified: false });
    client = await connectClient(deps, MCP_TOKEN);
    const result = await callTool(client, "get_site_status", {});
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe("I can only look up your own site.");
    expect(eventsWith("auth.denied")).toHaveLength(0);
    expect(eventsWith("mcp.tool")[0]?.outcome).toBe("fallback");
  });

  it("reports the regional incident with a spoken branch count", async () => {
    deps = makeDeps();
    const k = await seedSession(deps.kv, {});
    client = await connectClient(deps, MCP_TOKEN);
    const ticketId = await seedTicket(deps.actors, k);
    await deps.actors.region("riyadh-north").reportSite({
      siteId: "RUH-114",
      ticketId,
      regionCode: "1",
      trace_id: "t-test",
      at: T0,
    });
    const opened2 = await deps.actors.site("RUH-121").openOrAttach({
      k,
      trace_id: "t-test",
      callerRef: "c-ahmed",
      symptom: "loss of connectivity",
      impact: "site_down",
      serviceAffecting: true,
      priority: "P2",
      at: T0,
      siteCode: "21",
    });
    await deps.actors.region("riyadh-north").reportSite({
      siteId: "RUH-121",
      ticketId: opened2.ticket.id,
      regionCode: "1",
      trace_id: "t-test",
      at: T0,
    });
    const result = await callTool(client, "check_known_incidents", {});
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe(
      "There's an active priority 2 incident in Riyadh North affecting two branches since 9:00 AM.",
    );
  });

  it("speaks no incidents when the region is quiet", async () => {
    deps = makeDeps();
    client = await sessionClient();
    const result = await callTool(client, "check_known_incidents", {});
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe("No known incidents in your area.");
  });

  it("speaks a lookup failure when the incident actor fails", async () => {
    const actors = new FakeActorPort();
    actors.failNextGetIncident("riyadh-north", 1);
    deps = makeDeps({ actors });
    client = await sessionClient();
    const result = await callTool(client, "check_known_incidents", {});
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe("I can't check incidents right now.");
  });

  it("reads the session site's ticket without arguments", async () => {
    deps = makeDeps();
    const k = await seedSession(deps.kv, {});
    await seedTicket(deps.actors, k);
    client = await connectClient(deps, MCP_TOKEN);
    const result = await callTool(client, "get_ticket_status", {});
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe(
      "Ticket N J D, 1 4 0 1 is priority 2; engineer response due by 9:30 AM.",
    );
  });

  it("speaks no ticket when the session site has none", async () => {
    deps = makeDeps();
    client = await sessionClient();
    const result = await callTool(client, "get_ticket_status", {});
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe("I don't see an open ticket for that branch.");
  });

  it("looks up a given ticket through its site code", async () => {
    deps = makeDeps();
    client = await sessionClient({ sites: ["RUH-121"] });
    const opened = await deps.actors.site("RUH-121").openOrAttach({
      k: "k-other",
      trace_id: "t-test",
      callerRef: "c-sara",
      symptom: "loss of connectivity",
      impact: "site_down",
      serviceAffecting: true,
      priority: "P2",
      at: T0,
      siteCode: "21",
    });
    const result = await callTool(client, "get_ticket_status", {
      ticket_id: opened.ticket.id,
    });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain("priority 2");
  });

  it("refuses a ticket that belongs to another customer and logs auth.denied", async () => {
    deps = makeDeps();
    startLogs();
    client = await sessionClient();
    const result = await callTool(client, "get_ticket_status", { ticket_id: "NJD-9001" });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe("I can only look up your own site.");
    expect(eventsWith("auth.denied")).toHaveLength(1);
  });

  it("adds a note to the session site's ticket", async () => {
    deps = makeDeps();
    const k = await seedSession(deps.kv, {});
    const ticketId = await seedTicket(deps.actors, k);
    client = await connectClient(deps, MCP_TOKEN);
    const result = await callTool(client, "add_ticket_note", {
      note: "Power restored in the back office.",
    });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe("I've added your update to ticket N J D, 1 4 0 1.");
    const ticket = await deps.actors.site("RUH-114").getTicket({ trace_id: "t-test" });
    expect(ticket.ticket?.notes).toHaveLength(1);
    expect(ticket.ticket?.notes[0]?.text).toBe("Power restored in the back office.");
    expect(ticket.ticket?.notes[0]?.k).toBe(k);
    expect(ticket.ticket?.id).toBe(ticketId);
  });

  it("refuses a note on a ticket outside the session sites", async () => {
    deps = makeDeps();
    startLogs();
    const k = await seedSession(deps.kv, {});
    await seedTicket(deps.actors, k);
    const opened = await deps.actors.site("RUH-121").openOrAttach({
      k: "other",
      trace_id: "t-test",
      callerRef: "c-sara",
      symptom: "loss of connectivity",
      impact: "site_down",
      serviceAffecting: true,
      priority: "P2",
      at: T0,
      siteCode: "21",
    });
    client = await connectClient(deps, MCP_TOKEN);
    const result = await callTool(client, "add_ticket_note", {
      ticket_id: opened.ticket.id,
      note: "Power restored in the back office.",
    });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe("I can only add notes to tickets for your own site.");
    expect(eventsWith("auth.denied")).toHaveLength(1);
  });

  it("logs exactly one auth.denied and one mcp.tool line for a cross-tenant note", async () => {
    deps = makeDeps();
    startLogs();
    const k = await seedSession(deps.kv, {});
    await seedTicket(deps.actors, k);
    const opened = await deps.actors.site("RUH-121").openOrAttach({
      k: "other",
      trace_id: "t-test",
      callerRef: "c-sara",
      symptom: "loss of connectivity",
      impact: "site_down",
      serviceAffecting: true,
      priority: "P2",
      at: T0,
      siteCode: "21",
    });
    client = await connectClient(deps, MCP_TOKEN);
    const result = await callTool(client, "add_ticket_note", {
      ticket_id: opened.ticket.id,
      note: "Power restored in the back office.",
    });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe("I can only add notes to tickets for your own site.");
    expect(eventsWith("auth.denied")).toHaveLength(1);
    expect(eventsWith("auth.denied")[0]).toMatchObject({ hop: "mcp", tool: "add_ticket_note" });
    const toolLines = eventsWith("mcp.tool");
    expect(toolLines).toHaveLength(1);
    expect(toolLines[0].outcome).toBe("denied");
  });

  it("speaks no ticket when add_note hits a ticket mismatch", async () => {
    deps = makeDeps();
    startLogs();
    const k = await seedSession(deps.kv, {});
    await seedTicket(deps.actors, k);
    client = await connectClient(deps, MCP_TOKEN);
    const result = await callTool(client, "add_ticket_note", {
      ticket_id: "NJD-1499",
      note: "Power restored in the back office.",
    });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe("I don't see an open ticket for that branch.");
    expect(eventsWith("mcp.tool")[0]?.outcome).toBe("ok");
  });

  it("speaks a write failure when the site actor throws", async () => {
    const actors = new FakeActorPort();
    const failingSite = Object.create(actors.site("RUH-114")) as {
      addNote: (input: unknown) => Promise<never>;
    };
    failingSite.addNote = async () => {
      throw new Error("kv_write_failed");
    };
    deps = makeDeps({
      actors: {
        site: (siteId: string) =>
          siteId === "RUH-114" ? (failingSite as never) : actors.site(siteId),
        region: (region: string) => actors.region(region),
      },
    });
    startLogs();
    const k = await seedSession(deps.kv, {});
    await seedTicket(deps.actors, k);
    client = await connectClient(deps, MCP_TOKEN);
    const result = await callTool(client, "add_ticket_note", {
      note: "Power restored in the back office.",
    });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe("I can't update tickets right now.");
    const line = eventsWith("mcp.tool")[0];
    expect(line?.outcome).toBe("error");
    expect(line?.error).toBe("Error");
    expect(String(line?.error)).not.toContain("kv_write_failed");
  });

  it("rejects a note longer than 300 characters", async () => {
    deps = makeDeps();
    const k = await seedSession(deps.kv, {});
    await seedTicket(deps.actors, k);
    client = await connectClient(deps, MCP_TOKEN);
    const result = await callTool(client, "add_ticket_note", { note: "x".repeat(301) });
    expect(result.isError).toBe(true);
  });

  it("logs exactly one mcp.tool line per call with the session trace", async () => {
    deps = makeDeps();
    startLogs();
    client = await sessionClient();
    await callTool(client, "get_site_status", {});
    const lines = eventsWith("mcp.tool");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      hop: "mcp",
      tool: "get_site_status",
      outcome: "ok",
    });
    expect(typeof lines[0].total_ms).toBe("number");
    expect(typeof lines[0].trace_id).toBe("string");
    expect(String(lines[0].trace_id)).toMatch(/^t-/);
  });

  it("carries kv_ms and actor_ms on mcp.tool lines", { timeout: 30000 }, async () => {
    deps = makeDeps({
      actors: new SlowActorPort(new FakeActorPort(), 20),
      now: () => Date.now(),
    });
    startLogs();
    client = await sessionClient();
    await callTool(client, "check_known_incidents", {});
    const lines = eventsWith("mcp.tool");
    expect(lines).toHaveLength(1);
    expect(typeof lines[0].kv_ms).toBe("number");
    expect(lines[0].actor_ms).toBeGreaterThan(0);
    expect(lines[0].outcome).toBe("ok");
  });
});

describe("MCP session lookup observability", () => {
  async function mcpSessionCall(deps: McpDeps, convId: unknown): Promise<void> {
    const response = await handleMcp(
      postRequest(
        { authorization: `Bearer ${MCP_TOKEN}` },
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "get_site_status",
            arguments: {},
            _meta: convId === null ? undefined : { telnyx_conversation_id: convId },
          },
        },
      ),
      deps,
    );
    await response.text();
  }

  it("logs no_conv_id when the call carries no conversation id", async () => {
    deps = makeDeps();
    startLogs();
    await mcpSessionCall(deps, null);
    const lines = eventsWith("mcp.session");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("fallback");
    expect(lines[0].reason).toBe("no_conv_id");
    expect(lines[0].kv_ms).toBe(0);
  });

  it("logs no_conv_link when the conversation is not linked", async () => {
    deps = makeDeps();
    startLogs();
    await mcpSessionCall(deps, "conv-unknown");
    const lines = eventsWith("mcp.session");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("fallback");
    expect(lines[0].reason).toBe("no_conv_link");
    expect(lines[0].conv).toBe("conv-unk");
  });

  it("logs ok with the truncated conversation id when the session resolves", async () => {
    deps = makeDeps();
    await seedSession(deps.kv, {});
    startLogs();
    await mcpSessionCall(deps, CONV);
    const lines = eventsWith("mcp.session");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("ok");
    expect(lines[0]).not.toHaveProperty("reason");
    expect(lines[0].conv).toBe("conv-mcp");
    expect(String(lines[0].conv).length).toBeLessThanOrEqual(8);
    expect(typeof lines[0].kv_ms).toBe("number");
    expect(lines[0].trace_id).toMatch(/^t-/);
  });

  it("falls back with reason timeout when the lookup exceeds the deadline", { timeout: 30000 }, async () => {
    const inner = newKv();
    await seedSession(inner, {});
    deps = makeDeps({ kv: new SlowKv(inner, 3500) });
    startLogs();
    await mcpSessionCall(deps, CONV);
    const lines = eventsWith("mcp.session");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("fallback");
    expect(lines[0].reason).toBe("timeout");
    expect(lines[0].trace_id).toMatch(/^t-/);
  });

  it("falls back with reason error when the KV read fails", async () => {
    const failing: KvPort = {
      get: () => Promise.reject(new Error("kv_down")),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    };
    deps = makeDeps({ kv: failing });
    startLogs();
    await mcpSessionCall(deps, CONV);
    const lines = eventsWith("mcp.session");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("fallback");
    expect(lines[0].reason).toBe("error");
  });

  it("logs no mcp.session event for ops scope", async () => {
    deps = makeDeps();
    startLogs();
    const response = await handleMcp(
      postRequest(
        { authorization: `Bearer ${OPS_TOKEN}` },
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "get_site_status", arguments: {} },
        },
      ),
      deps,
    );
    await response.text();
    expect(eventsWith("mcp.session")).toHaveLength(0);
  });

  it("serves the second call from the memo with no conv-link KV read", async () => {
    deps = makeDeps();
    await seedSession(deps.kv, {});
    startLogs();
    await mcpSessionCall(deps, CONV);
    await mcpSessionCall(deps, CONV);
    const convGets = (deps.kv as FakeKv).calls.filter(
      (c) => c.op === "get" && c.key === kvKey("conv", CONV),
    );
    expect(convGets).toHaveLength(1);
    const lines = eventsWith("mcp.session");
    expect(lines).toHaveLength(2);
    expect(lines[1].outcome).toBe("ok");
  });

  it("resolves a session whose two KV rounds take about 4 s", { timeout: 30000 }, async () => {
    const inner = newKv();
    await seedSession(inner, {});
    deps = makeDeps({ kv: new SlowKv(inner, 2000), now: () => Date.now() });
    startLogs();
    await mcpSessionCall(deps, CONV);
    const lines = eventsWith("mcp.session");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("ok");
    expect(lines[0].kv_ms).toBeGreaterThan(3000);
  });
});

describe("MCP ops scope", () => {
  it("reads a site status by site_id", async () => {
    deps = makeDeps();
    client = await connectClient(deps, OPS_TOKEN);
    const result = await callTool(client, "get_site_status", { site_id: "RUH-114" }, null);
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain("stopped responding at 1:52 AM");
  });

  it("resolves any site globally", async () => {
    deps = makeDeps();
    client = await connectClient(deps, OPS_TOKEN);
    const result = await callTool(client, "find_site", { description: "the JED-900 branch" }, null);
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as Record<string, unknown>)?.site_id).toBe("JED-900");
  });

  it("rejects add_ticket_note", async () => {
    deps = makeDeps();
    startLogs();
    client = await connectClient(deps, OPS_TOKEN);
    const result = await callTool(client, "add_ticket_note", { note: "hi" }, null);
    expect(result.isError).toBe(true);
    expect(eventsWith("auth.denied")).toHaveLength(1);
  });

  it("rejects requests that carry _meta with 403", async () => {
    deps = makeDeps();
    startLogs();
    const response = await handleMcp(
      postRequest(
        {
          authorization: `Bearer ${OPS_TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: { telnyx_conversation_id: CONV } },
        },
      ),
      deps,
    );
    expect(response.status).toBe(403);
    expect(eventsWith("auth.denied")).toHaveLength(1);
  });

  it("still lists the five tools in ops scope", async () => {
    deps = makeDeps();
    client = await connectClient(deps, OPS_TOKEN);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("requires site_id when there is no session", async () => {
    deps = makeDeps();
    client = await connectClient(deps, OPS_TOKEN);
    const result = await callTool(client, "get_site_status", {}, null);
    expect(result.isError).toBe(true);
  });
});
