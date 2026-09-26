import { bearerOk, makeTokenCache, type SecretGetter } from "./auth";
import { logEvent } from "./log";
import { siteStub, regionStub, type NocEdgeEnv } from "./actors";

export const DEFAULT_SITE = "RUH-114";
export const DEFAULT_REGION = "riyadh-north";

let opsTokenGetter: SecretGetter | null = null;

export function makeOpsTokenGetter(env: NocEdgeEnv): SecretGetter {
  if (opsTokenGetter === null) {
    opsTokenGetter = makeTokenCache(async () => {
      try {
        return await env.SECRETS.get("OPS_TOKEN");
      } catch {
        return null;
      }
    });
  }
  return opsTokenGetter;
}

async function pingOne(
  name: string,
  call: () => Promise<{ pong: true; name: string }>,
): Promise<{ pong: true; name: string; actor_ms: number }> {
  const started = Date.now();
  const reply = await call();
  return { ...reply, actor_ms: Date.now() - started };
}

export async function routeOpsActorPing(
  request: Request,
  env: NocEdgeEnv,
  opsToken: SecretGetter,
): Promise<Response> {
  const url = new URL(request.url);
  const site = url.searchParams.get("site") ?? DEFAULT_SITE;
  const region = url.searchParams.get("region") ?? DEFAULT_REGION;

  const header = request.headers.get("authorization");
  const expected = await opsToken();
  if (typeof expected !== "string" || !bearerOk(header, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const siteResult = await pingOne(site, () => siteStub(env, site).ping());
    const regionResult = await pingOne(region, () =>
      regionStub(env, region).ping(),
    );
    return Response.json({ site: siteResult, region: regionResult });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logEvent("actor_ping_failed", {
      lvl: "error",
      hop: "ops/actor-ping",
      error: detail,
    });
    return Response.json({ error: "actor", detail }, { status: 502 });
  }
}
