import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionKey } from "../../../shared/src/ids";
import { kvKey } from "../../../shared/src/kvkeys";
import type { SiteStateApi } from "../../src/services/actorPort";
import { handleVerifySite } from "../../src/tools/verifySite";
import {
  CCID,
  CONV_ID,
  PIN,
  T0,
  FakeActorPort,
  allLogs,
  eventsWith,
  makeDeps,
  makeKeys,
  newKv,
  signedToolRequest,
  startLogs,
  stopLogs,
  type ToolResponse,
} from "./helpers";

const PROJECTION = {
  id: "INC-1002",
  version: 3,
  region_label: "Riyadh North",
  started_local: "1:52 AM",
  summary: "loss of connectivity at two branches",
  eta_local: "2:22 AM",
  priority: "P2",
  site_count: 2,
};

const WRONG_PIN = String(4000 + 999);
const WRONG_PIN2 = String(4000 + 998);
const WRONG_PIN3 = String(4000 + 997);

function presets(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    call_control_id: CCID,
    call_key: "none",
    trace_id: "t-cc",
    conversation_id: CONV_ID,
    ...over,
  };
}

async function jsonOf(res: Response): Promise<ToolResponse> {
  return (await res.json()) as ToolResponse;
}

function verifyFields(
  traceId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return { site_id: "RUH-114", pin: PIN, ...presets(), trace_id: traceId, ...over };
}

beforeEach(() => {
  startLogs();
});
afterEach(() => {
  stopLogs();
});

