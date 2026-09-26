import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionKey } from "../../../shared/src/ids";
import { kvKey } from "../../../shared/src/kvkeys";
import { putAuth, putDv } from "../../src/services/sessions";
import type { SiteStateApi } from "../../src/services/actorPort";
import { handleOpenTicket } from "../../src/tools/openTicket";
import {
  CCID,
  CONV_ID,
  T0,
  FakeActorPort,
  eventsWith,
  makeDeps,
  makeKeys,
  newKv,
  signedToolRequest,
  startLogs,
  stopLogs,
  type ToolResponse,
} from "./helpers";

const K = (await sessionKey({ call_control_id: CCID })) as string;

function presets(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    call_control_id: CCID,
    call_key: "none",
    trace_id: `t-${K}`,
    conversation_id: CONV_ID,
    ...over,
  };
}

function fields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    site_id: "RUH-114",
    symptom: "WAN link down",
    impact: "site_down",
    service_affecting: "true",
    ...presets(),
    ...over,
  };
}

async function jsonOf(res: Response): Promise<ToolResponse> {
  return (await res.json()) as ToolResponse;
}

beforeEach(() => {
  startLogs();
});

afterEach(() => {
  stopLogs();
});

describe("handleOpenTicket", () => {
  it("returns 403 when there is no session for the call", async () => {
    const keys = await makeKeys();
    const res = await handleOpenTicket(
      await signedToolRequest("/tools/open-ticket", fields(), keys),
      makeDeps(newKv(), new FakeActorPort(), keys),
    );
    expect(res.status).toBe(403);
    const out = await jsonOf(res);
    expect(out.error).toBe("site_not_writable");
    const lines = eventsWith("tool.open_ticket");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("denied");
    expect(lines[0].hop).toBe("tool");
  });

  it("opens a ticket for a verified session and spells the id in the readback", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    await putAuth(kv, K, { verified: true, site_id: "RUH-114", customer_id: "c-alwaha", at: T0 });
    const res = await handleOpenTicket(
      await signedToolRequest("/tools/open-ticket", fields(), keys),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(res.status).toBe(200);
    const out = await jsonOf(res);
    expect(out.ticket_id).toBe("NJD-1401");
    expect(out.priority).toBe("P2");
    expect(out.created).toBe("true");
    expect(out.ticket_readback).toContain("N J D, 1 4 0 1");
    expect(out.ticket_readback).toContain("Priority 2");
    expect(out.incident_note).toBe("none");
    expect(out.symptom).toBe("none");
    expect(out.impact).toBe("unknown");
    for (const value of Object.values(out)) {
      expect(typeof value).toBe("string");
      expect(value).not.toBe("");
    }
    const lines = eventsWith("tool.open_ticket");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("ok");
    expect(lines[0].trace_id).toBe(`t-${K}`);
    expect(typeof lines[0].total_ms).toBe("number");
  });

  it("opens a ticket for an identified (dv-only) session", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    await putDv(kv, K, {
      trace_id: `t-${K}`,
      identified: true,
      contact_id: null,
      customer_id: null,
      sites: ["RUH-114"],
      region: "riyadh-north",
    });
    const res = await handleOpenTicket(
      await signedToolRequest("/tools/open-ticket", fields(), keys),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(res.status).toBe(200);
    const out = await jsonOf(res);
    expect(out.ticket_id).toBe("NJD-1401");
  });

  it("returns 403 when the site is not in the session", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    await putAuth(kv, K, { verified: true, site_id: "RUH-121", customer_id: "c-alwaha", at: T0 });
    const res = await handleOpenTicket(
      await signedToolRequest("/tools/open-ticket", fields(), keys),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(res.status).toBe(403);
    const out = await jsonOf(res);
    expect(out.error).toBe("site_not_writable");
  });

  it("returns 403 when site_id is missing from the body", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    await putAuth(kv, K, { verified: true, site_id: "RUH-114", customer_id: "c-alwaha", at: T0 });
    const res = await handleOpenTicket(
      await signedToolRequest("/tools/open-ticket", fields({ site_id: undefined }), keys),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(res.status).toBe(403);
  });

  it("returns 503 when the fault flag is set", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    await kv.put(kvKey("flag", "fault", "open_ticket"), "503");
    const res = await handleOpenTicket(
      await signedToolRequest("/tools/open-ticket", fields(), keys),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(res.status).toBe(503);
    const lines = eventsWith("tool.open_ticket");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("error");
  });

  it("rejects unsigned, stale and unkeyed requests", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    const unsigned = await handleOpenTicket(
      await signedToolRequest("/tools/open-ticket", fields(), keys, { sign: false }),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(unsigned.status).toBe(403);
    const stale = await handleOpenTicket(
      await signedToolRequest("/tools/open-ticket", fields(), keys, { tsOffsetSec: -1000 }),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(stale.status).toBe(403);
    const noKey = await handleOpenTicket(
      await signedToolRequest(
        "/tools/open-ticket",
        fields({ call_control_id: undefined, call_key: "none" }),
        keys,
        { ccid: null },
      ),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(noKey.status).toBe(422);
    expect(eventsWith("tool.sig_fail")).toHaveLength(2);
    expect(eventsWith("tool.open_ticket")).toHaveLength(1);
  });

  it("returns 422 on unparsable JSON", async () => {
    const keys = await makeKeys();
    const res = await handleOpenTicket(
      await signedToolRequest("/tools/open-ticket", {}, keys, { rawBody: "{not json" }),
      makeDeps(newKv(), new FakeActorPort(), keys),
    );
    expect(res.status).toBe(422);
  });

  it("processes despite a header/body call-control mismatch and logs it", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    await putAuth(kv, K, { verified: true, site_id: "RUH-114", customer_id: "c-alwaha", at: T0 });
    const res = await handleOpenTicket(
      await signedToolRequest("/tools/open-ticket", fields(), keys, { ccid: "CC-OTHER" }),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(res.status).toBe(200);
    expect(eventsWith("tool.ccid_mismatch")).toHaveLength(1);
  });

  it("returns 500 when the actor fails", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    await putAuth(kv, K, { verified: true, site_id: "RUH-114", customer_id: "c-alwaha", at: T0 });
    const boom = Promise.reject(new Error("actor_boom"));
    boom.catch(() => {});
    const site = {
      openOrAttach: () => boom,
    } as unknown as SiteStateApi;
    const actors = {
      site: () => site,
      region: (() => {
        throw new Error("unused");
      }),
    } as unknown as FakeActorPort;
    const res = await handleOpenTicket(
      await signedToolRequest("/tools/open-ticket", fields(), keys),
      makeDeps(kv, actors, keys),
    );
    expect(res.status).toBe(500);
    const lines = eventsWith("tool.open_ticket");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("error");
  });
});
