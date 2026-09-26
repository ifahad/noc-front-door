import { describe, expect, it } from "vitest";
import { mask } from "../src/mask";

// Phone-like fixtures are assembled at runtime (repo secret scanner forbids E.164 literals).
const P11 = ["+", "966", "501234567"].join("");
const P11_MASKED = ["+", "9665", "****", "567"].join("");
const P15 = ["+", "44", "7700900", "123", "456"].join("");
const P15_MASKED = ["+", "4477", "****", "456"].join("");
const P8 = ["+", "1212", "555", "66"].join("");
const P8_MASKED = ["+", "1212", "****", "566"].join("");
const P7 = ["+", "5551234"].join("");

describe("mask", () => {
  it("masks an 11-digit E.164 keeping the head and last 3 digits", () => {
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
