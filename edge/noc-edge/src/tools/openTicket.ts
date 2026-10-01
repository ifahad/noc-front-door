import { open, TicketError, type TicketCtx } from "../services/tickets";
import { logEvent } from "../log";
import {
  TOOL_KV_BUDGET_MS,
  fail,
  flagsBounded,
  prelude,
  readSessionBounded,
  retryKvSession,
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
    // KV is a cache, not the authority: bound the session and flags reads
    // (E5) and fall back to the actor proof when they cannot answer. The
    // flags read uses the raw deps so the router's memoised port applies (E7).
    const [{ session, fromKv, timedOut, pending }, flags] = await Promise.all([
      readSessionBounded(pre.deps.kv, pre.k, TOOL_KV_BUDGET_MS),
      flagsBounded(deps, TOOL_KV_BUDGET_MS),
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
    const input = {
      site_id: str(pre.body.site_id as string | undefined, ""),
      symptom: str(pre.body.symptom as string | undefined, ""),
      impact: str(pre.body.impact as string | undefined, ""),
      service_affecting: str(pre.body.service_affecting as string | undefined, ""),
    };
    let result;
    try {
      result = await open(ctx, session, input);
    } catch (err) {
      // Ruling R-E: a denial wrote nothing, so when the session read only
      // timed out, wait for it (bounded) and retry once with the KV session.
      const kvSession =
        err instanceof TicketError && err.status === 403 && timedOut && pending !== null
          ? await retryKvSession(pending, deps, pre.started)
          : null;
      if (kvSession === null) throw err;
      result = await open({ ...ctx, trace_id: kvSession.trace_id }, kvSession, input);
    }
    logEvent("tool.open_ticket", {
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
    if (err instanceof TicketError) return denied("tool.open_ticket", deps, pre, err);
    return toolError("tool.open_ticket", deps, pre, err);
  }
}