describe("handleVerifySite", () => {
  it("verifies a correct PIN, puts the auth session and returns the variables", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    const k = (await sessionKey({ call_control_id: CCID })) as string;
    const trace = `t-${k}`;
    const res = await handleVerifySite(
      await signedToolRequest("/tools/verify-site", verifyFields(trace), keys),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(res.status).toBe(200);
    const out = await jsonOf(res);
    expect(out.verify_result).toBe("ok");
    expect(out.attempts_left).toBe("3");
    expect(out.pin).toBe("none");
    expect(out.call_key).toBe(CCID);
    expect(out.route_hint).toBe("verified");
    expect(out.site_id).toBe("RUH-114");
    expect(out.site_label).toBe("the Al Yasmin branch");
    expect(out.caller_name).toBe("there");
    expect(out.customer_name).toBe("Al-Waha Pharmacies");
    expect(out.incident_region).toBe("your area");
    expect(out.open_ticket_note).toBe("none");
    const authRaw = kv.raw(kvKey("call", k, "auth"));
    expect(authRaw).not.toBeNull();
    expect(JSON.parse(authRaw as string)).toEqual({
      verified: true,
      site_id: "RUH-114",
      customer_id: "c-alwaha",
      at: expect.any(Number),
    });
    expect(kv.raw(kvKey("conv", CONV_ID))).toBe(k);
    const lines = eventsWith("tool.verify_site");
    expect(lines).toHaveLength(1);
    expect(lines[0].hop).toBe("tool");
    expect(lines[0].outcome).toBe("ok");
    expect(lines[0].trace_id).toBe(trace);
    expect(typeof lines[0].total_ms).toBe("number");
  });

  it("recomputes route_hint to known_incident with the incident variables", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    await kv.put(kvKey("incident", "active", "riyadh-north"), JSON.stringify(PROJECTION));
    const res = await handleVerifySite(
      await signedToolRequest("/tools/verify-site", verifyFields("t-cc"), keys),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    const out = await jsonOf(res);
    expect(out.route_hint).toBe("known_incident");
    expect(out.incident_region).toBe("Riyadh North");
    expect(out.incident_started).toBe("1:52 AM");
    expect(out.incident_summary).toBe("loss of connectivity at two branches");
    expect(out.incident_eta).toBe("2:22 AM");
  });

  it("keeps route_hint verified when deflection is off", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    await kv.put(kvKey("incident", "active", "riyadh-north"), JSON.stringify(PROJECTION));
    await kv.put(kvKey("flag", "deflection_enabled"), "false");
    const res = await handleVerifySite(
      await signedToolRequest("/tools/verify-site", verifyFields("t-cc"), keys),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    const out = await jsonOf(res);
    expect(out.route_hint).toBe("verified");
  });

  it("reports an invalid PIN with attempts_left 2 and no auth put", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    const k = (await sessionKey({ call_control_id: CCID })) as string;
    const res = await handleVerifySite(
      await signedToolRequest(
        "/tools/verify-site",
        verifyFields("t-cc", { pin: WRONG_PIN }),
        keys,
      ),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(res.status).toBe(200);
    const out = await jsonOf(res);
    expect(out.verify_result).toBe("invalid");
    expect(out.attempts_left).toBe("2");
    expect(out.pin).toBe("none");
    expect(out.route_hint).toBe("unverified");
    expect(out.site_id).toBe("unknown");
    expect(out.site_label).toBe("your site");
    expect(out.caller_name).toBe("there");
    expect(out.customer_name).toBe("your organisation");
    expect(out.open_ticket_note).toBe("none");
    expect(kv.has(kvKey("call", k, "auth"))).toBe(false);
  });

  it("locks after the third bad PIN for the same call", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    const deps = makeDeps(kv, new FakeActorPort(), keys);
    for (const pin of [WRONG_PIN, WRONG_PIN2, WRONG_PIN3]) {
      const res = await handleVerifySite(
        await signedToolRequest(
          "/tools/verify-site",
          verifyFields("t-cc", { pin }),
          keys,
        ),
        deps,
      );
      const out = await jsonOf(res);
      expect(res.status).toBe(200);
      if (pin !== WRONG_PIN3) {
        expect(out.verify_result).toBe("invalid");
      } else {
        expect(out.verify_result).toBe("locked");
        expect(out.attempts_left).toBe("0");
      }
    }
  });

  it("mints a call_key when the body carries no identity and returns it on success", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    const res = await handleVerifySite(
      await signedToolRequest(
        "/tools/verify-site",
        verifyFields("t-none", { call_control_id: undefined, call_key: "none" }),
        keys,
        { ccid: null },
      ),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(res.status).toBe(200);
    const out = await jsonOf(res);
    expect(out.verify_result).toBe("ok");
    expect(out.call_key).toMatch(/^[0-9a-f-]{36}$/);
    const k = (await sessionKey({ call_key: out.call_key })) as string;
    expect(kv.has(kvKey("call", k, "auth"))).toBe(true);
    expect(kv.raw(kvKey("conv", CONV_ID))).toBe(k);
  });

  it("returns 422 when site_id or pin is missing", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    const noSite = await handleVerifySite(
      await signedToolRequest(
        "/tools/verify-site",
        verifyFields("t-cc", { site_id: undefined }),
        keys,
      ),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(noSite.status).toBe(422);
    const noPin = await handleVerifySite(
      await signedToolRequest(
        "/tools/verify-site",
        verifyFields("t-cc", { pin: undefined }),
        keys,
      ),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(noPin.status).toBe(422);
    const sentinelPin = await handleVerifySite(
      await signedToolRequest(
        "/tools/verify-site",
        verifyFields("t-cc", { pin: "none" }),
        keys,
      ),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(sentinelPin.status).toBe(422);
    expect(eventsWith("tool.verify_site")).toHaveLength(3);
  });

  it("returns 422 for an unresolvable site", async () => {
    const keys = await makeKeys();
    const res = await handleVerifySite(
      await signedToolRequest(
        "/tools/verify-site",
        verifyFields("t-cc", { site_id: "RUH-999" }),
        keys,
      ),
      makeDeps(newKv(), new FakeActorPort(), keys),
    );
    expect(res.status).toBe(422);
  });

  it("resolves id-shaped site input without a customer", async () => {
    const keys = await makeKeys();
    for (const site of ["RUH114", "R U H one one four"]) {
      const res = await handleVerifySite(
        await signedToolRequest("/tools/verify-site", verifyFields("t-cc", { site_id: site }), keys),
        makeDeps(newKv(), new FakeActorPort(), keys),
      );
      expect(res.status).toBe(200);
      const out = await jsonOf(res);
      expect(out.site_id).toBe("RUH-114");
    }
  });

  it("rejects unsigned and stale requests with 403 and logs tool.sig_fail", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    const unsigned = await handleVerifySite(
      await signedToolRequest("/tools/verify-site", verifyFields("t-cc"), keys, { sign: false }),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(unsigned.status).toBe(403);
    const stale = await handleVerifySite(
      await signedToolRequest("/tools/verify-site", verifyFields("t-cc"), keys, {
        tsOffsetSec: -1000,
      }),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(stale.status).toBe(403);
    const fails = eventsWith("tool.sig_fail");
    expect(fails).toHaveLength(2);
    expect(fails.every((l) => l.outcome === "denied")).toBe(true);
    expect(eventsWith("tool.verify_site")).toHaveLength(0);
  });

  it("returns 422 on unparsable JSON", async () => {
    const keys = await makeKeys();
    const res = await handleVerifySite(
      await signedToolRequest("/tools/verify-site", {}, keys, { rawBody: "{not json" }),
      makeDeps(newKv(), new FakeActorPort(), keys),
    );
    expect(res.status).toBe(422);
    const lines = eventsWith("tool.verify_site");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("error");
  });

  it("processes despite a header/body call-control mismatch and logs it", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    const res = await handleVerifySite(
      await signedToolRequest("/tools/verify-site", verifyFields("t-cc"), keys, {
        ccid: "CC-OTHER",
      }),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(res.status).toBe(200);
    const out = await jsonOf(res);
    expect(out.verify_result).toBe("ok");
    const mismatches = eventsWith("tool.ccid_mismatch");
    expect(mismatches).toHaveLength(1);
  });

  it("returns only non-empty string values", async () => {
    const keys = await makeKeys();
    const res = await handleVerifySite(
      await signedToolRequest("/tools/verify-site", verifyFields("t-cc"), keys),
      makeDeps(newKv(), new FakeActorPort(), keys),
    );
    const out = await jsonOf(res);
    for (const value of Object.values(out)) {
      expect(typeof value).toBe("string");
      expect(value).not.toBe("");
    }
  });

  it("reports an open ticket in open_ticket_note on success", async () => {
    const keys = await makeKeys();
    const actors = new FakeActorPort();
    await actors.site("RUH-114").openOrAttach({
      k: "k0",
      trace_id: "t-x",
      callerRef: "none",
      symptom: "WAN down",
      impact: "site_down",
      serviceAffecting: true,
      priority: "P2",
      at: T0,
      siteCode: "14",
    });
    const res = await handleVerifySite(
      await signedToolRequest("/tools/verify-site", verifyFields("t-cc"), keys),
      makeDeps(newKv(), actors, keys),
    );
    const out = await jsonOf(res);
    expect(out.open_ticket_note).toContain("N J D, 1 4 0 1");
  });

  it("returns 500 when the actor fails", async () => {
    const keys = await makeKeys();
    const boom = Promise.reject(new Error("actor_boom"));
    boom.catch(() => {});
    const site = {
      recordPinAttempt: () => boom,
    } as unknown as SiteStateApi;
    const actors = {
      site: () => site,
      region: (() => {
        throw new Error("unused");
      }),
    } as unknown as FakeActorPort;
    const res = await handleVerifySite(
      await signedToolRequest("/tools/verify-site", verifyFields("t-cc"), keys),
      makeDeps(newKv(), actors, keys),
    );
    expect(res.status).toBe(500);
    const lines = eventsWith("tool.verify_site");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("error");
  });

  it("never logs the PIN or a fingerprint", async () => {
    const keys = await makeKeys();
    await handleVerifySite(
      await signedToolRequest("/tools/verify-site", verifyFields("t-cc"), keys),
      makeDeps(newKv(), new FakeActorPort(), keys),
    );
    await handleVerifySite(
      await signedToolRequest(
        "/tools/verify-site",
        verifyFields("t-cc", { pin: WRONG_PIN }),
        keys,
      ),
      makeDeps(newKv(), new FakeActorPort(), keys),
    );
    const joined = allLogs().join("\n");
    expect(joined).not.toContain(PIN);
    expect(joined).not.toContain('"pin"');
    expect(joined).not.toContain('"fp"');
  });
});
