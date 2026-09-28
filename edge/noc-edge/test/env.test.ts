import { describe, expect, it, vi } from "vitest";
import type { Env } from "@telnyx/edge-runtime";
import { getSecret, loadSeedLocal, makeAdapter } from "../src/env";
import type { SeedLocalConfig } from "../../shared/src/itsm";

const PEPPER = ["p", "e", "pp", "er"].join("");
const PHONE = ["+", "1", "312", "555", "0101"].join("");
const PIN = ["4", "5", "6", "7"].join("");
const SEED_JSON = JSON.stringify({
  pins: { "RUH-114": PIN },
  contacts: [
    {
      contact_id: "c-ahmed",
      phone_digits: PHONE,
      name: "Ahmed",
      site_id: "RUH-114",
      preferred_language: "en",
    },
  ],
});

type SecretMap = Record<string, string | null>;

function makeEnv(values: SecretMap): Env {
  return {
    SECRETS: {
      get: async (name: string) => {
        const value = values[name];
        if (typeof value !== "string") throw new Error("missing_secret");
        return value;
      },
    },
  } as unknown as Env;
}

describe("getSecret", () => {
  it("memoises only after a non-empty success", async () => {
    const values: SecretMap = { PIN_PEPPER: PEPPER };
    const env = makeEnv(values);
    expect(await getSecret(env, "PIN_PEPPER")).toBe(PEPPER);
    values.PIN_PEPPER = ["n", "e", "w"].join("");
    expect(await getSecret(env, "PIN_PEPPER")).toBe(PEPPER);
  });

  it("does not memoise an empty value and retries", async () => {
    const values: SecretMap = { PIN_PEPPER: "" };
    const env = makeEnv(values);
    expect(await getSecret(env, "PIN_PEPPER")).toBeNull();
    expect(await getSecret(env, "PIN_PEPPER")).toBeNull();
    values.PIN_PEPPER = PEPPER;
    expect(await getSecret(env, "PIN_PEPPER")).toBe(PEPPER);
    expect(await getSecret(env, "PIN_PEPPER")).toBe(PEPPER);
  });

  it("does not memoise a thrown read and retries", async () => {
    const values: SecretMap = {};
    const env = makeEnv(values);
    expect(await getSecret(env, "PIN_PEPPER")).toBeNull();
    expect(await getSecret(env, "PIN_PEPPER")).toBeNull();
    values.PIN_PEPPER = PEPPER;
    expect(await getSecret(env, "PIN_PEPPER")).toBe(PEPPER);
  });

  it("caches per secret name", async () => {
    const env = makeEnv({ PIN_PEPPER: PEPPER, MCP_TOKEN: "mcp-token-value" });
    expect(await getSecret(env, "PIN_PEPPER")).toBe(PEPPER);
    expect(await getSecret(env, "MCP_TOKEN")).toBe("mcp-token-value");
  });
});

describe("loadSeedLocal", () => {
  it("parses SEED_LOCAL once", async () => {
    const values: SecretMap = { SEED_LOCAL: SEED_JSON };
    const env = makeEnv(values);
    const first = await loadSeedLocal(env);
    expect(first.pins["RUH-114"]).toBe(PIN);
    expect(first.contacts).toHaveLength(1);
    expect(first.contacts[0].contact_id).toBe("c-ahmed");
    expect(first.contacts[0].phone_digits).toBe(PHONE);
    const again = await loadSeedLocal(env);
    expect(again).toBe(first);
    values.SEED_LOCAL = "{}";
    expect(await loadSeedLocal(env)).toBe(first);
  });

  it("falls back to empty defaults for a missing or invalid secret", async () => {
    expect(await loadSeedLocal(makeEnv({}))).toEqual({ pins: {}, contacts: [] });
    expect(await loadSeedLocal(makeEnv({ SEED_LOCAL: "{not json" }))).toEqual({
      pins: {},
      contacts: [],
    });
    expect(await loadSeedLocal(makeEnv({ SEED_LOCAL: "" }))).toEqual({
      pins: {},
      contacts: [],
    });
  });

  it("does not memoise a failed read", async () => {
    const values: SecretMap = { SEED_LOCAL: "{not json" };
    const env = makeEnv(values);
    expect(await loadSeedLocal(env)).toEqual({ pins: {}, contacts: [] });
    values.SEED_LOCAL = SEED_JSON;
    const config = await loadSeedLocal(env);
    expect(config.contacts).toHaveLength(1);
    expect(await loadSeedLocal(env)).toBe(config);
  });

  it("normalises partial payloads", async () => {
    const config: SeedLocalConfig = await loadSeedLocal(
      makeEnv({ SEED_LOCAL: JSON.stringify({ contacts: [{ contact_id: "c-x" }] }) }),
    );
    expect(config.pins).toEqual({});
    expect(config.contacts).toEqual([{ contact_id: "c-x", phone_digits: null }]);
  });

  it("logs config.seed_local_invalid once per isolate for an unreadable or unparsable secret", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    const env = makeEnv({ SEED_LOCAL: "{not json" });
    await loadSeedLocal(env);
    await loadSeedLocal(env);
    const missing = makeEnv({});
    await loadSeedLocal(missing);
    const lines = logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.evt === "config.seed_local_invalid");
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.reason)).toEqual(["unparsable", "read_failed"]);
    expect(JSON.stringify(lines)).not.toContain("{not json");
    expect(JSON.stringify(lines)).not.toContain(SEED_JSON);
    vi.restoreAllMocks();
  });
});

describe("makeAdapter", () => {
  it("builds a working adapter from env secrets and memoises it per env", async () => {
    const env = makeEnv({ PIN_PEPPER: PEPPER, SEED_LOCAL: SEED_JSON });
    const adapter = await makeAdapter(env);
    expect(await adapter.checkPin(PIN, "RUH-114")).toBe(true);
    expect(await adapter.checkPin(["9", "9", "9", "9"].join(""), "RUH-114")).toBe(false);
    expect(await adapter.findContactById("c-ahmed")).not.toBeNull();
    expect(await makeAdapter(env)).toBe(adapter);
    expect(await makeAdapter(makeEnv({ PIN_PEPPER: PEPPER, SEED_LOCAL: SEED_JSON }))).not.toBe(
      adapter,
    );
  });

  it("still returns an adapter when the pepper is missing", async () => {
    const adapter = await makeAdapter(makeEnv({ SEED_LOCAL: SEED_JSON }));
    expect(await adapter.findContactById("c-ahmed")).not.toBeNull();
    await expect(adapter.pinHashFor("RUH-114")).rejects.toThrow();
  });
});
