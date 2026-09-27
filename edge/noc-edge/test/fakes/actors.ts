import type { ActorContext, Env } from "@telnyx/edge-runtime";
import { RegionState } from "../../../noc-actors/src/RegionState";
import { SiteState } from "../../../noc-actors/src/SiteState";
import { FakeStorage } from "../../../noc-actors/test/fakes/storage";
import type {
  ActorPort,
  RegionStateApi,
  SiteStateApi,
} from "../../src/services/actorPort";

class FaultyRegionState extends RegionState {
  private failures: Error[] = [];

  failNextReport(count: number, message = "injected_actor_error"): void {
    for (let i = 0; i < count; i++) this.failures.push(new Error(message));
  }

  failNextGetIncident(count: number, message = "injected_actor_error"): void {
    for (let i = 0; i < count; i++) this.failures.push(new Error(message));
  }

  async reportSite(input: Parameters<RegionState["reportSite"]>[0]) {
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    return super.reportSite(input);
  }

  async getIncident(input: Parameters<RegionState["getIncident"]>[0] = {}) {
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    return super.getIncident(input);
  }
}

function ctxFor(storage: FakeStorage, name: string): ActorContext {
  return {
    id: name,
    storage: storage as unknown as ActorContext["storage"],
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
    setAlarm: (when: number) => storage.setAlarm(when),
    count: () => 0,
    broadcast: () => 0,
    sockets: () => [],
  };
}

export function makeSiteActor(name: string): SiteState {
  return new SiteState(ctxFor(new FakeStorage(), name), {} as Env);
}

export function makeRegionActor(name: string): RegionState {
  return new RegionState(ctxFor(new FakeStorage(), name), {} as Env);
}

export class FakeActorPort implements ActorPort {
  private sites = new Map<string, SiteState>();
  private regions = new Map<string, FaultyRegionState>();

  site(siteId: string): SiteStateApi {
    let actor = this.sites.get(siteId);
    if (actor === undefined) {
      actor = new SiteState(ctxFor(new FakeStorage(), siteId), {} as Env);
      this.sites.set(siteId, actor);
    }
    return actor;
  }

  region(region: string): RegionStateApi {
    let actor = this.regions.get(region);
    if (actor === undefined) {
      actor = new FaultyRegionState(ctxFor(new FakeStorage(), region), {} as Env);
      this.regions.set(region, actor);
    }
    return actor;
  }

  failNextReport(region: string, count: number): void {
    this.regionActor(region).failNextReport(count);
  }

  failNextGetIncident(region: string, count: number): void {
    this.regionActor(region).failNextGetIncident(count);
  }

  siteTicket(siteId: string) {
    return storageOf(this.siteActor(siteId)).raw("ticket") as
      | { regionReported: boolean; id: string }
      | null;
  }

  regionMembers(region: string) {
    return storageOf(this.regionActor(region)).raw("members") as
      | Record<string, unknown>
      | undefined;
  }

  private siteActor(siteId: string): SiteState {
    this.site(siteId);
    return this.sites.get(siteId) as SiteState;
  }

  private regionActor(region: string): FaultyRegionState {
    if (!this.regions.has(region)) this.region(region);
    return this.regions.get(region) as FaultyRegionState;
  }
}

function storageOf(actor: SiteState | RegionState): FakeStorage {
  return (actor as unknown as { ctx: { storage: FakeStorage } }).ctx.storage;
}
