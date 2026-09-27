import { beforeEach, describe, expect, it, vi } from "vitest";
import { SeedAdapter } from "../../../shared/src/itsm";
import { kvKey } from "../../../shared/src/kvkeys";
import { REGIONS, SITES } from "../../../shared/src/seed";
import type { Session } from "../../../shared/src/types";
import {
  OpsActionError,
  ackIncident,
  resetAll,
  resolveIncident,
  stageIncident,
  unlockSite,
  type ActionDeps,
} from "../../src/ops/actions";
import { syncProjection } from "../../src/services/incidents";
import { FakeActorPort } from "../fakes/actors";
import { FakeKv } from "../fakes/kv";
import { PEPPER, T0 } from "./helpers";

const DEPS = (): { deps: ActionDeps; kv: FakeKv; actors: FakeActorPort } => {
  const kv = new FakeKv();
  const actors = new FakeActorPort();
  return {
    kv,
    actors,
    deps: {
      kv,
      actors,
      adapter: new SeedAdapter({ seedLocal: { pins: {}, contacts: [] }, pepper: PEPPER, now: () => T0 }),
      now: T0,
      trace_id: "t-ops-1",
    },
  };
};

function stageTwoSites(bundle: { deps: ActionDeps; actors: FakeActorPort }): Promise<void> {
  const { deps, actors } = bundle;
  return (async () => {
    for (const siteId of ["RUH-121", "RUH-133"]) {
      const session: Session = {
        k: `stage-${siteId}`,
        trace_id: `t-${siteId}`,
        identified: true,
        verified: true,
        contact_id: null,
        customer_id: "c-alwaha",
        sites: [siteId],
        region: "riyadh-north",
      };
      await actors.site(siteId).openOrAttach({
        k: session.k,
        trace_id: session.trace_id,
        callerRef: "none",
        symptom: "WAN link down",
        impact: "site_down",
        serviceAffecting: true,
        priority: "P2",
        at: deps.now,
        siteCode: SITES.find((s) => s.site_id === siteId)?.code ?? "00",
      });
      await actors.region("riyadh-north").reportSite({
        siteId,
        ticketId: "NJD-0000",
        regionCode: "1",
        trace_id: session.trace_id,
        at: deps.now,
      });
    }
    await syncProjection({ actors: deps.actors, kv: deps.kv }, "riyadh-north", deps.trace_id);
  })();
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ops reset", () => {
  it("clears tickets, incidents, projections and fault flags while keeping seq", async () => {
    const { deps, kv, actors } = DEPS();
    const ticket = await actors.site("RUH-114").openOrAttach({
      k: "k1",
      trace_id: "t-1",
      callerRef: "none",
      symptom: "WAN link down",
      impact: "site_down",
      serviceAffecting: true,
      priority: "P2",
      at: T0,
      siteCode: "14",
    });
    expect(ticket.ticket.id).toBe("NJD-1401");
    await actors.site("RUH-114").recordPinAttempt({
      k: "k1",
      valid: false,
      fp: "f1",
      trace_id: "t-1",
      at: T0,
    });
    await stageTwoSites({ deps, actors });
    await kv.put(kvKey("flag", "fault", "open_ticket"), "503");
    await kv.put(kvKey("flag", "deflection_enabled"), "false");
    await kv.put(kvKey("flag", "require_pin"), "true");

    const report = await resetAll(deps);

    expect(report.items.every((i) => i.ok)).toBe(true);
    expect(report.items.map((i) => i.item)).toContain("site/RUH-114");
    expect(report.items.map((i) => i.item)).toContain("region/lab");
    const reopened = await actors.site("RUH-114").openOrAttach({
      k: "k2",
      trace_id: "t-2",
      callerRef: "none",
      symptom: "WAN link down",
      impact: "site_down",
      serviceAffecting: true,
      priority: "P2",
      at: T0,
      siteCode: "14",
    });
    expect(reopened.ticket.id).toBe("NJD-1402");
    expect(reopened.created).toBe(true);
    const pin = await actors.site("RUH-114").recordPinAttempt({
      k: "k3",
      valid: false,
      fp: "f2",
      trace_id: "t-3",
      at: T0,
    });
    expect(pin.result).toBe("invalid");
    expect(pin.attemptsLeft).toBe(2);
    const incident = await actors.region("riyadh-north").getIncident({ trace_id: "t-4" });
    expect(incident.incident).toBeNull();
    for (const region of REGIONS) {
      expect(kv.raw(kvKey("incident", "active", region.region))).toBeNull();
    }
    expect(await kv.list(kvKey("flag", "fault") + "/")).toEqual([]);
    expect(kv.raw(kvKey("flag", "deflection_enabled"))).toBe("true");
    expect(kv.raw(kvKey("flag", "require_pin"))).toBe("false");
  });

  it("resets every seed site and region plus lab", async () => {
    const { deps, kv, actors } = DEPS();
    const report = await resetAll(deps);
    const names = report.items.map((i) => i.item);
    for (const site of SITES) {
      expect(names).toContain(`site/${site.site_id}`);
    }
    for (const region of REGIONS) {
      expect(names).toContain(`region/${region.region}`);
      expect(names).toContain(`projection/${region.region}`);
    }
  });
});

