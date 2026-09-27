import { afterEach, describe, expect, it, vi } from "vitest";
import type { Incident } from "../../shared/src/types";
import type { Members, Page, ReportSiteInput } from "../src/RegionState";
import { makeRegionState, type RegionStateHarness } from "./fakes/storage";

const T0 = Date.UTC(2026, 8, 26, 6, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

const report = (overrides: Partial<ReportSiteInput> = {}): ReportSiteInput => ({
  siteId: "site-a",
  ticketId: "NJD-1401",
  regionCode: "1",
  trace_id: "t-1",
  at: T0,
  ...overrides,
});

function membersOf(storage: { raw(key: string): unknown }): Members {
  return (storage.raw("members") ?? {}) as Members;
}

describe("RegionState", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a single reported site does not declare an incident", async () => {
    const h = makeRegionState("riyadh-north");
    const r = await h.actor.reportSite(report());
    expect(r.declared).toBe(false);
    expect(r.upgraded).toBe(false);
    expect(r.siteCount).toBe(1);
    expect(r.incident).toBeNull();
    expect(r.trace_id).toBe("t-1");
    expect(typeof r.actor_ms).toBe("number");
  });

  it("a second distinct site declares a P2 incident INC-1001", async () => {
    const h = makeRegionState("riyadh-north");
    await h.actor.reportSite(report());
    const r = await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1402", trace_id: "t-2", at: T0 + MIN }),
    );
    expect(r.declared).toBe(true);
    expect(r.upgraded).toBe(false);
    expect(r.siteCount).toBe(2);
    const inc = r.incident as Incident;
    expect(inc.id).toBe("INC-1001");
    expect(inc.priority).toBe("P2");
    expect(inc.version).toBe(1);
    expect(inc.declaredAt).toBe(T0 + MIN);
    expect(inc.nextUpdateAt).toBe(T0 + MIN + 30 * MIN);
    expect(inc.ackAt).toBeNull();
    expect(inc.esc).toEqual({ level: 0, dueAt: T0 + MIN + 300_000, acked: false });
    expect(inc.pages).toEqual([]);
    expect(Object.keys(inc.sites).sort()).toEqual(["site-a", "site-b"]);
    expect(inc.sites["site-b"]).toEqual({ ticketId: "NJD-1402", at: T0 + MIN });
  });

  it("a repeat report for the same site and ticket is idempotent", async () => {
    const h = makeRegionState("riyadh-north");
    await h.actor.reportSite(report());
    await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1402", trace_id: "t-2", at: T0 + MIN }),
    );
    const again = await h.actor.reportSite(report({ trace_id: "t-3", at: T0 + 2 * MIN }));
    expect(again.declared).toBe(false);
    expect(again.upgraded).toBe(false);
    expect(again.siteCount).toBe(2);
    expect(again.incident?.id).toBe("INC-1001");
    expect(again.incident?.version).toBe(1);
    expect(again.incident?.priority).toBe("P2");
    expect(membersOf(h.storage)["site-a"]).toEqual({
      ticketId: "NJD-1401",
      firstAt: T0,
      lastAt: T0 + 2 * MIN,
    });
  });

  it("a same-site repeat does not upgrade the priority", async () => {
    const h = makeRegionState("riyadh-north");
    await h.actor.reportSite(report());
    const declared = await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1402", trace_id: "t-2" }),
    );
    expect(declared.incident?.priority).toBe("P2");
    const repeat = await h.actor.reportSite(report({ trace_id: "t-3", at: T0 + 2 * MIN }));
    expect(repeat.upgraded).toBe(false);
    expect(repeat.siteCount).toBe(2);
    expect(repeat.incident?.priority).toBe("P2");
    expect(repeat.incident?.version).toBe(1);
  });

  it("a third site upgrades to P1 and a fourth changes nothing", async () => {
    const h = makeRegionState("riyadh-north");
    await h.actor.reportSite(report());
    await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1402", trace_id: "t-2" }),
    );
    const up = await h.actor.reportSite(
      report({ siteId: "site-c", ticketId: "NJD-1403", trace_id: "t-3", at: T0 + MIN }),
    );
    expect(up.declared).toBe(false);
    expect(up.upgraded).toBe(true);
    expect(up.siteCount).toBe(3);
    const inc = up.incident as Incident;
    expect(inc.priority).toBe("P1");
    expect(inc.version).toBe(2);
    expect(inc.nextUpdateAt).toBe(T0 + MIN + 30 * MIN);
    expect(Object.keys(inc.sites).sort()).toEqual(["site-a", "site-b", "site-c"]);
    const fourth = await h.actor.reportSite(
      report({ siteId: "site-d", ticketId: "NJD-1404", trace_id: "t-4", at: T0 + 2 * MIN }),
    );
    expect(fourth.declared).toBe(false);
    expect(fourth.upgraded).toBe(false);
    expect(fourth.siteCount).toBe(4);
    expect(fourth.incident?.priority).toBe("P1");
    expect(fourth.incident?.version).toBe(3);
    expect(fourth.incident?.nextUpdateAt).toBe(T0 + MIN + 30 * MIN);
    expect(Object.keys(fourth.incident?.sites ?? {})).toHaveLength(4);
  });

  it("a declare can happen with three live members and declares at P1", async () => {
    const h = makeRegionState("riyadh-north");
    await h.storage.put("members", {
      "site-a": { ticketId: "NJD-1401", firstAt: T0, lastAt: T0 },
      "site-b": { ticketId: "NJD-1402", firstAt: T0, lastAt: T0 },
    });
    const r = await h.actor.reportSite(
      report({ siteId: "site-c", ticketId: "NJD-1403", trace_id: "t-2", at: T0 + MIN }),
    );
    expect(r.declared).toBe(true);
    expect(r.upgraded).toBe(false);
    expect(r.siteCount).toBe(3);
    const inc = r.incident as Incident;
    expect(inc.id).toBe("INC-1001");
    expect(inc.priority).toBe("P1");
    expect(inc.version).toBe(1);
    expect(inc.declaredAt).toBe(T0 + MIN);
    expect(inc.nextUpdateAt).toBe(T0 + MIN + 30 * MIN);
  });

  it("the incident stays P1 after a withdraw and a stale prune", async () => {
    const h = makeRegionState("riyadh-north");
    await h.actor.reportSite(report());
    await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1402", trace_id: "t-2" }),
    );
    await h.actor.reportSite(
      report({ siteId: "site-c", ticketId: "NJD-1403", trace_id: "t-3" }),
    );
    const w = await h.actor.withdrawSite({
      siteId: "site-c",
      ticketId: "NJD-1403",
      trace_id: "t-4",
      at: T0 + MIN,
    });
    expect(w.siteCount).toBe(2);
    const afterWithdraw = await h.actor.getIncident({ trace_id: "t-5" });
    expect(afterWithdraw.incident?.priority).toBe("P1");
    const d = await h.actor.reportSite(
      report({ siteId: "site-d", ticketId: "NJD-1404", trace_id: "t-6", at: T0 + 7 * HOUR }),
    );
    expect(d.declared).toBe(false);
    expect(d.upgraded).toBe(false);
    expect(d.siteCount).toBe(1);
    const inc = d.incident as Incident;
    expect(inc.priority).toBe("P1");
    expect(Object.keys(inc.sites)).toEqual(["site-d"]);
  });

  it("incident.sites mirrors the live members after every membership change", async () => {
    const h = makeRegionState("riyadh-north");
    await h.actor.reportSite(report());
    await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1402", trace_id: "t-2" }),
    );
    await h.actor.reportSite(
      report({ siteId: "site-c", ticketId: "NJD-1403", trace_id: "t-3" }),
    );
    const up = await h.actor.getIncident({ trace_id: "t-4" });
    expect(Object.keys(up.incident?.sites ?? {})).toHaveLength(3);
    expect(up.incident?.version).toBe(2);
    const d = await h.actor.reportSite(
      report({ siteId: "site-d", ticketId: "NJD-1404", trace_id: "t-5", at: T0 + MIN }),
    );
    expect(d.declared).toBe(false);
    expect(d.upgraded).toBe(false);
    const live = await h.actor.getIncident({ trace_id: "t-6" });
    expect(Object.keys(live.incident?.sites ?? {}).sort()).toEqual([
      "site-a",
      "site-b",
      "site-c",
      "site-d",
    ]);
    expect(live.incident?.version).toBe(3);
    expect(live.incident?.priority).toBe("P1");
    const w = await h.actor.withdrawSite({
      siteId: "site-c",
      ticketId: "NJD-1403",
      trace_id: "t-7",
      at: T0 + 2 * MIN,
    });
    expect(w.siteCount).toBe(3);
    const after = await h.actor.getIncident({ trace_id: "t-8" });
    expect(Object.keys(after.incident?.sites ?? {}).sort()).toEqual([
      "site-a",
      "site-b",
      "site-d",
    ]);
    expect(after.incident?.priority).toBe("P1");
    expect(after.incident?.version).toBe(4);
    await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1499", trace_id: "t-9", at: T0 + 3 * MIN }),
    );
    const replaced = await h.actor.getIncident({ trace_id: "t-10" });
    expect(replaced.incident?.sites["site-b"]).toEqual({
      ticketId: "NJD-1499",
      at: T0 + 3 * MIN,
    });
    expect(replaced.incident?.version).toBe(5);
    const pruned = await h.actor.reportSite(
      report({ siteId: "site-e", ticketId: "NJD-1405", trace_id: "t-11", at: T0 + 7 * HOUR }),
    );
    expect(pruned.siteCount).toBe(1);
    const final = await h.actor.getIncident({ trace_id: "t-12" });
    expect(Object.keys(final.incident?.sites ?? {})).toEqual(["site-e"]);
    expect(final.incident?.priority).toBe("P1");
    expect(final.incident?.version).toBe(6);
  });

  it("withdrawing below two members while an incident is open keeps the incident", async () => {
    const h = makeRegionState("riyadh-north");
    await h.actor.reportSite(report());
    await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1402", trace_id: "t-2" }),
    );
    const w = await h.actor.withdrawSite({
      siteId: "site-b",
      ticketId: "NJD-1402",
      trace_id: "t-3",
      at: T0 + MIN,
    });
    expect(w.siteCount).toBe(1);
    expect(w.trace_id).toBe("t-3");
    const live = await h.actor.getIncident({ trace_id: "t-4" });
    expect(live.incident?.id).toBe("INC-1001");
    expect(live.incident?.priority).toBe("P2");
  });

  it("withdrawSite ignores a mismatched ticket and is idempotent", async () => {
    const h = makeRegionState("riyadh-north");
    await h.actor.reportSite(report());
    const wrong = await h.actor.withdrawSite({
      siteId: "site-a",
      ticketId: "NJD-9999",
      trace_id: "t-2",
      at: T0 + MIN,
    });
    expect(wrong.siteCount).toBe(1);
    expect(membersOf(h.storage)["site-a"]).toEqual({
      ticketId: "NJD-1401",
      firstAt: T0,
      lastAt: T0,
    });
    const gone = await h.actor.withdrawSite({
      siteId: "site-a",
      ticketId: "NJD-1401",
      trace_id: "t-3",
      at: T0 + 2 * MIN,
    });
    expect(gone.siteCount).toBe(0);
    const repeat = await h.actor.withdrawSite({
      siteId: "site-a",
      ticketId: "NJD-1401",
      trace_id: "t-4",
      at: T0 + 3 * MIN,
    });
    expect(repeat.siteCount).toBe(0);
    expect(membersOf(h.storage)["site-a"]).toBeUndefined();
  });

  it("a member older than 6 h is pruned before counting", async () => {
    const h = makeRegionState("riyadh-north");
    await h.actor.reportSite(report());
    const late = await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1402", trace_id: "t-2", at: T0 + 6 * HOUR + 1 }),
    );
    expect(late.siteCount).toBe(1);
    expect(late.declared).toBe(false);
    expect(late.incident).toBeNull();
    expect(Object.keys(membersOf(h.storage))).toEqual(["site-b"]);
  });

  it("a member exactly 6 h old still counts", async () => {
    const h = makeRegionState("riyadh-north");
    await h.actor.reportSite(report());
    const boundary = await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1402", trace_id: "t-2", at: T0 + 6 * HOUR }),
    );
    expect(boundary.siteCount).toBe(2);
    expect(boundary.declared).toBe(true);
  });

  it("a new ticket for a reported site replaces its membership entry", async () => {
    const h = makeRegionState("riyadh-north");
    await h.actor.reportSite(report());
    const r = await h.actor.reportSite(
      report({ ticketId: "NJD-1499", trace_id: "t-2", at: T0 + MIN }),
    );
    expect(r.siteCount).toBe(1);
    expect(r.declared).toBe(false);
    expect(membersOf(h.storage)["site-a"]).toEqual({
      ticketId: "NJD-1499",
      firstAt: T0 + MIN,
      lastAt: T0 + MIN,
    });
  });

  it("resolve returns the final incident, clears state and the next declare mints INC-1002", async () => {
    const h = makeRegionState("riyadh-north");
    await h.actor.reportSite(report());
    await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1402", trace_id: "t-2" }),
    );
    await h.actor.reportSite(
      report({ siteId: "site-c", ticketId: "NJD-1403", trace_id: "t-3" }),
    );
    await h.storage.setAlarm(T0 + 5 * MIN);
    const resolved = await h.actor.resolve({ trace_id: "t-4", at: T0 + MIN });
    expect(resolved.incident?.id).toBe("INC-1001");
    expect(resolved.incident?.priority).toBe("P1");
    expect(resolved.trace_id).toBe("t-4");
    expect(typeof resolved.actor_ms).toBe("number");
    expect(await h.storage.getAlarm()).toBeNull();
    expect(h.storage.calls).toContain("deleteAlarm");
    const live = await h.actor.getIncident({ trace_id: "t-5" });
    expect(live.incident).toBeNull();
    expect(h.storage.keys()).toEqual(["events", "seq"]);
    await h.actor.reportSite(report({ trace_id: "t-6" }));
    const again = await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1402", trace_id: "t-7" }),
    );
    expect(again.declared).toBe(true);
    expect(again.incident?.id).toBe("INC-1002");
  });

  it("resolve without an incident is a no-op", async () => {
    const h = makeRegionState("riyadh-north");
    await h.actor.reportSite(report());
    const resolved = await h.actor.resolve({ trace_id: "t-2", at: T0 + MIN });
    expect(resolved.incident).toBeNull();
    expect(h.storage.keys()).toEqual(["events", "members"]);
    expect(await h.storage.getAlarm()).toBeNull();
  });

  it("ack sets ackAt once and is a no-op afterwards or without an incident", async () => {
    const h = makeRegionState("riyadh-north");
    const none = await h.actor.ack({ by: "ops-1", trace_id: "t-0", at: T0 });
    expect(none.incident).toBeNull();
    await h.actor.reportSite(report());
    await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1402", trace_id: "t-2" }),
    );
    const acked = await h.actor.ack({ by: "ops-1", trace_id: "t-3", at: T0 + MIN });
    expect(acked.incident?.ackAt).toBe(T0 + MIN);
    expect(acked.incident?.version).toBe(2);
    expect(acked.trace_id).toBe("t-3");
    const repeat = await h.actor.ack({ by: "ops-2", trace_id: "t-4", at: T0 + 2 * MIN });
    expect(repeat.incident?.ackAt).toBe(T0 + MIN);
    expect(repeat.incident?.version).toBe(2);
  });

  it("an ack after a P2-to-P1 upgrade stops the P1 ladder", async () => {
    const h = makeRegionState("riyadh-north");
    await h.actor.reportSite(report());
    await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1402", trace_id: "t-2" }),
    );
    const firstAck = await h.actor.ack({ by: "ops-1", trace_id: "t-3", at: T0 + MIN });
    expect(firstAck.incident?.ackAt).toBe(T0 + MIN);
    expect(firstAck.incident?.esc).toEqual({ level: 0, dueAt: T0 + 300_000, acked: true });
    const up = await h.actor.reportSite({
      siteId: "site-c",
      ticketId: "NJD-1403",
      regionCode: "1",
      trace_id: "t-4",
      at: T0 + 2 * MIN,
    });
    expect(up.upgraded).toBe(true);
    expect(up.incident?.esc).toEqual({ level: 0, dueAt: T0 + 2 * MIN + 120_000, acked: false });
    expect(await h.storage.getAlarm()).toBe(T0 + 2 * MIN + 120_000);
    const secondAck = await h.actor.ack({ by: "ops-2", trace_id: "t-5", at: T0 + 3 * MIN });
    expect(secondAck.incident?.ackAt).toBe(T0 + MIN);
    expect(secondAck.incident?.esc).toEqual({ level: 0, dueAt: T0 + 2 * MIN + 120_000, acked: true });
    expect(secondAck.incident?.version).toBe(4);
    expect(await h.storage.getAlarm()).toBeNull();
    const out = await h.actor.tick({ now: T0 + 2 * MIN + 120_000 + 1 });
    expect(out).toEqual({ escalated: false, level: null });
    expect((await h.actor.getPages()).pages).toHaveLength(0);
  });

  it("reset clears the incident and alarm but keeps the sequence", async () => {
    const h = makeRegionState("riyadh-north");
    await h.actor.reportSite(report());
    await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1402", trace_id: "t-2" }),
    );
    await h.storage.setAlarm(T0 + 5 * MIN);
    const reset = await h.actor.reset({ trace_id: "t-3" });
    expect(reset).toMatchObject({ ok: true, seq: 1, trace_id: "t-3" });
    expect(await h.storage.getAlarm()).toBeNull();
    expect(h.storage.calls).toContain("deleteAlarm");
    expect(h.storage.raw("seq")).toBe(1);
    expect(h.storage.keys()).toEqual(["seq"]);
    const live = await h.actor.getIncident({ trace_id: "t-4" });
    expect(live.incident).toBeNull();
    await h.actor.reportSite(report({ trace_id: "t-5" }));
    const again = await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1402", trace_id: "t-6" }),
    );
    expect(again.declared).toBe(true);
    expect(again.incident?.id).toBe("INC-1002");
  });

  it("two back-to-back reports for different sites yield exactly one incident", async () => {
    const h = makeRegionState("riyadh-north");
    const first = await h.actor.reportSite(report());
    const second = await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1402", trace_id: "t-2" }),
    );
    expect(first.declared).toBe(false);
    expect(second.declared).toBe(true);
    expect(second.incident?.id).toBe("INC-1001");
    const live = await h.actor.getIncident({ trace_id: "t-3" });
    expect(live.incident?.id).toBe("INC-1001");
    expect(Object.keys(membersOf(h.storage)).sort()).toEqual(["site-a", "site-b"]);
  });

  it("getIncident without a trace_id still returns the incident", async () => {
    const h = makeRegionState("riyadh-north");
    await h.actor.reportSite(report());
    await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1402", trace_id: "t-2" }),
    );
    const bare = await h.actor.getIncident();
    expect(bare.incident?.id).toBe("INC-1001");
    expect(bare.trace_id).toBe("none");
    const empty = await makeRegionState("riyadh-north-2").actor.getIncident();
    expect(empty.incident).toBeNull();
  });

  it("alarm before due escalates nothing and never throws", async () => {
    const h = makeRegionState("riyadh-north");
    vi.spyOn(Date, "now").mockReturnValue(T0 - 1);
    await expect(h.actor.alarm()).resolves.toBeUndefined();
    await h.actor.reportSite(report());
    await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1402", trace_id: "t-2" }),
    );
    await expect(h.actor.alarm()).resolves.toBeUndefined();
    expect((await h.actor.getPages({ trace_id: "t-1" })).pages).toHaveLength(0);
    const live = await h.actor.getIncident({ trace_id: "t-1" });
    expect(live.incident?.esc?.level).toBe(0);
    expect(live.incident?.pages).toEqual([]);
  });

  it("every result is JSON-serialisable and carries trace_id and actor_ms", async () => {
    const h = makeRegionState("riyadh-north");
    await h.actor.reportSite(report());
    const declared = await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1402", trace_id: "t-2" }),
    );
    const results: unknown[] = [
      declared,
      await h.actor.withdrawSite({
        siteId: "site-b",
        ticketId: "NJD-1402",
        trace_id: "t-3",
        at: T0 + MIN,
      }),
      await h.actor.getIncident({ trace_id: "t-4" }),
      await h.actor.ack({ by: "ops-1", trace_id: "t-5", at: T0 + 2 * MIN }),
      await h.actor.resolve({ trace_id: "t-6", at: T0 + 3 * MIN }),
      await h.actor.reset({ trace_id: "t-7" }),
    ];
    for (const result of results) {
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
      expect(result).toHaveProperty("trace_id");
      expect(result).toHaveProperty("actor_ms");
    }
  });
});

