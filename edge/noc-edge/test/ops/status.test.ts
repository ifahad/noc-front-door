import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kvKey } from "../../../shared/src/kvkeys";
import { REGIONS, SITES } from "../../../shared/src/seed";
import { buildStatus, renderStatusHtml, type StatusPayload } from "../../src/ops/status";
import { FakeActorPort } from "../fakes/actors";
import { FakeKv } from "../fakes/kv";
import { SlowActorPort, SlowKv } from "../fakes/slow";
import { openSiteTicket, recordSiteCall, T0 } from "./helpers";

interface LogLine extends Record<string, unknown> {
  evt: string;
}

let logs: string[];
beforeEach(() => {
  logs = [];
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

const PHONE = ["+", "1", "312", "555", "0101"].join("");
const PIN = ["43", "21"].join("");
const TOKEN = ["sk", "live", "9f2c"].join("-");

async function seedState(kv: FakeKv, actors: FakeActorPort, now: number): Promise<void> {
  await kv.put(kvKey("ops", "heartbeat"), JSON.stringify({ at: now - 5_000, ok: true, checks: { kv_ms: 1, actor_ms: 2, mcp_ms: 3, sync_ms: 4 } }));
  await kv.put(
    kvKey("incident", "active", "riyadh-north"),
    JSON.stringify({
      id: "INC-101",
      version: 2,
      region_label: "Riyadh North",
      started_local: "9:52 AM",
      summary: `outage for ${PHONE}`,
      eta_local: "10:22 AM",
      priority: "P1",
      site_count: 2,
    }),
  );
  await kv.put(kvKey("flag", "fault", "open_ticket"), "503");
  await kv.put(kvKey("flag", "fault", "dv_delay_ms"), "0");
  await kv.put(kvKey("dir", "999"), `token ${TOKEN}`);
  await openSiteTicket(actors, "RUH-114", "14", "aa11bb22cc33dd44", now);
  await recordSiteCall(actors, "RUH-114", "aa11bb22cc33dd44", PHONE, now - 60_000);
}

async function runStatus(kv: FakeKv, actors: FakeActorPort, now = T0): Promise<StatusPayload> {
  return buildStatus({ kv, actors, now });
}

describe("ops status", () => {
  it("renders heartbeat age, active fault flags, region incidents and site tickets", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    await seedState(kv, actors, T0);
    const payload = await runStatus(kv, actors);

    expect(payload.at).toBe(new Date(T0).toISOString());
    expect(payload.heartbeat).toEqual({ age_s: 5, ok: true });
    expect(payload.fault_flags).toEqual(["dv_delay_ms", "open_ticket"]);
    const riyadh = payload.regions.find((r) => r.region === "riyadh-north");
    expect(riyadh).toEqual({
      region: "riyadh-north",
      label: "Riyadh North",
      incident: { id: "INC-101", priority: "P1", site_count: 2, declared_local: "9:52 AM" },
    });
    expect(payload.regions.map((r) => r.region)).toEqual(
      REGIONS.filter((r) => r.region !== "lab").map((r) => r.region),
    );
    const ruh114 = payload.sites.find((s) => s.site_id === "RUH-114");
    expect(ruh114?.open_ticket).toEqual({
      id: "NJD-1401",
      priority: "P2",
      opened_local: expect.any(String),
    });
    expect(ruh114?.recent_calls).toEqual([
      { at_local: expect.any(String), trace_id: expect.any(String) },
    ]);
    expect(payload.sites.map((s) => s.site_id)).toEqual(
      SITES.filter((s) => !s.hidden).map((s) => s.site_id),
    );
    expect(payload.degraded).toBeUndefined();
  });

  it("excludes the internal lab region from the public status", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    await seedState(kv, actors, T0);
    await kv.put(kvKey("incident", "active", "lab"), JSON.stringify({
      id: "INC-901", version: 1, region_label: "Lab", started_local: "9:52 AM",
      summary: "s", eta_local: "10:22 AM", priority: "P2", site_count: 1,
    }));
    const payload = await runStatus(kv, actors);
    expect(payload.regions.some((r) => r.region === "lab")).toBe(false);
    const html = renderStatusHtml(payload);
    expect(html).not.toContain("Lab");
  });

  it("marks a heartbeat red when it is stale", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    kv.put(kvKey("ops", "heartbeat"), JSON.stringify({ at: T0 - 45_000, ok: true, checks: {} }));
    const payload = await runStatus(kv, actors);
    expect(payload.heartbeat).toEqual({ age_s: 45, ok: false });
  });

  it("sets degraded and nulls the fields when an actor read fails", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    await seedState(kv, actors, T0);
    actors.failNextGetTicket("RUH-114", 2);
    const payload = await runStatus(kv, actors);
    expect(payload.degraded).toBe(true);
    const ruh114 = payload.sites.find((s) => s.site_id === "RUH-114");
    expect(ruh114?.open_ticket).toBeNull();
    expect(ruh114?.recent_calls).toBeNull();
    const other = payload.sites.find((s) => s.site_id === "RUH-121");
    expect(other?.open_ticket).toBeNull();
    expect(other?.recent_calls).toEqual([]);
  });

  it("sets degraded when the heartbeat read fails", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    kv.failNext(1);
    const payload = await runStatus(kv, actors);
    expect(payload.heartbeat).toBeNull();
    expect(payload.degraded).toBe(true);
  });

  it("never exposes a phone number, PIN-shaped value or token", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    await seedState(kv, actors, T0);
    const payload = await runStatus(kv, actors);
    const text = JSON.stringify(payload);
    expect(text).not.toMatch(/\+[0-9]{8,15}/);
    expect(text).not.toContain(PIN);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(PHONE);
  });

  it("escapes html values and auto-refreshes every 5 seconds", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    await recordSiteCall(actors, "RUH-114", "k1", `<img src=x>`, T0 - 60_000);
    const payload = await runStatus(kv, actors);
    const html = renderStatusHtml(payload);
    expect(html).toContain('http-equiv="refresh" content="5"');
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<img src=x>");
  });

  it("renders every seeded region and site in the html page", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    await seedState(kv, actors, T0);
    const payload = await runStatus(kv, actors);
    const html = renderStatusHtml(payload);
    expect(html).toContain("Riyadh North");
    expect(html).toContain("RUH-114");
    expect(html).not.toContain("TST-001");
  });

  it("logs one status line per request", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    await seedState(kv, actors, T0);
    await runStatus(kv, actors);
    const lines = eventsWith("ops.status");
    expect(lines).toHaveLength(1);
    expect(lines[0].hop).toBe("ops/status");
    expect(lines[0].outcome).toBe("ok");
    expect(typeof lines[0].total_ms).toBe("number");
  });
});

describe("ops status latency", () => {
  it("issues its reads concurrently and survives a 1000 ms KV with 200 ms actors inside 3 s", { timeout: 15000 }, async () => {
    const inner = new FakeKv();
    await inner.put(kvKey("ops", "heartbeat"), JSON.stringify({ at: T0 - 5_000, ok: true, checks: {} }));
    await inner.put(
      kvKey("incident", "active", "riyadh-north"),
      JSON.stringify({
        id: "INC-101",
        version: 2,
        region_label: "Riyadh North",
        started_local: "9:52 AM",
        summary: "s",
        eta_local: "10:22 AM",
        priority: "P1",
        site_count: 2,
      }),
    );
    const kv = new SlowKv(inner, 1000);
    const actors = new SlowActorPort(new FakeActorPort(), 200);
    const started = Date.now();
    const payload = await buildStatus({ kv, actors, now: T0 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(3000);
    expect(payload.heartbeat).toEqual({ age_s: 5, ok: true });
    const riyadh = payload.regions.find((r) => r.region === "riyadh-north");
    expect(riyadh?.incident?.id).toBe("INC-101");
    expect(payload.sites).toHaveLength(SITES.filter((s) => !s.hidden).length);
    expect(payload.degraded).toBeUndefined();
  });
});
