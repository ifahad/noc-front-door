import { describe, expect, it } from "vitest";
import { SeedAdapter } from "../../../shared/src/itsm";
import type { SeedLocalConfig } from "../../../shared/src/itsm";
import { kvKey } from "../../../shared/src/kvkeys";
import type { Contact } from "../../../shared/src/types";
import type { Flags } from "../../src/services/flags";
import { lookup } from "../../src/services/directory";
import { FakeKv } from "../fakes/kv";

const E164 = ["+", "1", "312", "555", "0101"].join("");
const ALT_E164 = ["+", "1", "312", "555", "0202"].join("");
const PEPPER = ["p", "e", "pp", "er"].join("");

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

const FLAGS: Flags = {
  deflection_enabled: true,
  require_pin: false,
  demo_caller: null,
  fault_open_ticket: null,
  fault_dv_delay_ms: null,
  actor_mode: "per-entity",
};

function adapter(seedLocal = SEED_LOCAL): SeedAdapter {
  return new SeedAdapter({ seedLocal, pepper: PEPPER, now: () => 0 });
}

function deps(kv: FakeKv, a = adapter(), flags: Flags = FLAGS) {
  return { kv, adapter: a, flags };
}

describe("directory.lookup", () => {
  it("returns null for a SIP URI caller", async () => {
    const kv = new FakeKv();
    const contact = await lookup(deps(kv), "sip:caller@example.com");
    expect(contact).toBeNull();
    expect(kv.calls.every((c) => c.op !== "put")).toBe(true);
  });

  it("returns the demo contact when demo_caller is set and the target is not E.164", async () => {
    const kv = new FakeKv();
    const contact = await lookup(
      deps(kv, adapter(), { ...FLAGS, demo_caller: "c-ahmed" }),
      "sip:caller@example.com",
    );
    expect(contact?.contact_id).toBe("c-ahmed");
    expect(contact?.site_id).toBe("RUH-114");
  });

  it("resolves an E.164 caller through the adapter and caches it", async () => {
    const kv = new FakeKv();
    const a = adapter();
    const first = await lookup(deps(kv, a), E164);
    expect(first?.contact_id).toBe("c-ahmed");
    const key = kvKey("dir", E164.replace(/[^0-9]/g, ""));
    expect(kv.has(key)).toBe(true);
    expect(kv.ttlSecondsLeft(key)).toBe(300);
    const second = await lookup(deps(kv, a), E164);
    expect(second?.contact_id).toBe("c-ahmed");
    expect(kv.puts(key)).toBe(1);
  });

  it("returns null for an unknown E.164 caller and caches nothing", async () => {
    const kv = new FakeKv();
    const contact = await lookup(deps(kv), ALT_E164);
    expect(contact).toBeNull();
    expect(kv.calls.every((c) => c.op !== "put")).toBe(true);
  });

  it("prefers the kv hit and does not call the adapter again", async () => {
    const kv = new FakeKv();
    const a = adapter();
    await lookup(deps(kv, a), E164);
    const key = kvKey("dir", E164.replace(/[^0-9]/g, ""));
    const kvOnly = new FakeKv();
    kvOnly.setNow(0);
    await kvOnly.put(key, JSON.stringify(firstContact()));
    const contact = await lookup(deps(kvOnly, a), E164);
    expect(contact?.contact_id).toBe("c-ahmed");
    expect(kvOnly.puts(key)).toBe(1);
  });

  it("treats a corrupt kv value as a miss and re-caches from the adapter", async () => {
    const kv = new FakeKv();
    kv.setNow(0);
    await kv.put(kvKey("dir", E164.replace(/[^0-9]/g, "")), "{not json");
    const contact = await lookup(deps(kv), E164);
    expect(contact?.contact_id).toBe("c-ahmed");
    const key = kvKey("dir", E164.replace(/[^0-9]/g, ""));
    expect(JSON.parse(kv.raw(key) as string)).toHaveProperty("contact_id");
  });

  it("an expired cache entry falls through to the adapter", async () => {
    const kv = new FakeKv();
    const a = adapter();
    await lookup(deps(kv, a), E164);
    kv.setNow(301_000);
    const contact = await lookup(deps(kv, a), E164);
    expect(contact?.contact_id).toBe("c-ahmed");
    const key = kvKey("dir", E164.replace(/[^0-9]/g, ""));
    expect(kv.puts(key)).toBe(2);
  });

  it("a demo contact that cannot be resolved returns null", async () => {
    const kv = new FakeKv();
    const contact = await lookup(
      deps(kv, adapter(), { ...FLAGS, demo_caller: "c-ghost" }),
      "sip:caller@example.com",
    );
    expect(contact).toBeNull();
  });

  it("an E.164 caller still goes through the normal path with demo_caller set", async () => {
    const kv = new FakeKv();
    const a = adapter();
    const contact = await lookup(
      deps(kv, a, { ...FLAGS, demo_caller: "c-ahmed" }),
      E164,
    );
    expect((contact as Contact).contact_id).toBe("c-ahmed");
    expect(kv.has(kvKey("dir", E164.replace(/[^0-9]/g, "")))).toBe(true);
  });
});

function firstContact(): Contact {
  return {
    contact_id: "c-ahmed",
    name: "Ahmed",
    customer_id: "c-alwaha",
    customer_name: "Al-Waha Pharmacies",
    site_id: "RUH-114",
    site_label: "the Al Yasmin branch",
    region: "riyadh-north",
    region_label: "Riyadh North",
    preferred_language: "en",
  };
}
