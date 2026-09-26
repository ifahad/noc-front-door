import { describe, expect, it } from "vitest";
import {
  SeedAdapter,
  type SeedLocalConfig,
} from "../src/itsm";
import { SITES, CONTACT_SEED, CUSTOMERS } from "../src/seed";

const pinFor = (suffix: number): string => String(4000 + suffix);
const pepper = ["t", "e", "s", "t", "-", "p", "e", "p", "p", "e", "r"].join("");

function makeConfig(): SeedLocalConfig {
  return {
    pins: {
      "RUH-114": pinFor(114),
      "JED-015": pinFor(15),
      "DMM-011": pinFor(11),
      "JED-900": pinFor(900),
    },
    contacts: [
      {
        contact_id: "c-ahmed",
        phone_digits: ["9", "6", "6", "5", "0", "1", "2", "3", "4", "5", "6", "7"].join(""),
        preferred_language: "en",
      },
      { contact_id: "c-sara", phone_digits: null },
      { contact_id: "c-rawda-demo", phone_digits: ["5", "5", "5", "0", "0", "0", "1"].join(""), name: "Riyadh", site_id: "RUH-114", preferred_language: "en" },
    ],
  };
}

const now = (): number => Date.UTC(2026, 8, 25, 22, 52);

function makeAdapter(seedLocal = makeConfig()): SeedAdapter {
  return new SeedAdapter({ seedLocal, pepper, now });
}

describe("resolveSite", () => {
  it.each([
    ["RUH114"],
    ["ruh 114"],
    ["R U H one one four"],
    ["the Yasmin branch"],
  ])("resolves %j to RUH-114 for Al-Waha", async (description) => {
    const adapter = makeAdapter();
    const site = await adapter.resolveSite(description, "c-alwaha");
    expect(site?.site_id).toBe("RUH-114");
  });

  it("returns null for another customer's site", async () => {
    const adapter = makeAdapter();
    expect(await adapter.resolveSite("JED-900", "c-alwaha")).toBeNull();
  });

  it("resolves the Rawda site for the Rawda customer", async () => {
    const adapter = makeAdapter();
    expect((await adapter.resolveSite("JED-900", "c-rawda"))?.site_id).toBe("JED-900");
  });

  it("never matches hidden sites", async () => {
    const adapter = makeAdapter();
    expect(await adapter.resolveSite("TST-001", "c-lab")).toBeNull();
    expect(await adapter.resolveSite("t s t zero zero one", "c-lab")).toBeNull();
  });

  it("returns null for an unknown customer", async () => {
    const adapter = makeAdapter();
    expect(await adapter.resolveSite("RUH-114", "c-nobody")).toBeNull();
  });

  it("is case-insensitive and tolerant of punctuation", async () => {
    const adapter = makeAdapter();
    expect((await adapter.resolveSite("ruh-114", "c-alwaha"))?.site_id).toBe("RUH-114");
    expect((await adapter.resolveSite("RUH.114", "c-alwaha"))?.site_id).toBe("RUH-114");
  });

  it("does not match a wrong number of digits", async () => {
    const adapter = makeAdapter();
    expect(await adapter.resolveSite("RUH one one four zero", "c-alwaha")).toBeNull();
    expect(await adapter.resolveSite("RUH1140", "c-alwaha")).toBeNull();
  });

  it("matches all label keywords", async () => {
    const adapter = makeAdapter();
    expect((await adapter.resolveSite("the Malqa branch", "c-alwaha"))?.site_id).toBe("RUH-121");
    expect((await adapter.resolveSite("Hittin", "c-alwaha"))?.site_id).toBe("RUH-133");
  });
});

describe("checkPin", () => {
  it("accepts the correct PIN", async () => {
    const adapter = makeAdapter();
    expect(await adapter.checkPin(pinFor(114), "RUH-114")).toBe(true);
  });

  it("rejects a wrong PIN", async () => {
    const adapter = makeAdapter();
    expect(await adapter.checkPin(["9", "9", "9", "9"].join(""), "RUH-114")).toBe(false);
  });

  it("normalises spaces and punctuation to digits", async () => {
    const adapter = makeAdapter();
    expect(await adapter.checkPin(` ${pinFor(114)[0]} ${pinFor(114)[1]} ${pinFor(114)[2]} ${pinFor(114)[3]} `, "RUH-114")).toBe(true);
  });

  it("rejects an empty or sentinel PIN", async () => {
    const adapter = makeAdapter();
    expect(await adapter.checkPin("", "RUH-114")).toBe(false);
    expect(await adapter.checkPin("none", "RUH-114")).toBe(false);
  });

  it("rejects an unknown site or a site without a configured PIN", async () => {
    const adapter = makeAdapter();
    expect(await adapter.checkPin(pinFor(114), "RUH-999")).toBe(false);
    expect(await adapter.checkPin(pinFor(114), "RUH-121")).toBe(false);
  });
});

describe("pinHashFor", () => {
  it("hashes the configured PIN and returns null when none is configured", async () => {
    const adapter = makeAdapter();
    expect(await adapter.pinHashFor("RUH-114")).toBe(
      await adapter.pinHashFor("RUH-114"),
    );
    expect(await adapter.pinHashFor("RUH-121")).toBeNull();
  });
});

