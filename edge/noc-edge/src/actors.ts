import type { ActorNamespace, ActorStub, IdFromNameOptions } from "@telnyx/edge-runtime";
import type { SiteState } from "../../noc-actors/src/SiteState";
import type { RegionState } from "../../noc-actors/src/RegionState";

export interface PingReply {
  pong: true;
  name: string;
}

export type SiteStateStub = ActorStub & Pick<SiteState, "ping">;
export type RegionStateStub = ActorStub & Pick<RegionState, "ping">;

export interface SitesBinding extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): SiteStateStub;
}

export interface RegionsBinding extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): RegionStateStub;
}

// The MUX binding is a reference to the one working actor type on this trial
// account (Counter on noc-actor-canary, DEBUGLOG #4). The mux port multiplexes
// real SiteState/RegionState logic through that single instance.
export interface MuxStub extends ActorStub {
  site(name: string, method: string, input?: unknown): Promise<unknown>;
  region(name: string, method: string, input?: unknown): Promise<unknown>;
}

export interface MuxBinding extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): MuxStub;
}

export interface NocEdgeEnv extends Env {
  SITES: SitesBinding;
  REGIONS: RegionsBinding;
  MUX: MuxBinding;
}

export function siteStub(env: NocEdgeEnv, name: string): SiteStateStub {
  return env.SITES.idFromName(name) as SiteStateStub;
}

export function regionStub(env: NocEdgeEnv, name: string): RegionStateStub {
  return env.REGIONS.idFromName(name) as RegionStateStub;
}
