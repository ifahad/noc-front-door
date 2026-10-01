import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SeedAdapter } from "../../../shared/src/itsm";
import type { SeedLocalConfig } from "../../../shared/src/itsm";
import { kvKey } from "../../../shared/src/kvkeys";
import type { KvPort } from "../../src/services/kvPort";
import type { ActorPort, SiteStateApi } from "../../src/services/actorPort";
import { DV_TIMEOUT_MS, handleDv, type DvDeps } from "../../src/dv/handler";
import { FakeKv } from "../fakes/kv";
import { slowKv } from "../fakes/kv";
import { FakeActorPort } from "../fakes/actors";

const E164 = ["+", "1", "312", "555", "0101"].join("");
const SIP = "abc@sip.telnyx.eu";
const PEPPER = ["p", "e", "pp", "er"].join("");
const CCID = "CC-1111";
const CONV_ID = "CONV-1";

const SEED_LOCAL: SeedLocalConfig = {
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
};

const PROJECTION = {
  id: "INC-1002",
  version: 3,
  region_label: "Riyadh North",
  started_local: "1:52 AM",
  summary: "loss of connectivity at two branches",
  eta_local: "2:22 AM",
  priority: "P2",
  site_count: 2,
};

interface LogLine {
  ts: string;
  lvl: string;
  svc: string;
  evt: string;
  [k: string]: unknown;
}

interface DvResponse {
  dynamic_variables: Record<string, string>;
  conversation: { metadata: { trace_id: string; call_key: string } };
}

let logs: string[];

beforeEach(() => {
  logs = [];
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

async function makeKeys(): Promise<{ priv: CryptoKey; pub: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pub = btoa(String.fromCharCode(...raw));
  return { priv: pair.privateKey, pub };
}

async function signedRequest(
  body: string,
  keys: { priv: CryptoKey; pub: string },
  opts: { tsOffsetSec?: number; sign?: boolean; wrongKey?: boolean } = {},
): Promise<Request> {
  const ts = Math.floor(Date.now() / 1000) + (opts.tsOffsetSec ?? 0);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.sign !== false) {
    const signer = opts.wrongKey ? (await makeKeys()).priv : keys.priv;
    const sig = new Uint8Array(
      await crypto.subtle.sign("Ed25519", signer, new TextEncoder().encode(`${ts}|${body}`)),
    );
    headers["telnyx-signature-ed25519"] = btoa(String.fromCharCode(...sig));
    headers["telnyx-timestamp"] = String(ts);
  }
  return new Request("https://noc-edge.telnyxcompute.com/dv", { method: "POST", headers, body });
}

function payloadOf(target: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    call_control_id: CCID,
    telnyx_conversation_id: CONV_ID,
    telnyx_end_user_target: target,
    ...over,
  };
}

function bodyOf(payload: Record<string, unknown>): string {
  return JSON.stringify({
    data: { record_type: "event", id: "ev-1", event_type: "assistant.initialization", payload },
  });
}

function adapter(): SeedAdapter {
  return new SeedAdapter({ seedLocal: SEED_LOCAL, pepper: PEPPER, now: () => 0 });
}

function makeDeps(
  kv: KvPort,
  actors: ActorPort,
  keys: { priv: CryptoKey; pub: string },
  opts: { now?: () => number; timeoutMs?: number; publicKey?: string } = {},
): DvDeps {
  return {
    kv,
    actors,
    adapter: adapter(),
    publicKey: opts.publicKey ?? keys.pub,
    now: opts.now ?? (() => Date.now()),
    timeoutMs: opts.timeoutMs ?? DV_TIMEOUT_MS,
  };
}

function hangingActors(): ActorPort {
  const never = new Promise<never>(() => {});
  const site = { recordCall: () => never } as unknown as SiteStateApi;
  return {
    site: () => site,
    region: (() => {
      throw new Error("region_unused_in_dv");
    }) as unknown as ActorPort["region"],
  };
}

function kvFailPutWhere(inner: KvPort, pred: (key: string) => boolean): KvPort {
  return {
    get: (key) => inner.get(key),
    put: async (key, value, opts) => {
      if (pred(key)) throw new Error("injected_put_error");
      await inner.put(key, value, opts);
    },
    delete: (key) => inner.delete(key),
    list: (prefix) => inner.list(prefix),
  };
}

