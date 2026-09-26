import { describe, expect, it } from "vitest";
import type { Incident } from "../../shared/src/types";
import type { Members, ReportSiteInput } from "../src/RegionState";
import { makeRegionState } from "./fakes/storage";

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
    expect(inc.esc).toBeNull();
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

  it("alarm is a no-op that never throws", async () => {
    const h = makeRegionState("riyadh-north");
    await expect(h.actor.alarm()).resolves.toBeUndefined();
    await h.actor.reportSite(report());
    await h.actor.reportSite(
      report({ siteId: "site-b", ticketId: "NJD-1402", trace_id: "t-2" }),
    );
    await expect(h.actor.alarm()).resolves.toBeUndefined();
    expect(h.storage.calls).toEqual([]);
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
