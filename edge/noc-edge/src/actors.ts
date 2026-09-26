import type { ActorNamespace, ActorStub, IdFromNameOptions } from "@telnyx/edge-runtime";
import type { SiteActor } from "../../noc-actors/src/SiteActor";
import type { RegionActor } from "../../noc-actors/src/RegionActor";

export interface PingReply {
  pong: true;
  name: string;
}

export type SiteActorStub = ActorStub & Pick<SiteActor, "ping">;
export type RegionActorStub = ActorStub & Pick<RegionActor, "ping">;

export interface SitesBinding extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): SiteActorStub;
}

export interface RegionsBinding extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): RegionActorStub;
}

export interface NocEdgeEnv extends Env {
  SITES: SitesBinding;
  REGIONS: RegionsBinding;
}

export function siteStub(env: NocEdgeEnv, name: string): SiteActorStub {
  return env.SITES.idFromName(name) as SiteActorStub;
}

export function regionStub(env: NocEdgeEnv, name: string): RegionActorStub {
  return env.REGIONS.idFromName(name) as RegionActorStub;
}
