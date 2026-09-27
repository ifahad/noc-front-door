import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logEvent } from "../src/log";

type Line = Record<string, unknown>;

// Secret-shaped fixtures are assembled at runtime (repo secret scanner forbids literals).
const PIN_VALUE = ["4", "1", "1", "4"].join("");
const BEARER = ["B", "earer", " s", "ess", "ion"].join("");
const P11 = ["+", "966", "501234567"].join("");
const P11_MASKED = ["+", "9665", "****", "567"].join("");

describe("noc-edge logEvent", () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redacts secret-named keys at any depth", () => {
    logEvent("tool.verify_site", {
      hop: "tool",
      outcome: "ok",
      pin: PIN_VALUE,
      detail: {
        token: BEARER,
        nested: { authorization: `Basic ${BEARER}`, keep: "visible" },
        list: [{ apiKey: "k".repeat(8) }],
      },
    });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Line;
    expect(parsed.pin).toBe("[redacted]");
    const detail = parsed.detail as Record<string, unknown>;
    expect(detail.token).toBe("[redacted]");
    const nested = detail.nested as Record<string, unknown>;
    expect(nested.authorization).toBe("[redacted]");
    expect(nested.keep).toBe("visible");
    expect((detail.list as Record<string, unknown>[])[0].apiKey).toBe("[redacted]");
  });

  it("always writes svc, hop and evt with noc-edge as the service", () => {
    logEvent("mcp.session", { outcome: "ok" });

    const parsed = JSON.parse(lines[0]) as Line;
    expect(parsed.svc).toBe("noc-edge");
    expect(parsed.hop).toBe("none");
    expect(parsed.evt).toBe("mcp.session");
  });

  it("keeps the caller's hop and masks phone numbers in logged values", () => {
    logEvent("dv.request", { hop: "dv", outcome: "ok", caller: P11 });

    const parsed = JSON.parse(lines[0]) as Line;
    expect(parsed.hop).toBe("dv");
    expect(parsed.caller).toBe(P11_MASKED);
  });

  it("honours an explicit lvl", () => {
    logEvent("tool.verify_site", { hop: "tool", lvl: "warn" });

    const parsed = JSON.parse(lines[0]) as Line;
    expect(parsed.lvl).toBe("warn");
  });
});
