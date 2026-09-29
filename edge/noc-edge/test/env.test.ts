import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@telnyx/edge-runtime";
import { getSecret, loadSeedLocal, makeAdapter } from "../src/env";
import type { SeedLocalConfig } from "../../shared/src/itsm";

afterEach(() => {
  vi.useRealTimers();
});

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

type SecretStep = string | null | Error;

function makeScriptedEnv(steps: SecretStep[]): {
  env: Env;
  calls: { name: string }[];
} {
  const calls: { name: string }[] = [];
  const script = [...steps];
  const env = {
    SECRETS: {
      get: async (name: string) => {
        calls.push({ name });
        const step = script.shift();
        if (step === undefined) throw new Error("script_exhausted");
        if (step instanceof Error) throw step;
        return step;
      },
    },
  } as unknown as Env;
  return { env, calls };
}

function captureLogs(): string[] {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
  return logs;
}

function eventsOf(logs: string[], evt: string): Record<string, unknown>[] {
  return logs
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.evt === evt);
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

  describe("retries transient failures without a per-attempt cap", () => {
    it("succeeds on the second attempt after a throw and logs read_failed then read_recovered", async () => {
      vi.useFakeTimers();
      const logs = captureLogs();
      const { env, calls } = makeScriptedEnv([
        new Error("secret_store_down"),
        PEPPER,
      ]);
      const pending = getSecret(env, "PIN_PEPPER");
      await vi.runAllTimersAsync();
      expect(await pending).toBe(PEPPER);
      expect(calls).toHaveLength(2);
      const failed = eventsOf(logs, "secret.read_failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        hop: "env",
        secret_name: "PIN_PEPPER",
        attempt: 1,
        outcome: "error",
        error: "secret_store_down",
      });
      expect(failed[0]?.lvl).toBe("warn");
      const recovered = eventsOf(logs, "secret.read_recovered");
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        hop: "env",
        secret_name: "PIN_PEPPER",
        attempts: 2,
      });
    });

    it("succeeds on the second attempt after an empty value", async () => {
      vi.useFakeTimers();
      const logs = captureLogs();
      const { env, calls } = makeScriptedEnv(["", PEPPER]);
      const pending = getSecret(env, "PIN_PEPPER");
      await vi.runAllTimersAsync();
      expect(await pending).toBe(PEPPER);
      expect(calls).toHaveLength(2);
      const failed = eventsOf(logs, "secret.read_failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        secret_name: "PIN_PEPPER",
        attempt: 1,
        outcome: "error",
        error: "empty",
      });
      const recovered = eventsOf(logs, "secret.read_recovered");
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({ secret_name: "PIN_PEPPER", attempts: 2 });
    });

    it("gives up after three failures and logs three read_failed lines that name the secret but never its value", async () => {
      vi.useFakeTimers();
      const logs = captureLogs();
      const { env, calls } = makeScriptedEnv([
        new Error("secret_store_down"),
        "",
        "",
      ]);
      const pending = getSecret(env, "MCP_TOKEN");
      await vi.runAllTimersAsync();
      expect(await pending).toBeNull();
      expect(calls).toHaveLength(3);
      const failed = eventsOf(logs, "secret.read_failed");
      expect(failed.map((f) => f.attempt)).toEqual([1, 2, 3]);
      expect(failed.map((f) => f.secret_name)).toEqual([
        "MCP_TOKEN",
        "MCP_TOKEN",
        "MCP_TOKEN",
      ]);
      expect(failed.every((f) => f.lvl === "warn" && f.outcome === "error")).toBe(true);
      expect(eventsOf(logs, "secret.read_recovered")).toHaveLength(0);
      expect(logs.join("\n")).not.toContain(PEPPER);
    });

    it("shares one in-flight read between concurrent callers", async () => {
      vi.useFakeTimers();
      captureLogs();
      const { env, calls } = makeScriptedEnv([PEPPER]);
      const pending = Promise.all([
        getSecret(env, "PIN_PEPPER"),
        getSecret(env, "PIN_PEPPER"),
      ]);
      await vi.runAllTimersAsync();
      expect(await pending).toEqual([PEPPER, PEPPER]);
      expect(calls).toHaveLength(1);
    });

    it("succeeds on a slow 800 ms read instead of capping each attempt", async () => {
      vi.useFakeTimers();
      const logs = captureLogs();
      let calls = 0;
      const env = {
        SECRETS: {
          get: (name: string) => {
            calls += 1;
            if (name !== "PIN_PEPPER") return Promise.resolve("");
            return new Promise<string>((resolve) =>
              setTimeout(() => resolve(PEPPER), 800),
            );
          },
        },
      } as unknown as Env;
      const pending = getSecret(env, "PIN_PEPPER");
      await vi.runAllTimersAsync();
      expect(await pending).toBe(PEPPER);
      expect(calls).toBe(1);
      expect(eventsOf(logs, "secret.read_failed")).toHaveLength(0);
    });

    it("starts a fresh read after a failed one", async () => {
      vi.useFakeTimers();
      captureLogs();
      const { env, calls } = makeScriptedEnv(["", "", "", PEPPER]);
      const first = getSecret(env, "PIN_PEPPER");
      await vi.runAllTimersAsync();
      expect(await first).toBeNull();
      const second = getSecret(env, "PIN_PEPPER");
      await vi.runAllTimersAsync();
      expect(await second).toBe(PEPPER);
      expect(calls).toHaveLength(4);
    });
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

  it("survives one transient read failure before SEED_LOCAL parses", async () => {
    vi.useFakeTimers();
    const logs = captureLogs();
    const { env, calls } = makeScriptedEnv([
      new Error("secret_store_down"),
      SEED_JSON,
    ]);
    const pending = loadSeedLocal(env);
    await vi.runAllTimersAsync();
    const config = await pending;
    expect(config.pins["RUH-114"]).toBe(PIN);
    expect(config.contacts).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(
      eventsOf(logs, "secret.read_failed").map((f) => f.secret_name),
    ).toEqual(["SEED_LOCAL"]);
    expect(eventsOf(logs, "config.seed_local_invalid")).toHaveLength(0);
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
