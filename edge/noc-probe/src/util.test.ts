import { describe, expect, it } from "vitest";
import {
  sha256Hex,
  pickCallKey,
  pickToolCallKey,
  constantTimeEqual,
  keyPaths,
  findValue,
} from "./util";

describe("sha256Hex", () => {
  it("matches the known vector for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("matches the known vector for the empty string", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
});

describe("pickCallKey", () => {
  it("returns data.payload.call_control_id when it is a non-empty string", () => {
    const body = { data: { payload: { call_control_id: "call-abc-123" } } };
    expect(pickCallKey(body)).toBe("call-abc-123");
  });

  it("falls back to a dv- key when call_control_id is missing", () => {
    const key = pickCallKey({ data: { payload: {} } });
    expect(key.startsWith("dv-")).toBe(true);
    expect(key).toHaveLength(11);
  });

  it("falls back when call_control_id is not a string", () => {
    const key = pickCallKey({ data: { payload: { call_control_id: 42 } } });
    expect(key.startsWith("dv-")).toBe(true);
    expect(key).toHaveLength(11);
  });

  it("falls back when call_control_id is empty", () => {
    const key = pickCallKey({ data: { payload: { call_control_id: "" } } });
    expect(key.startsWith("dv-")).toBe(true);
    expect(key).toHaveLength(11);
  });

  it("falls back when the body is not an object", () => {
    const key = pickCallKey(null);
    expect(key.startsWith("dv-")).toBe(true);
    expect(key).toHaveLength(11);
  });
});

describe("pickToolCallKey", () => {
  it("returns body.call_key when valid", () => {
    expect(pickToolCallKey({ call_key: "abc123" })).toBe("abc123");
  });

  it("falls back when call_key is 'none'", () => {
    const key = pickToolCallKey({ call_key: "none" });
    expect(key.startsWith("tool-")).toBe(true);
    expect(key).toHaveLength(13);
  });

  it("falls back when call_key contains an unresolved template", () => {
    const key = pickToolCallKey({ call_key: "{{custom.call_key}}" });
    expect(key.startsWith("tool-")).toBe(true);
    expect(key).toHaveLength(13);
  });

  it("falls back when call_key is missing or empty", () => {
    expect(pickToolCallKey({}).startsWith("tool-")).toBe(true);
    expect(pickToolCallKey({ call_key: "" }).startsWith("tool-")).toBe(true);
    expect(pickToolCallKey(null).startsWith("tool-")).toBe(true);
  });
});

describe("keyPaths", () => {
  it("flattens nested keys with dot separators", () => {
    expect(keyPaths({ data: { payload: { call_control_id: "c1" } } })).toEqual([
      "data.payload.call_control_id",
    ]);
  });

  it("handles scalars, arrays and empty containers", () => {
    expect(keyPaths({ a: 1, b: [true, null] })).toEqual(["a", "b.0", "b.1"]);
    expect(keyPaths({ data: { payload: {} } })).toEqual(["data.payload"]);
    expect(keyPaths({ empty: [] })).toEqual(["empty"]);
  });
});

describe("findValue", () => {
  it("finds a value at any depth by key", () => {
    const body = { data: { event_type: "call.answered", payload: { from: "x" } } };
    expect(findValue(body, "event_type")).toBe("call.answered");
    expect(findValue(body, "from")).toBe("x");
  });

  it("returns undefined when the key is absent", () => {
    expect(findValue({ a: 1 }, "missing")).toBeUndefined();
    expect(findValue(null, "event_type")).toBeUndefined();
  });
});

describe("constantTimeEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqual("tok-1", "tok-1")).toBe(true);
  });

  it("returns false for different strings of equal length", () => {
    expect(constantTimeEqual("tok-1", "tok-2")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(constantTimeEqual("tok-1", "tok-12")).toBe(false);
  });

  it("returns false when one side is not a string", () => {
    expect(constantTimeEqual(null, "tok-1")).toBe(false);
    expect(constantTimeEqual("tok-1", undefined)).toBe(false);
  });
});
