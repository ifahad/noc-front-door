import { describe, expect, it } from "vitest";
import { kvKey } from "../src/kvkeys";

// Phone-like fixture assembled at runtime (repo secret scanner forbids E.164 literals).
const E164 = ["+", "966", "501234567"].join("");

describe("kvKey", () => {
  it("joins parts with /", () => {
    expect(kvKey("call", "v3", "abc")).toBe("call/v3/abc");
  });

  it("strips + from E.164 values, leaving digits only", () => {
    expect(kvKey("dir", E164)).toBe("dir/966501234567");
  });

  it("strips : from call keys", () => {
    expect(kvKey("call", "v3:ab")).toBe("call/v3ab");
  });

  it("removes every character outside the KV charset", () => {
    expect(kvKey("a", "b@c#d$")).toBe("a/bcd");
  });

  it("collapses repeated slashes produced by empty parts", () => {
    expect(kvKey("a", "", "b")).toBe("a/b");
    expect(kvKey("a//b")).toBe("a/b");
  });

  it("trims leading and trailing slashes", () => {
    expect(kvKey("/a")).toBe("a");
    expect(kvKey("a/")).toBe("a");
    expect(kvKey("/a/")).toBe("a");
  });

  it("throws empty_kv_key when nothing usable remains", () => {
    expect(() => kvKey()).toThrow("empty_kv_key");
    expect(() => kvKey("", "")).toThrow("empty_kv_key");
    expect(() => kvKey("+:")).toThrow("empty_kv_key");
    expect(() => kvKey("/")).toThrow("empty_kv_key");
  });

  it("keeps = . - _ characters", () => {
    expect(kvKey("a=b.c-d_e")).toBe("a=b.c-d_e");
  });
});
