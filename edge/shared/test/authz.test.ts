import { describe, expect, it } from "vitest";
import {
  canRead,
  canWrite,
  siteForTicket,
} from "../src/authz";
import type { Session, Site } from "../src/types";

const s: Session = {
  k: "k1",
  trace_id: "t-k1",
  identified: true,
  verified: false,
  contact_id: "c-ahmed",
  customer_id: "c-alwaha",
  sites: ["RUH-114", "RUH-121"],
  region: "riyadh-north",
};

function site(id: string, customer_id: string): Site {
  return {
    site_id: id,
    code: id.slice(-2),
    customer_id,
    label: `the ${id} branch`,
    region: "riyadh-north",
    region_label: "Riyadh North",
  };
}

describe("canRead", () => {
  it("allows reading a site owned by the session's customer", () => {
    expect(canRead(s, site("RUH-114", "c-alwaha"))).toBe(true);
  });

  it("denies reading another customer's site", () => {
    expect(canRead(s, site("JED-900", "c-rawda"))).toBe(false);
  });

  it("denies when the session has no customer", () => {
    expect(canRead({ ...s, customer_id: null }, site("RUH-114", "c-alwaha"))).toBe(false);
  });
});

describe("canWrite", () => {
  it("allows a verified session to write its own site", () => {
    expect(canWrite({ ...s, verified: true }, "RUH-114")).toBe(true);
  });

  it("allows an identified-but-unverified session for a site in its list", () => {
    expect(canWrite({ ...s, identified: true, verified: false }, "RUH-114")).toBe(true);
  });

  it("denies another customer's site (it is not in the session's list)", () => {
    expect(canWrite(s, "JED-900")).toBe(false);
  });

  it("denies a site outside the session's list", () => {
    expect(canWrite(s, "RUH-133")).toBe(false);
  });

  it("denies when neither identified nor verified", () => {
    expect(canWrite({ ...s, identified: false, verified: false }, "RUH-114")).toBe(false);
  });
});

describe("siteForTicket", () => {
  const sites: Site[] = [
    site("RUH-114", "c-alwaha"),
    site("RUH-121", "c-alwaha"),
    site("JED-900", "c-rawda"),
  ];

  it("finds the site whose code matches the ticket id", () => {
    expect(siteForTicket("NJD-1407", sites)?.site_id).toBe("RUH-114");
    expect(siteForTicket("NJD-2123", sites)?.site_id).toBe("RUH-121");
  });

  it("returns null when no site shares the ticket's code", () => {
    expect(siteForTicket("NJD-9001", sites)).toBeNull();
  });

  it("returns null for ids that are not tickets", () => {
    expect(siteForTicket("INC-1002", sites)).toBeNull();
    expect(siteForTicket("nonsense", sites)).toBeNull();
  });
});
