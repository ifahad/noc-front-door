import {
  joinIncident,
  open,
  TicketError,
  type OpenResult,
  type TicketCtx,
} from "../services/tickets";
import type { Session } from "../../../shared/src/types";
import { logEvent } from "../log";
import {
  TOOL_KV_BUDGET_MS,
  fail,
  flagsBounded,
  prelude,
  readSessionBounded,
  retryKvSession,
  toolError,
  usable,
  type PreludeOk,
  type ToolDeps,
} from "./common";

const NO_INCIDENT_PREFIX =
  "There is no active incident for your region right now.";

function denied(
  evt: string,
  deps: ToolDeps,
  pre: PreludeOk,
  err: TicketError,
): Response {
  logEvent(evt, {
    hop: "tool",
    trace_id: pre.trace_id,
    k: pre.k ?? "none",
    outcome: err.status === 403 ? "denied" : "error",
    reason: err.message,
    total_ms: deps.now() - pre.started,
  });
  return Response.json({ error: err.message }, { status: err.status });
}

export async function handleJoinIncident(
  request: Request,
  deps: ToolDeps,
): Promise<Response> {
  const pre = await prelude(request, deps, "tool.join_incident");
  if (!pre.ok) return pre.response;
  try {
    if (pre.k === null) {
      return fail("tool.join_incident", deps, pre, 422, "no_identity");
    }
    // Bound the session and flags reads (E5, E7); the body site_id, preset
    // by the assistant from verify_site's stored variable, is the site
    // fallback when KV cannot answer (S1).
    const [{ session, fromKv, timedOut, pending }, flags] = await Promise.all([
      readSessionBounded(pre.deps.kv, pre.k, TOOL_KV_BUDGET_MS),
      flagsBounded(deps, TOOL_KV_BUDGET_MS),
    ]);
    const rawSite = pre.body.site_id;
    const bodySite = usable(rawSite) ? rawSite : null;
    const ctx: TicketCtx = {
      actors: pre.deps.actors,
      kv: pre.deps.kv,
      adapter: pre.deps.adapter,
      flags,
      now: pre.deps.now(),
      trace_id: session.trace_id,
      deferSync: true,
    };
    const attemptWith = async (s: Session): Promise<OpenResult> => {
      const sctx: TicketCtx = { ...ctx, trace_id: s.trace_id };
      try {
        return await joinIncident(sctx, s, bodySite);
      } catch (err) {
        if (!(err instanceof TicketError) || err.code !== "no_active_incident") {
          throw err;
        }
        const sessionSite = s.sites[0];
        const opened = await open(
          sctx,
          s,
          {
            site_id: (usable(sessionSite) ? sessionSite : null) ?? bodySite ?? "",
            symptom: "none",
            impact: "site_down",
            service_affecting: "true",
          },
          "not_identified",
        );
        return {
          ...opened,
          ticket_readback: `${NO_INCIDENT_PREFIX} ${opened.ticket_readback}`,
        };
      }
    };
    let result;
    try {
      result = await attemptWith(session);
    } catch (err) {
      // Ruling R-E: a denial wrote nothing, so when the session read only
      // timed out, wait for it (bounded) and retry once with the KV session.
      const kvSession =
        err instanceof TicketError && err.status === 403 && timedOut && pending !== null
          ? await retryKvSession(pending, deps, pre.started)
          : null;
      if (kvSession === null) throw err;
      result = await attemptWith(kvSession);
    }
    logEvent("tool.join_incident", {
      hop: "tool",
      trace_id: pre.trace_id,
      k: pre.k,
      ticket_id: result.ticket_id,
      outcome: "ok",
      session_src: fromKv ? "kv" : "none",
      kv_ms: pre.kvMs(),
      actor_ms: pre.actorMs(),
      total_ms: pre.deps.now() - pre.started,
    });
    return Response.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof TicketError) return denied("tool.join_incident", deps, pre, err);
    return toolError("tool.join_incident", deps, pre, err);
  }
}
