import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  mintIncidentId,
  mintTicketId,
  sessionKey,
  sha256Hex,
  siteCodeOfTicket,
  spellId,
  traceId,
} from "../src/ids";

describe("sha256Hex", () => {
  it("matches the known vector for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches the known vector for the empty string", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("constantTimeEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqual("tok-1", "tok-1")).toBe(true);
  });

  it("returns false for different strings of equal length", () => {
    expect(constantTimeEqual("tok-1", "tok-2")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(constantTimeEqual("tok-1", "tok-12")).toBe(false);
  });

  it("returns false when one side is not a string", () => {
    expect(constantTimeEqual(null, "tok-1")).toBe(false);
    expect(constantTimeEqual("tok-1", undefined)).toBe(false);
  });
});

describe("traceId", () => {
  it("prefixes k with t-", () => {
    expect(traceId("k1")).toBe("t-k1");
  });
});

describe("sessionKey", () => {
  it("derives the key from a present call_control_id", async () => {
    const key = await sessionKey({ call_control_id: "v3:abc-123" });
    expect(key).toBe((await sha256Hex("v3:abc-123")).slice(0, 16));
  });

  it("falls back to a call_key-derived key when the ccid is empty", async () => {
    const key = await sessionKey({ call_control_id: "", call_key: "v3:x" });
    expect(key).toBe((await sha256Hex("key:v3:x")).slice(0, 16));
  });

  it("falls back to the call_key when the ccid is a sentinel", async () => {
    const key = await sessionKey({ call_control_id: "none", call_key: "k9" });
    expect(key).toBe((await sha256Hex("key:k9")).slice(0, 16));
  });

  it("returns null when both sides are the none sentinel", async () => {
    expect(await sessionKey({ call_control_id: "none", call_key: "none" })).toBeNull();
  });

  it("returns null when both sides contain template braces", async () => {
    expect(
      await sessionKey({ call_control_id: "{{ccid}}", call_key: "{{ck}}" }),
    ).toBeNull();
  });

  it("returns null when the ccid is a sentinel and the call_key is missing", async () => {
    expect(await sessionKey({ call_control_id: "unknown" })).toBeNull();
    expect(await sessionKey({ call_key: "none" })).toBeNull();
    expect(await sessionKey({})).toBeNull();
  });

  it("gives different call_keys different keys", async () => {
    const a = await sessionKey({ call_key: "v3:a" });
    const b = await sessionKey({ call_key: "v3:b" });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("gives a 16-hex-char key", async () => {
    const key = await sessionKey({ call_control_id: "ccid-1" });
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("mintTicketId", () => {
  it("pads the sequence to two digits", () => {
    expect(mintTicketId("14", 7)).toBe("NJD-1407");
  });

  it("wraps the sequence mod 100", () => {
    expect(mintTicketId("14", 100)).toBe("NJD-1400");
    expect(mintTicketId("14", 199)).toBe("NJD-1499");
  });
});

describe("mintIncidentId", () => {
  it("pads the sequence to three digits", () => {
    expect(mintIncidentId("1", 2)).toBe("INC-1002");
  });

  it("wraps the sequence mod 1000", () => {
    expect(mintIncidentId("1", 1000)).toBe("INC-1000");
    expect(mintIncidentId("1", 1999)).toBe("INC-1999");
  });
});

describe("siteCodeOfTicket", () => {
  it("extracts the 2-digit site code", () => {
    expect(siteCodeOfTicket("NJD-1407")).toBe("14");
  });

  it("returns null for malformed ids", () => {
    expect(siteCodeOfTicket("NJD-14")).toBeNull();
    expect(siteCodeOfTicket("INC-1002")).toBeNull();
    expect(siteCodeOfTicket("")).toBeNull();
    expect(siteCodeOfTicket("NJD-14a7")).toBeNull();
  });
});

describe("spellId", () => {
  it("spells a ticket id for the voice line", () => {
    expect(spellId("NJD-1407")).toBe("N J D, 1 4 0 7");
  });

  it("spells an incident id for the voice line", () => {
    expect(spellId("INC-1002")).toBe("I N C, 1 0 0 2");
  });
});
