import { describe, expect, it } from "vitest";
import { classify, responseTargetMinutes } from "../src/severity";

describe("severity.classify", () => {
  const rows: [
    impact: "site_down" | "degraded" | "single_user",
    serviceAffecting: boolean,
    want: "P1" | "P2" | "P3" | "P4",
  ][] = [
    ["site_down", true, "P2"],
    ["site_down", false, "P2"],
    ["degraded", true, "P3"],
    ["degraded", false, "P4"],
    ["single_user", true, "P4"],
    ["single_user", false, "P4"],
  ];

  it.each(rows)("classifies %s / serviceAffecting=%s as %s", (impact, sa, want) => {
    expect(classify(impact, sa)).toBe(want);
  });

  it("covers the whole matrix without a default escape", () => {
    for (const impact of ["site_down", "degraded", "single_user"] as const) {
      for (const sa of [true, false]) {
        expect(["P1", "P2", "P3", "P4"]).toContain(classify(impact, sa));
      }
    }
  });
});

describe("responseTargetMinutes", () => {
  it("returns the spec §9 targets", () => {
    expect(responseTargetMinutes("P1")).toBe(15);
    expect(responseTargetMinutes("P2")).toBe(30);
    expect(responseTargetMinutes("P3")).toBe(240);
    expect(responseTargetMinutes("P4")).toBe(1440);
  });
});
