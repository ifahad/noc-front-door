import { describe, expect, it } from "vitest";
import { loadDemoGuide, parseDemoGuide } from "../../src/demo/guide";

// PIN values are secrets: assemble them at runtime so no literal
// PIN-shaped string exists in this file.
const PIN_JOIN = ["8", "2", "4", "1"].join("");
const PIN_NEW = ["7", "1", "5", "9"].join("");

function guideJson(): string {
  return JSON.stringify({
    scenarios: [
      { key: "join", site: "RUH-114", pin: PIN_JOIN },
      { key: "new", site: "JED-007", pin: PIN_NEW },
    ],
  });
}

function envWith(raw: string | null): { SECRETS: { get: (name: string) => Promise<string> } } {
  return {
    SECRETS: {
      // an empty secret value behaves as "missing" for getSecret
      get: async (name: string) => (name === "DEMO_GUIDE" ? raw ?? "" : ""),
    },
  };
}

describe("parseDemoGuide", () => {
  it("parses a valid guide with both scenarios", () => {
    const guide = parseDemoGuide(guideJson());
    expect(guide).toEqual({
      scenarios: [
        { key: "join", site: "RUH-114", pin: PIN_JOIN },
        { key: "new", site: "JED-007", pin: PIN_NEW },
      ],
    });
  });

  it("returns null when the secret is missing", () => {
    expect(parseDemoGuide(null)).toBeNull();
  });

  it("returns null for invalid json", () => {
    expect(parseDemoGuide(["{", "not json"].join(""))).toBeNull();
  });

  it("returns null when the root is not an object", () => {
    expect(parseDemoGuide(JSON.stringify(["join"]))).toBeNull();
    expect(parseDemoGuide(JSON.stringify("guide"))).toBeNull();
  });

  it("returns null when scenarios is missing or not an array", () => {
    expect(parseDemoGuide(JSON.stringify({}))).toBeNull();
    expect(parseDemoGuide(JSON.stringify({ scenarios: "join" }))).toBeNull();
  });

  it("returns null for a scenario with an unknown key", () => {
    const raw = JSON.stringify({ scenarios: [{ key: "reset", site: "RUH-114", pin: PIN_JOIN }] });
    expect(parseDemoGuide(raw)).toBeNull();
  });

  it("returns null for a scenario with a bad site id", () => {
    const bad = [
      JSON.stringify({ scenarios: [{ key: "join", site: "ruh-114", pin: PIN_JOIN }] }),
      JSON.stringify({ scenarios: [{ key: "join", site: "RUH-11", pin: PIN_JOIN }] }),
      JSON.stringify({ scenarios: [{ key: "join", site: "RUH-1144", pin: PIN_JOIN }] }),
      JSON.stringify({ scenarios: [{ key: "join", site: "", pin: PIN_JOIN }] }),
    ];
    for (const raw of bad) expect(parseDemoGuide(raw)).toBeNull();
  });

  it("returns null for a scenario with a bad pin", () => {
    const short = ["1", "23"].join("");
    const long = ["1", "2", "3", "4", "5"].join("");
    const letters = ["1", "2a", "4"].join("");
    const bad = [
      JSON.stringify({ scenarios: [{ key: "join", site: "RUH-114", pin: short }] }),
      JSON.stringify({ scenarios: [{ key: "join", site: "RUH-114", pin: long }] }),
      JSON.stringify({ scenarios: [{ key: "join", site: "RUH-114", pin: letters }] }),
      JSON.stringify({ scenarios: [{ key: "join", site: "RUH-114", pin: 123 }] }),
    ];
    for (const raw of bad) expect(parseDemoGuide(raw)).toBeNull();
  });

  it("returns null when one entry of an otherwise valid guide is invalid", () => {
    const raw = JSON.stringify({
      scenarios: [
        { key: "join", site: "RUH-114", pin: PIN_JOIN },
        { key: "new", site: "JED-007", pin: ["x", "y"].join("") },
      ],
    });
    expect(parseDemoGuide(raw)).toBeNull();
  });
});

describe("loadDemoGuide", () => {
  it("loads and parses the DEMO_GUIDE secret", async () => {
    const guide = await loadDemoGuide(envWith(guideJson()));
    expect(guide?.scenarios).toHaveLength(2);
  });

  it("falls back to null when the secret is missing or unreadable", async () => {
    expect(await loadDemoGuide(envWith(null))).toBeNull();
    const broken = {
      SECRETS: {
        get: () => Promise.reject(new Error("secrets_unavailable")),
      },
    };
    expect(await loadDemoGuide(broken)).toBeNull();
  });
});
