import { describe, expect, it } from "vitest";
import { kvKey } from "../../../shared/src/kvkeys";
import type { Session } from "../../../shared/src/types";
import {
  byConversation,
  get,
  linkConversation,
  putAuth,
  putDv,
  type AuthSession,
  type DvSession,
} from "../../src/services/sessions";
import { FakeKv } from "../fakes/kv";

const K = ["1a", "2b", "3c", "4d", "5e", "6f", "7a", "8b"].join("");
const CONV_ID = ["conv", "1111", "2222", "3333", "4444"].join("-");

const DV: DvSession = {
  trace_id: "t-" + K,
  identified: true,
  contact_id: "c-ahmed",
  customer_id: "c-alwaha",
  sites: ["RUH-114"],
  region: "riyadh-north",
};

const AUTH: AuthSession = {
  verified: true,
  site_id: "RUH-121",
  customer_id: "c-alwaha",
  at: 1000,
};

describe("sessions.putDv / putAuth / get", () => {
  it("round-trips a dv session with a 3600 s ttl", async () => {
    const kv = new FakeKv();
    kv.setNow(0);
    await putDv(kv, K, DV);
    expect(kv.ttlSecondsLeft(kvKey("call", K, "dv"))).toBe(3600);
    const session = await get(kv, K);
    expect(session).toEqual({
      k: K,
      trace_id: DV.trace_id,
      identified: true,
      verified: false,
      contact_id: "c-ahmed",
      customer_id: "c-alwaha",
      sites: ["RUH-114"],
      region: "riyadh-north",
    } satisfies Session);
  });

  it("auth overrides dv for verified and sites", async () => {
    const kv = new FakeKv();
    kv.setNow(0);
    await putDv(kv, K, DV);
    await putAuth(kv, K, AUTH);
    expect(kv.ttlSecondsLeft(kvKey("call", K, "auth"))).toBe(3600);
    const session = await get(kv, K);
    expect(session.verified).toBe(true);
    expect(session.sites).toEqual(["RUH-121"]);
    expect(session.customer_id).toBe("c-alwaha");
    expect(session.identified).toBe(true);
    expect(session.contact_id).toBe("c-ahmed");
    expect(session.trace_id).toBe(DV.trace_id);
    expect(session.region).toBe("riyadh-north");
  });

  it("returns defaults when neither record exists", async () => {
    const kv = new FakeKv();
    const session = await get(kv, K);
    expect(session).toEqual({
      k: K,
      trace_id: "t-" + K,
      identified: false,
      verified: false,
      contact_id: null,
      customer_id: null,
      sites: [],
      region: null,
    } satisfies Session);
  });

  it("treats a corrupt dv record as absent", async () => {
    const kv = new FakeKv();
    kv.setNow(0);
    await kv.put(kvKey("call", K, "dv"), "{not json");
    await putAuth(kv, K, AUTH);
    const session = await get(kv, K);
    expect(session.verified).toBe(true);
    expect(session.sites).toEqual(["RUH-121"]);
    expect(session.identified).toBe(false);
  });
});

describe("sessions.linkConversation / byConversation", () => {
  it("round-trips a conversation join with a 3600 s ttl", async () => {
    const kv = new FakeKv();
    kv.setNow(0);
    await linkConversation(kv, CONV_ID, K);
    expect(kv.ttlSecondsLeft(kvKey("conv", CONV_ID))).toBe(3600);
    expect(await byConversation(kv, CONV_ID)).toBe(K);
  });

  it("returns null for an unknown conversation", async () => {
    const kv = new FakeKv();
    expect(await byConversation(kv, CONV_ID)).toBeNull();
  });
});
