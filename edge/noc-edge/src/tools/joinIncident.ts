import { open, joinIncident, TicketError, type TicketCtx } from "../services/tickets";
import { get } from "../services/sessions";
import { logEvent } from "../log";
import {
  fail,
  flagsOf,
  prelude,
  toolError,
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
    const [session, flags] = await Promise.all([
      get(pre.deps.kv, pre.k),
      flagsOf(pre.deps),
      pre.convPending ?? Promise.resolve(false),
    ]);
    const ctx: TicketCtx = {
      actors: pre.deps.actors,
      kv: pre.deps.kv,
      adapter: pre.deps.adapter,
      flags,
      now: pre.deps.now(),
      trace_id: session.trace_id,
      deferSync: true,
    };
    let result;
    try {
      result = await joinIncident(ctx, session);
    } catch (err) {
      if (!(err instanceof TicketError) || err.code !== "no_active_incident") {
        throw err;
      }
      result = await open(ctx, session, {
        site_id: session.sites[0] ?? "",
        symptom: "none",
        impact: "site_down",
        service_affecting: "true",
      });
      result = {
        ...result,
        ticket_readback: `${NO_INCIDENT_PREFIX} ${result.ticket_readback}`,
      };
    }
    logEvent("tool.join_incident", {
      hop: "tool",
      trace_id: pre.trace_id,
      k: pre.k,
      ticket_id: result.ticket_id,
      outcome: "ok",
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
