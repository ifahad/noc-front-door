import { describe, expect, it } from "vitest";
import { read } from "../../src/services/flags";
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

  it("a failed read does not poison the memo: the next call retries", async () => {
    const kv = kvFor();
    const slow = slowKv(kv, 20, { failGets: true });
    await expect(read(slow, T0)).rejects.toThrow("injected_slow_error");
    slow.failGets = false;
    const flags = await read(slow, T0 + 10);
    expect(flags).toEqual({
      deflection_enabled: true,
      require_pin: false,
      demo_caller: null,
      fault_open_ticket: null,
      fault_dv_delay_ms: null,
      actor_mode: "per-entity",
    });
    for (const key of FLAG_KEYS) {
      expect(slow.getCalls(key)).toBe(2);
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
