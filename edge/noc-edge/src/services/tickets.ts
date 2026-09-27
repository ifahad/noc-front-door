import { canWrite } from "../../../shared/src/authz";
import { spellId } from "../../../shared/src/ids";
import type { Impact, Incident, Session } from "../../../shared/src/types";
import {
  incidentAffects,
  joinReadback,
  ticketReadback,
  type ReadbackIncident,
} from "../../../shared/src/readback";
import { classify } from "../../../shared/src/severity";
import type { SeedAdapter } from "../../../shared/src/itsm";
import { logEvent } from "../log";
import type { ActorPort, ReportSiteInput, ReportSiteResult, SiteStateApi } from "./actorPort";
import type { Flags } from "./flags";
import { incidentSummaryOf, regionCodeOf, syncProjection } from "./incidents";
import type { KvPort } from "./kvPort";

export type TicketErrorCode =
  | "fault_injected"
  | "missing_site_id"
  | "site_not_writable"
  | "site_unresolvable"
  | "not_identified"
  | "no_active_incident";

export class TicketError extends Error {
  status: 403 | 422 | 500 | 503 | 504;
  code: TicketErrorCode;

  constructor(
    status: 403 | 422 | 500 | 503 | 504,
    code: TicketErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "TicketError";
    this.status = status;
    this.code = code;
  }
}

const IMPACTS: readonly Impact[] = ["site_down", "degraded", "single_user"];

const SITE_SENTINELS = new Set(["none", "unknown"]);

function usableSite(value: string | undefined | null): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !SITE_SENTINELS.has(value) &&
    !value.includes("{{")
  );
}

export interface TicketCtx {
  actors: ActorPort;
  kv: KvPort;
  adapter: SeedAdapter;
  flags: Flags;
  now: number;
  trace_id: string;
}

export interface TicketInput {
  site_id: string;
  symptom: string;
  impact: string;
  service_affecting: string;
}

export interface OpenResult {
  ticket_id: string;
  priority: string;
  created: string;
  ticket_readback: string;
  incident_note: string;
  symptom: string;
  impact: string;
}

export async function open(
  ctx: TicketCtx,
  session: Session,
  input: TicketInput,
): Promise<OpenResult> {
  if (!usableSite(input.site_id)) {
    throw new TicketError(422, "missing_site_id");
  }
  return (await openInternal(ctx, session, input)).result;
}

interface ReportMeta {
  incident: Incident | null;
  upgraded: boolean;
}

