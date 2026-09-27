import type { ActorPort, RegionStateApi, SiteStateApi } from "../../src/services/actorPort";
import type { KvPort } from "../../src/services/kvPort";
import type { FakeActorPort } from "./actors";
import type { FakeKv } from "./kv";

export const SLOW_KV_MS = 1000;
export const SLOW_ACTOR_MS = 200;

function sleep(ms: number, timerMs = ms): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timerMs);
    if (typeof t === "object" && t !== null && "unref" in t && typeof t.unref === "function") {
      t.unref();
    }
  });
}

export class SlowKv implements KvPort {
  constructor(
    private readonly inner: FakeKv,
    private readonly delayMs: number = SLOW_KV_MS,
  ) {}

  private async delay(): Promise<void> {
    await sleep(this.delayMs);
  }

  async get(key: string): Promise<string | null> {
    await this.delay();
    return this.inner.get(key);
  }

  async put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ): Promise<void> {
    await this.delay();
    return this.inner.put(key, value, opts);
  }

  async delete(key: string): Promise<void> {
    await this.delay();
    return this.inner.delete(key);
  }

  async list(prefixOrOpts: string | { prefix?: string }): Promise<string[]> {
    await this.delay();
    return this.inner.list(prefixOrOpts);
  }

  has(key: string): boolean {
    return this.inner.has(key);
  }

  raw(key: string): string | null {
    return this.inner.raw(key);
  }

  puts(key: string): number {
    return this.inner.puts(key);
  }

  setNow(nowMs: number): void {
    this.inner.setNow(nowMs);
  }
}

type SiteMethod = keyof SiteStateApi;
type RegionMethod = keyof RegionStateApi;

const SITE_METHODS: SiteMethod[] = [
  "ping",
  "recordCall",
  "recordPinAttempt",
  "openOrAttach",
  "markRegionReported",
  "getTicket",
  "getRecents",
  "addNote",
  "resolveTicket",
  "reset",
];

const REGION_METHODS: RegionMethod[] = [
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
];

function slowWrap<T extends object>(api: T, methodNames: readonly string[], delayMs: number): T {
  const out: Record<string, unknown> = {};
  for (const name of methodNames) {
    const fn = (api as Record<string, unknown>)[name];
    if (typeof fn !== "function") {
      throw new Error(`slow_wrap_missing_method:${String(name)}`);
    }
    const bound = (fn as (...a: unknown[]) => Promise<unknown>).bind(api);
    out[name] = async (...args: unknown[]) => {
      await sleep(delayMs);
      return bound(...args);
    };
  }
  return out as unknown as T;
}

export class SlowActorPort implements ActorPort {
  private sites = new Map<string, SiteStateApi>();
  private regions = new Map<string, RegionStateApi>();

  constructor(
    private readonly inner: FakeActorPort,
    private readonly delayMs: number = SLOW_ACTOR_MS,
  ) {}

  site(siteId: string): SiteStateApi {
    let wrapped = this.sites.get(siteId);
    if (wrapped === undefined) {
      wrapped = slowWrap(this.inner.site(siteId), SITE_METHODS, this.delayMs);
      this.sites.set(siteId, wrapped);
    }
    return wrapped;
  }

  region(region: string): RegionStateApi {
    let wrapped = this.regions.get(region);
    if (wrapped === undefined) {
      wrapped = slowWrap(this.inner.region(region), REGION_METHODS, this.delayMs);
      this.regions.set(region, wrapped);
    }
    return wrapped;
  }
}
