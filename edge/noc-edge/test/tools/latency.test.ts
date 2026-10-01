import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionKey } from "../../../shared/src/ids";
import { putAuth, putDv } from "../../src/services/sessions";
import { handleCallback } from "../../src/tools/callback";
import { handleOpenTicket } from "../../src/tools/openTicket";
import { handleVerifySite } from "../../src/tools/verifySite";
import {
  CCID,
  CONV_ID,
  PIN,
  T0,
  FakeActorPort,
  makeDeps,
  makeKeys,
  newKv,
  signedToolRequest,
  startLogs,
  stopLogs,
  type ToolResponse,
} from "./helpers";
import type { FakeKv } from "../fakes/kv";
import { SlowActorPort, SlowKv } from "../fakes/slow";

const SITE_DOWN_FIELDS = {
  site_id: "RUH-114",
  symptom: "WAN link down",
  impact: "site_down",
  service_affecting: "true",
};

function presets(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    call_control_id: CCID,
    call_key: "none",
    trace_id: "t-latency",
    conversation_id: CONV_ID,
    ...over,
  };
}

async function seededSlowKv(): Promise<SlowKv> {
  const kv = new SlowKv(newKv() as FakeKv);
  const k = (await sessionKey({ call_control_id: CCID })) as string;
  await putDv(kv, k, {
    trace_id: "t-latency",
    identified: true,
    contact_id: "c-ahmed",
    customer_id: "c-alwaha",
    sites: ["RUH-114"],
    region: "riyadh-north",
  });
  await putAuth(kv, k, {
    verified: true,
    site_id: "RUH-114",
    customer_id: "c-alwaha",
    at: T0,
  });
  return kv;
}

async function timedJson(
  p: Promise<Response>,
): Promise<{ ms: number; out: ToolResponse; status: number }> {
  const started = Date.now();
  const res = await p;
  const out = (await res.json()) as ToolResponse;
  return { ms: Date.now() - started, out, status: res.status };
}

beforeEach(() => {
  startLogs();
});
afterEach(() => {
  stopLogs();
});

describe("tool latency under real Telnyx KV cost", () => {
  it(
    "verify_site responds under 3000 ms for a valid PIN on an identified session",
    { timeout: 30000 },
    async () => {
      const keys = await makeKeys();
      const kv = await seededSlowKv();
      const actors = new SlowActorPort(new FakeActorPort());
      const { ms, out, status } = await timedJson(
        handleVerifySite(
          await signedToolRequest(
            "/tools/verify-site",
            { site_id: "RUH-114", pin: PIN, ...presets() },
            keys,
          ),
          makeDeps(kv, actors, keys),
        ),
      );
      expect(status).toBe(200);
      expect(out.verify_result).toBe("ok");
expect(ms).toBeLessThan(3000);
    },
  );

  it("open_ticket responds under 3500 ms for a verified session", { timeout: 30000 }, async () => {
    const keys = await makeKeys();
    const kv = await seededSlowKv();
    const actors = new SlowActorPort(new FakeActorPort());
    const { ms, out, status } = await timedJson(
      handleOpenTicket(
        await signedToolRequest(
          "/tools/open-ticket",
          { ...SITE_DOWN_FIELDS, ...presets() },
          keys,
        ),
        makeDeps(kv, actors, keys),
      ),
    );
    expect(status).toBe(200);
    expect(out.ticket_id).toBe("NJD-1401");
expect(ms).toBeLessThan(3500);
  });

  it(
    "verify_site answers under 3500 ms when every KV op takes 5000 ms",
    { timeout: 20000 },
    async () => {
      const keys = await makeKeys();
      const slow = new SlowKv(newKv(), 5000);
      const actors = new SlowActorPort(new FakeActorPort());
      const { ms, out, status } = await timedJson(
        handleVerifySite(
          await signedToolRequest(
            "/tools/verify-site",
            { site_id: "RUH-114", pin: PIN, ...presets() },
            keys,
          ),
          makeDeps(slow, actors, keys),
        ),
      );
      expect(status).toBe(200);
      expect(out.verify_result).toBe("ok");
      expect(out.route_hint).toBe("verified");
      expect(ms).toBeLessThan(3500);
    },
  );

  it(
    "open_ticket via the actor proof answers under 4500 ms when every KV op takes 5000 ms",
    { timeout: 30000 },
    async () => {
      const keys = await makeKeys();
      const fast = newKv();
      const actors = new FakeActorPort();
      const verified = await handleVerifySite(
        await signedToolRequest(
          "/tools/verify-site",
          { site_id: "RUH-114", pin: PIN, ...presets() },
          keys,
        ),
        makeDeps(fast, actors, keys),
      );
      expect(verified.status).toBe(200);
      const slow = new SlowKv(newKv(), 5000);
      const { ms, out, status } = await timedJson(
        handleOpenTicket(
          await signedToolRequest(
            "/tools/open-ticket",
            { ...SITE_DOWN_FIELDS, ...presets() },
            keys,
          ),
          makeDeps(slow, actors, keys),
        ),
      );
      expect(status).toBe(200);
      expect(out.ticket_id).toBe("NJD-1401");
      expect(ms).toBeLessThan(4500);
    },
  );

  it("callback responds under 2500 ms with a site ticket to note", { timeout: 30000 }, async () => {
    const keys = await makeKeys();
    const kv = await seededSlowKv();
    const actors = new SlowActorPort(new FakeActorPort());
    await actors.site("RUH-114").openOrAttach({
      k: "k-lat",
      trace_id: "t-latency",
      callerRef: "none",
      symptom: "WAN down",
      impact: "site_down",
      serviceAffecting: true,
      priority: "P2",
      at: T0,
      siteCode: "14",
    });
    const { ms, out, status } = await timedJson(
      handleCallback(
        await signedToolRequest(
          "/tools/callback",
          { callback_note: "call me back", ...presets() },
          keys,
        ),
        makeDeps(kv, actors, keys),
      ),
    );
    expect(status).toBe(200);
    expect(out.escalated).toBe("true");
expect(ms).toBeLessThan(2000);
  });
});