const T1 = Date.UTC(2026, 8, 26, 7, 0, 0);
const P2_WINDOW_MS = 300_000;
const P1_WINDOW_MS = 120_000;

async function declareIncident(
  h: RegionStateHarness,
  opts: { at: number; p1?: boolean },
): Promise<Incident> {
  await h.actor.reportSite({
    siteId: "site-a",
    ticketId: "NJD-1401",
    regionCode: "1",
    trace_id: "t-a",
    at: opts.at,
  });
  await h.actor.reportSite({
    siteId: "site-b",
    ticketId: "NJD-1402",
    regionCode: "1",
    trace_id: "t-b",
    at: opts.at,
  });
  if (opts.p1 === true) {
    await h.actor.reportSite({
      siteId: "site-c",
      ticketId: "NJD-1403",
      regionCode: "1",
      trace_id: "t-c",
      at: opts.at,
    });
  }
  const { incident } = await h.actor.getIncident({ trace_id: "t-g" });
  return incident as Incident;
}

function failFirstGet(h: RegionStateHarness, message: string, count = 2): void {
  const inner = h.storage;
  const orig = inner.get.bind(inner);
  let called = 0;
  inner.get = (async <T,>(key: string) => {
    called += 1;
    if (called <= count) throw new Error(message);
    return orig<T>(key);
  }) as typeof inner.get;
}

