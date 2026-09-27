import { describe, expect, it } from "vitest";
import type { ActorStorage } from "@telnyx/edge-runtime";
import { FakeStorage } from "../../noc-actors/test/fakes/storage";
import { prefixedStorage } from "../src/prefixedStorage";

const A = "site/RUH-114/";
const B = "site/RUH-115/";

function asActorStorage(s: FakeStorage): ActorStorage {
  return s as unknown as ActorStorage;
}

describe("prefixedStorage", () => {
  it("scopes get/put to the prefix and stores under the prefixed key", async () => {
    const raw = new FakeStorage();
    const a = prefixedStorage(asActorStorage(raw), A);
    const ticket = { id: "NJD-1401" };
    await a.put("ticket", ticket);
    expect(await a.get("ticket")).toEqual(ticket);
    expect(raw.raw(A + "ticket")).toEqual(ticket);
    expect(await a.get<unknown>("missing")).toBeUndefined();
  });

  it("never exposes another prefix's keys", async () => {
    const raw = new FakeStorage();
    const a = prefixedStorage(asActorStorage(raw), A);
    const b = prefixedStorage(asActorStorage(raw), B);
    await a.put("ticket", { id: "NJD-1401" });
    await b.put("ticket", { id: "NJD-1402" });
    expect(await a.get<unknown>("ticket")).toEqual({ id: "NJD-1401" });
    expect(await b.get<unknown>("ticket")).toEqual({ id: "NJD-1402" });
    await a.delete("ticket");
    expect(await b.get<unknown>("ticket")).toEqual({ id: "NJD-1402" });
    expect(raw.raw(A + "ticket")).toBeUndefined();
  });

  it("lists keys with the outer prefix stripped and applies sub-options", async () => {
    const raw = new FakeStorage();
    const a = prefixedStorage(asActorStorage(raw), A);
    const b = prefixedStorage(asActorStorage(raw), B);
    await a.put("z1", 1);
    await a.put("z2", 2);
    await a.put("a0", 0);
    await b.put("z9", 9);
    await raw.put("value", 45);

    expect([...(await a.list<number>()).keys()]).toEqual(["a0", "z1", "z2"]);
    expect([...(await a.list<number>({ prefix: "z" })).keys()]).toEqual(["z1", "z2"]);
    expect([...(await a.list<number>({ prefix: "z1" })).keys()]).toEqual(["z1"]);
    expect([...(await a.list<number>({ startAfter: "z1" })).keys()]).toEqual(["z2"]);
    expect([...(await a.list<number>({ start: "z1" })).keys()]).toEqual(["z1", "z2"]);
    expect([...(await a.list<number>({ end: "z2" })).keys()]).toEqual(["a0", "z1"]);
    expect([...(await a.list<number>({ reverse: true })).keys()]).toEqual(["z2", "z1", "a0"]);
    expect([...(await a.list<number>({ limit: 2 })).keys()]).toEqual(["a0", "z1"]);
    expect((await a.list()).size).toBe(3);
  });

  it("deleteAll removes only keys under the prefix", async () => {
    const raw = new FakeStorage();
    const a = prefixedStorage(asActorStorage(raw), A);
    const b = prefixedStorage(asActorStorage(raw), B);
    await a.put("x", 1);
    await a.put("y", 2);
    await b.put("x", 1);
    await raw.put("value", 45);
    await a.deleteAll();
    expect(await a.get<unknown>("x")).toBeUndefined();
    expect(raw.raw(A + "y")).toBeUndefined();
    expect(raw.raw(B + "x")).toBe(1);
    expect(raw.raw("value")).toBe(45);
  });

  it("reports delete results for keys under the prefix only", async () => {
    const raw = new FakeStorage();
    const a = prefixedStorage(asActorStorage(raw), A);
    await a.put("x", 1);
    expect(await a.delete("x")).toBe(true);
    expect(await a.delete("x")).toBe(false);
    expect(await a.delete("outside")).toBe(false);
  });

  it("alarms are unsupported in mux mode: getAlarm is null, set/delete are no-ops", async () => {
    const raw = new FakeStorage();
    const a = prefixedStorage(asActorStorage(raw), A);
    expect(await a.getAlarm()).toBeNull();
    await a.setAlarm(123);
    await a.deleteAlarm();
    expect(await raw.getAlarm()).toBeNull();
    expect(await a.getAlarm()).toBeNull();
  });
});
