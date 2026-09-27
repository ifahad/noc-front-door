import { z } from "zod";
import { canRead, canWrite, siteForTicket } from "../../../shared/src/authz";
import { formatRiyadhTime } from "../../../shared/src/readback";
import { SITES } from "../../../shared/src/seed";
import { responseTargetMinutes } from "../../../shared/src/severity";
import { spellId } from "../../../shared/src/ids";
import type { Site, Ticket } from "../../../shared/src/types";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SeedAdapter, NmsStatus } from "../../../shared/src/itsm";
import type { Session } from "../../../shared/src/types";
import { deadline } from "../../../shared/src/timing";
import { logEvent } from "../log";
import type { ActorPort } from "../services/actorPort";
import type { KvPort } from "../services/kvPort";

export const SESSION_FALLBACK =
  "I can't reach our network systems right now, but I can still log your ticket.";
const NOT_YOUR_SITE = "I can only look up your own site.";
const NOT_FOUND = "I couldn't find that branch for your organisation.";
const INCIDENT_LOOKUP_FAIL = "I can't check incidents right now.";
const NO_TICKET = "I don't see an open ticket for that branch.";
const WRITE_NOT_ALLOWED = "I can only add notes to tickets for your own site.";
const OPS_WRITE_REJECTED = "add_ticket_note is not available in ops scope.";
const OPS_ARG_REQUIRED = "This tool needs a site or ticket id in ops scope.";

export const MCP_HOP = "mcp";
const INCIDENT_DEADLINE_MS = 1500;

export interface ToolCtx {
  scope: "session" | "ops";
  kv: KvPort;
  actors: ActorPort;
  adapter: SeedAdapter;
  now: () => number;
  session: Session | null;
}

const SENTINELS = new Set(["none", "unknown"]);

function usable(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !SENTINELS.has(value) &&
    !value.includes("{{")
  );
}

export const TOOL_SCHEMAS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  find_site: z.object({ description: z.string() }),
  get_site_status: z.object({ site_id: z.string().optional() }),
  check_known_incidents: z.object({ site_id: z.string().optional() }),
  get_ticket_status: z.object({ ticket_id: z.string().optional() }),
  add_ticket_note: z.object({
    ticket_id: z.string().optional(),
    note: z.string().min(1).max(300),
  }),
};

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: true;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function wrapTool(ctx: ToolCtx, name: string, handler: ToolHandler): ToolHandler {
  return async (args) => {
    const started = ctx.now();
    try {
      const result = await handler(args);
      logEvent("mcp.tool", {
        hop: MCP_HOP,
        tool: name,
        trace_id: traceIdOf(ctx),
        outcome: result.isError === true ? "denied" : "ok",
        total_ms: ctx.now() - started,
      });
      return result;
    } catch (err) {
      logEvent("mcp.tool", {
        hop: MCP_HOP,
        tool: name,
        trace_id: traceIdOf(ctx),
        outcome: "error",
        error: err instanceof Error ? err.message : String(err),
        total_ms: ctx.now() - started,
      });
      throw err;
    }
  };
}

function spoken(input: {
  speech: string;
  structured: Record<string, unknown>;
  isError?: true;
}): ToolResult {
  return {
    content: [{ type: "text", text: input.speech }],
    structuredContent: input.structured,
    ...(input.isError === true ? { isError: true } : {}),
  };
}

const NONE_IDS = { site_id: "none", ticket_id: "none", incident_id: "none" };

function sessionOf(ctx: ToolCtx): Session | null {
  return ctx.session;
}

function needsFallback(ctx: ToolCtx): boolean {
  return ctx.scope === "session" && ctx.session === null;
}

function traceIdOf(ctx: ToolCtx): string {
  return ctx.scope === "session" && ctx.session !== null
    ? ctx.session.trace_id
    : "none";
}

function denyLog(
  ctx: ToolCtx,
  tool: string,
  reason: string,
  target: string | null,
): void {
  logEvent("auth.denied", {
    hop: MCP_HOP,
    tool,
    trace_id: traceIdOf(ctx),
    outcome: "denied",
    reason,
    ...(target !== null ? { target } : {}),
  });
}

type SiteResolution =
  | { kind: "site"; site: Site }
  | { kind: "not_yours" }
  | { kind: "not_found" }
  | { kind: "missing" };

