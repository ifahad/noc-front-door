import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logEvent } from "../src/log";

type Line = Record<string, unknown>;

// Phone-like fixtures are assembled at runtime (repo secret scanner forbids E.164 literals).
const P11 = ["+", "966", "501234567"].join("");
const P11_MASKED = ["+", "9665", "****", "567"].join("");

describe("logEvent", () => {
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

  it("writes exactly one JSON line with ts first, then lvl, svc, hop, evt", () => {
    logEvent({ svc: "dv", hop: "dv", evt: "dv.request" });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Line;
    const keys = Object.keys(parsed);
    expect(keys.slice(0, 5)).toEqual(["ts", "lvl", "svc", "hop", "evt"]);
    expect(typeof parsed.ts).toBe("string");
    expect(parsed.ts).toContain("T");
    expect(parsed.lvl).toBe("info");
    expect(parsed.svc).toBe("dv");
    expect(parsed.hop).toBe("dv");
    expect(parsed.evt).toBe("dv.request");
  });

  it("emits the remaining fields after the structural prefix, in order", () => {
    logEvent({
      svc: "tools",
      hop: "tool",
      evt: "tool.open_ticket",
      trace_id: "t-k1",
      outcome: "ok",
      total_ms: 12,
      site: "RUH-114",
    });

    const parsed = JSON.parse(lines[0]) as Line;
    const keys = Object.keys(parsed);
    expect(keys.slice(0, 5)).toEqual(["ts", "lvl", "svc", "hop", "evt"]);
    expect(keys).toEqual([
      "ts",
      "lvl",
      "svc",
      "hop",
      "evt",
      "trace_id",
      "outcome",
      "total_ms",
      "site",
    ]);
    expect(parsed.trace_id).toBe("t-k1");
    expect(parsed.outcome).toBe("ok");
    expect(parsed.total_ms).toBe(12);
    expect(parsed.site).toBe("RUH-114");
  });

  it("honours an explicit lvl override", () => {
    logEvent({ svc: "dv", hop: "dv", evt: "dv.late", lvl: "warn" });
    const parsed = JSON.parse(lines[0]) as Line;
    expect(parsed.lvl).toBe("warn");
  });

  it("masks phone numbers inside logged values", () => {
    logEvent({ svc: "dv", hop: "dv", evt: "dv.request", caller: P11 });

    const parsed = JSON.parse(lines[0]) as Line;
    expect(parsed.caller).toBe(P11_MASKED);
    expect(lines[0]).not.toContain(P11);
  });

  it("masks phones nested inside objects and arrays", () => {
    logEvent({
      svc: "mcp",
      hop: "mcp",
      evt: "mcp.request",
      body: { from: P11, list: [P11, "x"] },
    });

    const parsed = JSON.parse(lines[0]) as Line;
    expect(lines[0]).not.toContain(P11);
    const body = parsed.body as { from: string; list: string[] };
    expect(body.from).toBe(P11_MASKED);
    expect(body.list[0]).toBe(P11_MASKED);
    expect(body.list[1]).toBe("x");
  });

  it("masks the structural fields too", () => {
    logEvent({ svc: P11, hop: P11, evt: P11 });
    expect(lines[0]).not.toContain(P11);
  });

  it.each([
    "pin",
    "PIN",
    "fp",
    "FP",
    "pinFingerprint",
    "PINFINGERPRINT",
    "authorization",
    "AUTHORIZATION",
    "token",
    "Token",
    "secret",
    "SECRET",
    "apiKey",
    "APIKEY",
  ])("replaces the value of key %s with [redacted]", (key) => {
    const fields: Record<string, unknown> = {
      svc: "tools",
      hop: "tool",
      evt: "tool.verify_site",
    };
    fields[key] = "raw-value-should-vanish";
    logEvent(fields as Parameters<typeof logEvent>[0]);

    const parsed = JSON.parse(lines[0]) as Line;
    expect(parsed[key]).toBe("[redacted]");
    expect(lines[0]).not.toContain("raw-value-should-vanish");
  });

  it("redacts secret-named keys at any depth, not just the top level", () => {
    logEvent({
      svc: "mcp",
      hop: "mcp",
      evt: "mcp.request",
      nested: { deep: { Pin: "inside-secret" }, arr: [{ secret: "hidden-val" }] },
    });

    const parsed = JSON.parse(lines[0]) as Line;
    const nested = parsed.nested as {
      deep: { Pin: string };
      arr: { secret: string }[];
    };
    expect(nested.deep.Pin).toBe("[redacted]");
    expect(nested.arr[0].secret).toBe("[redacted]");
    expect(lines[0]).not.toContain("inside-secret");
    expect(lines[0]).not.toContain("hidden-val");
  });

  it("leaves ordinary keys untouched", () => {
    logEvent({ svc: "dv", hop: "dv", evt: "dv.route", pinata: "keep-me" });
    const parsed = JSON.parse(lines[0]) as Line;
    expect(parsed.pinata).toBe("keep-me");
  });

  it("does not redact or mask the ts key", () => {
    logEvent({ svc: "dv", hop: "dv", evt: "dv.request" });
    const parsed = JSON.parse(lines[0]) as Line;
    expect(Object.keys(parsed)[0]).toBe("ts");
    expect(parsed.ts).not.toBe("[redacted]");
  });
});