async function jsonOf(res: Response): Promise<DvResponse> {
  return (await res.json()) as DvResponse;
}

describe("handleDv", () => {
  it("rejects an unsigned request with 403 and logs dv.sig_fail", async () => {
    const keys = await makeKeys();
    const req = await signedRequest(bodyOf(payloadOf(E164)), keys, { sign: false });
    const res = await handleDv(req, makeDeps(new FakeKv(), hangingActors(), keys));
    expect(res.status).toBe(403);
    const sigFails = eventsWith("dv.sig_fail");
    expect(sigFails).toHaveLength(1);
    expect(sigFails[0].outcome).toBe("denied");
  });

  it("rejects a stale timestamp with 403", async () => {
    const keys = await makeKeys();
    const req = await signedRequest(bodyOf(payloadOf(E164)), keys, { tsOffsetSec: -1000 });
    const res = await handleDv(req, makeDeps(new FakeKv(), hangingActors(), keys));
    expect(res.status).toBe(403);
    expect(eventsWith("dv.sig_fail")).toHaveLength(1);
  });

  it("rejects a bad signature with 403", async () => {
    const keys = await makeKeys();
    const req = await signedRequest(bodyOf(payloadOf(E164)), keys, { wrongKey: true });
    const res = await handleDv(req, makeDeps(new FakeKv(), hangingActors(), keys));
    expect(res.status).toBe(403);
    expect(eventsWith("dv.sig_fail")).toHaveLength(1);
  });

  it("fails closed when no public key is configured", async () => {
    const keys = await makeKeys();
    const req = await signedRequest(bodyOf(payloadOf(E164)), keys);
    const res = await handleDv(
      req,
      makeDeps(new FakeKv(), hangingActors(), keys, { publicKey: "" }),
    );
    expect(res.status).toBe(403);
    expect(eventsWith("dv.sig_fail")).toHaveLength(1);
  });

  it("personalises a known E.164 caller with no incident", async () => {
    const keys = await makeKeys();
    const kv = new FakeKv();
    const req = await signedRequest(bodyOf(payloadOf(E164)), keys);
    const res = await handleDv(req, makeDeps(kv, new FakeActorPort(), keys));
    expect(res.status).toBe(200);
    const out = await jsonOf(res);
    expect(out.dynamic_variables.route_hint).toBe("verified");
    expect(out.dynamic_variables.caller_name).toBe("Ahmed");
    expect(out.dynamic_variables.customer_name).toBe("Al-Waha Pharmacies");
    expect(out.dynamic_variables.site_id).toBe("RUH-114");
    expect(out.dynamic_variables.site_label).toBe("the Al Yasmin branch");
    expect(out.dynamic_variables.calls_today).toBe("1");
    expect(out.dynamic_variables.repeat_note).toBe("none");
    expect(out.dynamic_variables.open_ticket_note).toBe("none");
    expect(out.dynamic_variables.trace_id).toBe(out.conversation.metadata.trace_id);
    expect(out.dynamic_variables.call_key).toBe(CCID);
    expect(out.conversation.metadata.trace_id).toMatch(/^t-[0-9a-f]{16}$/);
    expect(kv.has(kvKey("call", out.conversation.metadata.trace_id.slice(2), "dv"))).toBe(true);
    expect(kv.raw(kvKey("conv", CONV_ID))).toBe(out.conversation.metadata.trace_id.slice(2));
  });

  it("returns within the webhook budget on slow KV with actor and incident data intact", async () => {
    const keys = await makeKeys();
    const inner = new FakeKv();
    inner.setNow(0);
    await inner.put(kvKey("incident", "active", "riyadh-north"), JSON.stringify(PROJECTION));
    const kv = slowKv(inner, 1000);
    const started = Date.now();
    const res = await handleDv(
      await signedRequest(bodyOf(payloadOf(E164)), keys),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    const elapsed = Date.now() - started;
    console.info("test.dv_regression_ms", elapsed);
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(1800);
    const out = await jsonOf(res);
    expect(out.dynamic_variables.route_hint).toBe("known_incident");
    expect(out.dynamic_variables.caller_name).toBe("Ahmed");
    expect(out.dynamic_variables.site_id).toBe("RUH-114");
    expect(out.dynamic_variables.incident_region).toBe("Riyadh North");
    expect(out.dynamic_variables.incident_started).toBe("1:52 AM");
    expect(out.dynamic_variables.incident_summary).toBe("loss of connectivity at two branches");
    expect(out.dynamic_variables.incident_eta).toBe("2:22 AM");
    expect(out.dynamic_variables.calls_today).toBe("1");
    expect(out.dynamic_variables.repeat_note).toBe("none");
    const routes = eventsWith("dv.route");
    expect(routes).toHaveLength(1);
    expect(routes[0].outcome).toBe("ok");
    expect(inner.has(kvKey("call", out.conversation.metadata.trace_id.slice(2), "dv"))).toBe(true);
    expect(inner.has(kvKey("conv", CONV_ID))).toBe(true);
    expect(inner.has(kvKey("incident", "active", "riyadh-north"))).toBe(true);
  });

  it("identifies a flagged web caller when every KV op takes 1500 ms, while the old 2500 ms budget fell back", { timeout: 30000 }, async () => {
    const keys = await makeKeys();
    const slowWebKv = async (): Promise<KvPort> => {
      const inner = new FakeKv();
      inner.setNow(0);
      await inner.put(kvKey("flag", "demo_caller"), "c-ahmed");
      await inner.put(kvKey("incident", "active", "riyadh-north"), JSON.stringify(PROJECTION));
      return slowKv(inner, 1500);
    };
    // Live finding 2026-10-01: a flagged web caller waits for the flags read
    // before the session write, so at 1500 ms per KV op the old internal
    // budget (timeoutMs - 300 = 2200 ms) could not fit both in sequence and
    // the identified caller still fell back to "unverified".
    const fixed = await handleDv(
      await signedRequest(bodyOf(payloadOf(SIP)), keys),
      makeDeps(await slowWebKv(), new FakeActorPort(), keys, { timeoutMs: DV_TIMEOUT_MS }),
    );
    expect(fixed.status).toBe(200);
    const out = await jsonOf(fixed);
    expect(out.dynamic_variables.route_hint).toBe("known_incident");
    expect(out.dynamic_variables.caller_name).toBe("Ahmed");
    expect(out.dynamic_variables.site_id).toBe("RUH-114");
    const regressed = await handleDv(
      await signedRequest(bodyOf(payloadOf(SIP)), keys),
      makeDeps(await slowWebKv(), new FakeActorPort(), keys, { timeoutMs: 2500 }),
    );
    expect(regressed.status).toBe(200);
    const outOld = await jsonOf(regressed);
    expect(outOld.dynamic_variables.route_hint).toBe("unverified");
    expect(outOld.dynamic_variables.caller_name).toBe("Ahmed");
    const routes = eventsWith("dv.route");
    expect(routes).toHaveLength(2);
    expect(routes[0].outcome).toBe("ok");
    expect(routes[1].outcome).toBe("fallback");
  });

  it("routes to known_incident with the incident variables when the region projection is active", async () => {
    const keys = await makeKeys();
    const kv = new FakeKv();
    kv.setNow(0);
    await kv.put(kvKey("incident", "active", "riyadh-north"), JSON.stringify(PROJECTION));
    const req = await signedRequest(bodyOf(payloadOf(E164)), keys);
    const res = await handleDv(req, makeDeps(kv, new FakeActorPort(), keys));
    const out = await jsonOf(res);
    expect(out.dynamic_variables.route_hint).toBe("known_incident");
    expect(out.dynamic_variables.incident_region).toBe("Riyadh North");
    expect(out.dynamic_variables.incident_started).toBe("1:52 AM");
    expect(out.dynamic_variables.incident_summary).toBe("loss of connectivity at two branches");
    expect(out.dynamic_variables.incident_eta).toBe("2:22 AM");
  });

  it("falls back to defaults for a SIP URI caller with no demo flag", async () => {
    const keys = await makeKeys();
    const req = await signedRequest(bodyOf(payloadOf(SIP)), keys);
    const res = await handleDv(req, makeDeps(new FakeKv(), new FakeActorPort(), keys));
    const out = await jsonOf(res);
    expect(out.dynamic_variables.route_hint).toBe("unverified");
    expect(out.dynamic_variables.caller_name).toBe("there");
    expect(out.dynamic_variables.customer_name).toBe("your organisation");
    expect(out.dynamic_variables.site_id).toBe("unknown");
    expect(out.dynamic_variables.site_label).toBe("your site");
    expect(out.dynamic_variables.calls_today).toBe("1");
    expect(out.dynamic_variables.repeat_note).toBe("none");
    expect(out.dynamic_variables.open_ticket_note).toBe("none");
    expect(out.dynamic_variables.incident_region).toBe("your area");
  });

  it("routes to unverified when require_pin is true", async () => {
    const keys = await makeKeys();
    const kv = new FakeKv();
    kv.setNow(0);
    await kv.put(kvKey("flag", "require_pin"), "true");
    const req = await signedRequest(bodyOf(payloadOf(E164)), keys);
    const res = await handleDv(req, makeDeps(kv, new FakeActorPort(), keys));
    const out = await jsonOf(res);
    expect(out.dynamic_variables.route_hint).toBe("unverified");
    expect(out.dynamic_variables.caller_name).toBe("Ahmed");
  });

  it("forces unverified when the session write fails", async () => {
    const keys = await makeKeys();
    const inner = new FakeKv();
    const kv = kvFailPutWhere(
      inner,
      (key) => key.startsWith("call/") && key.endsWith("/dv"),
    );
    const req = await signedRequest(bodyOf(payloadOf(E164)), keys);
    const res = await handleDv(req, makeDeps(kv, new FakeActorPort(), keys));
    expect(res.status).toBe(200);
    const out = await jsonOf(res);
    expect(out.dynamic_variables.route_hint).toBe("unverified");
    expect(out.dynamic_variables.caller_name).toBe("Ahmed");
  });

  it("still builds the response when the actor times out, with personalisation skipped", async () => {
    const keys = await makeKeys();
    const req = await signedRequest(bodyOf(payloadOf(E164)), keys);
    const res = await handleDv(req, makeDeps(new FakeKv(), hangingActors(), keys));
    expect(res.status).toBe(200);
    const out = await jsonOf(res);
    expect(out.dynamic_variables.route_hint).toBe("verified");
    expect(out.dynamic_variables.calls_today).toBe("1");
    expect(out.dynamic_variables.repeat_note).toBe("none");
    expect(out.dynamic_variables.open_ticket_note).toBe("none");
    const routes = eventsWith("dv.route");
    expect(routes).toHaveLength(1);
    expect(routes[0].outcome).toBe("fallback");
    expect(routes[0].hop).toBe("dv");
    expect(routes[0].trace_id).toBe(out.conversation.metadata.trace_id);
  });

  it("acknowledges the second call of the day", async () => {
    const keys = await makeKeys();
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    const first = await handleDv(
      await signedRequest(bodyOf(payloadOf(E164, { call_control_id: "CC-A" })), keys),
      makeDeps(kv, actors, keys),
    );
    const firstOut = await jsonOf(first);
    expect(firstOut.dynamic_variables.calls_today).toBe("1");
    expect(firstOut.dynamic_variables.repeat_note).toBe("none");
    const second = await handleDv(
      await signedRequest(bodyOf(payloadOf(E164, { call_control_id: "CC-B" })), keys),
      makeDeps(kv, actors, keys),
    );
    const secondOut = await jsonOf(second);
    expect(secondOut.dynamic_variables.calls_today).toBe("2");
    expect(secondOut.dynamic_variables.repeat_note).toBe(
      "I can see this is your second call today about this branch.",
    );
  });

  it("returns only non-empty string values", async () => {
    const keys = await makeKeys();
    const kv = new FakeKv();
    kv.setNow(0);
    await kv.put(kvKey("incident", "active", "riyadh-north"), JSON.stringify(PROJECTION));
    const res = await handleDv(
      await signedRequest(bodyOf(payloadOf(E164, { call_control_id: "CC-B" })), keys),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    const out = await jsonOf(res);
    const values = Object.values(out.dynamic_variables);
    expect(values.length).toBeGreaterThanOrEqual(15);
    for (const value of values) {
      expect(typeof value).toBe("string");
      expect(value).not.toBe("");
    }
  });

  it("applies dv_delay_ms after building the response and logs dv.late with fault_injected", async () => {
    const keys = await makeKeys();
    const kv = new FakeKv();
    kv.setNow(0);
    await kv.put(kvKey("flag", "fault", "dv_delay_ms"), "50");
    const realNow = () => Date.now();
    const started = Date.now();
    const res = await handleDv(
      await signedRequest(bodyOf(payloadOf(E164)), keys),
      makeDeps(kv, new FakeActorPort(), keys, { now: realNow }),
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    const out = await jsonOf(res);
    expect(out.dynamic_variables.route_hint).toBe("verified");
    const routes = eventsWith("dv.route");
    expect(routes).toHaveLength(1);
    expect(Number(routes[0].total_ms)).toBeGreaterThanOrEqual(50);
    const lates = eventsWith("dv.late");
    expect(lates).toHaveLength(1);
    expect(lates[0].fault_injected).toBe(true);
  });

  it("logs exactly one dv.route line with the timing fields", async () => {
    const keys = await makeKeys();
    const req = await signedRequest(bodyOf(payloadOf(E164)), keys);
    await handleDv(req, makeDeps(new FakeKv(), new FakeActorPort(), keys));
    const routes = eventsWith("dv.route");
    expect(routes).toHaveLength(1);
    const route = routes[0];
    expect(route.hop).toBe("dv");
    expect(route.route_hint).toBe("verified");
    expect(route.caller).toBe(`${E164.slice(0, 5)}****${E164.slice(-3)}`);
    expect(typeof route.kv_ms).toBe("number");
    expect(typeof route.actor_ms).toBe("number");
    expect(typeof route.total_ms).toBe("number");
    expect(route.outcome).toBe("ok");
    expect(eventsWith("dv.late")).toHaveLength(0);
  });

  it("fails open with safe defaults on unparsable JSON", async () => {
    const keys = await makeKeys();
    const kv = new FakeKv();
    const req = await signedRequest("{not json", keys);
    const res = await handleDv(req, makeDeps(kv, hangingActors(), keys));
    expect(res.status).toBe(200);
    const out = await jsonOf(res);
    expect(out.dynamic_variables.route_hint).toBe("unverified");
    expect(out.dynamic_variables.caller_name).toBe("there");
    expect(out.dynamic_variables.site_id).toBe("unknown");
    expect(out.dynamic_variables.repeat_note).toBe("none");
    expect(out.dynamic_variables.calls_today).toBe("1");
    expect(out.dynamic_variables.trace_id).toBe(out.conversation.metadata.trace_id);
    expect(out.conversation.metadata.call_key).not.toBe("");
    expect(kv.calls.filter((c) => c.op === "put")).toHaveLength(0);
    const routes = eventsWith("dv.route");
    expect(routes).toHaveLength(1);
    expect(routes[0].outcome).toBe("fallback");
    expect(routes[0].reason).toBe("bad_json");
    expect(eventsWith("dv.late")).toHaveLength(0);
  });

  it("fails open when data.payload is missing or not an object", async () => {
    const keys = await makeKeys();
    const kv = new FakeKv();
    const missing = await handleDv(
      await signedRequest(
        JSON.stringify({ data: { event_type: "assistant.initialization" } }),
        keys,
      ),
      makeDeps(kv, hangingActors(), keys),
    );
    expect(missing.status).toBe(200);
    const missingOut = await jsonOf(missing);
    expect(missingOut.dynamic_variables.route_hint).toBe("unverified");
    expect(kv.calls.filter((c) => c.op === "put")).toHaveLength(0);
    const nonObject = await handleDv(
      await signedRequest(JSON.stringify({ data: { payload: 42 } }), keys),
      makeDeps(kv, hangingActors(), keys),
    );
    expect(nonObject.status).toBe(200);
    const routes = eventsWith("dv.route").filter((r) => r.reason === "no_payload");
    expect(routes).toHaveLength(2);
    expect(routes.every((r) => r.outcome === "fallback")).toBe(true);
  });

  it("identifies a SIP caller through the demo_caller flag", async () => {
    const keys = await makeKeys();
    const kv = new FakeKv();
    kv.setNow(0);
    await kv.put(kvKey("flag", "demo_caller"), "c-ahmed");
    const req = await signedRequest(bodyOf(payloadOf(SIP)), keys);
    const res = await handleDv(req, makeDeps(kv, new FakeActorPort(), keys));
    const out = await jsonOf(res);
    expect(out.dynamic_variables.route_hint).toBe("verified");
    expect(out.dynamic_variables.caller_name).toBe("Ahmed");
    expect(out.dynamic_variables.customer_name).toBe("Al-Waha Pharmacies");
    expect(out.dynamic_variables.site_id).toBe("RUH-114");
  });
});
