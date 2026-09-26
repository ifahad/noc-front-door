import { open, TicketError, type TicketCtx } from "../services/tickets";
import { get } from "../services/sessions";
import { logEvent } from "../log";
import {
  fail,
  flagsOf,
  prelude,
  str,
  toolError,
  type PreludeOk,
  type ToolDeps,
} from "./common";

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

export async function handleOpenTicket(
  request: Request,
  deps: ToolDeps,
): Promise<Response> {
  const pre = await prelude(request, deps, "tool.open_ticket");
  if (!pre.ok) return pre.response;
  try {
    if (pre.k === null) {
      return fail("tool.open_ticket", deps, pre, 422, "no_identity");
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
    const result = await open(ctx, session, {
      site_id: str(pre.body.site_id as string | undefined, ""),
      symptom: str(pre.body.symptom as string | undefined, ""),
      impact: str(pre.body.impact as string | undefined, ""),
      service_affecting: str(pre.body.service_affecting as string | undefined, ""),
    });
    logEvent("tool.open_ticket", {
      hop: "tool",
      trace_id: session.trace_id,
      k: pre.k,
      ticket_id: result.ticket_id,
      outcome: "ok",
      total_ms: deps.now() - pre.started,
    });
    return Response.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof TicketError) return denied("tool.open_ticket", deps, pre, err);
    return toolError("tool.open_ticket", deps, pre, err);
  }
}
