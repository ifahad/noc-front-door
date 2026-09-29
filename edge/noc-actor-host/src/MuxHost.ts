import { StatefulActor } from "@telnyx/edge-runtime";
import type { ActorContext, ActorStorage, Env } from "@telnyx/edge-runtime";
import { SiteState } from "../../noc-actors/src/SiteState";
import { RegionState } from "../../noc-actors/src/RegionState";
import { listInner, prefixedStorage } from "./prefixedStorage";

const NAME_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const SCHED_PREFIX = "sched/";
const ALARM_GRACE_MS = 1000;

export interface FanOutResult {
  fired: string[];
  failed: string[];
  next: number | null;
}

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
];

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
];

// The exported class name MUST stay "Counter": this host is the pre-existing
// noc-actor-canary function, and "Counter" is the only actor type on this
// trial account that the platform will serve (DEBUGLOG #4 — no NEW actor
// instance can be created, 503 actor directory unavailable). The stock
// increment/value surface is unchanged: the live instance holds value=45 and
// an external recovery watcher calls it. All muxed state lives under the
// "site/" and "region/" storage prefixes, so it can never collide with
// the unprefixed "value" key.
export class Counter extends StatefulActor {
  async increment(n: number): Promise<number> {
    const value = ((await this.ctx.storage.get<number>("value")) ?? 0) + n;
    await this.ctx.storage.put("value", value);
    return value;
  }

  async value(): Promise<number> {
    return (await this.ctx.storage.get<number>("value")) ?? 0;
  }

  async ping(): Promise<{ pong: true; name: string }> {
    return { pong: true, name: "mux" };
  }

  async site(name: string, method: string, input?: unknown): Promise<unknown> {
    return this.dispatch(SITE_METHODS, name, method, "site", input);
  }

  async region(name: string, method: string, input?: unknown): Promise<unknown> {
    return this.dispatch(REGION_METHODS, name, method, "region", input);
  }

  // The platform calls this when the single real alarm fires. It must never
  // throw: a throwing alarm handler is retried ~3x and then the host's only
  // alarm is lost. Entity errors are caught inside the fan-out; anything else
  // (e.g. a storage fault) is logged here and swallowed.
  async alarm(): Promise<void> {
    try {
      await this.fanOut(Date.now());
    } catch (err) {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          lvl: "error",
          svc: "noc-actor-host",
          hop: "mux",
          evt: "mux.alarm_fanout_failed",
          err: (err as Error)?.message ?? String(err),
        }),
      );
    }
  }

  // Fallback driver called over RPC every 30s by the external prober when
  // platform alarms do not fire on this account.
  async tick(now: number): Promise<FanOutResult> {
    if (typeof now !== "number" || !Number.isFinite(now)) {
      throw new Error("mux_bad_request");
    }
    return this.fanOut(now);
  }

  private async fanOut(now: number): Promise<FanOutResult> {
    const fired: string[] = [];
    const failed: string[] = [];
    const rows = await listInner<unknown>(this.ctx.storage as ActorStorage, SCHED_PREFIX);
    for (const [key, value] of rows) {
      const dueAt = value as number;
      if (typeof dueAt !== "number" || dueAt > now + ALARM_GRACE_MS) continue;
      const entity = key.slice(SCHED_PREFIX.length);
      // Delete the entry FIRST so a redelivered alarm cannot fire it twice.
      await this.ctx.storage.delete(key);
      const slash = entity.indexOf("/");
      const kind = entity.slice(0, slash);
      const name = entity.slice(slash + 1);
      const ctx = this.derivedCtx(name, kind);
      const actor = this.makeEntity(kind as "site" | "region", ctx);
      const alarmFn = (actor as Record<string, unknown>)["alarm"];
      if (typeof alarmFn !== "function") continue;
      try {
        await (alarmFn as () => Promise<void>).call(actor);
        fired.push(entity);
      } catch (err) {
        failed.push(entity);
        console.error(
          JSON.stringify({
            ts: new Date().toISOString(),
            lvl: "error",
            svc: "noc-actor-host",
            hop: "mux",
            evt: "mux.alarm_failed",
            entity,
            err: (err as Error)?.message ?? String(err),
          }),
        );
      }
    }
    const next = await this.reconcileAlarm();
    return { fired, failed, next };
  }

  // Re-arms the host's single real alarm to the earliest schedule entry, or
  // clears it when none remain. The entries live at sched/<kind>/<name>,
  // outside every entity prefix, so an entity deleteAll can never drop one.
  private async reconcileAlarm(): Promise<number | null> {
    const rows = await listInner<number>(this.ctx.storage as ActorStorage, SCHED_PREFIX);
    let min: number | null = null;
    for (const [, dueAt] of rows) {
      if (min === null || dueAt < min) min = dueAt;
    }
    if (min === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(min);
    return min;
  }

  // Tests subclass this to swap in fake entities; production builds the real
  // SiteState/RegionState over the derived context.
  protected makeEntity(kind: "site" | "region", ctx: ActorContext): object {
    return kind === "site" ? new SiteState(ctx, this.env) : new RegionState(ctx, this.env);
  }

  private async dispatch(
    allowed: readonly string[],
    name: string,
    method: string,
    kind: string,
    input: unknown,
  ): Promise<unknown> {
    if (!NAME_RE.test(name) || !allowed.includes(method)) {
      throw new Error("mux_bad_request");
    }
    const ctx = this.derivedCtx(name, kind);
    const actor = this.makeEntity(kind as "site" | "region", ctx);
    const fn = (actor as Record<string, (i: unknown) => Promise<unknown>>)[method];
    return fn.call(actor, input);
  }

  private derivedCtx(name: string, kind: string): ActorContext {
    const storage = prefixedStorage(this.ctx.storage as ActorStorage, kind + "/" + name + "/", {
      key: SCHED_PREFIX + kind + "/" + name,
      reconcile: async () => {
        await this.reconcileAlarm();
      },
    });
    return {
      id: name,
      // prefixed storage implements only get/put/delete/list/deleteAll/alarms; transaction/sql are unsupported in mux mode
      storage: storage as unknown as ActorStorage,
      blockConcurrencyWhile: <T,>(fn: () => Promise<T>) => this.ctx.blockConcurrencyWhile(fn),
      // Delegates to the prefixed storage, which writes sched/<kind>/<name>
      // and re-arms the host's single real alarm.
      setAlarm: (when: number) => storage.setAlarm(when),
      count: () => 0,
      broadcast: () => 0,
      sockets: () => [],
    };
  }
}
