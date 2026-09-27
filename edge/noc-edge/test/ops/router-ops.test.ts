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
  { method: "POST", path: "/ops/tick" },
  { method: "GET", path: "/ops/pages/pending" },
  { method: "POST", path: "/ops/pages/claim" },
  { method: "POST", path: "/ops/pages/sent" },
  { method: "GET", path: "/ops/reports" },
  {
    method: "GET",
    path: "/ops/reports/incidents/INC-1001-2026-09-27T06-00-00Z.json",
  },
  { method: "POST", path: "/diag/race" },
];

async function opsRequest(
  method: string,
  path: string,
  auth: string | null,
  env?: RouterEnvBundle,
  body?: unknown,
): Promise<Response> {
  const bundle = env ?? makeRouterEnv(OPS_TOKEN);
  const headers: Record<string, string> =
    auth === null ? {} : { authorization: auth };
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

describe("ops reports routes", () => {
  it("lists stored reports newest first", async () => {
    const env = makeRouterEnv(OPS_TOKEN);
    for (const id of ["INC-1002", "INC-1001", "INC-1003"]) {
      await env.bucket.put(`incidents/${id}-2026-09-27T06-00-00Z.json`, "{}");
    }
    const res = await opsRequest("GET", "/ops/reports", bearer(OPS_TOKEN), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reports: { key: string; size: number; uploaded: string }[] };
    expect(body.reports.map((r) => r.key)).toEqual([
      "incidents/INC-1003-2026-09-27T06-00-00Z.json",
      "incidents/INC-1002-2026-09-27T06-00-00Z.json",
      "incidents/INC-1001-2026-09-27T06-00-00Z.json",
    ]);
    for (const entry of body.reports) {
      expect(entry.size).toBe(2);
      expect(typeof entry.uploaded).toBe("string");
    }
  });

  it("serves a stored report as json", async () => {
    const env = makeRouterEnv(OPS_TOKEN);
    const report = { schema: "noc.incident-report/1", incident_id: "INC-1001" };
    const key = "incidents/INC-1001-2026-09-27T06-00-00Z.json";
    await env.bucket.put(key, JSON.stringify(report));
    const res = await opsRequest("GET", `/ops/reports/${key}`, bearer(OPS_TOKEN), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(report);
  });

  it("404s a missing report", async () => {
    const env = makeRouterEnv(OPS_TOKEN);
    const res = await opsRequest(
      "GET",
      "/ops/reports/incidents/INC-9999-2026-09-27T06-00-00Z.json",
      bearer(OPS_TOKEN),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("400s keys outside the incidents namespace", async () => {
    const env = makeRouterEnv(OPS_TOKEN);
    for (const path of [
      "/ops/reports/other/x.json",
      "/ops/reports/incidents/sub/x.json",
      "/ops/reports/INC-1001.json",
      "/ops/reports/incidents/x.json.bak",
    ]) {
      const res = await opsRequest("GET", path, bearer(OPS_TOKEN), env);
      expect(res.status).toBe(400);
    }
  });

  it("carries the report outcome and the last-report pointer through the resolve route", async () => {
    const env = makeRouterEnv(OPS_TOKEN);
    await opsRequest("POST", "/ops/reset", bearer(OPS_TOKEN), env);
    await opsRequest("POST", "/ops/stage-incident?region=riyadh-north", bearer(OPS_TOKEN), env);
    const resolve = await opsRequest(
      "POST",
      "/ops/resolve?region=riyadh-north",
      bearer(OPS_TOKEN),
      env,
    );
    expect(resolve.status).toBe(200);
    const body = (await resolve.json()) as {
      resolved: string | null;
      report: { ok: boolean; key: string };
    };
    expect(body.resolved).not.toBeNull();
    expect(body.report.ok).toBe(true);
    expect(env.bucket.raw(body.report.key)).not.toBeNull();
    expect(env.kv.raw(kvKey("report", "last"))).not.toBeNull();
  });
});
