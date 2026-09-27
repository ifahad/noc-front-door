import type { ActorContext, Env } from "@telnyx/edge-runtime";
import { RegionState } from "../../../noc-actors/src/RegionState";
import { SiteState } from "../../../noc-actors/src/SiteState";
import { FakeStorage } from "../../../noc-actors/test/fakes/storage";
import type {
  ActorPort,
  RegionStateApi,
  SiteStateApi,
} from "../../src/services/actorPort";

class FaultySiteState extends SiteState {
  private failures: Error[] = [];

  failNextGetTicket(count: number, message = "injected_actor_error"): void {
    for (let i = 0; i < count; i++) this.failures.push(new Error(message));
  }

  failNextGetRecents(count: number, message = "injected_actor_error"): void {
    for (let i = 0; i < count; i++) this.failures.push(new Error(message));
  }

  async getTicket(input: Parameters<SiteState["getTicket"]>[0] = {}) {
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    return super.getTicket(input);
  }

  async getRecents(input: Parameters<SiteState["getRecents"]>[0] = {}) {
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    return super.getRecents(input);
  }
}

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

const SITE_METHODS = [
  "recordCall",
  "recordPinAttempt",
  "openOrAttach",
  "markRegionReported",
  "getTicket",
  "getRecents",
  "addNote",
  "resolveTicket",
  "reset",
] as const;

const REGION_METHODS = [
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

function serialise<T extends object>(api: T, methodNames: readonly string[]): T {
  const out: Record<string, unknown> = {};
  let tail: Promise<unknown> = Promise.resolve();
  for (const name of methodNames) {
    const fn = (api as Record<string, unknown>)[name];
    if (typeof fn !== "function") {
      throw new Error(`serialise_missing_method:${name}`);
    }
    const bound = (fn as (...a: unknown[]) => Promise<unknown>).bind(api);
    out[name] = (...args: unknown[]) => {
      const run = (tail as Promise<unknown>).then(
        () => bound(...args),
        () => bound(...args),
      );
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };
  }
  return out as T;
}

export function makeSiteActor(name: string): SiteState {
  return new SiteState(ctxFor(new FakeStorage(), name), {} as Env);
}

export function makeRegionActor(name: string): RegionState {
  return new RegionState(ctxFor(new FakeStorage(), name), {} as Env);
}

export interface FakeActorPortOpts {
  serialise?: boolean;
}

export class FakeActorPort implements ActorPort {
  private sites = new Map<string, FaultySiteState>();
  private regions = new Map<string, FaultyRegionState>();
  private opts: FakeActorPortOpts;

  constructor(opts: FakeActorPortOpts = {}) {
    this.opts = opts;
  }

  site(siteId: string): SiteStateApi {
    let actor = this.sites.get(siteId);
    if (actor === undefined) {
      actor = new FaultySiteState(ctxFor(new FakeStorage(), siteId), {} as Env);
      this.sites.set(siteId, actor);
    }
    const api = actor as unknown as SiteStateApi;
    return this.opts.serialise === true ? serialise(api, SITE_METHODS) : api;
  }

  region(region: string): RegionStateApi {
    let actor = this.regions.get(region);
    if (actor === undefined) {
      actor = new FaultyRegionState(ctxFor(new FakeStorage(), region), {} as Env);
      this.regions.set(region, actor);
    }
    const api = actor as unknown as RegionStateApi;
    return this.opts.serialise === true ? serialise(api, REGION_METHODS) : api;
  }

  failNextReport(region: string, count: number): void {
    this.regionActor(region).failNextReport(count);
  }

  failNextGetIncident(region: string, count: number): void {
    this.regionActor(region).failNextGetIncident(count);
  }

  failNextGetTicket(site: string, count: number): void {
    this.siteActor(site).failNextGetTicket(count);
  }

  failNextGetRecents(site: string, count: number): void {
    this.siteActor(site).failNextGetRecents(count);
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

  private siteActor(siteId: string): FaultySiteState {
    this.site(siteId);
    return this.sites.get(siteId) as FaultySiteState;
  }

  private regionActor(region: string): FaultyRegionState {
    if (!this.regions.has(region)) this.region(region);
    return this.regions.get(region) as FaultyRegionState;
  }
}

export function storageOf(actor: SiteState | RegionState): FakeStorage {
  return (actor as unknown as { ctx: { storage: FakeStorage } }).ctx.storage;
}