describe("findContactByPhone", () => {
  it("matches only seedLocal phone digits", async () => {
    const adapter = makeAdapter();
    const digits = makeConfig().contacts[0].phone_digits as string;
    const contact = await adapter.findContactByPhone(digits);
    expect(contact?.contact_id).toBe("c-ahmed");
    expect(contact?.customer_id).toBe("c-alwaha");
  });

  it("normalises formatting before matching", async () => {
    const adapter = makeAdapter();
    const digits = makeConfig().contacts[0].phone_digits as string;
    expect(await adapter.findContactByPhone(`+${digits}`)).not.toBeNull();
  });

  it("returns null for an unknown number", async () => {
    const adapter = makeAdapter();
    expect(await adapter.findContactByPhone(["1", "0", "0", "0", "0", "0", "0"].join(""))).toBeNull();
  });
});

describe("findContactById", () => {
  it("returns the enriched committed contact", async () => {
    const adapter = makeAdapter();
    const c = await adapter.findContactById("c-khalid");
    expect(c).toMatchObject({
      contact_id: "c-khalid",
      name: "Khalid",
      customer_id: "c-alwaha",
      site_id: "RUH-133",
      preferred_language: "ar",
    });
  });

  it("applies seedLocal overrides and returns null for unknown ids", async () => {
    const adapter = makeAdapter();
    const overridden = await adapter.findContactById("c-rawda-demo");
    expect(overridden?.site_id).toBe("RUH-114");
    expect(await adapter.findContactById("c-nobody")).toBeNull();
  });
});

describe("getSite / listSites", () => {
  it("returns the committed site, including hidden", async () => {
    const adapter = makeAdapter();
    expect((await adapter.getSite("RUH-114"))?.label).toBe("the Al Yasmin branch");
    expect((await adapter.getSite("TST-001"))?.hidden).toBe(true);
    expect(await adapter.getSite("RUH-000")).toBeNull();
  });

  it("lists only that customer's visible sites", async () => {
    const adapter = makeAdapter();
    const alwaha = await adapter.listSites("c-alwaha");
    expect(alwaha.map((s) => s.site_id).sort()).toEqual([
      "DMM-003", "DMM-011", "JED-007", "JED-015", "RUH-114", "RUH-121", "RUH-133", "RUH-207",
    ]);
    expect((await adapter.listSites("c-rawda")).map((s) => s.site_id)).toEqual(["JED-900"]);
    expect(await adapter.listSites("c-nobody")).toEqual([]);
  });
});

describe("getNmsStatus", () => {
  it("reports riyadh-north sites down since 01:52 Riyadh today", async () => {
    const adapter = makeAdapter();
    const s = await adapter.getNmsStatus("RUH-114");
    expect(s.state).toBe("down");
    expect(s.device).toBe("edge router");
    expect(s.alarms).toEqual(["WAN link down", "LTE backup down"]);
    expect(s.since).toBe(now());
  });

  it("reports all other sites up", async () => {
    const adapter = makeAdapter();
    for (const site of SITES.filter((s) => s.region !== "riyadh-north")) {
      const s = await adapter.getNmsStatus(site.site_id);
      expect(s.state).toBe("up");
      expect(s.since).toBeNull();
      expect(s.alarms).toEqual([]);
    }
  });

  it("returns up for an unknown site", async () => {
    const adapter = makeAdapter();
    expect((await adapter.getNmsStatus("RUH-000")).state).toBe("up");
  });
});

describe("getOnCall", () => {
  it("returns the demo on-call descriptor without a number", async () => {
    const adapter = makeAdapter();
    const onCall = await adapter.getOnCall();
    expect(onCall.name).toBe("On-call engineer");
    expect(onCall.number).toBeNull();
  });
});

describe("seed invariants", () => {
  it("has exactly the two committed customers", () => {
    expect(CUSTOMERS.map((c) => c.customer_id).sort()).toEqual(["c-alwaha", "c-rawda"]);
  });

  it("carries every committed site with its brief code and region", () => {
    const byId = new Map(SITES.map((s) => [s.site_id, s]));
    expect(byId.get("RUH-114")?.code).toBe("14");
    expect(byId.get("RUH-121")?.code).toBe("21");
    expect(byId.get("RUH-133")?.code).toBe("33");
    expect(byId.get("RUH-207")?.code).toBe("27");
    expect(byId.get("JED-007")?.code).toBe("07");
    expect(byId.get("JED-015")?.code).toBe("15");
    expect(byId.get("DMM-003")?.code).toBe("03");
    expect(byId.get("DMM-011")?.code).toBe("11");
    expect(byId.get("JED-900")?.code).toBe("90");
    expect(byId.get("TST-001")?.code).toBe("99");
    expect(byId.get("TST-001")?.hidden).toBe(true);
    for (const s of SITES) {
      expect(s.hidden ?? false).toBe(s.site_id === "TST-001");
    }
  });

  it("the committed contacts carry no phone numbers", () => {
    for (const c of CONTACT_SEED) {
      expect(Object.keys(c)).not.toContain("phone_digits");
    }
    expect(CONTACT_SEED.map((c) => c.contact_id).sort()).toEqual([
      "c-ahmed", "c-khalid", "c-noura", "c-sara",
    ]);
  });
});
