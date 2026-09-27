import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActorContext, ActorStorage, Env, ListOptions } from "@telnyx/edge-runtime";
import { FakeStorage } from "../../noc-actors/test/fakes/storage";
import { Counter } from "../src/MuxHost";
import { prefixedStorage } from "../src/prefixedStorage";

const T = Date.UTC(2026, 8, 27, 9, 0, 0);

interface FakeSpec {
  due?: number;
  cancelOnPing?: boolean;
  throwOnAlarm?: string;
  rearmOnAlarm?: number;
  wipeOnReset?: boolean;
}

class TestCounter extends Counter {
  private specs = new Map<string, (ctx: ActorContext) => object>();

  register(kind: "site" | "region", name: string, spec: FakeSpec, fired: string[]): void {
    this.specs.set(kind + "/" + name, (ctx) => ({
      async ping() {
        const current = await ctx.storage.getAlarm();
        if (spec.cancelOnPing && current !== null) await ctx.storage.deleteAlarm();
        else if (spec.due !== undefined) await ctx.setAlarm(spec.due);
        return { pong: true, name: ctx.id };
      },
      async alarm() {
        if (spec.throwOnAlarm) throw new Error(spec.throwOnAlarm);
        if (spec.rearmOnAlarm !== undefined) await ctx.setAlarm(spec.rearmOnAlarm);
        fired.push(kind + "/" + ctx.id);
      },
      async reset() {
        if (spec.wipeOnReset) {
          await ctx.storage.deleteAll();
          await ctx.storage.put("seq", 1);
        }
        return { ok: true, seq: 1, trace_id: "none", actor_ms: 0 };
      },
    }));
  }

  protected makeEntity(kind: "site" | "region", ctx: ActorContext): object {
    const spec = this.specs.get(kind + "/" + ctx.id);
    if (!spec) throw new Error("mux_no_fake_entity:" + kind + "/" + ctx.id);
    return spec(ctx);
  }
}

function makeHost(): { host: TestCounter; storage: FakeStorage } {
  const storage = new FakeStorage();
  const ctx: ActorContext = {
    id: "demo",
    storage: storage as unknown as ActorContext["storage"],
    blockConcurrencyWhile: <T2,>(fn: () => Promise<T2>) => fn(),
    setAlarm: (when: number) => storage.setAlarm(when),
    count: () => 0,
    broadcast: () => 0,
    sockets: () => [],
  };
  return { host: new TestCounter(ctx, {} as Env), storage };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prefixedStorage entity alarms", () => {
  it("setAlarm writes the schedule key outside the prefix and calls reconcile", async () => {
    const raw = new FakeStorage();
    let reconciles = 0;
    const ps = prefixedStorage(raw as unknown as ActorStorage, "site/RUH-114/", {
      key: "sched/site/RUH-114",
      reconcile: async () => {
        reconciles += 1;
      },
    });
    await ps.setAlarm(T + 1000);
    expect(reconciles).toBe(1);
    expect(raw.raw("sched/site/RUH-114")).toBe(T + 1000);
    expect(await ps.getAlarm()).toBe(T + 1000);
  });

  it("deleteAlarm removes the schedule key and calls reconcile", async () => {
    const raw = new FakeStorage();
    let reconciles = 0;
    const ps = prefixedStorage(raw as unknown as ActorStorage, "site/RUH-114/", {
      key: "sched/site/RUH-114",
      reconcile: async () => {
        reconciles += 1;
      },
    });
    await ps.setAlarm(T + 1000);
    await ps.deleteAlarm();
    expect(reconciles).toBe(2);
    expect(raw.raw("sched/site/RUH-114")).toBeUndefined();
    expect(await ps.getAlarm()).toBeNull();
  });

  it("deleteAll leaves the schedule entry alone", async () => {
    const raw = new FakeStorage();
    const ps = prefixedStorage(raw as unknown as ActorStorage, "site/RUH-114/", {
      key: "sched/site/RUH-114",
      reconcile: async () => {},
    });
    await ps.put("ticket", { id: "NJD-1" });
    await ps.setAlarm(T + 1000);
    await ps.deleteAll();
    expect(raw.raw("sched/site/RUH-114")).toBe(T + 1000);
    expect(raw.raw("site/RUH-114/ticket")).toBeUndefined();
    expect(await ps.getAlarm()).toBe(T + 1000);
  });
});

