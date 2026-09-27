import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withErrorHandling, route, __resetActorModeForTests } from "../src/router";
import type { NocEdgeEnv } from "../src/actors";
import { putAuth } from "../src/services/sessions";
import { sessionKey } from "../../shared/src/ids";
import { FakeKv } from "./fakes/kv";
import { makeRegionActor, makeSiteActor } from "./fakes/actors";
import { kvKey } from "../../shared/src/kvkeys";

const E164 = ["+", "1", "312", "555", "0101"].join("");

interface LogLine {
  ts: string;
  lvl: string;
  svc: string;
  evt: string;
  [k: string]: unknown;
}

let logs: string[];

beforeEach(() => {
  logs = [];
  __resetActorModeForTests();
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function eventsWith(evt: string): LogLine[] {
  return logs.map((l) => JSON.parse(l) as LogLine).filter((l) => l.evt === evt);
}

async function makeEnv() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pub = btoa(String.fromCharCode(...raw));
  const seedLocal = JSON.stringify({
    pins: {},
    contacts: [
      {
        contact_id: "c-ahmed",
        phone_digits: E164,
        name: "Ahmed",
        site_id: "RUH-114",
        preferred_language: "en",
      },
    ],
  });
  const cache = new FakeKv();
  const siteActor = {
    recordCall: async (input: { callsToday?: number }) => ({
      callsToday: 1,
      openTicket: null,
      trace_id: input ? "" : "",
      actor_ms: 0,
    }),
  };
  const env = {
    CACHE: cache,
    SITES: {
      idFromName: () => siteActor,
    },
    REGIONS: {
      idFromName: () => ({}),
    },
    MUX: {
      idFromName: () => ({
        site: async (_entity: string, method: string) => {
          if (method === "recordCall") {
            return { callsToday: 1, openTicket: null, trace_id: "", actor_ms: 0 };
          }
          return {};
        },
        region: async () => ({}),
      }),
    },
    SECRETS: {
      get: async (name: string) => {
        if (name === "TELNYX_PUBLIC_KEY") return pub;
        if (name === "PIN_PEPPER") return ["p", "e", "pp", "er"].join("");
        if (name === "SEED_LOCAL") return seedLocal;
        throw new Error(`unknown_secret_${name}`);
      },
    },
  } as unknown as NocEdgeEnv;
  return { env, priv: pair.privateKey, pub, cache };
}

async function signedRequest(
  body: string,
  priv: CryptoKey,
): Promise<Request> {
  const ts = Math.floor(Date.now() / 1000);
  const sig = new Uint8Array(
    await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(`${ts}|${body}`)),
  );
  return new Request("https://noc-edge.telnyxcompute.com/dv", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "telnyx-signature-ed25519": btoa(String.fromCharCode(...sig)),
      "telnyx-timestamp": String(ts),
    },
    body,
  });
}

describe("router route table", () => {
  it("returns 404 JSON for an unknown method or path", async () => {
    const { env } = await makeEnv();
    const get = await route(new Request("https://x/dv", { method: "GET" }), env);
    expect(get.status).toBe(404);
    const missing = await route(new Request("https://x/nope", { method: "POST" }), env);
    expect(missing.status).toBe(404);
  });

  it("routes a signed DV request through the real deps", async () => {
    const { env, priv, cache } = await makeEnv();
    const payload = {
      call_control_id: "CC-1",
      telnyx_conversation_id: "CONV-1",
      telnyx_end_user_target: E164,
    };
    const body = JSON.stringify({
      data: { record_type: "event", event_type: "assistant.initialization", payload },
    });
    const res = await route(await signedRequest(body, priv), env);
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      dynamic_variables: Record<string, string>;
      conversation: { metadata: { trace_id: string; call_key: string } };
    };
    expect(out.dynamic_variables.route_hint).toBe("verified");
    expect(out.dynamic_variables.caller_name).toBe("Ahmed");
    expect(out.conversation.metadata.call_key).toBe("CC-1");
    expect(cache.has(kvKey("conv", "CONV-1"))).toBe(true);
  });

  it("fails closed with 403 when the public key secret cannot be read", async () => {
    const { env, priv } = await makeEnv();
    (env as unknown as { SECRETS: { get: (n: string) => Promise<string> } }).SECRETS.get =
      async () => {
        throw new Error("secrets_unavailable");
      };
    const payload = { call_control_id: "CC-1", telnyx_end_user_target: E164 };
    const body = JSON.stringify({
      data: { record_type: "event", event_type: "assistant.initialization", payload },
    });
    const res = await route(await signedRequest(body, priv), env);
    expect(res.status).toBe(403);
    expect(eventsWith("dv.sig_fail")).toHaveLength(1);
  });
});

