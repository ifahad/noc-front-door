import { sessionKey, traceId } from "../../../shared/src/ids";
import { openTicketNote } from "../../../shared/src/readback";
import { get, linkConversation, putAuth } from "../services/sessions";
import type { IncidentProjection } from "../services/incidents";
import { logEvent } from "../log";
import {
  customersName,
  fail,
  flagsOf,
  prelude,
  readProjection,
  str,
  toolError,
  usable,
  type ToolDeps,
} from "./common";

const DEFAULTS = {
  route_hint: "unverified",
  caller_name: "there",
  customer_name: "your organisation",
  site_id: "unknown",
  site_label: "your site",
  incident_region: "your area",
  incident_started: "earlier today",
  incident_summary: "a network incident",
  incident_eta: "shortly",
  open_ticket_note: "none",
};

async function fpOf(pepper: string, k: string, pin: string): Promise<string> {
  if (pepper === "") throw new Error("missing_pepper");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${k}|${pin}`),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function incidentFields(
  projection: IncidentProjection | null,
): Record<string, string> {
  return {
    incident_region: str(projection?.region_label, DEFAULTS.incident_region),
    incident_started: str(projection?.started_local, DEFAULTS.incident_started),
    incident_summary: str(projection?.summary, DEFAULTS.incident_summary),
    incident_eta: str(projection?.eta_local, DEFAULTS.incident_eta),
  };
}

export async function handleVerifySite(
  request: Request,
  deps: ToolDeps,
): Promise<Response> {
  const pre = await prelude(request, deps, "tool.verify_site");
  if (!pre.ok) return pre.response;
  try {
    const siteInput = usable(pre.body.site_id) ? pre.body.site_id : null;
    const pin = usable(pre.body.pin) ? pre.body.pin : null;
    if (siteInput === null || pin === null) {
      return fail("tool.verify_site", deps, pre, 422, "missing_site_or_pin");
    }
    let minted: string | null = null;
    let k = pre.k;
    if (k === null) {
      minted = crypto.randomUUID();
      k = (await sessionKey({ call_key: minted })) as string;
    }
    const site = await deps.adapter.resolveSiteGlobal(siteInput);
    if (site === null) {
      return fail("tool.verify_site", deps, pre, 422, "site_unresolvable");
    }
    const valid = await deps.adapter.checkPin(pin, site.site_id);
    const fp = await fpOf(deps.pinPepper, k, pin);
    const trace_id = traceId(k);
    const attempt = await deps.actors.site(site.site_id).recordPinAttempt({
      k,
      valid,
      fp,
      trace_id,
      at: deps.now(),
    });
    const verified = attempt.result === "ok";
    let degraded = pre.k !== null && !pre.convLinked;
    let caller_name = DEFAULTS.caller_name;
    let customer_name = DEFAULTS.customer_name;
    let projection: IncidentProjection | null = null;
    let deflection = false;
    let open_note = DEFAULTS.open_ticket_note;
    if (verified && k !== null) {
      try {
        await putAuth(deps.kv, k, {
          verified: true,
          site_id: site.site_id,
          customer_id: site.customer_id,
          at: deps.now(),
        });
      } catch {
        degraded = true;
      }
      if (pre.k === null) {
        const convId = usable(pre.body.conversation_id)
          ? pre.body.conversation_id
          : null;
        if (convId !== null) {
          try {
            await linkConversation(deps.kv, convId, k);
          } catch {
            degraded = true;
          }
        }
      }
      try {
        const session = await get(deps.kv, k);
        const contact =
          session.contact_id !== null
            ? await deps.adapter.findContactById(session.contact_id)
            : null;
        caller_name = str(contact?.name, DEFAULTS.caller_name);
        customer_name = str(
          contact?.customer_name,
          customersName(site.customer_id) ?? DEFAULTS.customer_name,
        );
      } catch {
        degraded = true;
      }
      try {
        const flags = await flagsOf(deps);
        projection = await readProjection(deps.kv, site.region);
        deflection = flags.deflection_enabled;
      } catch {
        degraded = true;
      }
      try {
        const got = await deps.actors.site(site.site_id).getTicket({ trace_id });
        open_note = got.ticket !== null ? openTicketNote({ id: got.ticket.id }) : "none";
      } catch {
        degraded = true;
      }
    }
    const call_key =
      k !== null && minted === null
        ? pre.callKey
        : verified && minted !== null
          ? minted
          : "none";
    const route_hint =
      verified && projection !== null && deflection ? "known_incident" : verified ? "verified" : DEFAULTS.route_hint;
    const body: Record<string, string> = {
      verify_result: attempt.result,
      attempts_left: String(attempt.attemptsLeft),
      pin: "none",
      call_key,
      route_hint,
      site_id: verified ? site.site_id : DEFAULTS.site_id,
      site_label: verified ? site.label : DEFAULTS.site_label,
      caller_name,
      customer_name,
      ...(verified ? incidentFields(projection) : incidentFields(null)),
      open_ticket_note: open_note,
    };
    logEvent("tool.verify_site", {
      hop: "tool",
      trace_id,
      k: k ?? "none",
      site: verified ? site.site_id : undefined,
      verify_result: attempt.result,
      outcome: verified ? (degraded ? "fallback" : "ok") : "denied",
      total_ms: deps.now() - pre.started,
    });
    return Response.json(body, { status: 200 });
  } catch (err) {
    return toolError("tool.verify_site", deps, pre, err);
  }
}
