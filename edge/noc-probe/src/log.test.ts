import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mask, logEvent, type LogLine } from "./log";

const P11 = ["+", "966", "501234567"].join("");
const P11_MASKED = ["+", "9665", "****", "567"].join("");
const P15 = ["+", "44", "7700900", "123", "456"].join("");
const P15_MASKED = ["+", "4477", "****", "456"].join("");
const P8 = ["+", "1212", "555", "66"].join("");
const P8_MASKED = ["+", "1212", "****", "566"].join("");
const P7 = ["+", "5551234"].join("");

describe("mask", () => {
  it("masks an 11-digit E.164 keeping first 4 and last 3 digits", () => {
    expect(mask(P11)).toBe(P11_MASKED);
  });

  it("masks a 15-digit E.164", () => {
    expect(mask(P15)).toBe(P15_MASKED);
  });

  it("masks an 8-digit phone-like value", () => {
    expect(mask(P8)).toBe(P8_MASKED);
  });

  it("leaves a 7-digit short value alone", () => {
    expect(mask(P7)).toBe(P7);
  });

  it("leaves non-phone strings alone", () => {
    expect(mask("hello world")).toBe("hello world");
    expect(mask("+not-a-phone")).toBe("+not-a-phone");
    expect(mask("")).toBe("");
  });

  it("leaves 16+ digit runs alone (not phone-like)", () => {
    const sixteen = ["+", "123456789012345", "6"].join("");
    expect(mask(sixteen)).toBe(sixteen);
  });

  it("masks phones embedded in longer strings", () => {
    const s = ["caller ", P11, " joined"].join("");
    const masked = ["caller ", P11_MASKED, " joined"].join("");
    expect(mask(s)).toBe(masked);
  });

  it("masks every occurrence in a string", () => {
    const s = [P11, " then ", P11].join("");
    const masked = [P11_MASKED, " then ", P11_MASKED].join("");
    expect(mask(s)).toBe(masked);
  });
});

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

  it("writes exactly one line of valid JSON with ts, lvl, svc and evt", () => {
    logEvent("diag.arm", { where: "armAlarm" });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as LogLine;
    expect(parsed.svc).toBe("noc-probe");
    expect(parsed.evt).toBe("diag.arm");
    expect(parsed.ts).toBeTruthy();
    expect(typeof parsed.ts).toBe("string");
    expect(parsed.lvl).toBe("info");
    expect(parsed.where).toBe("armAlarm");
  });

  it("masks phone numbers inside logged field values", () => {
    logEvent("dv.probe", { caller: P11 });

    const parsed = JSON.parse(lines[0]) as LogLine;
    expect(parsed.caller).toBe(P11_MASKED);
    expect(JSON.stringify(parsed)).not.toContain(P11);
  });

  it("masks phones nested inside object fields", () => {
    logEvent("mcp.wire", { params_meta: { user: [P15] } });

    const parsed = JSON.parse(lines[0]) as LogLine;
    expect(JSON.stringify(parsed)).not.toContain(P15);
    expect((parsed.params_meta as { user: string[] }).user[0]).toBe(P15_MASKED);
  });

  it("never leaks the literal phone in the raw line", () => {
    logEvent("tool.echo", { body: { from: P11 } });

    expect(lines[0]).not.toContain(P11);
  });

  it("honours an explicit lvl override", () => {
    logEvent("http.fallthrough", { lvl: "warn" });

    const parsed = JSON.parse(lines[0]) as LogLine;
    expect(parsed.lvl).toBe("warn");
  });
});
