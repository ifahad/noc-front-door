import { describe, expect, it } from "vitest";
import { bearerOk, makeTokenCache, parseBearer } from "../src/auth";

const TOKEN_A = "tok-1";
const TOKEN_B = "tok-2";

describe("parseBearer", () => {
  it("extracts the token from a valid header", () => {
    expect(parseBearer(`Bearer ${TOKEN_A}`)).toBe(TOKEN_A);
  });

  it("accepts a lowercase scheme", () => {
    expect(parseBearer(`bearer ${TOKEN_A}`)).toBe(TOKEN_A);
  });

  it("accepts any case scheme", () => {
    expect(parseBearer(`BeArEr ${TOKEN_A}`)).toBe(TOKEN_A);
  });

  it("returns null when the header is missing", () => {
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
  });

  it("returns null for a malformed header", () => {
    expect(parseBearer(TOKEN_A)).toBeNull();
    expect(parseBearer("Bearer")).toBeNull();
    expect(parseBearer("Bearer a b")).toBeNull();
  });

  it("returns null for an empty token", () => {
    expect(parseBearer("Bearer ")).toBeNull();
    expect(parseBearer("Bearer   ")).toBeNull();
  });
});

describe("bearerOk", () => {
  it("accepts a valid token", () => {
    expect(bearerOk(`Bearer ${TOKEN_A}`, TOKEN_A)).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(bearerOk(`Bearer ${TOKEN_B}`, TOKEN_A)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(bearerOk(null, TOKEN_A)).toBe(false);
    expect(bearerOk(undefined, TOKEN_A)).toBe(false);
  });

  it("rejects a non-bearer scheme", () => {
    expect(bearerOk(`Basic ${TOKEN_A}`, TOKEN_A)).toBe(false);
  });

  it("fails closed against an empty expected secret", () => {
    expect(bearerOk(`Bearer ${TOKEN_A}`, "")).toBe(false);
    expect(bearerOk("Bearer ", "")).toBe(false);
  });
});

describe("makeTokenCache", () => {
  it("memoises the value only after a successful read", async () => {
    let reads = 0;
    let value: string | null = TOKEN_A;
    const get = makeTokenCache(async () => {
      reads += 1;
      if (reads === 1 && value === TOKEN_A) {
        value = null;
        return null;
      }
      return value;
    });
    expect(await get()).toBeNull();
    expect(await get()).toBeNull();
    expect(reads).toBe(2);
    value = TOKEN_A;
    expect(await get()).toBe(TOKEN_A);
    expect(await get()).toBe(TOKEN_A);
    expect(reads).toBe(3);
  });

  it("does not memoise a failed read", async () => {
    let reads = 0;
    const get = makeTokenCache(async () => {
      reads += 1;
      throw new Error("boom");
    });
    await expect(get()).rejects.toThrow("boom");
    await expect(get()).rejects.toThrow("boom");
    expect(reads).toBe(2);
  });
});
