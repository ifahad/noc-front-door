import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBoard, type BoardDeps } from "../../src/ops/board";
import { route } from "../../src/router";
import { SITES } from "../../../shared/src/seed";
import { kvKey } from "../../../shared/src/kvkeys";
import { LAST_REPORT_KEY } from "../../src/services/reports";
import { FakeActorPort } from "../fakes/actors";
import { FakeKv } from "../fakes/kv";
import { bearer, makeRouterEnv, openSiteTicket, OPS_TOKEN, T0 } from "./helpers";

let logs: string[];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const regionOf = new Map(SITES.map((s) => [s.site_id, s.region]));

interface Counters {
  builds: number;
}

function makeDeps(
  kv: FakeKv,
  actors: FakeActorPort,
  counters: Counters,
  opts: { mode?: "mux" | "per-entity"; gate?: Promise<void>; failFirst?: boolean } = {},
): (now: number) => BoardDeps {
  return (now: number) => ({
    kv,
    now,
    selectActor: async () => {
      counters.builds++;
      if (opts.failFirst && counters.builds === 1) {
        throw new Error("injected_actor_error");
      }
      if (opts.gate !== undefined) await opts.gate;
      return { port: actors, mode: opts.mode ?? "per-entity" };
    },
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ops board cache", () => {
  it("shares one build across concurrent requests and a request 5 s later", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    await openSiteTicket(actors, "RUH-114", "14", "aa11bb22cc33dd44", T0);
    const counters: Counters = { builds: 0 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = makeDeps(kv, actors, counters, { gate });
    const cacheKey = {};

    const first = getBoard(cacheKey, deps(T0));
    const second = getBoard(cacheKey, deps(T0));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(counters.builds).toBe(1);
    expect(b).toBe(a);

    const third = await getBoard(cacheKey, deps(T0 + 5_000));
    expect(counters.builds).toBe(1);
    expect(third).toBe(a);
  });

  it("starts a second build once the cached board is 30 s past settle", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    const counters: Counters = { builds: 0 };
    const deps = makeDeps(kv, actors, counters);
    const cacheKey = {};
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      const first = await getBoard(cacheKey, deps(T0));
      expect(first.sites.find((s) => s.site_id === "RUH-121")?.open_ticket).toBeNull();

      await openSiteTicket(actors, "RUH-121", "21", "bb22cc33dd44ee55", T0 + 6_000);
      vi.setSystemTime(T0 + 5_000);
      const poll = await getBoard(cacheKey, deps(T0 + 5_000));
      expect(counters.builds).toBe(1);
      expect(poll).toBe(first);
      vi.setSystemTime(T0 + 29_999);
      const near = await getBoard(cacheKey, deps(T0 + 29_999));
      expect(counters.builds).toBe(1);
      expect(near).toBe(first);

      vi.setSystemTime(T0 + 30_000);
      const fresh = await getBoard(cacheKey, deps(T0 + 30_000));
      expect(counters.builds).toBe(2);
      expect(fresh.sites.find((s) => s.site_id === "RUH-121")?.open_ticket).not.toBeNull();
      expect(fresh).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebuilds on the next request after a failed build", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    const counters: Counters = { builds: 0 };
    const deps = makeDeps(kv, actors, counters, { failFirst: true });
    const cacheKey = {};

    await expect(getBoard(cacheKey, deps(T0))).rejects.toThrow("injected_actor_error");
    await flush();

    const board = await getBoard(cacheKey, deps(T0));
    expect(counters.builds).toBe(2);
    expect(board.actor_mode).toBe("per-entity");
  });

  it("adds region to every site, actor_mode and generated_at to the status body", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    const counters: Counters = { builds: 0 };
    const deps = makeDeps(kv, actors, counters, { mode: "mux" });
    const board = await getBoard({}, deps(T0));

    expect(board.actor_mode).toBe("mux");
    expect(board.generated_at).toBe(new Date(T0).toISOString());
    expect(board.sites.length).toBe(SITES.filter((s) => !s.hidden).length);
    for (const site of board.sites) {
      expect(site.region).toBe(regionOf.get(site.site_id));
    }
  });

  it("reuses a slow build for the full 30 s measured from settle, not from the start", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    await openSiteTicket(actors, "RUH-114", "14", "aa11bb22cc33dd44", T0);
    const counters: Counters = { builds: 0 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = makeDeps(kv, actors, counters, { gate });
    const cacheKey = {};
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      const first = getBoard(cacheKey, deps(T0));
      vi.setSystemTime(T0 + 10_000);
      const joined = getBoard(cacheKey, deps(T0 + 10_000));
      expect(counters.builds).toBe(1);

      release();
      const boards = await Promise.all([first, joined]);
      expect(boards[1]).toBe(boards[0]);

      const rightAfterSettle = await getBoard(cacheKey, deps(T0 + 10_500));
      expect(counters.builds).toBe(1);
      expect(rightAfterSettle).toBe(boards[0]);

      vi.setSystemTime(T0 + 39_999);
      const near = await getBoard(cacheKey, deps(T0 + 39_999));
      expect(counters.builds).toBe(1);
      expect(near).toBe(boards[0]);

      vi.setSystemTime(T0 + 40_000);
      const expired = await getBoard(cacheKey, deps(T0 + 40_000));
      expect(counters.builds).toBe(2);
      expect(expired).not.toBe(boards[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebuilds a degraded board after 10 s while a healthy board stays for 30 s", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    const counters: Counters = { builds: 0 };
    const deps = makeDeps(kv, actors, counters);
    const cacheKey = {};
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      actors.failNextGetTicket("RUH-114", 1);
      const degraded = await getBoard(cacheKey, deps(T0));
      expect(degraded.degraded).toBe(true);
      expect(counters.builds).toBe(1);

      const withinTen = await getBoard(cacheKey, deps(T0 + 9_999));
      expect(counters.builds).toBe(1);
      expect(withinTen.degraded).toBe(true);

      vi.setSystemTime(T0 + 10_000);
      const rebuilt = await getBoard(cacheKey, deps(T0 + 10_000));
      expect(counters.builds).toBe(2);
      expect(rebuilt.degraded).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a slow in-flight build out of the actor path of later concurrent viewers", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    const counters: Counters = { builds: 0 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = makeDeps(kv, actors, counters, { gate });
    const cacheKey = {};

    const first = getBoard(cacheKey, deps(T0));
    const second = getBoard(cacheKey, deps(T0 + 100));
    release();
    await Promise.all([first, second]);
    expect(counters.builds).toBe(1);
  });
});

describe("ops board last_report", () => {
  it("carries the last_report pointer once resolve wrote it", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    const deps = makeDeps(kv, actors, { builds: 0 });
    const none = await getBoard({}, deps(T0));
    expect(none.last_report).toBeNull();

    const pointer = {
      key: "incidents/INC-1001-2026-09-27T06-00-00Z.json",
      incident_id: "INC-1001",
      resolved_at: new Date(T0).toISOString(),
    };
    await kv.put(LAST_REPORT_KEY, JSON.stringify(pointer));
    const board = await getBoard({}, deps(T0 + 1_000));
    expect(board.last_report).toEqual(pointer);
  });

  it("treats a malformed pointer as no report", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    await kv.put(LAST_REPORT_KEY, "not json");
    const board = await getBoard({}, makeDeps(kv, actors, { builds: 0 })(T0));
    expect(board.last_report).toBeNull();
  });

  it("fails open to null when the pointer read fails", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    kv.failNext(1);
    const board = await getBoard({}, makeDeps(kv, actors, { builds: 0 })(T0));
    expect(board.last_report).toBeNull();
  });
});

