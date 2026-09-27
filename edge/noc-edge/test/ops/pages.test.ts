import { describe, expect, it } from "vitest";
import type { Incident } from "../../../shared/src/types";
import { kvKey } from "../../../shared/src/kvkeys";
import { route } from "../../src/router";
import { bearer, makeRouterEnv, OPS_TOKEN, T0, type RouterEnvBundle } from "./helpers";
import { regionActorOf } from "./helpers";
import { makeRegionActor, storageOf } from "../fakes/actors";

const TOKEN = OPS_TOKEN;

async function opsRequest(
  method: string,
  path: string,
  bundle: RouterEnvBundle,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { authorization: bearer(TOKEN) };
  if (body !== undefined) headers["content-type"] = "application/json";
  return route(
    new Request(`https://x${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    bundle.env,
  );
}

async function openIncidentDueInThePast(bundle: RouterEnvBundle): Promise<Incident> {
  const actor = regionActorOf(bundle, "riyadh-north");
  await actor.reportSite({
    siteId: "RUH-114",
    ticketId: "NJD-1401",
    regionCode: "1",
    trace_id: "t-1",
    at: T0,
  });
  await actor.reportSite({
    siteId: "RUH-121",
    ticketId: "NJD-1402",
    regionCode: "1",
    trace_id: "t-2",
    at: T0,
  });
  const live = await actor.getIncident({ trace_id: "t-3" });
  const incident = live.incident as Incident;
  const overdue = {
    ...incident,
    esc: { level: 0, dueAt: T0 - 1000, acked: false },
  };
  await storageOf(actor).put("incident", overdue);
  return overdue;
}

describe("ops paging routes auth", () => {
  it("returns 401 without a token", async () => {
    const bundle = makeRouterEnv(TOKEN);
    for (const [method, path] of [
      ["POST", "/ops/tick"],
      ["GET", "/ops/pages/pending"],
      ["POST", "/ops/pages/claim"],
      ["POST", "/ops/pages/sent"],
    ] as const) {
      const res = await route(
        new Request(`https://x${path}`, { method }),
        bundle.env,
      );
      expect(res.status).toBe(401);
    }
  });

  it("returns 401 with a wrong token", async () => {
    const bundle = makeRouterEnv(TOKEN);
    const res = await route(
      new Request("https://x/ops/tick", {
        method: "POST",
        headers: { authorization: bearer("wrong") },
      }),
      bundle.env,
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /ops/tick", () => {
  it("fans out per-entity and escalates an overdue incident", async () => {
    const bundle = makeRouterEnv(TOKEN);
    await openIncidentDueInThePast(bundle);
    const res = await opsRequest("POST", "/ops/tick", bundle);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      regions: { region: string; escalated: boolean; level: number | null }[];
    };
    expect(body.mode).toBe("per-entity");
    expect(body.regions).toHaveLength(5);
    const riyadh = body.regions.find((r) => r.region === "riyadh-north");
    expect(riyadh?.escalated).toBe(true);
    expect(riyadh?.level).toBe(1);
  });

  it("keeps ticking the other regions when one region RPC fails", async () => {
    const bundle = makeRouterEnv(TOKEN);
    const inner = bundle.env.REGIONS.idFromName.bind(bundle.env.REGIONS);
    bundle.env.REGIONS.idFromName = ((name: string) => {
      if (name === "jeddah") {
        return {
          tick: async () => {
            throw new Error("actor_down");
          },
        } as unknown as ReturnType<typeof makeRegionActor>;
      }
      return inner(name) as unknown as ReturnType<typeof makeRegionActor>;
    }) as unknown as typeof bundle.env.REGIONS.idFromName;
    const res = await opsRequest("POST", "/ops/tick", bundle);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      regions: { region: string; error?: string; escalated: boolean }[];
    };
    const jeddah = body.regions.find((r) => r.region === "jeddah");
    expect(jeddah?.escalated).toBe(false);
    expect(jeddah?.error).toBe("actor_down");
    expect(body.regions.find((r) => r.region === "dammam")?.escalated).toBe(false);
    expect(body.regions.filter((r) => r.error === undefined)).toHaveLength(4);
  });

  it("uses the mux host-level tick when actor_mode is mux", async () => {
    const bundle = makeRouterEnv(TOKEN);
    await bundle.kv.put(kvKey("flag", "actor_mode"), "mux");
    const res = await opsRequest("POST", "/ops/tick", bundle);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      mux: { fired: string[]; failed: string[]; next: number | null };
    };
    expect(body.mode).toBe("mux");
    expect(body.mux).toEqual({
      fired: ["region/riyadh-north"],
      failed: [],
      next: null,
    });
  });
});

