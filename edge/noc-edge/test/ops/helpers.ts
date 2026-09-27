import { SeedAdapter } from "../../../shared/src/itsm";
import type { Session } from "../../../shared/src/types";
import type { NocEdgeEnv } from "../../src/actors";
import type { Flags } from "../../src/services/flags";
import { FakeActorPort } from "../fakes/actors";
import { FakeKv } from "../fakes/kv";
import { makeRegionActor, makeSiteActor } from "../fakes/actors";

export const OPS_TOKEN = ["op", "s_be", "arer_", "t0k", "en_11"].join("");

export const T0 = Date.UTC(2026, 8, 26, 6, 0, 0);
export const PEPPER = ["p", "e", "pp", "er"].join("");

export const FLAGS_CLEAR: Flags = {
  deflection_enabled: true,
  require_pin: false,
  demo_caller: null,
  fault_open_ticket: null,
  fault_dv_delay_ms: null,
  actor_mode: "per-entity",
};

export function syntheticSession(siteId: string, kSeed: string): Session {
  return {
    k: kSeed,
    trace_id: `t-${kSeed}`,
    identified: true,
    verified: true,
    contact_id: null,
    customer_id: "c-lab",
    sites: [siteId],
    region: "lab",
  };
}

export interface OpsDepsBundle {
  kv: FakeKv;
  actors: FakeActorPort;
  adapter: SeedAdapter;
  actorsOpts?: { serialise?: boolean };
}

export function makeOpsDeps(opts: OpsDepsBundle["actorsOpts"] = {}): OpsDepsBundle {
  const actors = new FakeActorPort(opts);
  const kv = new FakeKv();
  const adapter = new SeedAdapter({
    seedLocal: { pins: {}, contacts: [] },
    pepper: PEPPER,
    now: () => T0,
  });
  return { kv, actors, adapter };
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}

export interface RouterEnvBundle {
  env: NocEdgeEnv;
  kv: FakeKv;
  actors: FakeActorPort;
}

export function makeRouterEnv(opsToken: string | null): RouterEnvBundle {
  const kv = new FakeKv();
  const actors = new FakeActorPort();
  const sites = new Map<string, ReturnType<typeof makeSiteActor>>();
  const regions = new Map<string, ReturnType<typeof makeRegionActor>>();
  const env = {
    CACHE: {
      get: (key: string) => kv.get(key),
      put: (key: string, value: string, opts?: { expirationTtl?: number }) =>
        kv.put(key, value, opts),
      delete: (key: string) => kv.delete(key),
      list: async (opts?: { prefix?: string }) => ({
        keys: (await kv.list(opts?.prefix ?? "")).map((name) => ({ name })),
        list_complete: true,
      }),
    },
    SITES: {
      idFromName: (name: string) => {
        let actor = sites.get(name);
        if (actor === undefined) {
          actor = makeSiteActor(name);
          sites.set(name, actor);
        }
        return actor;
      },
    },
    REGIONS: {
      idFromName: (name: string) => {
        let actor = regions.get(name);
        if (actor === undefined) {
          actor = makeRegionActor(name);
          regions.set(name, actor);
        }
        return actor;
      },
    },
    SECRETS: {
      get: async (name: string) => {
        if (name === "OPS_TOKEN") return opsToken;
        if (name === "PIN_PEPPER") return PEPPER;
        if (name === "SEED_LOCAL") return JSON.stringify({ pins: {}, contacts: [] });
        return null;
      },
    },
  } as unknown as NocEdgeEnv;
  return { env, kv, actors };
}

export async function openSiteTicket(
  actors: FakeActorPort,
  siteId: string,
  siteCode: string,
  k: string,
  at: number,
): Promise<string> {
  const opened = await actors.site(siteId).openOrAttach({
    k,
    trace_id: `t-${k}`,
    callerRef: "none",
    symptom: "WAN link down",
    impact: "site_down",
    serviceAffecting: true,
    priority: "P2",
    at,
    siteCode,
  });
  return opened.ticket.id;
}

export async function recordSiteCall(
  actors: FakeActorPort,
  siteId: string,
  k: string,
  trace_id: string,
  at: number,
): Promise<void> {
  await actors.site(siteId).recordCall({ k, trace_id, at });
}
