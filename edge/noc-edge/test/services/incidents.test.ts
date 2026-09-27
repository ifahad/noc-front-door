import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRiyadhTime } from "../../../shared/src/readback";
import { kvKey } from "../../../shared/src/kvkeys";
import type { Incident } from "../../../shared/src/types";
import { incidentSummaryOf, syncProjection } from "../../src/services/incidents";
import { FakeActorPort } from "../fakes/actors";
import { FakeKv } from "../fakes/kv";

const T0 = Date.UTC(2026, 8, 26, 6, 0, 0);
const REGION = "riyadh-north";
const KEY = kvKey("incident", "active", REGION);

function report(siteId: string, ticketId: string, at: number) {
  return { siteId, ticketId, regionCode: "1", trace_id: "t-1", at };
}

async function declareTwoSites(actors: FakeActorPort) {
  await actors.region(REGION).reportSite(report("RUH-114", "NJD-1401", T0));
  const declared = await actors
    .region(REGION)
    .reportSite(report("RUH-121", "NJD-2101", T0 + 1000));
  expect(declared.declared).toBe(true);
  expect(declared.incident).not.toBeNull();
  return declared.incident as Incident;
}

describe("incidents.syncProjection", () => {
  const logs: string[] = [];
  beforeEach(() => {
    logs.length = 0;
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes the projection when the region has no incident", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    await kv.put(KEY, "stale");
    const actors = new FakeActorPort();
    await syncProjection({ actors, kv }, REGION, "t-1");
    expect(kv.has(KEY)).toBe(false);
  });

  it("writes the full projection for an active incident", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const actors = new FakeActorPort();
    const incident = await declareTwoSites(actors);
    await syncProjection({ actors, kv }, REGION, "t-1");
    const projection = JSON.parse(kv.raw(KEY) as string);
    expect(projection).toEqual({
      id: incident.id,
      version: 1,
      region_label: "Riyadh North",
      started_local: formatRiyadhTime(incident.declaredAt),
      summary: "loss of connectivity at two branches",
      eta_local: formatRiyadhTime(incident.nextUpdateAt),
      priority: "P2",
      site_count: 2,
    });
    expect(kv.ttlSecondsLeft(KEY)).toBe(7200);
  });

  it("refreshes the ttl on every sync", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const actors = new FakeActorPort();
    await declareTwoSites(actors);
    await syncProjection({ actors, kv }, REGION, "t-1");
    kv.setNow(T0 + 3000_000);
    await syncProjection({ actors, kv }, REGION, "t-1");
    expect(kv.ttlSecondsLeft(KEY)).toBe(7200);
  });

  it("deletes the projection after the incident is resolved", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const actors = new FakeActorPort();
    await declareTwoSites(actors);
    await syncProjection({ actors, kv }, REGION, "t-1");
    expect(kv.has(KEY)).toBe(true);
    await actors.region(REGION).resolve({ trace_id: "t-1", at: T0 + 2000 });
    await syncProjection({ actors, kv }, REGION, "t-1");
    expect(kv.has(KEY)).toBe(false);
  });

  it("survives an actor error and leaves the projection untouched, reporting the failure", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    await kv.put(KEY, "stale");
    const actors = new FakeActorPort();
    actors.failNextGetIncident(REGION, 1);
    await expect(
      syncProjection({ actors, kv }, REGION, "t-1"),
    ).resolves.toEqual({ ok: false, projected: false });
    expect(kv.raw(KEY)).toBe("stale");
    const events = logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.evt === "incident.sync");
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("error");
  });

  it("logs incident.sync only when the projection changes, not on every sync", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const actors = new FakeActorPort();
    await declareTwoSites(actors);
    await syncProjection({ actors, kv }, REGION, "t-1");
    await syncProjection({ actors, kv }, REGION, "t-1");
    kv.setNow(T0 + 60_000);
    await syncProjection({ actors, kv }, REGION, "t-1");
    const events = logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.evt === "incident.sync");
    expect(events).toHaveLength(1);
    expect(events[0].projected).toBe(true);
    expect(kv.ttlSecondsLeft(KEY)).toBe(7200);
  });

  it("logs again when the projection content changes", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const actors = new FakeActorPort();
    await declareTwoSites(actors);
    await syncProjection({ actors, kv }, REGION, "t-1");
    await actors.region(REGION).reportSite(report("RUH-133", "NJD-3301", T0 + 2000));
    kv.setNow(T0 + 1000);
    await syncProjection({ actors, kv }, REGION, "t-1");
    const events = logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.evt === "incident.sync");
    expect(events).toHaveLength(2);
    expect(events[1].site_count).toBe(3);
  });

  it("logs the clear once when an incident is withdrawn and stays quiet afterwards", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const actors = new FakeActorPort();
    await declareTwoSites(actors);
    await syncProjection({ actors, kv }, REGION, "t-1");
    await actors.region(REGION).resolve({ trace_id: "t-1", at: T0 + 2000 });
    await syncProjection({ actors, kv }, REGION, "t-1");
    await syncProjection({ actors, kv }, REGION, "t-1");
    const events = logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.evt === "incident.sync");
    expect(events).toHaveLength(2);
    expect(events[1].projected).toBe(false);
    expect(kv.has(KEY)).toBe(false);
  });

  it("stays quiet after the first cold-isolate clear when there was never a projection", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const actors = new FakeActorPort();
    await syncProjection({ actors, kv }, REGION, "t-1");
    await syncProjection({ actors, kv }, REGION, "t-1");
    const events = logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.evt === "incident.sync");
    expect(events).toHaveLength(1);
    expect(events[0].projected).toBe(false);
    expect(kv.calls.filter((c) => c.op === "delete")).toHaveLength(1);
  });
});

describe("incidentSummaryOf", () => {
  const base: Incident = {
    id: "INC-1001",
    version: 1,
    declaredAt: T0,
    priority: "P2",
    sites: {},
    nextUpdateAt: T0 + 30 * 60_000,
    ackAt: null,
    pageSeq: 0,
    esc: null,
    pages: [],
  };

  function incidentWith(n: number): Incident {
    const sites: Incident["sites"] = {};
    for (let i = 1; i <= n; i++) {
      sites[`RUH-${100 + i}`] = { ticketId: `NJD-${i}`, at: T0 };
    }
    return { ...base, sites };
  }

  it("speaks one branch", () => {
    expect(incidentSummaryOf(incidentWith(1))).toBe("loss of connectivity at one branch");
  });

  it("speaks two through nine as words", () => {
    expect(incidentSummaryOf(incidentWith(2))).toBe("loss of connectivity at two branches");
    expect(incidentSummaryOf(incidentWith(3))).toBe("loss of connectivity at three branches");
    expect(incidentSummaryOf(incidentWith(9))).toBe("loss of connectivity at nine branches");
  });

  it("uses digits above nine", () => {
    expect(incidentSummaryOf(incidentWith(10))).toBe("loss of connectivity at 10 branches");
    expect(incidentSummaryOf(incidentWith(23))).toBe("loss of connectivity at 23 branches");
  });
});
