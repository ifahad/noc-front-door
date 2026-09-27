import { describe, expect, it } from "vitest";
import type { Flags } from "../../src/services/flags";
import { routeHint } from "../../src/dv/route";
import type { Contact } from "../../../shared/src/types";

const FLAGS: Flags = {
  deflection_enabled: true,
  require_pin: false,
  demo_caller: null,
  fault_open_ticket: null,
  fault_dv_delay_ms: null,
  actor_mode: "per-entity",
};

const CONTACT: Contact = {
  contact_id: "c-ahmed",
  name: "Ahmed",
  customer_id: "c-alwaha",
  customer_name: "Al-Waha Pharmacies",
  site_id: "RUH-114",
  site_label: "the Al Yasmin branch",
  region: "riyadh-north",
  region_label: "Riyadh North",
  preferred_language: "en",
};

const INCIDENT = { id: "INC-1002" };

describe("routeHint", () => {
  it("forces unverified when the session write did not complete", () => {
    expect(
      routeHint({ sessionWritten: false, flags: FLAGS, contact: CONTACT, incident: null }),
    ).toBe("unverified");
  });

  it("forces unverified when require_pin is true", () => {
    expect(
      routeHint({
        sessionWritten: true,
        flags: { ...FLAGS, require_pin: true },
        contact: CONTACT,
        incident: null,
      }),
    ).toBe("unverified");
  });

  it("is unverified without a contact", () => {
    expect(routeHint({ sessionWritten: true, flags: FLAGS, contact: null, incident: null })).toBe(
      "unverified",
    );
  });

  it("routes to known_incident when deflection is on and the region has an active incident", () => {
    expect(
      routeHint({ sessionWritten: true, flags: FLAGS, contact: CONTACT, incident: INCIDENT }),
    ).toBe("known_incident");
  });

  it("routes to verified with deflection off during an incident", () => {
    expect(
      routeHint({
        sessionWritten: true,
        flags: { ...FLAGS, deflection_enabled: false },
        contact: CONTACT,
        incident: INCIDENT,
      }),
    ).toBe("verified");
  });

  it("routes to verified for a known contact with no incident", () => {
    expect(
      routeHint({ sessionWritten: true, flags: FLAGS, contact: CONTACT, incident: null }),
    ).toBe("verified");
  });
});
