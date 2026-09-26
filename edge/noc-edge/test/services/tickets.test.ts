import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SeedAdapter } from "../../../shared/src/itsm";
import { kvKey } from "../../../shared/src/kvkeys";
import type { Session } from "../../../shared/src/types";
import type { Flags } from "../../src/services/flags";
import {
  open,
  joinIncident,
  TicketError,
  type TicketCtx,
} from "../../src/services/tickets";
import { FakeActorPort } from "../fakes/actors";
import { FakeKv } from "../fakes/kv";

const T0 = Date.UTC(2026, 8, 26, 6, 0, 0);
const PEPPER = ["p", "e", "pp", "er"].join("");

const FLAGS: Flags = {
  deflection_enabled: true,
  require_pin: false,
  demo_caller: null,
  fault_open_ticket: null,
  fault_dv_delay_ms: null,
};

const PROJECTION_KEY = kvKey("incident", "active", "riyadh-north");

interface LogLine extends Record<string, unknown> {
  evt: string;
  lvl?: string;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    k: ["1a", "2b", "3c", "4d", "5e", "6f", "7a", "8b"].join(""),
    trace_id: "t-1",
    identified: true,
    verified: false,
    contact_id: "c-ahmed",
    customer_id: "c-alwaha",
    sites: ["RUH-114"],
    region: "riyadh-north",
    ...overrides,
  };
}

function makeCtx(opts: {
  kv: FakeKv;
  actors: FakeActorPort;
  flags?: Flags;
  trace_id?: string;
}): TicketCtx {
  return {
    actors: opts.actors,
    kv: opts.kv,
    adapter: new SeedAdapter({
      seedLocal: { pins: {}, contacts: [] },
      pepper: PEPPER,
      now: () => T0,
    }),
    flags: opts.flags ?? FLAGS,
    now: T0,
    trace_id: opts.trace_id ?? "t-1",
  };
}

const SITE_DOWN = { site_id: "RUH-114", symptom: "WAN link down", impact: "site_down", service_affecting: "true" };

