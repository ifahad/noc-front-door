import { routeOpsActorPing, makeOpsTokenGetter } from "./router";
import type { NocEdgeEnv } from "./actors";
import { logEvent } from "./log";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/ops/actor-ping") {
        const nocEnv = env as NocEdgeEnv;
        return await routeOpsActorPing(
          request,
          nocEnv,
          makeOpsTokenGetter(nocEnv),
        );
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logEvent("request_failed", { lvl: "error", error: detail });
      return Response.json({ error: "internal", detail }, { status: 500 });
    }
  },
};
