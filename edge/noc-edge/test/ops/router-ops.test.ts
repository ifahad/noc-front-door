import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { route } from "../../src/router";
import { resetCanaryCounters } from "../../src/ops/health";
import { kvKey } from "../../../shared/src/kvkeys";
import { bearer, makeRouterEnv, OPS_TOKEN, type RouterEnvBundle } from "./helpers";

interface LogLine extends Record<string, unknown> {
  evt: string;
}

let logs: string[];
beforeEach(() => {
  logs = [];
  resetCanaryCounters();
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function eventsWith(evt: string): LogLine[] {
  return logs.map((l) => JSON.parse(l) as LogLine).filter((l) => l.evt === evt);
}

const OPS_PATHS: { method: string; path: string }[] = [
  { method: "GET", path: "/ops/health/deep" },
  { method: "POST", path: "/ops/reset" },
  { method: "POST", path: "/ops/stage-incident" },
  { method: "POST", path: "/ops/resolve" },
  { method: "POST", path: "/ops/ack" },
  { method: "POST", path: "/ops/unlock" },
  { method: "POST", path: "/diag/race" },
];

async function opsRequest(
  method: string,
  path: string,
  auth: string | null,
  env?: RouterEnvBundle,
): Promise<Response> {
  const bundle = env ?? makeRouterEnv(OPS_TOKEN);
  const headers: Record<string, string> =
    auth === null ? {} : { authorization: auth };
  return route(new Request(`https://x${path}`, { method, headers }), bundle.env);
}

describe("ops routes auth", () => {
  it("returns 401 without a token on every ops route", async () => {
    const env = makeRouterEnv(OPS_TOKEN);
    for (const spec of OPS_PATHS) {
      const res = await opsRequest(spec.method, spec.path, null, env);
      expect(res.status).toBe(401);
    }
  });

  it("returns 401 with a wrong token on every ops route", async () => {
    const env = makeRouterEnv(OPS_TOKEN);
    for (const spec of OPS_PATHS) {
      const res = await opsRequest(spec.method, spec.path, bearer("wrong"), env);
      expect(res.status).toBe(401);
    }
  });

  it("returns 401 when the ops token secret cannot be read", async () => {
    const env = makeRouterEnv(null);
    const res = await opsRequest("POST", "/ops/reset", bearer(OPS_TOKEN), env);
    expect(res.status).toBe(401);
  });
});

describe("ops routes wired", () => {
  it("serves the public status as json and html", async () => {
    const env = makeRouterEnv(OPS_TOKEN);
    const json = await opsRequest("GET", "/ops/status", null, env);
    expect(json.status).toBe(200);
    const payload = (await json.json()) as { regions: unknown[]; sites: unknown[] };
    expect(Array.isArray(payload.regions)).toBe(true);
    expect(Array.isArray(payload.sites)).toBe(true);
    const html = await opsRequest("GET", "/ops/status?format=html", null, env);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain('http-equiv="refresh" content="5"');
  });

  it("runs the deep health end to end", async () => {
    const env = makeRouterEnv(OPS_TOKEN);
    const res = await opsRequest("GET", "/ops/health/deep", bearer(OPS_TOKEN), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checks: Record<string, number> };
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.checks.kv_ms).toBeGreaterThanOrEqual(0);
    expect(env.kv.has(kvKey("ops", "heartbeat"))).toBe(true);
  });

  it("runs reset, stage, ack, resolve, unlock and race end to end", async () => {
    const env = makeRouterEnv(OPS_TOKEN);
    const reset = await opsRequest("POST", "/ops/reset", bearer(OPS_TOKEN), env);
    expect(reset.status).toBe(200);
    expect(((await reset.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);

    const stage = await opsRequest(
      "POST",
      "/ops/stage-incident?region=riyadh-north",
      bearer(OPS_TOKEN),
      env,
    );
    expect(stage.status).toBe(200);
    const staged = (await stage.json()) as { incident: { site_count: number } | null };
    expect(staged.incident?.site_count).toBe(2);

    const ack = await opsRequest("POST", "/ops/ack?region=riyadh-north", bearer(OPS_TOKEN), env);
    expect(ack.status).toBe(200);
    expect(((await ack.json()) as { acked: boolean }).acked).toBe(true);

    const resolve = await opsRequest(
      "POST",
      "/ops/resolve?region=riyadh-north",
      bearer(OPS_TOKEN),
      env,
    );
    expect(resolve.status).toBe(200);
    expect(((await resolve.json()) as { resolved: string | null }).resolved).not.toBeNull();

    const unlock = await opsRequest("POST", "/ops/unlock?site=RUH-114", bearer(OPS_TOKEN), env);
    expect(unlock.status).toBe(200);
    expect(((await unlock.json()) as { ok: boolean }).ok).toBe(true);

    const race = await opsRequest("POST", "/diag/race?mode=actor&n=5", bearer(OPS_TOKEN), env);
    expect(race.status).toBe(200);
    const raced = (await race.json()) as { mode: string; created_count: number };
    expect(raced.mode).toBe("actor");
    expect(raced.created_count).toBe(1);
  });

  it("maps ops action errors to 422", async () => {
    const env = makeRouterEnv(OPS_TOKEN);
    const res = await opsRequest("POST", "/ops/stage-incident?region=jeddah", bearer(OPS_TOKEN), env);
    expect(res.status).toBe(422);
    const race = await opsRequest("POST", "/diag/race?mode=nope", bearer(OPS_TOKEN), env);
    expect(race.status).toBe(422);
  });

  it("404s an unknown ops path", async () => {
    const res = await opsRequest("GET", "/ops/unknown", null);
    expect(res.status).toBe(404);
  });

  it("logs the canary check and summary lines from the deep health", async () => {
    const env = makeRouterEnv(OPS_TOKEN);
    await opsRequest("GET", "/ops/health/deep", bearer(OPS_TOKEN), env);
    expect(eventsWith("canary.check")).toHaveLength(1);
    expect(eventsWith("canary.summary")).toHaveLength(1);
  });
});
