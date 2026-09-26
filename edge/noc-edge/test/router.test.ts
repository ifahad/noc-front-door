import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withErrorHandling, route } from "../src/router";
import type { NocEdgeEnv } from "../src/actors";
import { FakeKv } from "./fakes/kv";
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
