import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionKey } from "../../../shared/src/ids";
import { kvKey } from "../../../shared/src/kvkeys";
import { putAuth } from "../../src/services/sessions";
import { handleCallback } from "../../src/tools/callback";
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
const NOTE = ["please", "call", "the", "duty", "manager"].join(" ");

function presets(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    call_control_id: CCID,
    call_key: "none",
    trace_id: `t-${K}`,
    conversation_id: CONV_ID,
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

describe("handleCallback", () => {
  it("records the note on the site actor when a session site and open ticket exist", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    const actors = new FakeActorPort();
    await putAuth(kv, K, { verified: true, site_id: "RUH-114", customer_id: "c-alwaha", at: T0 });
    await actors.site("RUH-114").openOrAttach({
      k: "k0",
      trace_id: `t-${K}`,
      callerRef: "none",
      symptom: "WAN down",
      impact: "site_down",
      serviceAffecting: true,
      priority: "P2",
      at: T0,
      siteCode: "14",
    });
    const res = await handleCallback(
      await signedToolRequest("/tools/callback", { callback_note: NOTE, ...presets() }, keys),
      makeDeps(kv, actors, keys),
    );
    expect(res.status).toBe(200);
    const out = await jsonOf(res);
    expect(out.escalated).toBe("true");
    expect(out.callback_note).toBe("none");
    const ticket = await actors.site("RUH-114").getTicket({ trace_id: `t-${K}` });
    expect(ticket.ticket?.notes.some((n) => n.text === `Callback requested: ${NOTE}`)).toBe(true);
    expect(eventsWith("page.raised")).toHaveLength(1);
    const lines = eventsWith("tool.callback");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("ok");
    expect(lines[0].hop).toBe("tool");
    expect(typeof lines[0].total_ms).toBe("number");
  });

  it("only logs when the session has no open ticket, and still escalates", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    const actors = new FakeActorPort();
    await putAuth(kv, K, { verified: true, site_id: "RUH-114", customer_id: "c-alwaha", at: T0 });
    const res = await handleCallback(
      await signedToolRequest("/tools/callback", { callback_note: NOTE, ...presets() }, keys),
      makeDeps(kv, actors, keys),
    );
    expect(res.status).toBe(200);
    const out = await jsonOf(res);
    expect(out.escalated).toBe("true");
    expect(eventsWith("page.raised")).toHaveLength(1);
    expect(eventsWith("tool.callback")).toHaveLength(1);
  });

  it("only logs when there is no session site", async () => {
    const keys = await makeKeys();
    const res = await handleCallback(
      await signedToolRequest("/tools/callback", { callback_note: NOTE, ...presets() }, keys),
      makeDeps(newKv(), new FakeActorPort(), keys),
    );
    expect(res.status).toBe(200);
    const out = await jsonOf(res);
    expect(out.escalated).toBe("true");
    expect(out.callback_note).toBe("none");
    expect(eventsWith("page.raised")).toHaveLength(1);
  });

  it("returns 422 when the body carries no identity", async () => {
    const keys = await makeKeys();
    const res = await handleCallback(
      await signedToolRequest(
        "/tools/callback",
        { callback_note: NOTE, call_control_id: undefined, call_key: "none" },
        keys,
        { ccid: null },
      ),
      makeDeps(newKv(), new FakeActorPort(), keys),
    );
    expect(res.status).toBe(422);
    expect(eventsWith("page.raised")).toHaveLength(0);
  });

  it("rejects unsigned and stale requests with 403", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    await putAuth(kv, K, { verified: true, site_id: "RUH-114", customer_id: "c-alwaha", at: T0 });
    const unsigned = await handleCallback(
      await signedToolRequest(
        "/tools/callback",
        { callback_note: NOTE, ...presets() },
        keys,
        { sign: false },
      ),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(unsigned.status).toBe(403);
    const stale = await handleCallback(
      await signedToolRequest(
        "/tools/callback",
        { callback_note: NOTE, ...presets() },
        keys,
        { tsOffsetSec: -1000 },
      ),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(stale.status).toBe(403);
    expect(eventsWith("tool.sig_fail")).toHaveLength(2);
    expect(eventsWith("page.raised")).toHaveLength(0);
  });

  it("returns 422 on unparsable JSON", async () => {
    const keys = await makeKeys();
    const res = await handleCallback(
      await signedToolRequest("/tools/callback", {}, keys, { rawBody: "{not json" }),
      makeDeps(newKv(), new FakeActorPort(), keys),
    );
    expect(res.status).toBe(422);
  });

  it("still escalates when the actor note fails, with a fallback outcome", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    const actors = new FakeActorPort();
    await putAuth(kv, K, { verified: true, site_id: "RUH-114", customer_id: "c-alwaha", at: T0 });
    const boom = Promise.reject(new Error("actor_boom"));
    boom.catch(() => {});
    await actors.site("RUH-114").openOrAttach({
      k: "k0",
      trace_id: `t-${K}`,
      callerRef: "none",
      symptom: "WAN down",
      impact: "site_down",
      serviceAffecting: true,
      priority: "P2",
      at: T0,
      siteCode: "14",
    });
    const realSite = actors.site("RUH-114");
    realSite.addNote = () => boom;
    const res = await handleCallback(
      await signedToolRequest("/tools/callback", { callback_note: NOTE, ...presets() }, keys),
      makeDeps(kv, actors, keys),
    );
    expect(res.status).toBe(200);
    const out = await jsonOf(res);
    expect(out.escalated).toBe("true");
    const lines = eventsWith("tool.callback");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("fallback");
  });

  it("still escalates 200 with a fallback outcome when KV fails", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    kv.failNext(10);
    const res = await handleCallback(
      await signedToolRequest("/tools/callback", { callback_note: NOTE, ...presets() }, keys),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(res.status).toBe(200);
    const out = await jsonOf(res);
    expect(out.escalated).toBe("true");
    expect(out.callback_note).toBe("none");
    const lines = eventsWith("tool.callback");
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("fallback");
  });

  it("escalates within budget when KV hangs", { timeout: 20000 }, async () => {
    const keys = await makeKeys();
    const hang: import("../../src/services/kvPort").KvPort = {
      get: () => new Promise<string | null>(() => undefined),
      put: () => new Promise<void>(() => undefined),
      delete: () => new Promise<void>(() => undefined),
      list: () => new Promise<string[]>(() => undefined),
    };
    const started = Date.now();
    const res = await handleCallback(
      await signedToolRequest("/tools/callback", { callback_note: NOTE, ...presets() }, keys),
      makeDeps(hang, new FakeActorPort(), keys),
    );
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    const out = await jsonOf(res);
    expect(out.escalated).toBe("true");
    expect(elapsed).toBeLessThan(2500);
  });

  it("links the conversation id to the session key", async () => {
    const keys = await makeKeys();
    const kv = newKv();
    await putAuth(kv, K, { verified: true, site_id: "RUH-114", customer_id: "c-alwaha", at: T0 });
    await handleCallback(
      await signedToolRequest("/tools/callback", { callback_note: NOTE, ...presets() }, keys),
      makeDeps(kv, new FakeActorPort(), keys),
    );
    expect(kv.raw(kvKey("conv", CONV_ID))).toBe(K);
  });
});
