import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionKey, traceId } from "../../../shared/src/ids";
import { putAuth, putDv } from "../../src/services/sessions";
import { handleCallback } from "../../src/tools/callback";
import { handleJoinIncident } from "../../src/tools/joinIncident";
import { handleOpenTicket } from "../../src/tools/openTicket";
import { handleVerifySite } from "../../src/tools/verifySite";
import {
  CCID,
  CONV_ID,
  FakeActorPort,
  makeDeps,
  makeKeys,
  newKv,
  signedToolRequest,
  startLogs,
  stopLogs,
  T0,
  allLogs,
  eventsWith,
  type LogLine,
  type ToolResponse,
} from "./helpers";
import { SlowActorPort, SlowKv } from "../fakes/slow";

const K = (await sessionKey({ call_control_id: CCID })) as string;
const TRACE = traceId(K);

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
    trace_id: "t-none",
    conversation_id: CONV_ID,
    ...over,
  };
}

async function jsonOf(res: Response): Promise<ToolResponse> {
  return (await res.json()) as ToolResponse;
}

function toolLines(): LogLine[] {
  return allLogs()
    .map((l) => JSON.parse(l) as LogLine)
    .filter((l) => l.evt.startsWith("tool."));
}

beforeEach(() => {
  startLogs();
});

afterEach(() => {
  stopLogs();
});

describe("tool tracing", () => {
  it("prefers the k-derived trace over the t-none DV default", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    await putDv(kv, K, {
      trace_id: TRACE,
      identified: true,
      contact_id: null,
      customer_id: null,
      sites: ["RUH-114"],
      region: "riyadh-north",
    });
    const res = await handleOpenTicket(
      await signedToolRequest(
        "/tools/open-ticket",
        { ...SITE_DOWN_FIELDS, ...presets() },
        keys,
      ),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(res.status).toBe(200);
    const lines = eventsWith("tool.open_ticket");
    expect(lines).toHaveLength(1);
    expect(lines[0].trace_id).toBe(TRACE);
    expect(lines[0].trace_id).not.toBe("t-none");
  });

  it("carries numeric kv_ms and actor_ms on every tool line", async () => {
    const keys = await makeKeys();
    const slowKv = new SlowKv(newKv(), 20);
    await putDv(slowKv, K, {
      trace_id: TRACE,
      identified: true,
      contact_id: null,
      customer_id: null,
      sites: ["RUH-114"],
      region: "riyadh-north",
    });
    await putAuth(slowKv, K, {
      verified: true,
      site_id: "RUH-114",
      customer_id: "c-alwaha",
      at: T0,
    });
    const res = await handleOpenTicket(
      await signedToolRequest(
        "/tools/open-ticket",
        { ...SITE_DOWN_FIELDS, ...presets() },
        keys,
      ),
      makeDeps(slowKv, new SlowActorPort(new FakeActorPort(), 20), keys),
    );
    expect(res.status).toBe(200);
    const lines = toolLines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(typeof line.kv_ms).toBe("number");
      expect(typeof line.actor_ms).toBe("number");
    }
    const ok = lines.find((l) => l.evt === "tool.open_ticket");
    expect(ok?.kv_ms).toBeGreaterThan(0);
    expect(ok?.actor_ms).toBeGreaterThan(0);
  });

  it("adds kv_ms and actor_ms to failure lines too", async () => {
    const keys = await makeKeys();
    const res = await handleOpenTicket(
      await signedToolRequest(
        "/tools/open-ticket",
        { ...SITE_DOWN_FIELDS, call_control_id: "none", call_key: "none", trace_id: "t-none" },
        keys,
        { ccid: null },
      ),
      makeDeps(newKv(), new FakeActorPort(), keys),
    );
    expect(res.status).toBe(422);
    const lines = eventsWith("tool.open_ticket");
    expect(lines[0].outcome).toBe("error");
    expect(lines[0].trace_id).toBe("t-none");
    expect(lines[0].kv_ms).toBe(0);
    expect(lines[0].actor_ms).toBe(0);
  });

  it("keeps trace_id and timings on the callback page and tool lines", async () => {
    const keys = await makeKeys();
    const actors = new FakeActorPort();
    await actors.site("RUH-114").openOrAttach({
      k: K,
      trace_id: TRACE,
      callerRef: "none",
      symptom: "WAN down",
      impact: "site_down",
      serviceAffecting: true,
      priority: "P2",
      at: T0,
      siteCode: "14",
    });
    const res = await handleCallback(
      await signedToolRequest(
        "/tools/callback",
        { callback_note: "call me back", ...presets() },
        keys,
      ),
      makeDeps(newKv(), actors, keys),
    );
    expect(res.status).toBe(200);
    for (const evt of ["page.raised", "tool.callback"]) {
      const lines = eventsWith(evt);
      expect(lines).toHaveLength(1);
      expect(lines[0].trace_id).toBe(TRACE);
      expect(typeof lines[0].kv_ms).toBe("number");
      expect(typeof lines[0].actor_ms).toBe("number");
    }
  });

  it("falls back to the header trace only when k is unknown", async () => {
    const keys = await makeKeys();
    const res = await handleVerifySite(
      await signedToolRequest(
        "/tools/verify-site",
        {
          site_id: "RUH-114",
          pin: "none",
          call_control_id: "none",
          call_key: "none",
          trace_id: "t-none",
        },
        keys,
        { ccid: null },
      ),
      makeDeps(newKv(), new FakeActorPort(), keys),
    );
    expect(res.status).toBe(422);
    const lines = eventsWith("tool.verify_site");
    expect(lines[0].trace_id).toBe("t-none");
  });

  it("carries the header trace and timings on signature-failure lines", async () => {
    const keys = await makeKeys();
    const res = await handleVerifySite(
      await signedToolRequest(
        "/tools/verify-site",
        { site_id: "RUH-114", pin: "none" },
        keys,
        { sign: false },
      ),
      makeDeps(newKv(), new FakeActorPort(), keys),
    );
    expect(res.status).toBe(403);
    const lines = eventsWith("tool.sig_fail");
    expect(lines).toHaveLength(1);
    expect(lines[0].trace_id).toBe("t-none");
    expect(typeof lines[0].kv_ms).toBe("number");
    expect(typeof lines[0].actor_ms).toBe("number");
  });

  it("joins an incident without touching the t-none body trace", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    await putDv(kv, K, {
      trace_id: TRACE,
      identified: true,
      contact_id: null,
      customer_id: null,
      sites: ["RUH-114"],
      region: "riyadh-north",
    });
    const res = await handleJoinIncident(
      await signedToolRequest(
        "/tools/join-incident",
        { ...presets() },
        keys,
      ),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(res.status).toBe(200);
    const lines = eventsWith("tool.join_incident");
    expect(lines).toHaveLength(1);
    expect(lines[0].trace_id).toBe(TRACE);
    expect(typeof lines[0].kv_ms).toBe("number");
    expect(typeof lines[0].actor_ms).toBe("number");
  });
});
