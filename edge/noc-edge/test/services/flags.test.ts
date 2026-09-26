import { describe, expect, it } from "vitest";
import { read } from "../../src/services/flags";
import { kvKey } from "../../../shared/src/kvkeys";
import { FakeKv } from "../fakes/kv";

const DEMO_CONTACT = ["c-", "demo"].join("");
const T0 = Date.UTC(2026, 8, 26, 6, 0, 0);
const STEP = 100_000;

function kvFor(base: number): FakeKv {
  const kv = new FakeKv();
  kv.setNow(base);
  return kv;
}

describe("flags.read", () => {
  it("returns safe defaults when no flag keys exist", async () => {
    const flags = await read(kvFor(T0), T0);
    expect(flags).toEqual({
      deflection_enabled: true,
      require_pin: false,
      demo_caller: null,
      fault_open_ticket: null,
      fault_dv_delay_ms: null,
    });
  });

  it("parses every flag value", async () => {
    const base = T0 + STEP;
    const kv = kvFor(base);
    await kv.put(kvKey("flag", "deflection_enabled"), "false");
    await kv.put(kvKey("flag", "require_pin"), "true");
    await kv.put(kvKey("flag", "demo_caller"), DEMO_CONTACT);
    await kv.put(kvKey("flag", "fault", "open_ticket"), "503");
    await kv.put(kvKey("flag", "fault", "dv_delay_ms"), "4000");
    const flags = await read(kv, base + 1000);
    expect(flags).toEqual({
      deflection_enabled: false,
      require_pin: true,
      demo_caller: DEMO_CONTACT,
      fault_open_ticket: 503,
      fault_dv_delay_ms: 4000,
    });
  });

  it("rejects an open_ticket fault outside {500,503,504}", async () => {
    const kv = kvFor(T0 + 2 * STEP);
    for (const [i, bad] of ["418", "429", "0", "abc", ""].entries()) {
      await kv.put(kvKey("flag", "fault", "open_ticket"), bad);
      const flags = await read(kv, T0 + 2 * STEP + 6000 * (i + 1));
      expect(flags.fault_open_ticket).toBeNull();
    }
  });

  it("clamps dv_delay_ms to at most 12000 and floors negatives", async () => {
    const kv = kvFor(T0 + 3 * STEP);
    await kv.put(kvKey("flag", "fault", "dv_delay_ms"), "12001");
    expect((await read(kv, T0 + 3 * STEP + 6000)).fault_dv_delay_ms).toBe(12000);
    await kv.put(kvKey("flag", "fault", "dv_delay_ms"), "-5");
    expect((await read(kv, T0 + 3 * STEP + 12_000)).fault_dv_delay_ms).toBe(0);
    await kv.put(kvKey("flag", "fault", "dv_delay_ms"), "abc");
    expect((await read(kv, T0 + 3 * STEP + 18_000)).fault_dv_delay_ms).toBeNull();
  });

  it("memoises for 5 seconds and re-reads after that", async () => {
    const kv = kvFor(T0 + 4 * STEP);
    await kv.put(kvKey("flag", "require_pin"), "true");
    const first = await read(kv, T0 + 4 * STEP);
    expect(first.require_pin).toBe(true);
    await kv.put(kvKey("flag", "require_pin"), "false");
    expect((await read(kv, T0 + 4 * STEP + 4999)).require_pin).toBe(true);
    expect((await read(kv, T0 + 4 * STEP + 5000)).require_pin).toBe(false);
  });
});
