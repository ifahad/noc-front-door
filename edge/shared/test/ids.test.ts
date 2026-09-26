import { describe, expect, it } from "vitest";
import { constantTimeEqual, sha256Hex } from "../src/ids";

describe("sha256Hex", () => {
  it("matches the known vector for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches the known vector for the empty string", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
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
