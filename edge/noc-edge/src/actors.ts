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

export interface NocEdgeEnv extends Env {
  SITES: SitesBinding;
  REGIONS: RegionsBinding;
}

export function siteStub(env: NocEdgeEnv, name: string): SiteStateStub {
  return env.SITES.idFromName(name) as SiteStateStub;
}

export function regionStub(env: NocEdgeEnv, name: string): RegionStateStub {
  return env.REGIONS.idFromName(name) as RegionStateStub;
}
