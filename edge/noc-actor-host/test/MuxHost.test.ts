import { describe, expect, it } from "vitest";
import type { ActorContext, Env } from "@telnyx/edge-runtime";
import { FakeStorage } from "../../noc-actors/test/fakes/storage";
import { Counter } from "../src/MuxHost";

const T = Date.UTC(2026, 8, 26, 8, 0, 0);

function makeHost(): { host: Counter; storage: FakeStorage } {
  const storage = new FakeStorage();
  const ctx: ActorContext = {
    id: "demo",
    storage: storage as unknown as ActorContext["storage"],
    blockConcurrencyWhile: <T2,>(fn: () => Promise<T2>) => fn(),
    setAlarm: (when: number) => storage.setAlarm(when),
    count: () => 0,
    broadcast: () => 0,
    sockets: () => [],
  };
  return { host: new Counter(ctx, {} as Env), storage };
}

function openInput(k: string, siteCode: string, at: number = T) {
  return {
    k,
    trace_id: `t-${k}`,
    callerRef: "none",
    symptom: "WAN link down",
    impact: "site_down" as const,
    serviceAffecting: true,
    priority: "P2" as const,
    at,
    siteCode,
  };
}

describe("MuxHost stock Counter surface", () => {
  it("keeps increment/value over the unprefixed key", async () => {
    const { host, storage } = makeHost();
    expect(await host.increment(3)).toBe(3);
    expect(await host.increment(1)).toBe(4);
    expect(await host.value()).toBe(4);
    expect(storage.raw("value")).toBe(4);
  });

  it("ping answers from the host itself", async () => {
    const { host } = makeHost();
    expect(await host.ping()).toEqual({ pong: true, name: "mux" });
  });
});

describe("MuxHost site muxing", () => {
  it("two openOrAttach calls with different k open one shared ticket", async () => {
    const { host } = makeHost();
    const first = (await host.site("RUH-114", "openOrAttach", openInput("c-a", "RUH"))) as {
      created: boolean;
      ticket: { id: string };
    };
    const second = (await host.site("RUH-114", "openOrAttach", openInput("c-b", "RUH"))) as {
      created: boolean;
      ticket: { id: string };
    };
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.ticket.id).toBe(first.ticket.id);
  });

  it("different sites get independent tickets under isolated prefixes", async () => {
    const { host, storage } = makeHost();
    const a = (await host.site("RUH-114", "openOrAttach", openInput("c-a", "RUH"))) as {
      ticket: { id: string };
    };
    const b = (await host.site("RUH-115", "openOrAttach", openInput("c-b", "RUH"))) as {
      created: boolean;
      ticket: { id: string };
    };
    expect(b.created).toBe(true);
    expect(b.ticket.id).toBe(a.ticket.id);
    expect(storage.keys()).toContain("site/RUH-114/ticket");
    expect(storage.keys()).toContain("site/RUH-115/ticket");
    expect(storage.raw("site/RUH-115/ticket")).not.toEqual(storage.raw("site/RUH-114/ticket"));
  });

  it("pinging a site reports the site name, not the host", async () => {
    const { host } = makeHost();
    expect(await host.site("RUH-114", "ping")).toEqual({ pong: true, name: "RUH-114" });
  });

  it("reset of one site leaves another site untouched", async () => {
    const { host } = makeHost();
    await host.site("RUH-114", "openOrAttach", openInput("c-a", "RUH"));
    await host.site("RUH-115", "openOrAttach", openInput("c-b", "RUH"));
    const reset = (await host.site("RUH-114", "reset")) as { ok: true; seq: number };
    expect(reset.ok).toBe(true);
    expect(reset.seq).toBe(1);
    expect(await host.site("RUH-114", "getTicket")).toEqual({
      ticket: null,
      trace_id: "none",
      actor_ms: expect.any(Number),
    });
    const other = (await host.site("RUH-115", "getTicket")) as { ticket: { id: string } | null };
    expect(other.ticket).not.toBeNull();
  });
});

describe("MuxHost region muxing", () => {
  it("reportSite across two sites declares one incident", async () => {
    const { host, storage } = makeHost();
    const t1 = (await host.site("RUH-114", "openOrAttach", openInput("c-a", "RUH"))) as {
      ticket: { id: string };
    };
    const t2 = (await host.site("RUH-115", "openOrAttach", openInput("c-b", "RUH"))) as {
      ticket: { id: string };
    };
    const r1 = (await host.region("riyadh-north", "reportSite", {
      siteId: "RUH-114",
      ticketId: t1.ticket.id,
      regionCode: "riyadh-north",
      trace_id: "t-1",
      at: T,
    })) as { declared: boolean; incident: unknown };
    expect(r1.declared).toBe(false);
    const r2 = (await host.region("riyadh-north", "reportSite", {
      siteId: "RUH-115",
      ticketId: t2.ticket.id,
      regionCode: "riyadh-north",
      trace_id: "t-2",
      at: T + 1000,
    })) as { declared: boolean; incident: { sites: Record<string, unknown> } };
    expect(r2.declared).toBe(true);
    expect(Object.keys(r2.incident.sites).sort()).toEqual(["RUH-114", "RUH-115"]);
    expect(storage.keys()).toContain("region/riyadh-north/incident");
  });
});

describe("MuxHost request validation", () => {
  it("rejects a method outside the allowlist", async () => {
    const { host } = makeHost();
    await expect(host.site("RUH-114", "nope")).rejects.toThrow("mux_bad_request");
    await expect(host.region("riyadh-north", "recordCall")).rejects.toThrow("mux_bad_request");
  });

  it("rejects a bad entity name", async () => {
    const { host } = makeHost();
    await expect(host.site("../evil", "ping")).rejects.toThrow("mux_bad_request");
    await expect(host.site("", "ping")).rejects.toThrow("mux_bad_request");
    await expect(host.region("a".repeat(65), "ping")).rejects.toThrow("mux_bad_request");
    await expect(host.site("has space", "ping")).rejects.toThrow("mux_bad_request");
  });
});