describe("GET /ops/pages/pending", () => {
  it("lists pending pages across regions with id, region, level and created time", async () => {
    const bundle = makeRouterEnv(TOKEN);
    await openIncidentDueInThePast(bundle);
    await opsRequest("POST", "/ops/tick", bundle);
    const res = await opsRequest("GET", "/ops/pages/pending", bundle);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      pages: { id: string; region: string; level: number; created_local: string }[];
    };
    expect(body.mode).toBe("per-entity");
    expect(body.pages).toHaveLength(1);
    expect(body.pages[0]).toMatchObject({
      id: "INC-1001:p1",
      region: "riyadh-north",
      level: 1,
      created_local: expect.any(String),
    });
  });

  it("is empty when nothing is pending", async () => {
    const bundle = makeRouterEnv(TOKEN);
    const res = await opsRequest("GET", "/ops/pages/pending", bundle);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pages: unknown[] }).pages).toEqual([]);
  });

  it("still serves the healthy regions' pending pages when one region read fails", async () => {
    const bundle = makeRouterEnv(TOKEN);
    await openIncidentDueInThePast(bundle);
    await opsRequest("POST", "/ops/tick", bundle);
    const inner = bundle.env.REGIONS.idFromName.bind(bundle.env.REGIONS);
    bundle.env.REGIONS.idFromName = ((name: string) => {
      if (name === "jeddah") {
        return {
          getPages: async () => {
            throw new Error("actor_down");
          },
        } as unknown as ReturnType<typeof makeRegionActor>;
      }
      return inner(name) as unknown as ReturnType<typeof makeRegionActor>;
    }) as unknown as typeof bundle.env.REGIONS.idFromName;
    const res = await opsRequest("GET", "/ops/pages/pending", bundle);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pages: { id: string }[] };
    expect(body.pages).toHaveLength(1);
    expect(body.pages[0].id).toBe("INC-1001:p1");
  });
});

describe("POST /ops/pages/claim", () => {
  it("claims exactly once and reports the loser", async () => {
    const bundle = makeRouterEnv(TOKEN);
    await openIncidentDueInThePast(bundle);
    await opsRequest("POST", "/ops/tick", bundle);

    const first = await opsRequest("POST", "/ops/pages/claim", bundle, {
      region: "riyadh-north",
      pageId: "INC-1001:p1",
      claimer: "host-a:11",
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { claimed: boolean }).claimed).toBe(true);

    const second = await opsRequest("POST", "/ops/pages/claim", bundle, {
      region: "riyadh-north",
      pageId: "INC-1001:p1",
      claimer: "host-b:22",
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { claimed: boolean }).claimed).toBe(false);
  });

  it("rejects bad input with 400", async () => {
    const bundle = makeRouterEnv(TOKEN);
    for (const body of [
      { region: "riyadh-north", pageId: "", claimer: "host-a" },
      { region: "riyadh-north", claimer: "host-a" },
      { pageId: "INC-1001:p1", claimer: "host-a" },
      { region: "atlantis", pageId: "INC-1001:p1", claimer: "host-a" },
    ]) {
      const res = await opsRequest("POST", "/ops/pages/claim", bundle, body);
      expect(res.status).toBe(400);
    }
    const notJson = await route(
      new Request("https://x/ops/pages/claim", {
        method: "POST",
        headers: { authorization: bearer(TOKEN), "content-type": "application/json" },
        body: "not-json",
      }),
      bundle.env,
    );
    expect(notJson.status).toBe(400);
  });
});

describe("POST /ops/pages/sent", () => {
  it("marks a claimed page sent and drops it from pending", async () => {
    const bundle = makeRouterEnv(TOKEN);
    await openIncidentDueInThePast(bundle);
    await opsRequest("POST", "/ops/tick", bundle);
    await opsRequest("POST", "/ops/pages/claim", bundle, {
      region: "riyadh-north",
      pageId: "INC-1001:p1",
      claimer: "host-a:11",
    });

    const sent = await opsRequest("POST", "/ops/pages/sent", bundle, {
      region: "riyadh-north",
      pageId: "INC-1001:p1",
    });
    expect(sent.status).toBe(200);
    expect(((await sent.json()) as { ok: boolean }).ok).toBe(true);

    const pending = await opsRequest("GET", "/ops/pages/pending", bundle);
    expect(((await pending.json()) as { pages: unknown[] }).pages).toEqual([]);
  });

  it("rejects bad input with 400", async () => {
    const bundle = makeRouterEnv(TOKEN);
    const missing = await opsRequest("POST", "/ops/pages/sent", bundle, {
      region: "riyadh-north",
    });
    expect(missing.status).toBe(400);
    const unknownRegion = await opsRequest("POST", "/ops/pages/sent", bundle, {
      region: "nowhere",
      pageId: "INC-1001:p1",
    });
    expect(unknownRegion.status).toBe(400);
  });
});
