import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionKey } from "../../../shared/src/ids";
import { kvKey } from "../../../shared/src/kvkeys";
import { putAuth, putDv } from "../../src/services/sessions";
import type { SiteStateApi } from "../../src/services/actorPort";
import { handleJoinIncident } from "../../src/tools/joinIncident";
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

function presets(): Record<string, unknown> {
  return {
    call_control_id: CCID,
    call_key: "none",
    trace_id: `t-${K}`,
    conversation_id: CONV_ID,
  };
}

async function jsonOf(res: Response): Promise<ToolResponse> {
  return (await res.json()) as ToolResponse;
}

function withSession(kv: ReturnType<typeof newKv>): Promise<void> {
  return putAuth(kv, K, { verified: true, site_id: "RUH-114", customer_id: "c-alwaha", at: T0 });
}

async function declareIncident(actors: FakeActorPort): Promise<void> {
  await actors.region("riyadh-north").reportSite({
    siteId: "RUH-121",
    ticketId: "NJD-2101",
    regionCode: "1",
    trace_id: "t-pre",
    at: Date.now() - 60_000,
  });
  await actors.region("riyadh-north").reportSite({
    siteId: "RUH-133",
    ticketId: "NJD-3301",
    regionCode: "1",
    trace_id: "t-pre",
    at: Date.now() - 30_000,
  });
}

beforeEach(() => {
  startLogs();
});
afterEach(() => {
  stopLogs();
});

describe("handleJoinIncident", () => {
  it("joins the caller's branch to the active incident", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    const actors = new FakeActorPort();
    await declareIncident(actors);
    await withSession(kv);
    const res = await handleJoinIncident(
      await signedToolRequest("/tools/join-incident", presets(), keys),
      makeDeps(kv, actors, keys),
    );
    expect(res.status).toBe(200);
    const out = await jsonOf(res);
    expect(out.ticket_id).toBe("NJD-1401");
    expect(out.created).toBe("true");
    expect(out.ticket_readback).toContain("I've added your branch to incident");
    expect(out.ticket_readback).toContain("N J D, 1 4 0 1");
    expect(out.ticket_readback).toContain("raised to priority 1");
    expect(out.incident_note).toContain("3 branches");
    const lines = eventsWith("tool.join_incident");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("ok");
    expect(lines[0].hop).toBe("tool");
  });

  it("opens a site_down ticket with a no-incident readback when there is no active incident", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    const actors = new FakeActorPort();
    await withSession(kv);
    const res = await handleJoinIncident(
      await signedToolRequest("/tools/join-incident", presets(), keys),
      makeDeps(kv, actors, keys),
    );
    expect(res.status).toBe(200);
    const out = await jsonOf(res);
    expect(out.ticket_id).toBe("NJD-1401");
    expect(out.ticket_readback).toContain("no active incident");
    expect(out.ticket_readback).toContain("N J D, 1 4 0 1");
    expect(out.incident_note).toBe("none");
    const ticket = await actors.site("RUH-114").getTicket({ trace_id: `t-${K}` });
    expect(ticket.ticket?.impact).toBe("site_down");
    expect(ticket.ticket?.serviceAffecting).toBe(true);
    const lines = eventsWith("tool.join_incident");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("ok");
  });

  it("returns 403 when the call is neither identified nor verified", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    await putDv(kv, K, {
      trace_id: `t-${K}`,
      identified: false,
      contact_id: null,
      customer_id: null,
      sites: ["RUH-114"],
      region: "riyadh-north",
    });
    const res = await handleJoinIncident(
      await signedToolRequest("/tools/join-incident", presets(), keys),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(res.status).toBe(403);
    const out = await jsonOf(res);
    expect(out.error).toBe("not_identified");
    const lines = eventsWith("tool.join_incident");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("denied");
  });

  it("returns 422 missing_site_id when the session carries no site", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    await putDv(kv, K, {
      trace_id: `t-${K}`,
      identified: true,
      contact_id: "c-ahmed",
      customer_id: "c-alwaha",
      sites: [],
      region: null,
    });
    const res = await handleJoinIncident(
      await signedToolRequest("/tools/join-incident", presets(), keys),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(res.status).toBe(422);
    const out = await jsonOf(res);
    expect(out.error).toBe("missing_site_id");
  });

  it("returns 422 missing_site_id when there is no session at all", async () => {
    const keys = await makeKeys();
    const res = await handleJoinIncident(
      await signedToolRequest("/tools/join-incident", presets(), keys),
      makeDeps(newKv(), new FakeActorPort(), keys),
    );
    expect(res.status).toBe(422);
    const out = await jsonOf(res);
    expect(out.error).toBe("missing_site_id");
  });

  it("rejects unsigned, stale and unkeyed requests", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    await withSession(kv);
    const unsigned = await handleJoinIncident(
      await signedToolRequest("/tools/join-incident", presets(), keys, { sign: false }),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(unsigned.status).toBe(403);
    const stale = await handleJoinIncident(
      await signedToolRequest("/tools/join-incident", presets(), keys, { tsOffsetSec: -1000 }),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(stale.status).toBe(403);
    const noKey = await handleJoinIncident(
      await signedToolRequest(
        "/tools/join-incident",
        { call_control_id: undefined, call_key: "none" },
        keys,
        { ccid: null },
      ),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(noKey.status).toBe(422);
    expect(eventsWith("tool.sig_fail")).toHaveLength(2);
    expect(eventsWith("tool.join_incident")).toHaveLength(1);
  });

  it("returns 422 on unparsable JSON", async () => {
    const keys = await makeKeys();
    const res = await handleJoinIncident(
      await signedToolRequest("/tools/join-incident", {}, keys, { rawBody: "{not json" }),
      makeDeps(newKv(), new FakeActorPort(), keys),
    );
    expect(res.status).toBe(422);
  });

  it("returns 503 when the fault flag is set", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    await withSession(kv);
    await kv.put(kvKey("flag", "fault", "open_ticket"), "503");
    const res = await handleJoinIncident(
      await signedToolRequest("/tools/join-incident", presets(), keys),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(res.status).toBe(503);
  });

  it("returns 500 when the region actor fails", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    await withSession(kv);
    const boom = Promise.reject(new Error("actor_boom"));
    boom.catch(() => {});
    const site = {} as unknown as SiteStateApi;
    const actors = {
      site: () => site,
      region: (() => {
        throw new Error("actor_boom");
      }),
    } as unknown as FakeActorPort;
    const res = await handleJoinIncident(
      await signedToolRequest("/tools/join-incident", presets(), keys),
      makeDeps(kv, actors, keys),
    );
    expect(res.status).toBe(500);
    const lines = eventsWith("tool.join_incident");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("error");
  });
});
