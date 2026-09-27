import { get } from "../services/sessions";
import { logEvent } from "../log";
import {
  fail,
  prelude,
  toolError,
  usable,
  type PreludeOk,
  type ToolDeps,
} from "./common";

export async function handleCallback(
  request: Request,
  deps: ToolDeps,
): Promise<Response> {
  const pre = await prelude(request, deps, "tool.callback");
  if (!pre.ok) return pre.response;
  try {
    if (pre.k === null) {
      return fail("tool.callback", deps, pre, 422, "no_identity");
    }
    const [session] = await Promise.all([
      get(deps.kv, pre.k),
      pre.convPending ?? Promise.resolve(false),
    ]);
    const siteId = session.sites[0] ?? null;
    const trace_id = session.trace_id;
    let noted = false;
    if (siteId !== null) {
      try {
        const got = await deps.actors.site(siteId).getTicket({ trace_id });
        const note = usable(pre.body.callback_note)
          ? `Callback requested: ${pre.body.callback_note as string}`
          : null;
        if (got.ticket !== null && note !== null) {
          await deps.actors.site(siteId).addNote({
            k: pre.k,
            ticketId: got.ticket.id,
            note,
            at: deps.now(),
            trace_id,
          });
          noted = true;
        }
      } catch {
        noted = false;
      }
    }
    logEvent("page.raised", {
      hop: "tool",
      trace_id,
      k: pre.k,
      site: siteId ?? undefined,
      outcome: noted ? "ok" : "fallback",
    });
    logEvent("tool.callback", {
      hop: "tool",
      trace_id,
      k: pre.k,
      site: siteId ?? undefined,
      outcome: noted ? "ok" : "fallback",
      total_ms: deps.now() - pre.started,
    });
    return Response.json({ escalated: "true", callback_note: "none" }, { status: 200 });
  } catch (err) {
    return toolError("tool.callback", deps, pre, err);
  }
}
