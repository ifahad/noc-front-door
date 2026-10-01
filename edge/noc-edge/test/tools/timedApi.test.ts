import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ActorPort,
  RegionStateApi,
  SiteStateApi,
} from "../../src/services/actorPort";
import { newTimers, timingActors } from "../../src/tools/common";
import { handleVerifySite } from "../../src/tools/verifySite";
import {
  CCID,
  CONV_ID,
  PIN,
  FakeActorPort,
  eventsWith,
  makeDeps,
  makeKeys,
  newKv,
  signedToolRequest,
  startLogs,
  stopLogs,
} from "./helpers";
import {
  MCP_TOKEN,
  callTool,
  connectClient,
  makeDeps as mcpDeps,
  seedSession,
  seedTicket,
} from "../mcp/helpers";

// The per-entity stub built by @telnyx/edge-runtime: a Proxy over an empty
// target with get/has traps and no ownKeys trap, so enumeration finds no
// business method names (node_modules/@telnyx/edge-runtime actor-namespace).
function sdkStub(): SiteStateApi {
  return new Proxy({} as SiteStateApi, {
    get: (_t, p) =>
      typeof p === "symbol"
        ? undefined
        : (...a: unknown[]) => Promise.resolve({ method: p, args: a }),
    has: () => true,
  });
}

// The same Proxy shape over an existing test fake: every property access is
// delegated to the real actor, but enumeration still sees nothing.
function sdkShaped<T extends object>(api: T): T {
  return new Proxy({} as T, {
    get: (_t, p) => {
      if (typeof p === "symbol") return undefined;
      return (api as unknown as Record<string, unknown>)[p];
    },
    has: () => true,
  });
}

function portOf(site: SiteStateApi, region: RegionStateApi): ActorPort {
  return { site: () => site, region: () => region };
}

// One shared FakeActorPort, but each entity api is served behind the
// SDK-shaped Proxy, like the per-entity binding does in production.
function proxyPort(base: FakeActorPort): ActorPort {
  return {
    site: (siteId) => sdkShaped(base.site(siteId)),
    region: (region) => sdkShaped(base.region(region)),
  };
}

type StubReply = { method: string; args: unknown[] };

describe("timingActors with an SDK-shaped actor stub", () => {
  it("times recordPinAttempt, openIfVerified and arbitrary methods the stub exposes", async () => {
    const timers = newTimers();
    let tick = 0;
    const stub = sdkStub();
    const timed = timingActors(
      portOf(stub, stub as unknown as RegionStateApi),
      () => ++tick,
      timers,
    );
    const site = timed.site("RUH-114");
    expect(timers.actor).toBe(0);
    expect(site.recordPinAttempt).toBe(site.recordPinAttempt);

    const pinInput = { k: "k-1", valid: true, fp: "fp-1", trace_id: "t-1", at: 1 };
    const attempt = (await site.recordPinAttempt(pinInput)) as unknown as StubReply;
    expect(attempt.method).toBe("recordPinAttempt");
    expect(attempt.args).toEqual([pinInput]);
    expect(timers.actor).toBe(1);

    const openInput = {
      k: "k-1",
      trace_id: "t-1",
      callerRef: "none",
      symptom: "WAN down",
      impact: "site_down" as const,
      serviceAffecting: true,
      priority: "P2" as const,
      at: 2,
      siteCode: "14",
    };
    const opened = (await site.openIfVerified(openInput)) as unknown as StubReply;
    expect(opened.method).toBe("openIfVerified");
    expect(opened.args).toEqual([openInput]);
    expect(timers.actor).toBe(2);

    const arbitrary = (site as unknown as Record<
      string,
      (...a: unknown[]) => Promise<StubReply>
    >).madeUpForTests("x", 7);
    const reply = await arbitrary;
    expect(reply.method).toBe("madeUpForTests");
    expect(reply.args).toEqual(["x", 7]);
    expect(timers.actor).toBe(3);
  });
});

describe("timingActors with a plain object port", () => {
  it("still times own methods, keeps this on the original api and passes data properties through", async () => {
    const timers = newTimers();
    let tick = 0;
    const api = {
      entity: "RUH-114",
      recordPinAttempt: async (input: { k: string; valid: boolean }) => ({
        result: "ok",
        attemptsLeft: 3,
        repeat: false,
        trace_id: "t-" + input.k,
        actor_ms: 4,
      }),
      openIfVerified: async () => ({ ticket: null }),
      readEntity: async function (this: { entity: string }) {
        return this.entity;
      },
    };
    const timed = timingActors(
      portOf(
        api as unknown as SiteStateApi,
        api as unknown as RegionStateApi,
      ),
      () => ++tick,
      timers,
    );
    const site = timed.site("RUH-114");

    expect((site as unknown as { entity: string }).entity).toBe("RUH-114");

    const attempt = await site.recordPinAttempt({
      k: "k-2",
      valid: true,
      fp: "fp-2",
      trace_id: "t-2",
      at: 2,
    });
    expect(attempt.result).toBe("ok");
    expect(attempt.attemptsLeft).toBe(3);
    expect(timers.actor).toBe(1);

    const opened = await site.openIfVerified({
      k: "k-2",
      trace_id: "t-2",
      callerRef: "none",
      symptom: "WAN down",
      impact: "site_down" as const,
      serviceAffecting: true,
      priority: "P2" as const,
      at: 3,
      siteCode: "14",
    });
    expect(opened).toEqual({ ticket: null });
    expect(timers.actor).toBe(2);

    const entity = await (
      site as unknown as { readEntity: () => Promise<string> }
    ).readEntity();
    expect(entity).toBe("RUH-114");
    expect(timers.actor).toBe(3);
  });
});

describe("per-entity tool path with Proxy-backed actor stubs", () => {
  beforeEach(() => {
    startLogs();
  });
  afterEach(() => {
    stopLogs();
  });

  it("answers verify_site through a Proxy-shaped SiteState stub", async () => {
    const keys = await makeKeys();
    const actors = new FakeActorPort();
    // Anchored to real time so the signature freshness check passes, but
    // ticking so each timed actor call adds a deterministic millisecond.
    let clock = Date.now();
    const deps = makeDeps(newKv(), proxyPort(actors), keys, {
      now: () => ++clock,
    });
    const res = await handleVerifySite(
      await signedToolRequest(
        "/tools/verify-site",
        {
          site_id: "RUH-114",
          pin: PIN,
          call_control_id: CCID,
          call_key: "none",
          trace_id: "t-cc",
          conversation_id: CONV_ID,
        },
        keys,
      ),
      deps,
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, string>;
    expect(out.verify_result).toBe("ok");
    expect(out.site_id).toBe("RUH-114");
    expect(out.customer_name).toBe("Al-Waha Pharmacies");
    const lines = eventsWith("tool.verify_site");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("ok");
    expect(Number(lines[0].actor_ms)).toBeGreaterThan(0);
  });

  it("answers get_ticket_status through a Proxy-shaped SiteState stub", async () => {
    const actors = new FakeActorPort();
    const port = proxyPort(actors);
    const kv = newKv();
    const k = await seedSession(kv);
    const ticketId = await seedTicket(port, k);
    let tick = 0;
    const deps = mcpDeps({ kv, actors: port, now: () => ++tick });
    const client = await connectClient(deps, MCP_TOKEN);
    const result = await callTool(client, "get_ticket_status");
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ ticket_id: ticketId });
    const lines = eventsWith("mcp.tool");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("ok");
    expect(Number(lines[0].actor_ms)).toBeGreaterThan(0);
    await client.close();
  });
});