async function resolveSiteArg(
  ctx: ToolCtx,
  tool: string,
  raw: string | undefined,
): Promise<SiteResolution> {
  const arg = usable(raw) ? raw : null;
  if (arg !== null) {
    const site = await ctx.adapter.getSite(arg);
    if (site === null) return { kind: "not_found" };
    if (ctx.scope === "session" && !canRead(sessionOf(ctx) as Session, site)) {
      denyLog(ctx, tool, "site_not_read", arg);
      return { kind: "not_yours" };
    }
    return { kind: "site", site };
  }
  if (ctx.scope === "ops") return { kind: "missing" };
  const session = sessionOf(ctx) as Session | null;
  const defaultSiteId = session !== null ? session.sites[0] : undefined;
  if (!usable(defaultSiteId)) return { kind: "not_yours" };
  const site = await ctx.adapter.getSite(defaultSiteId);
  if (site === null) return { kind: "not_found" };
  if (!canRead(session as Session, site)) {
    denyLog(ctx, tool, "site_not_read", defaultSiteId);
    return { kind: "not_yours" };
  }
  return { kind: "site", site };
}

const NUMBER_WORDS: Record<number, string> = {
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
  9: "nine",
};

function spokenCount(count: number): string {
  return NUMBER_WORDS[count] ?? String(count);
}

function siteLabel(site: Site): string {
  return site.label.startsWith("the ")
    ? site.label.slice("the ".length)
    : site.label;
}

function nmsSpeech(site: Site, status: NmsStatus): string {
  if (status.state === "up") {
    return `The ${siteLabel(site)} looks healthy from our side.`;
  }
  const device = usable(status.device) ? status.device : "edge router";
  if (status.state === "degraded") {
    return `The ${device} at the ${siteLabel(site)} is degraded; our team is on it.`;
  }
  const since = status.since !== null ? formatRiyadhTime(status.since) : "just now";
  let out = `The ${device} at the ${siteLabel(site)} stopped responding at ${since}`;
  if (status.alarms.some((a) => a.toLowerCase().includes("lte"))) {
    out += "; the backup LTE link is also down";
  }
  return `${out}.`;
}

function incidentSpeech(
  incident: { priority: string; declaredAt: number },
  siteCount: number,
  regionLabel: string,
): string {
  return `There's an active priority ${incident.priority.slice(1)} incident in ${regionLabel} affecting ${spokenCount(siteCount)} branches since ${formatRiyadhTime(incident.declaredAt)}.`;
}

function ticketSpeech(ticket: Ticket): string {
  const dueBy = formatRiyadhTime(
    ticket.openedAt + responseTargetMinutes(ticket.priority) * 60_000,
  );
  return `Ticket ${spellId(ticket.id)} is priority ${ticket.priority.slice(1)}; engineer response due by ${dueBy}.`;
}

type TicketResolution =
  | { kind: "ticket"; ticketId: string | null; site: Site }
  | { kind: "not_yours" }
  | { kind: "not_found" }
  | { kind: "missing" };

async function resolveTicketArg(
  ctx: ToolCtx,
  tool: string,
  raw: string | undefined,
): Promise<TicketResolution> {
  const arg = usable(raw) ? raw : null;
  if (arg !== null) {
    let site: Site | null;
    if (ctx.scope === "ops") {
      site = siteForTicket(arg, SITES.filter((s) => !s.hidden));
    } else {
      const session = sessionOf(ctx) as Session | null;
      const customerId = session !== null ? session.customer_id : null;
      site =
        customerId !== null
          ? siteForTicket(arg, await ctx.adapter.listSites(customerId))
          : null;
    }
    if (site === null) {
      if (ctx.scope === "session") {
        denyLog(ctx, tool, "ticket_not_in_scope", arg);
        return { kind: "not_yours" };
      }
      return { kind: "not_found" };
    }
    if (ctx.scope === "session" && !canRead(sessionOf(ctx) as Session, site)) {
      denyLog(ctx, tool, "site_not_read", arg);
      return { kind: "not_yours" };
    }
    return { kind: "ticket", ticketId: arg, site };
  }
  if (ctx.scope === "ops") return { kind: "missing" };
  const session = sessionOf(ctx) as Session | null;
  const defaultSiteId = session !== null ? session.sites[0] : undefined;
  if (!usable(defaultSiteId)) return { kind: "not_yours" };
  const site = await ctx.adapter.getSite(defaultSiteId);
  if (site === null) return { kind: "not_found" };
  if (!canRead(session as Session, site)) {
    denyLog(ctx, tool, "site_not_read", defaultSiteId);
    return { kind: "not_yours" };
  }
  return { kind: "ticket", ticketId: null, site };
}

