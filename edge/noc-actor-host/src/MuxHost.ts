import { StatefulActor } from "@telnyx/edge-runtime";
import type { ActorContext, ActorStorage, Env } from "@telnyx/edge-runtime";
import { SiteState } from "../../noc-actors/src/SiteState";
import { RegionState } from "../../noc-actors/src/RegionState";
import { prefixedStorage } from "./prefixedStorage";

const NAME_RE = /^[A-Za-z0-9._:-]{1,64}$/;

const SITE_METHODS = [
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

const REGION_METHODS = [
  "ping",
  "reportSite",
  "withdrawSite",
  "getIncident",
  "resolve",
  "ack",
  "reset",
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
    return this.dispatch(SITE_METHODS, name, method, "site/", input);
  }

  async region(name: string, method: string, input?: unknown): Promise<unknown> {
    return this.dispatch(REGION_METHODS, name, method, "region/", input);
  }

  private async dispatch(
    allowed: readonly string[],
    name: string,
    method: string,
    kindPrefix: string,
    input: unknown,
  ): Promise<unknown> {
    if (!NAME_RE.test(name) || !allowed.includes(method)) {
      throw new Error("mux_bad_request");
    }
    const ctx = this.derivedCtx(name, kindPrefix);
    const actor: object =
      kindPrefix === "site/" ? new SiteState(ctx, this.env) : new RegionState(ctx, this.env);
    const fn = (actor as Record<string, (i: unknown) => Promise<unknown>>)[method];
    return fn.call(actor, input);
  }

  private derivedCtx(name: string, kindPrefix: string): ActorContext {
    const storage = prefixedStorage(this.ctx.storage as ActorStorage, kindPrefix + name + "/");
    return {
      id: name,
      // prefixed storage implements only get/put/delete/list/deleteAll/alarms; transaction/sql are unsupported in mux mode
      storage: storage as unknown as ActorStorage,
      blockConcurrencyWhile: <T,>(fn: () => Promise<T>) => this.ctx.blockConcurrencyWhile(fn),
      // Alarms are Plan 2 and unsupported in mux mode: the derived context
      // never schedules one, so setAlarm is a no-op and getAlarm reports null.
      setAlarm: async () => {},
      count: () => 0,
      broadcast: () => 0,
      sockets: () => [],
    };
  }
}
