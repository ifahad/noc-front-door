import { describe, expect, it } from "vitest";
import type { NocEdgeEnv } from "../../src/actors";
import { MUX_ACTOR_NAME, muxActorPort } from "../../src/services/muxActorPort";

interface MuxCall {
  kind: "site" | "region";
  name: string;
  method: string;
  input: unknown;
}

function muxEnv(): {
  env: NocEdgeEnv;
  idNames: string[];
  calls: MuxCall[];
} {
  const idNames: string[] = [];
  const calls: MuxCall[] = [];
  const stub = {
    site: async (name: string, method: string, input?: unknown) => {
      calls.push({ kind: "site", name, method, input });
      return { pong: true, name };
    },
    region: async (name: string, method: string, input?: unknown) => {
      calls.push({ kind: "region", name, method, input });
      return { incident: null };
    },
  };
  const env = {
    MUX: {
      idFromName: (name: string) => {
        idNames.push(name);
        return stub;
      },
    },
  } as unknown as NocEdgeEnv;
  return { env, idNames, calls };
}

describe("muxActorPort", () => {
  it("routes every site method through the demo instance as (name, method, input)", async () => {
    const { env, idNames, calls } = muxEnv();
    const port = muxActorPort(env);
    const input = {
      k: "c-a",
      trace_id: "t-1",
      callerRef: "none",
      symptom: "WAN link down",
      impact: "site_down" as const,
      serviceAffecting: true,
      priority: "P2" as const,
      at: 1000,
      siteCode: "RUH",
    };
    const out = await port.site("RUH-114").openOrAttach(input);
    expect(out).toEqual({ pong: true, name: "RUH-114" });
    expect(idNames).toEqual([MUX_ACTOR_NAME]);
    expect(calls).toEqual([
      { kind: "site", name: "RUH-114", method: "openOrAttach", input },
    ]);
  });

  it("passes through every SiteStateApi method without input where the API omits it", async () => {
    const { env, calls } = muxEnv();
    const port = muxActorPort(env);
    await port.site("RUH-114").getTicket();
    await port.site("RUH-114").ping();
    expect(calls).toEqual([
      { kind: "site", name: "RUH-114", method: "getTicket", input: undefined },
      { kind: "site", name: "RUH-114", method: "ping", input: undefined },
    ]);
  });

  it("routes openIfVerified through the demo instance", async () => {
    const { env, calls } = muxEnv();
    const port = muxActorPort(env);
    const input = {
      k: "c-a",
      trace_id: "t-3",
      callerRef: "none",
      symptom: "WAN link down",
      impact: "site_down" as const,
      serviceAffecting: true,
      priority: "P2" as const,
      at: 1500,
      siteCode: "RUH",
    };
    await port.site("RUH-114").openIfVerified(input);
    expect(calls).toEqual([
      { kind: "site", name: "RUH-114", method: "openIfVerified", input },
    ]);
  });

  it("routes every region method through the same demo instance", async () => {
    const { env, idNames, calls } = muxEnv();
    const port = muxActorPort(env);
    const input = {
      siteId: "RUH-114",
      ticketId: "NJD-1401",
      regionCode: "riyadh-north",
      trace_id: "t-2",
      at: 2000,
    };
    await port.region("riyadh-north").reportSite(input);
    await port.region("riyadh-north").ping();
    expect(idNames).toEqual([MUX_ACTOR_NAME]);
    expect(calls).toEqual([
      { kind: "region", name: "riyadh-north", method: "reportSite", input },
      { kind: "region", name: "riyadh-north", method: "ping", input: undefined },
    ]);
  });
});