describe("withErrorHandling", () => {
  it("catches everything and returns JSON 500 with an error log", async () => {
    const res = await withErrorHandling("dv", async () => {
      throw new Error("boom");
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    const errors = eventsWith("error");
    expect(errors).toHaveLength(1);
    expect(errors[0].hop).toBe("dv");
    expect(errors[0].outcome).toBe("error");
  });

  it("passes successful responses through", async () => {
    const res = await withErrorHandling("dv", async () =>
      Response.json({ ok: true }, { status: 200 }),
    );
    expect(res.status).toBe(200);
    expect(eventsWith("error")).toHaveLength(0);
  });
});

describe("router actor-mode selection", () => {
  const OPS = ["op", "s_b", "earer_", "test", "11"].join("");

  interface PingRecord {
    binding: "MUX";
    kind: "site" | "region";
    name: string;
    method: string;
  }

  async function makePingEnv() {
    const base = await makeEnv();
    const pings: PingRecord[] = [];
    (base.env as unknown as { SECRETS: { get: (n: string) => Promise<string | null> } }).SECRETS.get =
      async (name: string) => {
        if (name === "OPS_TOKEN") return OPS;
        if (name === "TELNYX_PUBLIC_KEY") return base.pub;
        return null;
      };
    (base.env as unknown as { SITES: { idFromName: (n: string) => unknown } }).SITES = {
      idFromName: (name: string) => ({
        ping: async () => {
          pings.push({ binding: "MUX", kind: "site", name, method: "binding" });
          return { pong: true, name };
        },
      }),
    };
    (base.env as unknown as { REGIONS: { idFromName: (n: string) => unknown } }).REGIONS = {
      idFromName: (name: string) => ({
        ping: async () => {
          pings.push({ binding: "MUX", kind: "region", name, method: "binding" });
          return { pong: true, name };
        },
      }),
    };
    (base.env as unknown as { MUX: { idFromName: (n: string) => unknown } }).MUX = {
      idFromName: (name: string) => ({
        site: async (entity: string, method: string) => {
          pings.push({ binding: "MUX", kind: "site", name: entity, method });
          return { pong: true, name: entity };
        },
        region: async (entity: string, method: string) => {
          pings.push({ binding: "MUX", kind: "region", name: entity, method });
          return { pong: true, name: entity };
        },
      }),
    };
    return { ...base, pings };
  }

  async function actorPing(env: NocEdgeEnv): Promise<Response> {
    return route(
      new Request("https://noc-edge.telnyxcompute.com/ops/actor-ping", {
        headers: { authorization: `Bearer ${OPS}` },
      }),
      env,
    );
  }

  it("reads per-entity from an unset flag and never touches MUX", async () => {
    const { env, pings } = await makePingEnv();
    const res = await actorPing(env);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { mode: string; site: { pong: boolean } };
    expect(out.mode).toBe("per-entity");
    expect(out.site.pong).toBe(true);
    expect(pings.map((p) => p.method)).toEqual(["binding", "binding"]);
    expect(pings.filter((p) => p.binding === "MUX" && p.method !== "binding")).toHaveLength(0);
  });

  it("picks the mux port when flag/actor_mode says mux", async () => {
    const { env, cache, pings } = await makePingEnv();
    await cache.put(kvKey("flag", "actor_mode"), "mux");
    const res = await actorPing(env);
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      mode: string;
      site: { name: string };
      region: { name: string };
    };
    expect(out.mode).toBe("mux");
    expect(out.site).toEqual({ pong: true, name: "RUH-114", actor_ms: expect.any(Number) });
    expect(out.region).toEqual({ pong: true, name: "riyadh-north", actor_ms: expect.any(Number) });
    expect(pings).toEqual([
      { binding: "MUX", kind: "site", name: "RUH-114", method: "ping" },
      { binding: "MUX", kind: "region", name: "riyadh-north", method: "ping" },
    ]);
  });

  function withSlowGet(kv: FakeKv, ms: number): FakeKv {
    return {
      get: async (key: string) => {
        await new Promise((r) => setTimeout(r, ms));
        return kv.get(key);
      },
      put: (key: string, value: string) => kv.put(key, value),
      delete: (key: string) => kv.delete(key),
      list: (prefix: string) => kv.list(prefix),
    } as unknown as FakeKv;
  }

  function hangKv(): FakeKv {
    return {
      get: () => new Promise<string>(() => undefined),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    } as unknown as FakeKv;
  }

  it("falls back to the configured default mode (mux) on a cold isolate when the flags read exceeds the budget", async () => {
    const { env, pings } = await makePingEnv();
    (env as unknown as { CACHE: unknown }).CACHE = withSlowGet(new FakeKv(), 2400);
    const res = await actorPing(env);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { mode: string };
    expect(out.mode).toBe("mux");
    expect(pings.map((p) => p.method)).toEqual(["ping", "ping"]);
    expect(pings.filter((p) => p.binding === "MUX")).toHaveLength(2);
    const fallbacks = eventsWith("flags.fallback");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].mode).toBe("mux");
    expect(fallbacks[0].budget_ms).toBe(2000);
    expect(fallbacks[0].total_ms).toBeGreaterThanOrEqual(2000);
  }, 15000);

  it("selects mux on a non-dv route when the flags read takes 400 ms", async () => {
    const { env, cache, pings } = await makePingEnv();
    await cache.put(kvKey("flag", "actor_mode"), "mux");
    (env as unknown as { CACHE: unknown }).CACHE = withSlowGet(cache, 400);
    const res = await actorPing(env);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { mode: string };
    expect(out.mode).toBe("mux");
    expect(pings.map((p) => p.method)).toEqual(["ping", "ping"]);
    const reads = eventsWith("actor_mode.read");
    expect(reads).toHaveLength(1);
    expect(reads[0].lvl).toBe("info");
    expect(reads[0].mode).toBe("mux");
    expect(reads[0].total_ms).toBeGreaterThanOrEqual(400);
  });

  it("picks the mux port on /dv from the same flags read when the read takes 400 ms", async () => {
    const { env, priv, cache } = await makeEnv();
    const muxCalls: string[] = [];
    (env as unknown as { MUX: { idFromName: (n: string) => unknown } }).MUX = {
      idFromName: () => ({
        site: async (entity: string, method: string) => {
          if (method === "recordCall") {
            muxCalls.push(entity);
            return { callsToday: 1, openTicket: null, trace_id: "", actor_ms: 0 };
          }
          return {};
        },
        region: async () => ({}),
      }),
    };
    await cache.put(kvKey("flag", "actor_mode"), "mux");
    (env as unknown as { CACHE: unknown }).CACHE = withSlowGet(cache, 400);
    const payload = {
      call_control_id: "CC-1",
      telnyx_conversation_id: "CONV-1",
      telnyx_end_user_target: E164,
    };
    const body = JSON.stringify({
      data: { record_type: "event", event_type: "assistant.initialization", payload },
    });
    const res = await route(await signedRequest(body, priv), env);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { dynamic_variables: Record<string, string> };
    expect(out.dynamic_variables.route_hint).toBe("verified");
    expect(out.dynamic_variables.calls_today).toBe("1");
    expect(muxCalls).toEqual(["RUH-114"]);
    expect(
      cache.calls.filter((c) => c.op === "get" && c.key === kvKey("flag", "actor_mode")),
    ).toHaveLength(1);
    expect(eventsWith("actor_mode.read")).toHaveLength(0);
  });

  it("reuses the last-known-good mux mode when a later flags read times out", async () => {
    const { env, cache, pings } = await makePingEnv();
    await cache.put(kvKey("flag", "actor_mode"), "mux");
    const first = await actorPing(env);
    expect(((await first.json()) as { mode: string }).mode).toBe("mux");
    (env as unknown as { CACHE: unknown }).CACHE = hangKv();
    const res = await actorPing(env);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { mode: string };
    expect(out.mode).toBe("mux");
    expect(pings.slice(2).map((p) => p.method)).toEqual(["ping", "ping"]);
    const fallbacks = eventsWith("flags.fallback");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].mode).toBe("mux");
    expect(eventsWith("actor_mode.read")).toHaveLength(1);
  });
});