describe("tickets.open", () => {
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
    return logs
      .map((l) => JSON.parse(l) as LogLine)
      .filter((l) => l.evt === evt);
  }

  it("creates the first site_down ticket, reports the region, projection absent", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const actors = new FakeActorPort();
    const ctx = makeCtx({ kv, actors });
    const result = await open(ctx, makeSession(), SITE_DOWN);
    expect(result).toEqual({
      ticket_id: "NJD-1401",
      priority: "P2",
      created: "true",
      ticket_readback: expect.stringContaining("Your ticket number is N J D, 1 4 0 1"),
      incident_note: "none",
      symptom: "none",
      impact: "unknown",
    });
    const ticket = actors.siteTicket("RUH-114");
    expect(ticket?.regionReported).toBe(true);
    expect(kv.has(PROJECTION_KEY)).toBe(false);
    expect(eventsWith("incidents.report_failed")).toHaveLength(0);
  });

  it("declares an incident on the second site and writes the projection", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const actors = new FakeActorPort();
    const ctx = makeCtx({ kv, actors });
    const first = await open(ctx, makeSession(), SITE_DOWN);
    expect(first.created).toBe("true");
    const second = await open(
      ctx,
      makeSession({
        k: ["2b", "3c", "4d", "5e", "6f", "7a", "8b", "9c"].join(""),
        trace_id: "t-2",
        contact_id: "c-sara",
        sites: ["RUH-121"],
      }),
      { site_id: "RUH-121", symptom: "WAN link down", impact: "site_down", service_affecting: "true" },
    );
    expect(second.ticket_id).toBe("NJD-2101");
    expect(second.created).toBe("true");
    const ticket = actors.siteTicket("RUH-121");
    expect(ticket?.regionReported).toBe(true);
    expect(kv.has(PROJECTION_KEY)).toBe(true);
    const projection = JSON.parse(kv.raw(PROJECTION_KEY) as string);
    expect(projection.id).toBe("INC-1001");
    expect(projection.priority).toBe("P2");
    expect(projection.site_count).toBe(2);
    expect(second.ticket_readback).toContain(
      "This is part of incident I N C, 1 0 0 1 affecting Riyadh North.",
    );
    expect(second.incident_note).not.toBe("none");
  });

  it("retries reportSite once and succeeds", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const actors = new FakeActorPort();
    actors.failNextReport("riyadh-north", 1);
    const ctx = makeCtx({ kv, actors });
    const result = await open(ctx, makeSession(), SITE_DOWN);
    expect(result.created).toBe("true");
    expect(actors.siteTicket("RUH-114")?.regionReported).toBe(true);
    expect(eventsWith("incidents.report_failed")).toHaveLength(0);
  });

  it("after a second failure logs incidents.report_failed and keeps regionReported false", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const actors = new FakeActorPort();
    actors.failNextReport("riyadh-north", 2);
    const ctx = makeCtx({ kv, actors });
    const result = await open(ctx, makeSession(), SITE_DOWN);
    expect(result.created).toBe("true");
    expect(actors.siteTicket("RUH-114")?.regionReported).toBe(false);
    const failures = eventsWith("incidents.report_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0].region).toBe("riyadh-north");
  });

  it("the next open for that site retries the region report", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const actors = new FakeActorPort();
    actors.failNextReport("riyadh-north", 2);
    const ctx = makeCtx({ kv, actors });
    await open(ctx, makeSession(), SITE_DOWN);
    expect(actors.siteTicket("RUH-114")?.regionReported).toBe(false);
    const again = await open(
      ctx,
      makeSession({
        k: ["2b", "3c", "4d", "5e", "6f", "7a", "8b", "9c"].join(""),
        trace_id: "t-2",
      }),
      { site_id: "RUH-114", symptom: "still down", impact: "site_down", service_affecting: "true" },
    );
    expect(again.created).toBe("false");
    expect(actors.siteTicket("RUH-114")?.regionReported).toBe(true);
  });

  it("a single_user report does not contact the region actor", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const actors = new FakeActorPort();
    const ctx = makeCtx({ kv, actors });
    const result = await open(ctx, makeSession(), {
      site_id: "RUH-114",
      symptom: "one phone",
      impact: "single_user",
      service_affecting: "false",
    });
    expect(result.created).toBe("true");
    expect(result.priority).toBe("P4");
    expect(actors.siteTicket("RUH-114")?.regionReported).toBe(false);
    expect(actors.regionMembers("riyadh-north")).toBeUndefined();
  });

  it("denies a cross-customer site with 403", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const actors = new FakeActorPort();
    const ctx = makeCtx({ kv, actors });
    await expect(
      open(ctx, makeSession(), {
        site_id: "JED-900",
        symptom: "x",
        impact: "site_down",
        service_affecting: "true",
      }),
    ).rejects.toMatchObject({ status: 403, name: "TicketError" });
    const denied = eventsWith("auth.denied");
    expect(denied).toHaveLength(1);
  });

  it("denies an unverified and unidentified caller with 403", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const ctx = makeCtx({ kv, actors: new FakeActorPort() });
    await expect(
      open(ctx, makeSession({ identified: false, verified: false }), SITE_DOWN),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns 422 for a site that cannot be resolved", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const ctx = makeCtx({ kv, actors: new FakeActorPort() });
    await expect(
      open(
        ctx,
        makeSession({ sites: ["RUH-999"], verified: true, identified: false, contact_id: null }),
        { site_id: "RUH-999", symptom: "x", impact: "site_down", service_affecting: "true" },
      ),
    ).rejects.toMatchObject({ status: 422, name: "TicketError" });
  });

  it("fault_injected flag makes open throw the flagged status", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const ctx = makeCtx({
      kv,
      actors: new FakeActorPort(),
      flags: { ...FLAGS, fault_open_ticket: 503 },
    });
    await expect(open(ctx, makeSession(), SITE_DOWN)).rejects.toMatchObject({
      status: 503,
      name: "TicketError",
    });
    expect(kv.calls.length).toBe(0);
  });

  it("attaches to the open ticket with the attach wording", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const actors = new FakeActorPort();
    const ctx = makeCtx({ kv, actors });
    await open(ctx, makeSession(), SITE_DOWN);
    const second = await open(
      ctx,
      makeSession({
        k: ["2b", "3c", "4d", "5e", "6f", "7a", "8b", "9c"].join(""),
        trace_id: "t-2",
        contact_id: "c-sara",
        sites: ["RUH-114"],
      }),
      { site_id: "RUH-114", symptom: "still down", impact: "degraded", service_affecting: "false" },
    );
    expect(second.created).toBe("false");
    expect(second.priority).toBe("P2");
    expect(second.ticket_id).toBe("NJD-1401");
    expect(second.ticket_readback).toContain("already an open ticket");
    expect(second.incident_note).toBe("none");
  });

  it("raises priority when a later report is more severe", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const actors = new FakeActorPort();
    const ctx = makeCtx({ kv, actors });
    await open(ctx, makeSession(), {
      site_id: "RUH-114",
      symptom: "one phone",
      impact: "single_user",
      service_affecting: "false",
    });
    const second = await open(
      ctx,
      makeSession({
        k: ["2b", "3c", "4d", "5e", "6f", "7a", "8b", "9c"].join(""),
        trace_id: "t-2",
        contact_id: "c-sara",
        sites: ["RUH-114"],
      }),
      { site_id: "RUH-114", symptom: "down", impact: "site_down", service_affecting: "true" },
    );
    expect(second.priority).toBe("P2");
    expect(second.ticket_readback).toContain("raised it to priority 2");
  });

  it("coerces an unknown impact to single_user", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const ctx = makeCtx({ kv, actors: new FakeActorPort() });
    const result = await open(ctx, makeSession(), {
      site_id: "RUH-114",
      symptom: "?",
      impact: "banana",
      service_affecting: "true",
    });
    expect(result.priority).toBe("P4");
  });
});