describe("ops stage-incident", () => {
  it("declares a two-site incident for riyadh-north and syncs the projection", async () => {
    const { deps, kv, actors } = DEPS();
    await resetAll(deps);
    const out = await stageIncident(deps, "riyadh-north");
    expect(out.incident).not.toBeNull();
    expect(out.incident?.site_count).toBe(2);
    expect(out.incident?.priority).toBe("P2");
    expect(out.incident?.region).toBe("riyadh-north");
    expect(out.tickets.sort()).toEqual(["NJD-2101", "NJD-3301"]);
    const projection = JSON.parse(
      kv.raw(kvKey("incident", "active", "riyadh-north")) as string,
    ) as { site_count: number };
    expect(projection.site_count).toBe(2);
  });

  it("rejects regions without the scripted sites", async () => {
    const { deps, kv, actors } = DEPS();
    await expect(stageIncident(deps, "jeddah")).rejects.toThrow(OpsActionError);
    await expect(stageIncident(deps, "nope")).rejects.toThrow(OpsActionError);
  });
});

describe("ops resolve and ack", () => {
  it("acks the incident then resolves it and clears the projection", async () => {
    const { deps, kv, actors } = DEPS();
    await resetAll(deps);
    await stageIncident(deps, "riyadh-north");
    const acked = await ackIncident(deps, "riyadh-north");
    expect(acked.acked).toBe(true);
    let incident = await actors.region("riyadh-north").getIncident({ trace_id: "t-2" });
    expect(incident.incident?.ackAt).toBe(T0);
    const again = await ackIncident(deps, "riyadh-north");
    expect(again.acked).toBe(false);

    const resolved = await resolveIncident(deps, "riyadh-north");
    expect(resolved.resolved).not.toBeNull();
    incident = await actors.region("riyadh-north").getIncident({ trace_id: "t-3" });
    expect(incident.incident).toBeNull();
    expect(kv.raw(kvKey("incident", "active", "riyadh-north"))).toBeNull();
  });

  it("rejects unknown regions", async () => {
    const { deps, kv, actors } = DEPS();
    await expect(ackIncident(deps, "nope")).rejects.toThrow(OpsActionError);
    await expect(resolveIncident(deps, "nope")).rejects.toThrow(OpsActionError);
  });
});

describe("ops unlock", () => {
  it("resets the site including its ticket (demo-only)", async () => {
    const { deps, kv, actors } = DEPS();
    await actors.site("RUH-114").openOrAttach({
      k: "k1",
      trace_id: "t-1",
      callerRef: "none",
      symptom: "WAN link down",
      impact: "site_down",
      serviceAffecting: true,
      priority: "P2",
      at: T0,
      siteCode: "14",
    });
    const out = await unlockSite(deps, "RUH-114");
    expect(out.ok).toBe(true);
    expect(out.note).toContain("demo");
    expect((await actors.site("RUH-114").getTicket({ trace_id: "t-2" })).ticket).toBeNull();
  });

  it("rejects unknown sites", async () => {
    const { deps, kv, actors } = DEPS();
    await expect(unlockSite(deps, "NOPE-1")).rejects.toThrow(OpsActionError);
  });
});