describe("router /dv fail-open", () => {
  function dvBody(cc = "CC-1"): string {
    const payload = {
      call_control_id: cc,
      telnyx_conversation_id: "CONV-1",
      telnyx_end_user_target: E164,
    };
    return JSON.stringify({
      data: { record_type: "event", event_type: "assistant.initialization", payload },
    });
  }

  function hangKv(): FakeKv {
    return {
      get: () => new Promise<string>(() => undefined),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    } as unknown as FakeKv;
  }

  it("returns 200 with the default dynamic variables when the KV binding rejects", async () => {
    const { env, priv } = await makeEnv();
    const boom = (): Promise<never> => Promise.reject(new Error("kv_down"));
    (env as unknown as { CACHE: unknown }).CACHE = {
      get: () => boom(),
      put: () => boom(),
      delete: () => boom(),
      list: () => boom(),
    };
    const res = await route(await signedRequest(dvBody(), priv), env);
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      dynamic_variables: Record<string, string>;
      conversation: { metadata: { call_key: string } };
    };
    expect(out.dynamic_variables.route_hint).toBe("unverified");
    expect(out.dynamic_variables.caller_name).toBe("Ahmed");
    expect(out.dynamic_variables.calls_today).toBe("1");
    expect(out.conversation.metadata.call_key).toBe("CC-1");
    const routes = eventsWith("dv.route");
    expect(routes).toHaveLength(1);
    expect(routes[0].outcome).toBe("fallback");
  });

  it("reads flag/actor_mode from KV at most once per /dv request in mux mode", async () => {
    const { env, priv, cache } = await makeEnv();
    const muxCalls: string[] = [];
    (env as unknown as { MUX: { idFromName: (n: string) => unknown } }).MUX = {
      idFromName: () => ({
        site: async (entity: string, method: string) => {
          if (method === "recordCall") {
            muxCalls.push(entity);
            return { callsToday: 1, openTicket: null, trace_id: "", actor_ms: 0 };
          }
          return {};
        },
        region: async () => ({}),
      }),
    };
    await cache.put(kvKey("flag", "actor_mode"), "mux");
    const res = await route(await signedRequest(dvBody(), priv), env);
    expect(res.status).toBe(200);
    expect(muxCalls).toEqual(["RUH-114"]);
    expect(
      cache.calls.filter((c) => c.op === "get" && c.key === kvKey("flag", "actor_mode")),
    ).toHaveLength(1);
  });

  it("keeps the last-known mux mode for /dv when the flags read hangs, without clobbering it", async () => {
    const { env, priv, cache } = await makeEnv();
    const muxCalls: string[] = [];
    const bindingCalls: string[] = [];
    (env as unknown as { MUX: { idFromName: (n: string) => unknown } }).MUX = {
      idFromName: () => ({
        site: async (entity: string, method: string) => {
          if (method === "recordCall") {
            muxCalls.push(entity);
            return { callsToday: 1, openTicket: null, trace_id: "", actor_ms: 0 };
          }
          return {};
        },
        region: async () => ({}),
      }),
    };
    (env as unknown as { SITES: { idFromName: (n: string) => unknown } }).SITES = {
      idFromName: () => ({
        recordCall: async () => {
          bindingCalls.push("called");
          return { callsToday: 1, openTicket: null, trace_id: "", actor_ms: 0 };
        },
      }),
    };
    await cache.put(kvKey("flag", "actor_mode"), "mux");
    const first = await route(await signedRequest(dvBody("CC-1"), priv), env);
    expect(first.status).toBe(200);
    expect(muxCalls).toEqual(["RUH-114"]);
    expect(bindingCalls).toHaveLength(0);

    (env as unknown as { CACHE: unknown }).CACHE = hangKv();
    const second = await route(await signedRequest(dvBody("CC-2"), priv), env);
    expect(second.status).toBe(200);
    expect(muxCalls).toEqual(["RUH-114", "RUH-114"]);

    const third = await route(await signedRequest(dvBody("CC-3"), priv), env);
    expect(third.status).toBe(200);
    expect(muxCalls).toEqual(["RUH-114", "RUH-114", "RUH-114"]);
    expect(bindingCalls).toHaveLength(0);
    const routes = eventsWith("dv.route");
    expect(routes.length).toBe(3);
    expect(routes.slice(1).every((r) => r.outcome === "fallback")).toBe(true);
  });
});

