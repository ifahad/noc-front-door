import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SeedAdapter } from "../../../shared/src/itsm";
import type { SeedLocalConfig } from "../../../shared/src/itsm";
import { SITES } from "../../../shared/src/seed";
import { kvKey } from "../../../shared/src/kvkeys";
import type { KvPort } from "../../src/services/kvPort";
import { resetCanaryCounters, runDeepHealth, type HealthDeps } from "../../src/ops/health";
import { FakeActorPort } from "../fakes/actors";
import { FakeKv, slowKv } from "../fakes/kv";
import { OPS_TOKEN, PEPPER, T0 } from "./helpers";

const TEST_PIN = ["9", "9", "9", "9"].join("");
const TEST_MCP_TOKEN = ["m", "c", "p", "_", "t", "0", "k"].join("");
const TEST_PUBLIC_KEY = btoa(
  String.fromCharCode(...new Uint8Array(32).fill(7)),
);

function seededPins(): Record<string, string> {
  return Object.fromEntries(SITES.map((s) => [s.site_id, TEST_PIN]));
}

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

interface DepsOpts {
  kv?: KvPort;
  actors?: FakeActorPort;
  now?: number;
  opsToken?: string;
  mcpToken?: string;
  publicKey?: string | null;
  seedLocal?: SeedLocalConfig;
}

function makeDeps(opts: DepsOpts = {}): HealthDeps {
  return {
    kv: opts.kv ?? new FakeKv(),
    actors: opts.actors ?? new FakeActorPort(),
    adapter: new SeedAdapter({ seedLocal: { pins: {}, contacts: [] }, pepper: PEPPER, now: () => T0 }),
    now: opts.now ?? T0,
    opsToken: opts.opsToken ?? OPS_TOKEN,
    mcpToken: opts.mcpToken ?? TEST_MCP_TOKEN,
    publicKey: opts.publicKey === undefined ? TEST_PUBLIC_KEY : opts.publicKey,
    seedLocal: opts.seedLocal ?? { pins: seededPins(), contacts: [] },
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
    kv.failNext(20);
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

  it("fails the sync check when a region projection cannot be synced", async () => {
    const actors = new FakeActorPort();
    actors.failNextGetIncident("riyadh-north", 1);
    const result = await runDeepHealth(makeDeps({ actors }));
    expect(result.ok).toBe(false);
  });

  it("fails the config check when the public key, mcp token or seed pins are missing", async () => {
    const result = await runDeepHealth(makeDeps({ publicKey: null, mcpToken: "" }));
    expect(result.ok).toBe(false);
    expect(result.config_problems).toContain("public_key");
    expect(result.config_problems).toContain("mcp_token");
  });

  it("rejects a public key that is not a 32-byte Ed25519 key", async () => {
    const short = btoa(String.fromCharCode(...new Uint8Array(16).fill(3)));
    const result = await runDeepHealth(makeDeps({ publicKey: short }));
    expect(result.ok).toBe(false);
    expect(result.config_problems).toContain("public_key");
  });

  it("fails the config check when a scripted site has no pin and logs config.invalid without values", async () => {
    const result = await runDeepHealth(
      makeDeps({ seedLocal: { pins: {}, contacts: [] } }),
    );
    expect(result.ok).toBe(false);
    expect(result.config_problems.some((p) => p.startsWith("seed_pin:"))).toBe(true);
    const invalid = eventsWith("config.invalid");
    expect(invalid).toHaveLength(1);
    expect(JSON.stringify(invalid[0])).not.toContain(TEST_PIN);
  });

  it("reports no config problems when the call-path config is complete", async () => {
    const result = await runDeepHealth(makeDeps());
    expect(result.ok).toBe(true);
    expect(result.config_problems).toEqual([]);
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
    failing.failNext(20);
    await runDeepHealth(makeDeps({ kv: failing, now: T0 + 61_000 }));
    const checks = eventsWith("canary.check");
    expect(checks).toHaveLength(2);
    expect(checks[1].ok).toBe(false);
    expect(checks[0].ok).toBe(true);
  });

  it("marks a kv round trip past its measured baseline slow but healthy, with no timeouts", { timeout: 15000 }, async () => {
    const slow = slowKv(new FakeKv(), 1900);
    const started = Date.now();
    const result = await runDeepHealth(makeDeps({ kv: slow }));
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.slow).toContain("kv");
    expect(result.timed_out).toEqual([]);
    expect(elapsed).toBeLessThan(4500);
  });

  it("keeps ok true and reports the check as timed out when the deadline is hit", { timeout: 15000 }, async () => {
    const slow = slowKv(new FakeKv(), 2100);
    const result = await runDeepHealth(makeDeps({ kv: slow }));
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.timed_out).toContain("kv");
    expect(result.slow).toContain("kv");
  });

  it("emits no mcp.auth or mcp.wire lines from the in-process mcp check", async () => {
    const result = await runDeepHealth(makeDeps());
    expect(result.ok).toBe(true);
    expect(eventsWith("mcp.auth")).toEqual([]);
    expect(eventsWith("mcp.wire")).toEqual([]);
  });

  it("reports a fast healthy run as not degraded", async () => {
    const result = await runDeepHealth(makeDeps());
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.slow).toEqual([]);
  });

  it("keeps the flags memo warm for the external prober", async () => {
    const kv = new FakeKv();
    await runDeepHealth(makeDeps({ kv }));
    const flagGets = kv.calls.filter((c) => c.op === "get" && c.key.startsWith("flag/")).length;
    expect(flagGets).toBeGreaterThan(0);
    await runDeepHealth(makeDeps({ kv, now: T0 + 1000 }));
    const more = kv.calls.filter((c) => c.op === "get" && c.key.startsWith("flag/")).length;
    expect(more).toBe(flagGets);
  });
});