describe("RegionState escalation ladder", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("declaring a P2 incident arms the alarm five minutes out with a level-0 esc", async () => {
    const h = makeRegionState("riyadh-north");
    const inc = await declareIncident(h, { at: T1 });
    expect(inc.esc).toEqual({ level: 0, dueAt: T1 + P2_WINDOW_MS, acked: false });
    expect(await h.storage.getAlarm()).toBe(T1 + P2_WINDOW_MS);
  });

  it("declaring a P1 incident arms the alarm two minutes out", async () => {
    const h = makeRegionState("riyadh-north");
    const inc = await declareIncident(h, { at: T1, p1: true });
    expect(inc.priority).toBe("P1");
    expect(inc.esc).toEqual({ level: 0, dueAt: T1 + P1_WINDOW_MS, acked: false });
    expect(await h.storage.getAlarm()).toBe(T1 + P1_WINDOW_MS);
  });

  it("an alarm before the due time escalates nothing", async () => {
    const h = makeRegionState("riyadh-north");
    const inc = await declareIncident(h, { at: T1 });
    const due = inc.esc?.dueAt ?? 0;
    const out = await h.actor.tick({ now: due - 1001 });
    expect(out).toEqual({ escalated: false, level: null });
    expect(await h.actor.getPages({ trace_id: "t-1" })).toEqual({
      pages: [],
      trace_id: "t-1",
      actor_ms: expect.any(Number),
    });
    expect(await h.storage.getAlarm()).toBe(due);
  });

  it("an alarm at due escalates once, pages once and re-arms to the next window", async () => {
    const h = makeRegionState("riyadh-north");
    const inc = await declareIncident(h, { at: T1 });
    const due = inc.esc?.dueAt ?? 0;
    const at = due + 1;
    const out = await h.actor.tick({ now: at });
    expect(out).toEqual({ escalated: true, level: 1 });
    const pages = (await h.actor.getPages()).pages;
    expect(pages).toHaveLength(1);
    expect(pages[0]).toEqual({
      id: "INC-1001:p1",
      level: 1,
      region: "riyadh-north",
      created_at: at,
      claimedBy: null,
      claimedAt: null,
      sentAt: null,
    });
    expect(await h.storage.getAlarm()).toBe(at + P2_WINDOW_MS);
    const live = await h.actor.getIncident({ trace_id: "t-2" });
    expect(live.incident?.esc).toEqual({ level: 1, dueAt: at + P2_WINDOW_MS, acked: false });
  });

  it("duplicate deliveries at the same moment produce one page", async () => {
    const h = makeRegionState("riyadh-north");
    const inc = await declareIncident(h, { at: T1 });
    const at = (inc.esc?.dueAt ?? 0) + 1;
    expect(await h.actor.tick({ now: at })).toEqual({ escalated: true, level: 1 });
    expect(await h.actor.tick({ now: at })).toEqual({ escalated: false, level: null });
    expect((await h.actor.getPages()).pages).toHaveLength(1);
  });

  it("a P2-to-P1 upgrade mid-ladder resets the ladder to the P1 window", async () => {
    const h = makeRegionState("riyadh-north");
    const inc = await declareIncident(h, { at: T1 });
    const firstDue = inc.esc?.dueAt ?? 0;
    const escalated = await h.actor.tick({ now: firstDue + 1 });
    expect(escalated).toEqual({ escalated: true, level: 1 });
    const at = firstDue + 2 * MIN;
    const up = await h.actor.reportSite({
      siteId: "site-c",
      ticketId: "NJD-1403",
      regionCode: "1",
      trace_id: "t-c",
      at,
    });
    expect(up.upgraded).toBe(true);
    expect(up.incident?.esc).toEqual({ level: 0, dueAt: at + P1_WINDOW_MS, acked: false });
    expect(await h.storage.getAlarm()).toBe(at + P1_WINDOW_MS);
    const second = await h.actor.tick({ now: at + P1_WINDOW_MS + 1 });
    expect(second).toEqual({ escalated: true, level: 1 });
    const pages = (await h.actor.getPages()).pages;
    expect(pages.map((p: Page) => p.level)).toEqual([1, 1]);
    expect(pages[1].id).toBe("INC-1001:p2");
  });

  it("a page minted after a mid-ladder upgrade gets a fresh id even when the earlier one was sent", async () => {
    const h = makeRegionState("riyadh-north");
    const inc = await declareIncident(h, { at: T1 });
    const at = (inc.esc?.dueAt ?? 0) + 1;
    await h.actor.tick({ now: at });
    expect(
      (await h.actor.claimPage({ pageId: "INC-1001:p1", claimer: "probe-a", now: at + 1 }))
        .claimed,
    ).toBe(true);
    expect((await h.actor.markPageSent({ pageId: "INC-1001:p1", now: at + 2 })).ok).toBe(true);
    const at2 = at + MIN;
    const up = await h.actor.reportSite({
      siteId: "site-c",
      ticketId: "NJD-1403",
      regionCode: "1",
      trace_id: "t-c",
      at: at2,
    });
    expect(up.upgraded).toBe(true);
    const at3 = (up.incident?.esc?.dueAt ?? 0) + 1;
    const escalated = await h.actor.tick({ now: at3 });
    expect(escalated).toEqual({ escalated: true, level: 1 });
    const pending = (await h.actor.getPages()).pages;
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("INC-1001:p2");
    expect(pending[0].id).not.toBe("INC-1001:p1");
    const claim = await h.actor.claimPage({
      pageId: "INC-1001:p2",
      claimer: "probe-b",
      now: at3 + 1,
    });
    expect(claim.claimed).toBe(true);
    expect((await h.actor.markPageSent({ pageId: "INC-1001:p2", now: at3 + 2 })).ok).toBe(true);
    expect((await h.actor.getPages()).pages).toHaveLength(0);
  });

  it("an alarm after resolve appends no page", async () => {
    const h = makeRegionState("riyadh-north");
    const inc = await declareIncident(h, { at: T1 });
    const due = inc.esc?.dueAt ?? 0;
    await h.actor.resolve({ trace_id: "t-2", at: due - 1 });
    expect(await h.storage.getAlarm()).toBeNull();
    const out = await h.actor.tick({ now: due + 1 });
    expect(out).toEqual({ escalated: false, level: null });
    expect((await h.actor.getPages()).pages).toHaveLength(0);
  });

  it("ack marks the esc acked, deletes the alarm and stops the ladder", async () => {
    const h = makeRegionState("riyadh-north");
    const inc = await declareIncident(h, { at: T1 });
    const due = inc.esc?.dueAt ?? 0;
    const acked = await h.actor.ack({ by: "ops-1", trace_id: "t-2", at: due - 1 });
    expect(acked.incident?.esc).toEqual({ level: 0, dueAt: due, acked: true });
    expect(await h.storage.getAlarm()).toBeNull();
    expect(h.storage.calls).toContain("deleteAlarm");
    const out = await h.actor.tick({ now: due + 1 });
    expect(out).toEqual({ escalated: false, level: null });
    expect((await h.actor.getPages()).pages).toHaveLength(0);
  });

  it("the ladder caps at three pages and then deletes the alarm", async () => {
    const h = makeRegionState("riyadh-north");
    const inc = await declareIncident(h, { at: T1 });
    let at = (inc.esc?.dueAt ?? 0) + 1;
    for (let level = 1; level <= 3; level++) {
      expect(await h.actor.tick({ now: at })).toEqual({ escalated: true, level });
      at += P2_WINDOW_MS;
    }
    const pages = (await h.actor.getPages()).pages;
    expect(pages.map((p: Page) => p.id)).toEqual(["INC-1001:p1", "INC-1001:p2", "INC-1001:p3"]);
    expect(await h.storage.getAlarm()).toBeNull();
    expect(await h.actor.tick({ now: at })).toEqual({ escalated: false, level: null });
    expect((await h.actor.getPages()).pages).toHaveLength(3);
  });

  it("two claims of the same page: exactly one wins", async () => {
    const h = makeRegionState("riyadh-north");
    const inc = await declareIncident(h, { at: T1 });
    const at = (inc.esc?.dueAt ?? 0) + 1;
    await h.actor.tick({ now: at });
    const first = await h.actor.claimPage({
      pageId: "INC-1001:p1",
      claimer: "probe-a",
      now: at + 1,
    });
    expect(first.claimed).toBe(true);
    expect(first.page?.claimedBy).toBe("probe-a");
    expect(first.page?.claimedAt).toBe(at + 1);
    const second = await h.actor.claimPage({
      pageId: "INC-1001:p1",
      claimer: "probe-b",
      now: at + 2,
    });
    expect(second.claimed).toBe(false);
  });

  it("a claim of an unknown page loses", async () => {
    const h = makeRegionState("riyadh-north");
    await declareIncident(h, { at: T1 });
    const none = await h.actor.claimPage({
      pageId: "INC-1001:p9",
      claimer: "probe-a",
      now: T1 + 1,
    });
    expect(none.claimed).toBe(false);
    expect(none.page).toBeNull();
  });

  it("a stale claim older than 60 s can be re-claimed, but only while unsent", async () => {
    const h = makeRegionState("riyadh-north");
    const inc = await declareIncident(h, { at: T1 });
    const at = (inc.esc?.dueAt ?? 0) + 1;
    await h.actor.tick({ now: at });
    expect(
      (await h.actor.claimPage({ pageId: "INC-1001:p1", claimer: "probe-a", now: at + 1 }))
        .claimed,
    ).toBe(true);
    expect(
      (await h.actor.claimPage({ pageId: "INC-1001:p1", claimer: "probe-b", now: at + 61_000 }))
        .claimed,
    ).toBe(true);
    expect(
      (await h.actor.markPageSent({ pageId: "INC-1001:p1", now: at + 61_001 })).ok,
    ).toBe(true);
    expect(
      (await h.actor.claimPage({ pageId: "INC-1001:p1", claimer: "probe-a", now: at + 130_000 }))
        .claimed,
    ).toBe(false);
  });

  it("markPageSent removes the page from pending", async () => {
    const h = makeRegionState("riyadh-north");
    const inc = await declareIncident(h, { at: T1 });
    const at = (inc.esc?.dueAt ?? 0) + 1;
    await h.actor.tick({ now: at });
    await h.actor.claimPage({ pageId: "INC-1001:p1", claimer: "probe-a", now: at + 1 });
    expect((await h.actor.getPages()).pages).toHaveLength(1);
    const sent = await h.actor.markPageSent({ pageId: "INC-1001:p1", now: at + 2 });
    expect(sent).toEqual({ ok: true, pageId: "INC-1001:p1" });
    expect((await h.actor.getPages()).pages).toHaveLength(0);
    const repeat = await h.actor.markPageSent({ pageId: "INC-1001:p1", now: at + 3 });
    expect(repeat).toEqual({ ok: true, pageId: "INC-1001:p1" });
    const missing = await h.actor.markPageSent({ pageId: "INC-9999:p1", now: at + 3 });
    expect(missing).toEqual({ ok: false, pageId: "INC-9999:p1" });
  });

  it("getPages echoes the trace_id", async () => {
    const h = makeRegionState("riyadh-north");
    await declareIncident(h, { at: T1 });
    expect((await h.actor.getPages({ trace_id: "t-9" })).trace_id).toBe("t-9");
  });

  it("getIncident returns the incident's full page history including sent pages", async () => {
    const h = makeRegionState("riyadh-north");
    await declareIncident(h, { at: T1 });
    const due = T1 + P2_WINDOW_MS;
    await h.actor.tick({ now: due });
    const claim = await h.actor.claimPage({
      pageId: "INC-1001:p1",
      claimer: "probe-a",
      now: due + 1,
    });
    expect(claim.claimed).toBe(true);
    await h.actor.markPageSent({ pageId: "INC-1001:p1", now: due + 2 });

    const out = await h.actor.getIncident({ trace_id: "t-3" });
    const pages = (out.incident?.pages ?? []) as unknown as Page[];
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      id: "INC-1001:p1",
      level: 1,
      created_at: due,
      claimedBy: "probe-a",
      sentAt: due + 2,
    });
  });

  it("getIncident keeps other pages out and resolve carries the same history", async () => {
    const h = makeRegionState("riyadh-north");
    await declareIncident(h, { at: T1 });
    await h.actor.tick({ now: T1 + P2_WINDOW_MS });
    // A foreign page id under the same storage key must not leak in.
    const stored = ((await h.storage.get("pages")) ?? []) as unknown as Page[];
    stored.push({
      id: "INC-9999:p9",
      level: 3,
      region: "lab",
      created_at: T1,
      claimedBy: null,
      claimedAt: null,
      sentAt: null,
    });
    await h.storage.put("pages", stored);
    const live = await h.actor.getIncident({ trace_id: "t-3" });
    const livePages = (live.incident?.pages ?? []) as unknown as Page[];
    expect(livePages.map((p) => p.id)).toEqual(["INC-1001:p1"]);

    const resolved = await h.actor.resolve({ trace_id: "t-4", at: T1 + P2_WINDOW_MS + 1 });
    const resolvedPages = (resolved.incident?.pages ?? []) as unknown as Page[];
    expect(resolvedPages.map((p) => p.id)).toEqual(["INC-1001:p1"]);
  });

  it("resolve drops the resolved incident's pending pages so they are never sent later", async () => {
    const h = makeRegionState("riyadh-north");
    const inc = await declareIncident(h, { at: T1 });
    const at = (inc.esc?.dueAt ?? 0) + 1;
    expect(await h.actor.tick({ now: at })).toEqual({ escalated: true, level: 1 });
    expect((await h.actor.getPages()).pages).toHaveLength(1);
    const resolved = await h.actor.resolve({ trace_id: "t-2", at: at + 1 });
    expect(resolved.incident?.id).toBe("INC-1001");
    expect((await h.actor.getPages({ trace_id: "t-3" })).pages).toEqual([]);
    const claim = await h.actor.claimPage({
      pageId: "INC-1001:p1",
      claimer: "prober",
      now: at + 2,
    });
    expect(claim.claimed).toBe(false);
    expect(claim.page).toBeNull();
    const stored = ((await h.storage.get("pages")) ?? []) as unknown as Page[];
    expect(stored).toEqual([]);
  });

  it("alarm() at due escalates with the real clock and duplicate delivery is harmless", async () => {
    const h = makeRegionState("riyadh-north");
    const inc = await declareIncident(h, { at: T1 });
    const due = inc.esc?.dueAt ?? 0;
    const clock = vi.spyOn(Date, "now").mockReturnValue(due + 1);
    await expect(h.actor.alarm()).resolves.toBeUndefined();
    clock.mockReturnValue(due + 2);
    await expect(h.actor.alarm()).resolves.toBeUndefined();
    expect((await h.actor.getPages()).pages).toHaveLength(1);
  });

  it("alarm() and tick() never throw when storage fails", async () => {
    const errSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const h = makeRegionState("riyadh-north");
    await declareIncident(h, { at: T1 });
    failFirstGet(h, "storage_down");
    await expect(h.actor.alarm()).resolves.toBeUndefined();
    const out = await h.actor.tick({ now: T1 + P2_WINDOW_MS + 1 });
    expect(out).toEqual({ escalated: false, level: null });
    expect(errSpy).toHaveBeenCalledTimes(2);
    const line = JSON.parse(String(errSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect(line).toMatchObject({
      lvl: "error",
      svc: "noc-actors",
      hop: "region/alarm",
      evt: "region.alarm_failed",
      error: "storage_down",
    });
  });
});