export function registerMcpTools(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    "find_site",
    {
      description:
        "Call when the caller names a branch or a garbled site id (e.g. 'the Yasmin branch', 'R U H one one four') and you need its site id. Resolves only branches that belong to the caller's organisation.",
      inputSchema: TOOL_SCHEMAS.find_site.shape,
    },
    wrapTool(ctx, "find_site", async (raw) => {
      const args = raw as { description: string };
      if (needsFallback(ctx)) return spoken({ speech: SESSION_FALLBACK, structured: NONE_IDS });
      const scope = ctx.scope;
      const customerId = scope === "session" ? (sessionOf(ctx) as Session).customer_id : null;
      const site =
        scope === "ops"
          ? await ctx.adapter.resolveSiteGlobal(args.description)
          : customerId !== null
            ? await ctx.adapter.resolveSite(args.description, customerId)
            : null;
      if (site === null) return spoken({ speech: NOT_FOUND, structured: NONE_IDS });
      return spoken({
        speech: `That's ${site.label}, site ${spellId(site.site_id)}.`,
        structured: {
          site_id: site.site_id,
          label: site.label,
          region: site.region,
          region_label: site.region_label,
        },
      });
    }),
  );

  server.registerTool(
    "get_site_status",
    {
      description:
        "Call to check whether a branch is reachable from our monitoring. Without site_id it uses the caller's own site.",
      inputSchema: TOOL_SCHEMAS.get_site_status.shape,
    },
    wrapTool(ctx, "get_site_status", async (raw) => {
      const args = raw as { site_id?: string };
      if (needsFallback(ctx)) return spoken({ speech: SESSION_FALLBACK, structured: NONE_IDS });
      const resolved = await resolveSiteArg(ctx, "get_site_status", args.site_id);
      if (resolved.kind !== "site") return refusal(resolved);
      const status = await ctx.adapter.getNmsStatus(resolved.site.site_id);
      return spoken({
        speech: nmsSpeech(resolved.site, status),
        structured: {
          site_id: resolved.site.site_id,
          label: resolved.site.label,
          state: status.state,
          since_local: status.since !== null ? formatRiyadhTime(status.since) : "none",
          alarms: status.alarms.join("; ") || "none",
          device: status.device || "none",
        },
      });
    }),
  );

  server.registerTool(
    "check_known_incidents",
    {
      description:
        "Call before opening a ticket to see whether a regional incident already covers the branch. Without site_id it uses the caller's own site.",
      inputSchema: TOOL_SCHEMAS.check_known_incidents.shape,
    },
    wrapTool(ctx, "check_known_incidents", async (raw) => {
      const args = raw as { site_id?: string };
      if (needsFallback(ctx)) return spoken({ speech: SESSION_FALLBACK, structured: NONE_IDS });
      const resolved = await resolveSiteArg(ctx, "check_known_incidents", args.site_id);
      if (resolved.kind !== "site") return refusal(resolved);
      const outcome = await deadline(
        ctx.actors.region(resolved.site.region).getIncident({
          trace_id: traceIdOf(ctx),
        }),
        INCIDENT_DEADLINE_MS,
        "mcp.getIncident",
      );
      if (!outcome.ok) {
        return spoken({ speech: INCIDENT_LOOKUP_FAIL, structured: NONE_IDS });
      }
      const incident = outcome.value.incident;
      if (incident === null) {
        return spoken({
          speech: "No known incidents in your area.",
          structured: { ...NONE_IDS, site_count: "0" },
        });
      }
      const siteCount = Object.keys(incident.sites).length;
      return spoken({
        speech: incidentSpeech(incident, siteCount, resolved.site.region_label),
        structured: {
          incident_id: incident.id,
          priority: incident.priority,
          site_count: String(siteCount),
          started_local: formatRiyadhTime(incident.declaredAt),
          region: resolved.site.region,
          region_label: resolved.site.region_label,
        },
      });
    }),
  );

  server.registerTool(
    "get_ticket_status",
    {
      description:
        "Call to read an open ticket for the caller's own site (default) or, with ticket_id, any ticket of the caller's organisation. Gives priority and the engineer response target.",
      inputSchema: TOOL_SCHEMAS.get_ticket_status.shape,
    },
    wrapTool(ctx, "get_ticket_status", async (raw) => {
      const args = raw as { ticket_id?: string };
      if (needsFallback(ctx)) return spoken({ speech: SESSION_FALLBACK, structured: NONE_IDS });
      const resolved = await resolveTicketArg(ctx, "get_ticket_status", args.ticket_id);
      if (resolved.kind !== "ticket") return refusal(resolved);
      const result = await ctx.actors.site(resolved.site.site_id).getTicket({
        trace_id: traceIdOf(ctx),
      });
      const ticket = result.ticket;
      if (
        ticket === null ||
        (resolved.ticketId !== null && ticket.id !== resolved.ticketId)
      ) {
        return spoken({ speech: NO_TICKET, structured: NONE_IDS });
      }
      return spoken({
        speech: ticketSpeech(ticket),
        structured: {
          ticket_id: ticket.id,
          priority: ticket.priority,
          impact: ticket.impact,
          due_local: formatRiyadhTime(
            ticket.openedAt + responseTargetMinutes(ticket.priority) * 60_000,
          ),
          site_id: resolved.site.site_id,
        },
      });
    }),
  );

  server.registerTool(
    "add_ticket_note",
    {
      description:
        "Call when the caller wants to add an update to an existing ticket for their own site (e.g. 'we got the power back'). Never call this for ops requests.",
      inputSchema: TOOL_SCHEMAS.add_ticket_note.shape,
    },
    wrapTool(ctx, "add_ticket_note", async (raw) => {
      const args = raw as { ticket_id?: string; note: string };
      if (ctx.scope === "ops") {
        denyLog(ctx, "add_ticket_note", "ops_write", null);
        return spoken({
          speech: OPS_WRITE_REJECTED,
          structured: NONE_IDS,
          isError: true,
        });
      }
      if (needsFallback(ctx)) return spoken({ speech: SESSION_FALLBACK, structured: NONE_IDS });
      const session = sessionOf(ctx) as Session;
      const resolved = await resolveTicketArg(ctx, "add_ticket_note", args.ticket_id);
      if (resolved.kind === "not_yours") {
        denyLog(ctx, "add_ticket_note", "site_not_writable", args.ticket_id ?? null);
        return spoken({ speech: WRITE_NOT_ALLOWED, structured: NONE_IDS });
      }
      if (resolved.kind !== "ticket") return refusal(resolved);
      if (!canWrite(session, resolved.site.site_id)) {
        denyLog(ctx, "add_ticket_note", "site_not_writable", args.ticket_id ?? resolved.site.site_id);
        return spoken({ speech: WRITE_NOT_ALLOWED, structured: NONE_IDS });
      }
      let ticketId = resolved.ticketId;
      if (ticketId === null) {
        const existing = await ctx.actors.site(resolved.site.site_id).getTicket({
          trace_id: traceIdOf(ctx),
        });
        if (existing.ticket === null) {
          return spoken({ speech: NO_TICKET, structured: NONE_IDS });
        }
        ticketId = existing.ticket.id;
      }
      try {
        const added = await ctx.actors.site(resolved.site.site_id).addNote({
          k: session.k,
          ticketId,
          note: args.note,
          at: ctx.now(),
          trace_id: traceIdOf(ctx),
        });
        return spoken({
          speech: `I've added your update to ticket ${spellId(added.ticket.id)}.`,
          structured: {
            ticket_id: added.ticket.id,
            added: added.added ? "true" : "repeat",
            site_id: resolved.site.site_id,
          },
        });
      } catch {
        return spoken({ speech: NO_TICKET, structured: NONE_IDS });
      }
    }),
  );
}

function refusal(
  resolved: { kind: "not_yours" } | { kind: "not_found" } | { kind: "missing" },
): ToolResult {
  switch (resolved.kind) {
    case "not_yours":
      return spoken({ speech: NOT_YOUR_SITE, structured: NONE_IDS });
    case "not_found":
      return spoken({ speech: NOT_FOUND, structured: NONE_IDS });
    case "missing":
      return spoken({ speech: OPS_ARG_REQUIRED, structured: NONE_IDS, isError: true });
  }
}