describe("tickets.joinIncident", () => {
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

  it("denies an unidentified and unverified caller with 403", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const ctx = makeCtx({ kv, actors: new FakeActorPort() });
    await expect(
      joinIncident(ctx, makeSession({ identified: false, verified: false })),
    ).rejects.toMatchObject({ status: 403, name: "TicketError" });
  });

  it("returns 422 when no incident is active", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const ctx = makeCtx({ kv, actors: new FakeActorPort() });
    await expect(joinIncident(ctx, makeSession())).rejects.toMatchObject({
      status: 422,
      name: "TicketError",
    });
  });

  it("joins the active incident with impact site_down and forces region reporting", async () => {
    const kv = new FakeKv();
    kv.setNow(T0);
    const actors = new FakeActorPort();
    const ctx = makeCtx({ kv, actors });
    await open(ctx, makeSession(), SITE_DOWN);
    await open(
      ctx,
      makeSession({
        k: ["2b", "3c", "4d", "5e", "6f", "7a", "8b", "9c"].join(""),
        trace_id: "t-2",
        contact_id: "c-sara",
        sites: ["RUH-121"],
      }),
      { site_id: "RUH-121", symptom: "WAN link down", impact: "site_down", service_affecting: "true" },
    );
    const joiner = makeSession({
      k: ["3c", "4d", "5e", "6f", "7a", "8b", "9c", "ad"].join(""),
      trace_id: "t-3",
      contact_id: "c-khalid",
      sites: ["RUH-133"],
    });
    const result = await joinIncident(ctx, joiner);
    expect(result.created).toBe("true");
    expect(result.ticket_id).toBe("NJD-3301");
    expect(result.priority).toBe("P2");
    const ticket = actors.siteTicket("RUH-133");
    expect(ticket?.regionReported).toBe(true);
    const projection = JSON.parse(kv.raw(PROJECTION_KEY) as string);
    expect(projection.site_count).toBe(3);
    expect(projection.priority).toBe("P1");
  });
});

describe("TicketError", () => {
  it("carries the status", () => {
    const err = new TicketError(500, "boom");
    expect(err.status).toBe(500);
    expect(err).toBeInstanceOf(Error);
  });
});
