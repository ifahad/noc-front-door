import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SeedAdapter } from "../../../shared/src/itsm";
import { kvKey } from "../../../shared/src/kvkeys";
import { resetCanaryCounters, runDeepHealth, type HealthDeps } from "../../src/ops/health";
import { FakeActorPort } from "../fakes/actors";
import { FakeKv } from "../fakes/kv";
import { OPS_TOKEN, PEPPER, T0 } from "./helpers";

interface LogLine extends Record<string, unknown> {
  evt: string;
}

let logs: string[];
beforeEach(() => {
  logs = [];
  resetCanaryCounters();
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function eventsWith(evt: string): LogLine[] {
  return logs.map((l) => JSON.parse(l) as LogLine).filter((l) => l.evt === evt);
}

function makeDeps(opts: { kv?: FakeKv; actors?: FakeActorPort; now?: number; opsToken?: string } = {}): HealthDeps {
  return {
    kv: opts.kv ?? new FakeKv(),
    actors: opts.actors ?? new FakeActorPort(),
    adapter: new SeedAdapter({ seedLocal: { pins: {}, contacts: [] }, pepper: PEPPER, now: () => T0 }),
    now: opts.now ?? T0,
    opsToken: opts.opsToken ?? OPS_TOKEN,
    mcpToken: "",
    trace_id: "t-canary",
  };
}

describe("ops health deep", () => {
  it("round-trips kv, pings the lab site actor, lists mcp tools and writes the heartbeat", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    const result = await runDeepHealth(makeDeps({ kv, actors }));
    expect(result.ok).toBe(true);
    expect(result.checks.kv_ms).toBeGreaterThanOrEqual(0);
    expect(result.checks.actor_ms).toBeGreaterThanOrEqual(0);
    expect(result.checks.mcp_ms).toBeGreaterThanOrEqual(0);
    expect(result.checks.sync_ms).toBeGreaterThanOrEqual(0);
    expect(kv.has(kvKey("ops", "healthcheck"))).toBe(true);
    expect(kv.has(kvKey("ops", "heartbeat"))).toBe(true);
    const beat = JSON.parse(kv.raw(kvKey("ops", "heartbeat")) as string) as {
      at: number;
      ok: boolean;
      checks: Record<string, number>;
    };
    expect(beat.ok).toBe(true);
    expect(beat.at).toBe(T0);
    expect(Object.keys(beat.checks).sort()).toEqual([
      "actor_ms",
      "kv_ms",
      "mcp_ms",
      "sync_ms",
    ]);
  });

  it("returns ok false (not an http error) when the kv check fails", async () => {
    const kv = new FakeKv();
    kv.failNext(2);
    const result = await runDeepHealth(makeDeps({ kv }));
    expect(result.ok).toBe(false);
    expect(kv.has(kvKey("ops", "healthcheck"))).toBe(false);
    const beat = kv.raw(kvKey("ops", "heartbeat"));
    if (beat !== null) {
      expect((JSON.parse(beat) as { ok: boolean }).ok).toBe(false);
    }
  });

  it("fails the mcp check when the in-process tools/list returns nothing", async () => {
    const result = await runDeepHealth(makeDeps({ opsToken: "" }));
    expect(result.ok).toBe(false);
    expect(result.checks.mcp_ms).toBeGreaterThanOrEqual(0);
  });

  it("heals a missing projection for a region whose actor reports an active incident", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    const ruh121 = await actors.site("RUH-121").openOrAttach({
      k: "s1",
      trace_id: "t-1",
      callerRef: "none",
      symptom: "WAN link down",
      impact: "site_down",
      serviceAffecting: true,
      priority: "P2",
      at: T0,
      siteCode: "21",
    });
    const ruh133 = await actors.site("RUH-133").openOrAttach({
      k: "s2",
      trace_id: "t-2",
      callerRef: "none",
      symptom: "WAN link down",
      impact: "site_down",
      serviceAffecting: true,
      priority: "P2",
      at: T0,
      siteCode: "33",
    });
    await actors.region("riyadh-north").reportSite({
      siteId: "RUH-121",
      ticketId: ruh121.ticket.id,
      regionCode: "1",
      trace_id: "t-1",
      at: T0,
    });
    await actors.region("riyadh-north").reportSite({
      siteId: "RUH-133",
      ticketId: ruh133.ticket.id,
      regionCode: "1",
      trace_id: "t-2",
      at: T0,
    });
    expect(kv.raw(kvKey("incident", "active", "riyadh-north"))).toBeNull();
    const result = await runDeepHealth(makeDeps({ kv, actors }));
    expect(result.ok).toBe(true);
    const projection = JSON.parse(
      kv.raw(kvKey("incident", "active", "riyadh-north")) as string,
    ) as { id: string; site_count: number };
    expect(projection.site_count).toBe(2);
  });

  it("resyncs the projection for regions with an active incident", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    const ruh121 = await actors.site("RUH-121").openOrAttach({
      k: "s1",
      trace_id: "t-1",
      callerRef: "none",
      symptom: "WAN link down",
      impact: "site_down",
      serviceAffecting: true,
      priority: "P2",
      at: T0,
      siteCode: "21",
    });
    const ruh133 = await actors.site("RUH-133").openOrAttach({
      k: "s2",
      trace_id: "t-2",
      callerRef: "none",
      symptom: "WAN link down",
      impact: "site_down",
      serviceAffecting: true,
      priority: "P2",
      at: T0,
      siteCode: "33",
    });
    await actors.region("riyadh-north").reportSite({
      siteId: "RUH-121",
      ticketId: ruh121.ticket.id,
      regionCode: "1",
      trace_id: "t-1",
      at: T0,
    });
    await actors.region("riyadh-north").reportSite({
      siteId: "RUH-133",
      ticketId: ruh133.ticket.id,
      regionCode: "1",
      trace_id: "t-2",
      at: T0,
    });
    await kv.put(kvKey("incident", "active", "riyadh-north"), "stale");
    const result = await runDeepHealth(makeDeps({ kv, actors }));
    expect(result.ok).toBe(true);
    const projection = JSON.parse(kv.raw(kvKey("incident", "active", "riyadh-north")) as string) as {
      id: string;
      site_count: number;
    };
    expect(projection.id).not.toBe("stale");
    expect(projection.site_count).toBe(2);
  });

  it("logs canary.check only when the outcome changes and at most one canary.summary per 60s", async () => {
    const deps = makeDeps();
    await runDeepHealth(deps);
    expect(eventsWith("canary.check")).toHaveLength(1);
    expect(eventsWith("canary.summary")).toHaveLength(1);
    await runDeepHealth(deps);
    expect(eventsWith("canary.check")).toHaveLength(1);
    expect(eventsWith("canary.summary")).toHaveLength(1);
    await runDeepHealth(makeDeps({ now: T0 + 61_000 }));
    expect(eventsWith("canary.check")).toHaveLength(1);
    expect(eventsWith("canary.summary")).toHaveLength(2);
    const failing = new FakeKv();
    failing.failNext(2);
    await runDeepHealth(makeDeps({ kv: failing, now: T0 + 61_000 }));
    const checks = eventsWith("canary.check");
    expect(checks).toHaveLength(2);
    expect(checks[1].ok).toBe(false);
    expect(checks[0].ok).toBe(true);
  });
});