describe("MuxHost alarm scheduling", () => {
  it("arms the host alarm to the earliest dueAt and fires only the due entity", async () => {
    const { host, storage } = makeHost();
    const fired: string[] = [];
    host.register("site", "RUH-114", { due: T + 5000 }, fired);
    host.register("site", "RUH-115", { due: T + 9000 }, fired);
    await host.site("RUH-114", "ping");
    await host.site("RUH-115", "ping");
    expect(await storage.getAlarm()).toBe(T + 5000);
    expect(storage.raw("sched/site/RUH-114")).toBe(T + 5000);
    expect(storage.raw("sched/site/RUH-115")).toBe(T + 9000);

    const res = await host.tick(T + 5000);
    expect(fired).toEqual(["site/RUH-114"]);
    expect(res).toEqual({ fired: ["site/RUH-114"], failed: [], next: T + 9000 });
    expect(await storage.getAlarm()).toBe(T + 9000);
    expect(storage.raw("sched/site/RUH-114")).toBeUndefined();
    expect(storage.raw("sched/site/RUH-115")).toBe(T + 9000);
  });

  it("a throwing entity does not stop the others and the host still re-arms", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { host, storage } = makeHost();
    const fired: string[] = [];
    host.register("site", "RUH-114", { due: T + 5000, throwOnAlarm: "boom" }, fired);
    host.register("site", "RUH-115", { due: T + 5000 }, fired);
    host.register("region", "riyadh-north", { due: T + 60000 }, fired);
    await host.site("RUH-114", "ping");
    await host.site("RUH-115", "ping");
    await host.region("riyadh-north", "ping");

    const res = await host.tick(T + 5000);
    expect(fired).toEqual(["site/RUH-115"]);
    expect(res.fired).toEqual(["site/RUH-115"]);
    expect(res.failed).toEqual(["site/RUH-114"]);
    expect(res.next).toBe(T + 60000);
    expect(await storage.getAlarm()).toBe(T + 60000);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(errSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect(line).toMatchObject({
      lvl: "error",
      svc: "noc-actor-host",
      hop: "mux",
      evt: "mux.alarm_failed",
      entity: "site/RUH-114",
      err: "boom",
    });
  });

  it("duplicate alarm delivery fires each entity once", async () => {
    const { host, storage } = makeHost();
    const fired: string[] = [];
    const due = Date.now() - 1000;
    host.register("site", "RUH-114", { due }, fired);
    host.register("region", "riyadh-north", { due }, fired);
    await host.site("RUH-114", "ping");
    await host.region("riyadh-north", "ping");

    await host.alarm();
    await host.alarm();
    expect(fired.sort()).toEqual(["region/riyadh-north", "site/RUH-114"]);
    expect(await storage.getAlarm()).toBeNull();
    expect(storage.keys().filter((k) => k.startsWith("sched/"))).toEqual([]);
  });

  it("deleteAlarm re-arms to the next minimum and clears the host alarm when empty", async () => {
    const { host, storage } = makeHost();
    const fired: string[] = [];
    host.register("site", "RUH-114", { due: T + 5000, cancelOnPing: true }, fired);
    host.register("site", "RUH-115", { due: T + 9000, cancelOnPing: true }, fired);
    await host.site("RUH-114", "ping");
    await host.site("RUH-115", "ping");
    expect(await storage.getAlarm()).toBe(T + 5000);

    await host.site("RUH-114", "ping");
    expect(await storage.getAlarm()).toBe(T + 9000);
    expect(storage.raw("sched/site/RUH-114")).toBeUndefined();
    expect(storage.raw("sched/site/RUH-115")).toBe(T + 9000);

    await host.site("RUH-115", "ping");
    expect(await storage.getAlarm()).toBeNull();
    expect(storage.keys().filter((k) => k.startsWith("sched/"))).toEqual([]);
  });

  it("an entity that re-arms inside its alarm gets its new time scheduled", async () => {
    const { host, storage } = makeHost();
    const fired: string[] = [];
    host.register("site", "RUH-114", { due: T + 5000, rearmOnAlarm: T + 50000 }, fired);
    await host.site("RUH-114", "ping");

    const res = await host.tick(T + 5000);
    expect(fired).toEqual(["site/RUH-114"]);
    expect(res).toEqual({ fired: ["site/RUH-114"], failed: [], next: T + 50000 });
    expect(storage.raw("sched/site/RUH-114")).toBe(T + 50000);
    expect(await storage.getAlarm()).toBe(T + 50000);
  });

  it("tick validates now and behaves like the alarm fan-out", async () => {
    const { host, storage } = makeHost();
    const fired: string[] = [];
    host.register("site", "RUH-114", { due: T + 5000 }, fired);
    host.register("region", "riyadh-north", { due: T + 50000 }, fired);
    await host.site("RUH-114", "ping");
    await host.region("riyadh-north", "ping");

    await expect(host.tick("x" as unknown as number)).rejects.toThrow("mux_bad_request");
    await expect(host.tick(Number.NaN)).rejects.toThrow("mux_bad_request");
    expect(fired).toEqual([]);
    expect(await storage.getAlarm()).toBe(T + 5000);

    const first = await host.tick(T + 5000);
    expect(first.fired).toEqual(["site/RUH-114"]);
    const second = await host.tick(T + 50000);
    expect(second.fired).toEqual(["region/riyadh-north"]);
    expect(second.next).toBeNull();
    expect(await storage.getAlarm()).toBeNull();
  });

  it("an entity deleteAll does not remove its schedule entry", async () => {
    const { host, storage } = makeHost();
    const fired: string[] = [];
    host.register("site", "RUH-114", { due: T + 5000, wipeOnReset: true }, fired);
    await host.site("RUH-114", "ping");
    expect(await storage.getAlarm()).toBe(T + 5000);

    await host.site("RUH-114", "reset");
    expect(storage.raw("sched/site/RUH-114")).toBe(T + 5000);
    expect(await storage.getAlarm()).toBe(T + 5000);
    expect(storage.keys().filter((k) => k.startsWith("site/RUH-114/")).length).toBeGreaterThan(0);
  });
});

