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
    });
  });

  it("rejects an open_ticket fault outside {500,503,504}", async () => {
    const kv = kvFor();
    for (const [i, bad] of ["418", "429", "0", "abc", ""].entries()) {
      await kv.put(kvKey("flag", "fault", "open_ticket"), bad);
      const flags = await read(kv, T0 + 6000 * (i + 1));
      expect(flags.fault_open_ticket).toBeNull();
    }
  });

  it("clamps dv_delay_ms to at most 12000 and floors negatives", async () => {
    const kv = kvFor();
    await kv.put(kvKey("flag", "fault", "dv_delay_ms"), "12001");
    expect((await read(kv, T0 + 6000)).fault_dv_delay_ms).toBe(12000);
    await kv.put(kvKey("flag", "fault", "dv_delay_ms"), "-5");
    expect((await read(kv, T0 + 12_000)).fault_dv_delay_ms).toBe(0);
    await kv.put(kvKey("flag", "fault", "dv_delay_ms"), "abc");
    expect((await read(kv, T0 + 18_000)).fault_dv_delay_ms).toBeNull();
  });

  it("memoises for 5 seconds and re-reads after that", async () => {
    const kv = kvFor();
    await kv.put(kvKey("flag", "require_pin"), "true");
    expect((await read(kv, T0)).require_pin).toBe(true);
    await kv.put(kvKey("flag", "require_pin"), "false");
    expect((await read(kv, T0 + 4999)).require_pin).toBe(true);
    expect((await read(kv, T0 + 5000)).require_pin).toBe(false);
  });

  it("memos are per kv instance, so two stores within 5 s stay independent", async () => {
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
});
