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
    const session = await get(deps.kv, pre.k);
    const flags = await flagsOf(deps);
    const ctx: TicketCtx = {
      actors: deps.actors,
      kv: deps.kv,
      adapter: deps.adapter,
      flags,
      now: deps.now(),
      trace_id: session.trace_id,
    };
    let result;
    try {
      result = await joinIncident(ctx, session);
    } catch (err) {
      if (!(err instanceof TicketError) || err.message !== "no_active_incident") {
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
      trace_id: session.trace_id,
      k: pre.k,
      ticket_id: result.ticket_id,
      outcome: "ok",
      total_ms: deps.now() - pre.started,
    });
    return Response.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof TicketError) return denied("tool.join_incident", deps, pre, err);
    return toolError("tool.join_incident", deps, pre, err);
  }
}
