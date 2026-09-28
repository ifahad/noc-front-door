import { describe, expect, it } from "vitest";
import {
  ACTOR_MODE_DEFAULT,
  FALLBACK_FLAGS,
  NEG_MEMO_MS,
  __setNegJitterForTests,
  read,
} from "../../src/services/flags";
import { kvKey } from "../../../shared/src/kvkeys";
import { FakeKv } from "../fakes/kv";

const DEMO_CONTACT = ["c-", "demo"].join("");
const T0 = Date.UTC(2026, 8, 26, 6, 0, 0);

function kvFor(): FakeKv {
  const kv = new FakeKv();
  kv.setNow(T0);
  return kv;
}

describe("flags.read", () => {
  it("returns safe defaults when no flag keys exist", async () => {
    const flags = await read(kvFor(), T0);
    expect(flags).toEqual({
      deflection_enabled: true,
      require_pin: false,
      demo_caller: null,
      fault_open_ticket: null,
      fault_dv_delay_ms: null,
      actor_mode: "per-entity",
    });
  });

  it("parses every flag value", async () => {
    const kv = kvFor();
    await kv.put(kvKey("flag", "deflection_enabled"), "false");
    await kv.put(kvKey("flag", "require_pin"), "true");
    await kv.put(kvKey("flag", "demo_caller"), DEMO_CONTACT);
    await kv.put(kvKey("flag", "fault", "open_ticket"), "503");
    await kv.put(kvKey("flag", "fault", "dv_delay_ms"), "4000");
    expect(await read(kv, T0 + 1000)).toEqual({
      deflection_enabled: false,
      require_pin: true,
      demo_caller: DEMO_CONTACT,
      fault_open_ticket: 503,
      fault_dv_delay_ms: 4000,
      actor_mode: "per-entity",
    });
  });

  it("parses actor_mode: mux only for the exact value, anything else per-entity", async () => {
    const kv = kvFor();
    await kv.put(kvKey("flag", "actor_mode"), "mux");
    expect((await read(kv, T0 + 1000)).actor_mode).toBe("mux");
    await kv.put(kvKey("flag", "actor_mode"), "per-entity");
    expect((await read(kv, T0 + 61_000)).actor_mode).toBe("per-entity");
    for (const [i, bad] of ["MUX", "mux ", "", "0", "weird"].entries()) {
      await kv.put(kvKey("flag", "actor_mode"), bad);
      const flags = await read(kv, T0 + 61_000 * (i + 2));
      expect(flags.actor_mode).toBe("per-entity");
    }
  });

  it("rejects an open_ticket fault outside {500,503,504}", async () => {
    const kv = kvFor();
    for (const [i, bad] of ["418", "429", "0", "abc", ""].entries()) {
      await kv.put(kvKey("flag", "fault", "open_ticket"), bad);
      const flags = await read(kv, T0 + 61_000 * (i + 1));
      expect(flags.fault_open_ticket).toBeNull();
    }
  });

  it("clamps dv_delay_ms to at most 12000 and floors negatives", async () => {
    const kv = kvFor();
    await kv.put(kvKey("flag", "fault", "dv_delay_ms"), "12001");
    expect((await read(kv, T0 + 61_000)).fault_dv_delay_ms).toBe(12000);
    await kv.put(kvKey("flag", "fault", "dv_delay_ms"), "-5");
    expect((await read(kv, T0 + 122_000)).fault_dv_delay_ms).toBe(0);
    await kv.put(kvKey("flag", "fault", "dv_delay_ms"), "abc");
    expect((await read(kv, T0 + 183_000)).fault_dv_delay_ms).toBeNull();
  });

  it("memoises for 60 seconds and re-reads after that", async () => {
    const kv = kvFor();
    await kv.put(kvKey("flag", "require_pin"), "true");
    expect((await read(kv, T0)).require_pin).toBe(true);
    await kv.put(kvKey("flag", "require_pin"), "false");
    expect((await read(kv, T0 + 59_999)).require_pin).toBe(true);
    expect((await read(kv, T0 + 60_000)).require_pin).toBe(false);
  });

  it("memos are per kv instance, so two stores within 60 s stay independent", async () => {
    const kvA = kvFor();
    const kvB = kvFor();
    await kvA.put(kvKey("flag", "require_pin"), "true");
    await kvB.put(kvKey("flag", "require_pin"), "false");
    expect((await read(kvA, T0)).require_pin).toBe(true);
    expect((await read(kvB, T0 + 10)).require_pin).toBe(false);
    await kvA.put(kvKey("flag", "require_pin"), "false");
    expect((await read(kvA, T0 + 20)).require_pin).toBe(true);
    expect((await read(kvB, T0 + 30)).require_pin).toBe(false);
  });

  it("single-flights a slow read: concurrent calls fetch each flag key once", async () => {
    const kv = kvFor();
    const slow = slowKv(kv, 50);
    const [a, b] = await Promise.all([read(slow, T0), read(slow, T0)]);
    expect(a).toEqual(b);
    for (const key of FLAG_KEYS) {
      expect(slow.getCalls(key)).toBe(1);
    }
  });

  it("single-flights across sequential interleaving: a call during an in-flight read reuses it", async () => {
    const kv = kvFor();
    const slow = slowKv(kv, 50);
    const first = read(slow, T0);
    await sleep(5);
    const second = read(slow, T0);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    for (const key of FLAG_KEYS) {
      expect(slow.getCalls(key)).toBe(1);
    }
  });

  it("neg-memoises a failed read for 30 s: the next read returns FALLBACK_FLAGS without KV calls", async () => {
    const kv = kvFor();
    const slow = slowKv(kv, 20, { failGets: true });
    __setNegJitterForTests(() => 0);
    await expect(read(slow, T0)).rejects.toThrow("injected_slow_error");
    expect(await read(slow, T0 + 1000)).toEqual({
      deflection_enabled: true,
      require_pin: true,
      demo_caller: null,
      fault_open_ticket: null,
      fault_dv_delay_ms: null,
      actor_mode: "mux",
    });
    expect(await read(slow, T0 + 1000)).toBe(FALLBACK_FLAGS);
    for (const key of FLAG_KEYS) {
      expect(slow.getCalls(key)).toBe(1);
    }
  });

  it("never serves actor_mode per-entity from the fallback", async () => {
    const kv = kvFor();
    const slow = slowKv(kv, 20, { failGets: true });
    __setNegJitterForTests(() => 0);
    await expect(read(slow, T0)).rejects.toThrow("injected_slow_error");
    const flags = await read(slow, T0 + 1000);
    expect(flags.actor_mode).toBe(ACTOR_MODE_DEFAULT);
    expect(flags.actor_mode).not.toBe("per-entity");
  });

  it("the negative memo serves the last successful flags", async () => {
    const kv = kvFor();
    const slow = slowKv(kv, 20);
    __setNegJitterForTests(() => 0);
    await kv.put(kvKey("flag", "require_pin"), "true");
    await kv.put(kvKey("flag", "actor_mode"), "per-entity");
    expect((await read(slow, T0)).require_pin).toBe(true);
    slow.failGets = true;
    await expect(read(slow, T0 + 61_000)).rejects.toThrow("injected_slow_error");
    const flags = await read(slow, T0 + 61_500);
    expect(flags.require_pin).toBe(true);
    expect(flags.actor_mode).toBe("per-entity");
    for (const key of FLAG_KEYS) {
      expect(slow.getCalls(key)).toBe(2);
    }
  });

  it("retries KV after the negative memo expires", async () => {
    const kv = kvFor();
    const slow = slowKv(kv, 20, { failGets: true });
    __setNegJitterForTests(() => 1234);
    await expect(read(slow, T0)).rejects.toThrow("injected_slow_error");
    expect(await read(slow, T0 + NEG_MEMO_MS - 1)).toEqual(FALLBACK_FLAGS);
    expect(await read(slow, T0 + NEG_MEMO_MS + 1233)).toEqual(FALLBACK_FLAGS);
    for (const key of FLAG_KEYS) {
      expect(slow.getCalls(key)).toBe(1);
    }
    await expect(read(slow, T0 + NEG_MEMO_MS + 1234)).rejects.toThrow(
      "injected_slow_error",
    );
    for (const key of FLAG_KEYS) {
      expect(slow.getCalls(key)).toBe(2);
    }
    expect(await read(slow, T0 + NEG_MEMO_MS + 1235)).toEqual(FALLBACK_FLAGS);
    for (const key of FLAG_KEYS) {
      expect(slow.getCalls(key)).toBe(2);
    }
  });

  it("a success after a failure restores the normal 60 s memo", async () => {
    const kv = kvFor();
    const slow = slowKv(kv, 20, { failGets: true });
    __setNegJitterForTests(() => 0);
    await expect(read(slow, T0)).rejects.toThrow("injected_slow_error");
    expect(await read(slow, T0 + 1000)).toEqual(FALLBACK_FLAGS);
    slow.failGets = false;
    await kv.put(kvKey("flag", "require_pin"), "true");
    const at = T0 + NEG_MEMO_MS;
    expect((await read(slow, at)).require_pin).toBe(true);
    await kv.put(kvKey("flag", "require_pin"), "false");
    expect((await read(slow, at + 59_999)).require_pin).toBe(true);
    expect((await read(slow, at + 60_000)).require_pin).toBe(false);
    for (const key of FLAG_KEYS) {
      expect(slow.getCalls(key)).toBe(3);
    }
  });
});

const FLAG_KEYS = [
  kvKey("flag", "deflection_enabled"),
  kvKey("flag", "require_pin"),
  kvKey("flag", "demo_caller"),
  kvKey("flag", "fault", "open_ticket"),
  kvKey("flag", "fault", "dv_delay_ms"),
  kvKey("flag", "actor_mode"),
] as const;

interface SlowKv {
  getCalls(key: string): number;
  failGets: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slowKv(inner: FakeKv, ms: number, opts: { failGets?: boolean } = {}): FakeKv & SlowKv {
  const counts = new Map<string, number>();
  const wrapper: FakeKv & SlowKv = {
    failGets: opts.failGets ?? false,
    getCalls(key: string): number {
      return counts.get(key) ?? 0;
    },
    async get(key: string): Promise<string | null> {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      await sleep(ms);
      if (wrapper.failGets) throw new Error("injected_slow_error");
      return inner.get(key);
    },
    put: (key: string, value: string, o?: { expirationTtl?: number }) => inner.put(key, value, o),
    delete: (key: string) => inner.delete(key),
    list: (prefix: string) => inner.list(prefix),
  } as unknown as FakeKv & SlowKv;
  return wrapper;
}
