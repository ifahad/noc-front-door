import { sessionKey, traceId } from "../../../shared/src/ids";
import { openTicketNote } from "../../../shared/src/readback";
import { deadline } from "../../../shared/src/timing";
import { get, linkConversation, putAuth } from "../services/sessions";
import type { IncidentProjection } from "../services/incidents";
import { logEvent } from "../log";
import {
  ENRICH_BUDGET_MS,
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
    const site = await pre.deps.adapter.resolveSiteGlobal(siteInput);
    if (site === null) {
      return fail("tool.verify_site", deps, pre, 422, "site_unresolvable");
    }
    const valid = await pre.deps.adapter.checkPin(pin, site.site_id);
    const fp = await fpOf(pre.deps.pinPepper, k, pin);
    const trace_id = traceId(k);
    // The actor is the only awaited write on the critical path (kvfree E3):
    // every KV read/write below is enrichment, each bounded by a deadline.
    const attempt = await pre.deps.actors.site(site.site_id).recordPinAttempt({
      k,
      valid,
      fp,
      trace_id,
      at: deps.now(),
    });
    const verified = attempt.result === "ok";
    let degraded = false;
    let caller_name = DEFAULTS.caller_name;
    let customer_name = DEFAULTS.customer_name;
    let projection: IncidentProjection | null = null;
    let deflection = false;
    let open_note = DEFAULTS.open_ticket_note;
    if (verified && k !== null) {
      // Ruling R-D: the seed name is assigned only inside the verified
      // block, so an invalid or locked PIN never reveals the organisation.
      customer_name = customersName(site.customer_id) ?? DEFAULTS.customer_name;
      const convId = usable(pre.body.conversation_id)
        ? pre.body.conversation_id
        : null;
      const [authR, linkR, convR, contactR, flagsR, projR, ticketR] = await Promise.all([
        deadline(
          putAuth(pre.deps.kv, k, {
            verified: true,
            site_id: site.site_id,
            customer_id: site.customer_id,
            at: deps.now(),
          }),
          ENRICH_BUDGET_MS,
          "verify.auth",
        ),
        deadline(
          minted !== null && convId !== null
            ? linkConversation(pre.deps.kv, convId, k)
            : Promise.resolve(),
          ENRICH_BUDGET_MS,
          "verify.conv_minted",
        ),
        deadline(
          pre.convPending ?? Promise.resolve(false),
          ENRICH_BUDGET_MS,
          "verify.conv",
        ),
        deadline(
          (async () => {
            const session = await get(pre.deps.kv, k);
            const contact =
              session.contact_id !== null
                ? await pre.deps.adapter.findContactById(session.contact_id)
                : null;
            return {
              caller: str(contact?.name, DEFAULTS.caller_name),
              customer: str(
                contact?.customer_name,
                customersName(site.customer_id) ?? DEFAULTS.customer_name,
              ),
            };
          })(),
          ENRICH_BUDGET_MS,
          "verify.contact",
        ),
        // E7: the raw deps KV port, so the 60 s flags memo and the in-flight
        // dedupe the router already started apply (no fresh reads per call).
        deadline(flagsOf(deps), ENRICH_BUDGET_MS, "verify.flags"),
        deadline(
          readProjection(pre.deps.kv, site.region),
          ENRICH_BUDGET_MS,
          "verify.projection",
        ),
        deadline(
          pre.deps.actors.site(site.site_id).getTicket({ trace_id }),
          ENRICH_BUDGET_MS,
          "verify.ticket",
        ),
      ]);
      if (!authR.ok) degraded = true;
      if (!linkR.ok) degraded = true;
      if (!contactR.ok) {
        degraded = true;
      } else {
        caller_name = contactR.value.caller;
        customer_name = contactR.value.customer;
      }
      if (!flagsR.ok) {
        degraded = true;
      } else {
        deflection = flagsR.value.deflection_enabled;
      }
      if (!projR.ok) {
        degraded = true;
      } else {
        projection = projR.value;
      }
      if (!ticketR.ok) {
        degraded = true;
      } else {
        open_note =
          ticketR.value.ticket !== null
            ? openTicketNote({ id: ticketR.value.ticket.id })
            : "none";
      }
      // The conversation rule is unchanged: a pre-existing call identity is
      // degraded when its conversation link could not be confirmed.
      if (pre.k !== null && !(convR.ok && convR.value)) degraded = true;
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
      kv_ms: pre.kvMs(),
      actor_ms: pre.actorMs(),
      total_ms: deps.now() - pre.started,
    });
    return Response.json(body, { status: 200 });
  } catch (err) {
    return toolError("tool.verify_site", deps, pre, err);
  }
}
