import { describe, expect, it } from "vitest";
import { sessionKey } from "../../../shared/src/ids";
import { kvKey } from "../../../shared/src/kvkeys";
import { putAuth, putDv } from "../../src/services/sessions";
import type { KvPort } from "../../src/services/kvPort";
import {
  SAFE_FLAGS,
  flagsBounded,
  readSessionBounded,
} from "../../src/tools/common";
import { CCID, makeDeps, makeKeys, newKv } from "./helpers";

const K = (await sessionKey({ call_control_id: CCID })) as string;

function hangKv(): KvPort {
  return {
    get: () => new Promise<string | null>(() => undefined),
    put: () => new Promise<void>(() => undefined),
    delete: () => new Promise<void>(() => undefined),
    list: () => new Promise<string[]>(() => undefined),
  };
}

describe("readSessionBounded", () => {
  it("returns the KV session when KV answers", async () => {
    const kv = newKv();
    await putDv(kv, K, {
      trace_id: `t-${K}`,
      identified: true,
      contact_id: "c-ahmed",
      customer_id: "c-alwaha",
      sites: ["RUH-114"],
      region: "riyadh-north",
    });
    await putAuth(kv, K, {
      verified: true,
      site_id: "RUH-114",
      customer_id: "c-alwaha",
      at: 0,
    });
    const r = await readSessionBounded(kv, K, 2500);
    expect(r.fromKv).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.session.identified).toBe(true);
    expect(r.session.verified).toBe(true);
    expect(r.session.sites).toEqual(["RUH-114"]);
    expect(r.session.k).toBe(K);
  });

  it("returns an empty session when KV rejects", async () => {
    const kv = newKv();
    kv.failNext(2);
    const r = await readSessionBounded(kv, K, 2500);
    expect(r.fromKv).toBe(false);
    expect(r.session).toEqual({
      k: K,
      trace_id: `t-${K}`,
      identified: false,
      verified: false,
      contact_id: null,
      customer_id: null,
      sites: [],
      region: null,
    });
  });

  it("returns an empty session within the budget when KV hangs", async () => {
    const started = Date.now();
    const r = await readSessionBounded(hangKv(), K, 50);
    const elapsed = Date.now() - started;
    expect(r.fromKv).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.session.identified).toBe(false);
    expect(r.session.sites).toEqual([]);
    expect(r.pending).not.toBeNull();
    expect(elapsed).toBeLessThan(500);
  });
});

describe("flagsBounded", () => {
  it("returns the flags from KV when KV answers", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    await kv.put(kvKey("flag", "deflection_enabled"), "false");
    const flags = await flagsBounded(makeDeps(kv, null as never, keys), 2500);
    expect(flags.deflection_enabled).toBe(false);
  });

  it("returns SAFE_FLAGS when the read hangs", async () => {
    const keys = await makeKeys();
    const started = Date.now();
    const flags = await flagsBounded(makeDeps(hangKv(), null as never, keys), 50);
    const elapsed = Date.now() - started;
    expect(flags).toEqual(SAFE_FLAGS);
    expect(elapsed).toBeLessThan(500);
  });
});