describe("MuxHost alarm pagination and alarm() resilience", () => {
  class PagedStorage {
    failList = false;
    constructor(private inner: FakeStorage) {}
    get<T>(key: string): Promise<T | undefined> {
      return this.inner.get<T>(key);
    }
    async put<T>(key: string, value: T): Promise<void> {
      await this.inner.put(key, value);
    }
    async delete(key: string): Promise<boolean> {
      return this.inner.delete(key);
    }
    async getAlarm(): Promise<number | null> {
      return this.inner.getAlarm();
    }
    async setAlarm(when: number): Promise<void> {
      await this.inner.setAlarm(when);
    }
    async deleteAlarm(): Promise<void> {
      await this.inner.deleteAlarm();
    }
    async deleteAll(): Promise<void> {
      await this.inner.deleteAll();
    }
    raw(key: string): unknown {
      return this.inner.raw(key);
    }
    keys(): string[] {
      return this.inner.keys();
    }
    async list<T>(options?: ListOptions): Promise<Map<string, T>> {
      if (this.failList) throw new Error("kv_down");
      const full = await this.inner.list<T>(options);
      if (options?.limit === undefined) {
        const capped = new Map<string, T>();
        let i = 0;
        for (const [k, v] of full) {
          if (i++ >= 128) break;
          capped.set(k, v);
        }
        return capped;
      }
      return full;
    }
  }

  function makePagedHost(): { host: TestCounter; storage: FakeStorage; paged: PagedStorage } {
    const storage = new FakeStorage();
    const paged = new PagedStorage(storage);
    const ctx: ActorContext = {
      id: "demo",
      storage: paged as unknown as ActorContext["storage"],
      blockConcurrencyWhile: <T2,>(fn: () => Promise<T2>) => fn(),
      setAlarm: (when: number) => storage.setAlarm(when),
      count: () => 0,
      broadcast: () => 0,
      sockets: () => [],
    };
    return { host: new TestCounter(ctx, {} as Env), storage, paged };
  }

  const pad = (n: number) => "e-" + String(n).padStart(3, "0");

  it("fires every scheduled entity past the first 128-entry list page", async () => {
    const { host, storage } = makePagedHost();
    const fired: string[] = [];
    for (let i = 0; i < 130; i++) host.register("site", pad(i), { due: T - 100 }, fired);
    for (let i = 0; i < 130; i++) await host.site(pad(i), "ping");

    const res = await host.tick(T);
    expect(res.fired.length).toBe(130);
    expect(new Set(res.fired).size).toBe(130);
    expect(res.failed).toEqual([]);
    expect(res.next).toBeNull();
    expect(await storage.getAlarm()).toBeNull();
    expect(storage.keys().filter((k) => k.startsWith("sched/"))).toEqual([]);
  });

  it("reconciles the host alarm to the true minimum across pages", async () => {
    const { host, storage } = makePagedHost();
    const fired: string[] = [];
    for (let i = 0; i < 129; i++) host.register("site", pad(i), { due: T - 100 }, fired);
    host.register("site", pad(129), { due: T + 60000 }, fired);
    for (let i = 0; i < 130; i++) await host.site(pad(i), "ping");

    const res = await host.tick(T);
    expect(res.fired.length).toBe(129);
    expect(res.fired).not.toContain("site/" + pad(129));
    expect(res.next).toBe(T + 60000);
    expect(await storage.getAlarm()).toBe(T + 60000);
    expect(storage.raw("sched/site/" + pad(129))).toBe(T + 60000);
  });

  it("alarm() resolves even when the storage listing fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { host, storage, paged } = makePagedHost();
    const fired: string[] = [];
    host.register("site", "RUH-114", { due: T - 100 }, fired);
    await host.site("RUH-114", "ping");
    expect(await storage.getAlarm()).toBe(T - 100);
    paged.failList = true;

    await expect(host.alarm()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(errSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect(line).toMatchObject({
      lvl: "error",
      svc: "noc-actor-host",
      hop: "mux",
      evt: "mux.alarm_fanout_failed",
      err: "kv_down",
    });
    expect(await storage.getAlarm()).toBe(T - 100);
  });
});
