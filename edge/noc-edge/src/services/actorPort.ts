import type { RegionState } from "../../../noc-actors/src/RegionState";
import type { SiteState } from "../../../noc-actors/src/SiteState";
import { regionStub, siteStub, type NocEdgeEnv } from "../actors";

export type { ReportSiteInput, ReportSiteResult } from "../../../noc-actors/src/RegionState";

export type SiteStateApi = Pick<
  SiteState,
  | "ping"
  | "recordCall"
  | "recordPinAttempt"
  | "openOrAttach"
  | "markRegionReported"
  | "getTicket"
  | "getRecents"
  | "addNote"
  | "resolveTicket"
  | "reset"
>;

export type RegionStateApi = Pick<
  RegionState,
  | "ping"
  | "reportSite"
  | "withdrawSite"
  | "getIncident"
  | "resolve"
  | "ack"
  | "reset"
  | "tick"
  | "claimPage"
  | "markPageSent"
  | "getPages"
>;

export interface ActorPort {
  site(siteId: string): SiteStateApi;
  region(region: string): RegionStateApi;
}

export function bindingActorPort(env: NocEdgeEnv): ActorPort {
  return {
    site: (siteId: string) => siteStub(env, siteId) as unknown as SiteStateApi,
    region: (region: string) =>
      regionStub(env, region) as unknown as RegionStateApi,
  };
}
