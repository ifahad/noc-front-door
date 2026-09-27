import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBoard, type BoardDeps } from "../../src/ops/board";
import { route } from "../../src/router";
import { SITES } from "../../../shared/src/seed";
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

  it("starts a second build when the cached board is 9 s old", async () => {
    const kv = new FakeKv();
    const actors = new FakeActorPort();
    const counters: Counters = { builds: 0 };
    const deps = makeDeps(kv, actors, counters);
    const cacheKey = {};

    const first = await getBoard(cacheKey, deps(T0));
    expect(first.sites.find((s) => s.site_id === "RUH-121")?.open_ticket).toBeNull();

    await openSiteTicket(actors, "RUH-121", "21", "bb22cc33dd44ee55", T0 + 6_000);
    const second = await getBoard(cacheKey, deps(T0 + 9_000));
    expect(counters.builds).toBe(2);
    expect(second.sites.find((s) => s.site_id === "RUH-121")?.open_ticket).not.toBeNull();
    expect(second).not.toBe(first);
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

  it("joins an in-flight build past the TTL and reuses it for 8 s after settle observation", async () => {
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
    const joined = getBoard(cacheKey, deps(T0 + 9_000));
    expect(counters.builds).toBe(1);

    release();
    const boards = await Promise.all([first, joined]);

    const observed = await getBoard(cacheKey, deps(T0 + 10_000));
    expect(counters.builds).toBe(1);
    expect(observed).toBe(boards[0]);

    const stillFresh = await getBoard(cacheKey, deps(T0 + 16_999));
    expect(counters.builds).toBe(1);
    expect(stillFresh).toBe(boards[0]);

    await getBoard(cacheKey, deps(T0 + 17_000));
    expect(counters.builds).toBe(2);
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
