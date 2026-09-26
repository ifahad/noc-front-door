import { route } from "./router";
import type { NocEdgeEnv } from "./actors";
import { logEvent } from "./log";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env as NocEdgeEnv);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logEvent("request_failed", { lvl: "error", error: detail, outcome: "error" });
      return Response.json({ error: "internal" }, { status: 500 });
    }
  },
};