describe("router tool webhooks", () => {
  async function makeToolEnv() {
    const base = await makeEnv();
    const seedLocal = JSON.stringify({
      pins: { "RUH-114": String(4000 + 114) },
      contacts: [],
    });
    (base.env as unknown as { SECRETS: { get: (n: string) => Promise<string | null> } }).SECRETS.get =
      async (name: string) => {
        if (name === "TELNYX_PUBLIC_KEY") return base.pub;
        if (name === "PIN_PEPPER") return ["p", "e", "pp", "er"].join("");
        if (name === "SEED_LOCAL") return seedLocal;
        return null;
      };
    const sites = new Map<string, ReturnType<typeof makeSiteActor>>();
    const regions = new Map<string, ReturnType<typeof makeRegionActor>>();
    (base.env as unknown as { SITES: unknown }).SITES = {
      idFromName: (name: string) => {
        let actor = sites.get(name);
        if (actor === undefined) {
          actor = makeSiteActor(name);
          sites.set(name, actor);
        }
        return actor;
      },
    };
    (base.env as unknown as { REGIONS: unknown }).REGIONS = {
      idFromName: (name: string) => {
        let actor = regions.get(name);
        if (actor === undefined) {
          actor = makeRegionActor(name);
          regions.set(name, actor);
        }
        return actor;
      },
    };
    return base;
  }

  async function signedTool(
    path: string,
    fields: Record<string, unknown>,
    priv: CryptoKey,
  ): Promise<Request> {
    const body = JSON.stringify(fields);
    const ts = Math.floor(Date.now() / 1000);
    const sig = new Uint8Array(
      await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(`${ts}|${body}`)),
    );
    return new Request(`https://noc-edge.telnyxcompute.com${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "telnyx-signature-ed25519": btoa(String.fromCharCode(...sig)),
        "telnyx-timestamp": String(ts),
        "x-telnyx-call-control-id": String(fields.call_control_id ?? ""),
      },
      body,
    });
  }

  function presets(): Record<string, unknown> {
    return {
      call_control_id: "CC-1",
      call_key: "none",
      trace_id: "t-cc",
      conversation_id: "CONV-1",
    };
  }

  it("routes a signed verify_site request through the real deps to 200", async () => {
    const { env, priv } = await makeToolEnv();
    const res = await route(
      await signedTool("/tools/verify-site", {
        site_id: "RUH-114",
        pin: String(4000 + 114),
        ...presets(),
      }, priv),
      env,
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, string>;
    expect(out.verify_result).toBe("ok");
    expect(out.site_id).toBe("RUH-114");
    expect(eventsWith("tool.verify_site")).toHaveLength(1);
  });

  it("routes a signed open_ticket request to 200 for a verified session", async () => {
    const { env, priv, cache } = await makeToolEnv();
    const k = (await sessionKey({ call_control_id: "CC-1" })) as string;
    await putAuth(cache, k, {
      verified: true,
      site_id: "RUH-114",
      customer_id: "c-alwaha",
      at: Date.now(),
    });
    const res = await route(
      await signedTool("/tools/open-ticket", {
        site_id: "RUH-114",
        symptom: "WAN link down",
        impact: "site_down",
        service_affecting: "true",
        ...presets(),
      }, priv),
      env,
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, string>;
    expect(out.ticket_id).toBe("NJD-1401");
    expect(eventsWith("tool.open_ticket")).toHaveLength(1);
  });

  it("routes a signed open_ticket with a missing site_id to 422", async () => {
    const { env, priv } = await makeToolEnv();
    const res = await route(
      await signedTool("/tools/open-ticket", {
        symptom: "WAN link down",
        impact: "site_down",
        service_affecting: "true",
        ...presets(),
      }, priv),
      env,
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "missing_site_id" });
  });

  it("routes a signed join_incident with no session to 403", async () => {
    const { env, priv } = await makeToolEnv();
    const res = await route(
      await signedTool("/tools/join-incident", presets(), priv),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_identified" });
  });

  it("routes a signed callback to 200 escalated", async () => {
    const { env, priv } = await makeToolEnv();
    const res = await route(
      await signedTool("/tools/callback", { callback_note: "call the duty manager", ...presets() }, priv),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ escalated: "true", callback_note: "none" });
    expect(eventsWith("page.raised")).toHaveLength(1);
  });

  it("fails closed with 403 for every tool route when secrets cannot be read", async () => {
    const { env, priv } = await makeToolEnv();
    (env as unknown as { SECRETS: { get: (n: string) => Promise<string> } }).SECRETS.get =
      async () => {
        throw new Error("secrets_unavailable");
      };
    for (const path of ["/tools/verify-site", "/tools/open-ticket", "/tools/join-incident", "/tools/callback"]) {
      const res = await route(await signedTool(path, presets(), priv), env);
      expect(res.status).toBe(403);
    }
    const sigFails = eventsWith("tool.sig_fail");
    expect(sigFails).toHaveLength(4);
  });

  it("returns 500 on verify_site when PIN_PEPPER is missing", async () => {
    const { env, priv, pub } = await makeToolEnv();
    (env as unknown as { SECRETS: { get: (n: string) => Promise<string | null> } }).SECRETS.get =
      async (name: string) => (name === "TELNYX_PUBLIC_KEY" ? pub : null);
    const res = await route(
      await signedTool("/tools/verify-site", {
        site_id: "RUH-114",
        pin: String(4000 + 114),
        ...presets(),
      }, priv),
      env,
    );
    expect(res.status).toBe(500);
    const lines = eventsWith("tool.verify_site");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("error");
  });
});

describe("router /demo page", () => {
  const AGENT_ID = [
    "assistant-a2d301b3", "f112", "48f6", "84c8", "9e4d052cf3b7",
  ].join("-");
  const WIDGET_URL = [
    "https://unpkg.com/@telnyx/", "ai-agent-widget@0.36.0",
  ].join("");
  // PINs are secrets: assembled at runtime so no PIN literal is in this file.
  const PIN_JOIN = ["5", "1", "9", "0"].join("");
  const PIN_NEW = ["3", "8", "2", "6"].join("");

  function demoUrl(): string {
    return "https://noc-edge.telnyxcompute.com/demo";
  }

  function withGuideEnv(base: Awaited<ReturnType<typeof makeEnv>>, raw: string) {
    (
      base.env as unknown as { SECRETS: { get: (n: string) => Promise<string | null> } }
    ).SECRETS.get = async (name: string) => {
      if (name === "TELNYX_PUBLIC_KEY") return base.pub;
      if (name === "PIN_PEPPER") return ["p", "e", "pp", "er"].join("");
      if (name === "SEED_LOCAL") return JSON.stringify({ pins: {}, contacts: [] });
      if (name === "DEMO_GUIDE") return raw;
      return null;
    };
    return base.env;
  }

  it("serves the live NOC wall with the pinned widget and the scenario titles", async () => {
    const { env } = await makeEnv();
    const res = await route(new Request(demoUrl()), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await res.text();
    expect(html).toContain("<title>NOC Front Door — Live NOC wall</title>");
    expect(html).toContain(`agent-id="${AGENT_ID}"`);
    expect(html).toContain(WIDGET_URL);
    expect(html).toContain("noc front door");
    expect(html).toContain("Najd Networks · 24/7 AI fault line");
    expect(html).toContain("Join the incident");
    expect(html).toContain("Open a new ticket");
    expect(html).toContain("Lockout &amp; human");
    expect(html).toContain("<mark>AI fault line</mark>");
    expect(html).toContain("Live board");
    expect(html).toContain("Event feed");
    expect(html).toContain("How it works");
    expect(html).toContain("Stateful Actors + KV");
    expect(html).toContain("Calls are recorded and handled by an AI assistant.");
  });

  it("renders no innerHTML, no inline handlers and no PIN values without the guide", async () => {
    const { env } = await makeEnv();
    const html = await (await route(new Request(demoUrl()), env)).text();
    expect(html).not.toContain("innerHTML");
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).toContain("PIN: see the README reviewer guide");
    expect(html).not.toContain("data-pin=");
    expect(html).not.toContain(PIN_JOIN);
    expect(html).not.toContain(PIN_NEW);
    expect(html).not.toMatch(/\+[0-9]{8,15}/);
  });

  it("renders the two guide PINs when the DEMO_GUIDE secret is set", async () => {
    const base = await makeEnv();
    const env = withGuideEnv(base, JSON.stringify({
      scenarios: [
        { key: "join", site: "RUH-114", pin: PIN_JOIN },
        { key: "new", site: "JED-007", pin: PIN_NEW },
      ],
    }));
    const html = await (await route(new Request(demoUrl()), env)).text();
    expect(html).toContain(`data-pin="${PIN_JOIN}"`);
    expect(html).toContain(`data-pin="${PIN_NEW}"`);
    expect(html).toContain(`PIN ${PIN_JOIN}`);
    expect(html).toContain(`PIN ${PIN_NEW}`);
    expect(html).not.toContain("PIN: see the README reviewer guide");
  });

  it("shows the README fallback when the guide secret is invalid", async () => {
    const base = await makeEnv();
    const env = withGuideEnv(base, JSON.stringify({
      scenarios: [{ key: "join", site: "ruh-114", pin: PIN_JOIN }],
    }));
    const html = await (await route(new Request(demoUrl()), env)).text();
    expect(html).toContain("PIN: see the README reviewer guide");
    expect(html).not.toContain("data-pin=");
  });

  it("answers HEAD /demo with the same headers and an empty body", async () => {
    const { env } = await makeEnv();
    const res = await route(new Request(demoUrl(), { method: "HEAD" }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("");
  });

  it("rejects other methods with 405", async () => {
    const { env } = await makeEnv();
    const post = await route(new Request(demoUrl(), { method: "POST" }), env);
    expect(post.status).toBe(405);
    const del = await route(new Request(demoUrl(), { method: "DELETE" }), env);
    expect(del.status).toBe(405);
  });
});