describe("public status rides the board single-flight cache", () => {
  it("serves ten concurrent /ops/status and /ops/board requests from one build", async () => {
    const bundle = makeRouterEnv(OPS_TOKEN);
    const paths = ["/ops/status", "/ops/board", "/ops/status?format=html"];
    for (let i = 0; i < 7; i++) paths.push(i % 2 === 0 ? "/ops/status" : "/ops/board");
    const responses = await Promise.all(
      paths.map((path) => route(new Request(`https://x${path}`), bundle.env)),
    );
    for (const res of responses) expect(res.status).toBe(200);

    const heartbeatGets = bundle.kv.calls.filter(
      (c) => c.op === "get" && c.key === kvKey("ops", "heartbeat"),
    );
    expect(heartbeatGets).toHaveLength(1);

    const statusPayload = (await responses[0].json()) as Record<string, unknown> & {
      sites: Record<string, unknown>[];
    };
    expect(statusPayload.actor_mode).toBeUndefined();
    expect(statusPayload.generated_at).toBeUndefined();
    expect(statusPayload.last_report).toBeUndefined();
    expect(statusPayload.sites.length).toBe(SITES.filter((s) => !s.hidden).length);
    for (const site of statusPayload.sites) expect(site.region).toBeUndefined();

    const boardPayload = (await responses[1].json()) as { actor_mode: string };
    expect(boardPayload.actor_mode).toBe("per-entity");

    const html = await responses[2].text();
    expect(html).toContain('http-equiv="refresh" content="8"');
  });

  it("reuses the cached build for a status request after a board build", async () => {
    const bundle = makeRouterEnv(OPS_TOKEN);
    await route(new Request("https://x/ops/board"), bundle.env);
    const status = await route(new Request("https://x/ops/status"), bundle.env);
    expect(status.status).toBe(200);
    const heartbeatGets = bundle.kv.calls.filter(
      (c) => c.op === "get" && c.key === kvKey("ops", "heartbeat"),
    );
    expect(heartbeatGets).toHaveLength(1);
  });
});

describe("GET /ops/board route", () => {
  const HEADERS = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };

  it("is public and serves the board json with protective headers", async () => {
    const bundle = makeRouterEnv(OPS_TOKEN);
    const res = await route(new Request("https://x/ops/board"), bundle.env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(HEADERS["content-type"]);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const payload = (await res.json()) as {
      actor_mode: string;
      generated_at: string;
      sites: { region: string }[];
      regions: unknown[];
    };
    expect(payload.actor_mode).toBe("per-entity");
    expect(typeof payload.generated_at).toBe("string");
    expect(payload.sites.length).toBeGreaterThan(0);
    for (const site of payload.sites) expect(typeof site.region).toBe("string");
    expect(payload.regions.length).toBe(4);
  });

  it("answers HEAD /ops/board with the same headers and an empty body", async () => {
    const bundle = makeRouterEnv(OPS_TOKEN);
    const res = await route(new Request("https://x/ops/board", { method: "HEAD" }), bundle.env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("");
  });

  it("rejects other methods with 405", async () => {
    const bundle = makeRouterEnv(OPS_TOKEN);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"] as const) {
      const res = await route(new Request("https://x/ops/board", { method }), bundle.env);
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: "method_not_allowed" });
    }
  });

  it("serves a bearer-authed ops caller the same public board", async () => {
    const bundle = makeRouterEnv(OPS_TOKEN);
    const res = await route(
      new Request("https://x/ops/board", { headers: { authorization: bearer(OPS_TOKEN) } }),
      bundle.env,
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { actor_mode: string };
    expect(payload.actor_mode).toBe("per-entity");
  });
});
