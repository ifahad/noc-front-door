import type { MuxStub, NocEdgeEnv } from "../actors";
import type { ActorPort, RegionStateApi, SiteStateApi } from "./actorPort";

export const MUX_ACTOR_NAME = "demo";

const SITE_METHODS = [
  "ping",
  "recordCall",
  "recordPinAttempt",
  "openOrAttach",
  "openIfVerified",
  "markRegionReported",
  "getTicket",
  "getRecents",
  "addNote",
  "resolveTicket",
  "reset",
] as const;

const REGION_METHODS = [
  "ping",
  "reportSite",
  "withdrawSite",
  "getIncident",
  "resolve",
  "ack",
  "reset",
  "tick",
  "claimPage",
  "markPageSent",
  "getPages",
] as const;

function muxApi<API>(
  stub: MuxStub,
  kind: "site" | "region",
  entity: string,
  methods: readonly string[],
): API {
  const out: Record<string, (input?: unknown) => Promise<unknown>> = {};
  for (const method of methods) {
    out[method] = (input?: unknown) =>
      kind === "site" ? stub.site(entity, method, input) : stub.region(entity, method, input);
  }
  return out as API;
}

export function muxActorPort(env: NocEdgeEnv): ActorPort {
  const stub = env.MUX.idFromName(MUX_ACTOR_NAME);
  return {
    site: (name: string) =>
      muxApi<SiteStateApi>(stub, "site", name, SITE_METHODS),
    region: (region: string) =>
      muxApi<RegionStateApi>(stub, "region", region, REGION_METHODS),
  };
}