async function openInternal(
  ctx: TicketCtx,
  session: Session,
  input: TicketInput,
): Promise<{ result: OpenResult; report: ReportMeta | null }> {
  if (ctx.flags.fault_open_ticket !== null) {
    throw new TicketError(ctx.flags.fault_open_ticket, "fault_injected");
  }
  if (!canWrite(session, input.site_id)) {
    logEvent("auth.denied", {
      hop: "services/tickets",
      trace_id: ctx.trace_id,
      site_id: input.site_id,
      outcome: "denied",
    });
    throw new TicketError(403, "site_not_writable");
  }
  const site = await ctx.adapter.getSite(input.site_id);
  if (site === null) {
    throw new TicketError(422, "site_unresolvable");
  }
  const impact: Impact = (IMPACTS as readonly string[]).includes(input.impact)
    ? (input.impact as Impact)
    : "single_user";
  const symptom = input.symptom.length > 0 ? input.symptom : "none";
  const priority = classify(impact, truthy(input.service_affecting));
  const siteActor = ctx.actors.site(site.site_id);
  const opened = await siteActor.openOrAttach({
    k: session.k,
    trace_id: ctx.trace_id,
    callerRef: session.contact_id ?? "none",
    symptom,
    impact,
    serviceAffecting: truthy(input.service_affecting),
    priority,
    at: ctx.now,
    siteCode: site.code,
  });
  const ticket = opened.ticket;
  let report: ReportMeta | null = null;
  if (ticket.impact === "site_down" && !ticket.regionReported) {
    const region = site.region;
    const reportInput: ReportSiteInput = {
      siteId: site.site_id,
      ticketId: ticket.id,
      regionCode: regionCodeOf(region),
      trace_id: ctx.trace_id,
      at: ctx.now,
    };
    let reportedResult: ReportSiteResult | null = null;
    try {
      reportedResult = await ctx.actors.region(region).reportSite(reportInput);
    } catch {
      try {
        reportedResult = await ctx.actors.region(region).reportSite(reportInput);
      } catch (err) {
        logEvent("incidents.report_failed", {
          hop: "services/tickets",
          trace_id: ctx.trace_id,
          region,
          lvl: "warn",
          outcome: "error",
          error: String(err),
        });
      }
    }
    if (reportedResult !== null) {
      try {
        await siteActor.markRegionReported({
          ticketId: ticket.id,
          trace_id: ctx.trace_id,
          at: ctx.now,
        });
      } catch (err) {
        logEvent("incidents.report_failed", {
          hop: "services/tickets",
          trace_id: ctx.trace_id,
          region,
          lvl: "warn",
          outcome: "error",
          error: String(err),
        });
      }
      report = { incident: reportedResult.incident, upgraded: reportedResult.upgraded };
    }
  }
  await syncProjection({ actors: ctx.actors, kv: ctx.kv }, site.region, ctx.trace_id);
  const readback = ticketReadback({
    ticket,
    created: opened.created,
    priorityRaised: opened.priorityRaised,
    incident: readbackIncident(report?.incident ?? null, site.region_label),
    now: ctx.now,
  });
  return {
    result: {
      ticket_id: ticket.id,
      priority: ticket.priority,
      created: opened.created ? "true" : "false",
      ticket_readback: readback,
      incident_note: incidentNote(readbackIncident(report?.incident ?? null, site.region_label)),
      symptom: "none",
      impact: "unknown",
    },
    report,
  };
}

export async function joinIncident(
  ctx: TicketCtx,
  session: Session,
): Promise<OpenResult> {
  const siteId = session.sites[0] ?? "";
  if (!usableSite(siteId)) {
    throw new TicketError(422, "missing_site_id");
  }
  if (ctx.flags.fault_open_ticket !== null) {
    throw new TicketError(ctx.flags.fault_open_ticket, "fault_injected");
  }
  if (!(session.identified || session.verified)) {
    logEvent("auth.denied", {
      hop: "services/tickets",
      trace_id: ctx.trace_id,
      outcome: "denied",
    });
    throw new TicketError(403, "not_identified");
  }
  const site = await ctx.adapter.getSite(siteId);
  if (site === null) {
    throw new TicketError(422, "site_unresolvable");
  }
  const { incident } = await ctx.actors
    .region(site.region)
    .getIncident({ trace_id: ctx.trace_id });
  if (incident === null) {
    throw new TicketError(422, "no_active_incident");
  }
  const joined = await openInternal(ctx, session, {
    site_id: site.site_id,
    symptom: incidentSummaryOf(incident),
    impact: "site_down",
    service_affecting: "true",
  });
  const incidentForReadback = joined.report?.incident ?? incident;
  const raisedToP1 = joined.report?.upgraded ?? false;
  const readbackInc = readbackIncident(incidentForReadback, site.region_label);
  return {
    ...joined.result,
    ticket_readback: joinReadback({
      ticket: { id: joined.result.ticket_id },
      incident: readbackInc,
      priorityRaisedToP1: raisedToP1,
    }),
    incident_note:
      readbackInc === null
        ? "none"
        : incidentAffects(readbackInc.siteCount, raisedToP1).trim(),
  };
}

function truthy(raw: string): boolean {
  return raw === "true";
}

function readbackIncident(
  incident: Incident | null,
  regionLabel: string,
): ReadbackIncident | null {
  if (incident === null) return null;
  return {
    id: incident.id,
    priority: incident.priority,
    siteCount: Object.keys(incident.sites).length,
    regionLabel,
  };
}

function incidentNote(incident: ReadbackIncident | null): string {
  if (incident === null) return "none";
  return incident.priority === "P1"
    ? `It now affects ${incident.siteCount} branches and has been raised to priority 1.`
    : `This is part of incident ${spellId(incident.id)} affecting ${incident.regionLabel}.`;
}
