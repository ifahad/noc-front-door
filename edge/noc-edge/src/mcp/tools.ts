import { z } from "zod";
import { canRead, canWrite, siteForTicket } from "../../../shared/src/authz";
import { formatRiyadhTime } from "../../../shared/src/readback";
import { SITES } from "../../../shared/src/seed";
import { responseTargetMinutes } from "../../../shared/src/severity";
import { spellId } from "../../../shared/src/ids";
import type { Site } from "../../../shared/src/types";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SeedAdapter, NmsStatus } from "../../../shared/src/itsm";
import type { Session } from "../../../shared/src/types";
import { deadline } from "../../../shared/src/timing";
import { logEvent } from "../log";
import { newTimers, timingActors, timingKv, type Timers } from "../tools/common";
import type { ActorPort } from "../services/actorPort";
import type { KvPort } from "../services/kvPort";

export type McpLang = "en" | "ar";

const OPS_WRITE_REJECTED = "add_ticket_note is not available in ops scope.";
const OPS_ARG_REQUIRED = "This tool needs a site or ticket id in ops scope.";

export interface SpokenCatalog {
  sessionFallback: string;
  notYourSite: string;
  notFound: string;
  needVerify: string;
  incidentLookupFail: string;
  noIncidents: string;
  noTicket: string;
  writeNotAllowed: string;
  writeFail: string;
  defaultDevice: string;
  sinceFallback: string;
  findSiteFound(site: Site): string;
  statusUp(site: Site): string;
  statusDegraded(site: Site, device: string): string;
  statusDown(site: Site, device: string, since: string, lteDown: boolean): string;
  incident(priority: string, regionLabel: string, siteCount: number, time: string): string;
  ticket(id: string, priority: string, dueBy: string): string;
  noteAdded(id: string): string;
}

const EN_CATALOG: SpokenCatalog = {
  sessionFallback:
    "I can't reach our network systems right now, but I can still log your ticket.",
  notYourSite: "I can only look up your own site.",
  notFound: "I couldn't find that branch for your organisation.",
  needVerify:
    "I can look up branches only after you're verified with your site ID and PIN.",
  incidentLookupFail: "I can't check incidents right now.",
  noIncidents: "No known incidents in your area.",
  noTicket: "I don't see an open ticket for that branch.",
  writeNotAllowed: "I can only add notes to tickets for your own site.",
  writeFail: "I can't update tickets right now.",
  defaultDevice: "edge router",
  sinceFallback: "just now",
  findSiteFound: (site) => `That's ${site.label}, site ${spellId(site.site_id)}.`,
  statusUp: (site) => `The ${siteLabel(site)} looks healthy from our side.`,
  statusDegraded: (site, device) =>
    `The ${device} at the ${siteLabel(site)} is degraded; our team is on it.`,
  statusDown: (site, device, since, lteDown) => {
    let out = `The ${device} at the ${siteLabel(site)} stopped responding at ${since}`;
    if (lteDown) out += "; the backup LTE link is also down";
    return `${out}.`;
  },
  incident: (priority, regionLabel, siteCount, time) =>
    `There's an active priority ${priority} incident in ${regionLabel} affecting ${spokenCount(siteCount)} branches since ${time}.`,
  ticket: (id, priority, dueBy) =>
    `Ticket ${id} is priority ${priority}; engineer response due by ${dueBy}.`,
  noteAdded: (id) => `I've added your update to ticket ${id}.`,
};

const AR_CATALOG: SpokenCatalog = {
  sessionFallback: "ما أقدر أوصل لأنظمة الشبكة الحين، بس أقدر أسجّل لك البلاغ.",
  notYourSite: "أقدر أتحقق من فرعك أنت بس.",
  notFound: "ما لقيت هالفرع ضمن فروع شركتكم.",
  needVerify: "أقدر أبحث عن الفروع بعد ما نتحقق منك برقم الموقع ورقم السر.",
  incidentLookupFail: "ما أقدر أتحقق من الأعطال الحين.",
  noIncidents: "ما فيه أعطال معروفة في منطقتكم.",
  noTicket: "ما أشوف تذكرة مفتوحة لهالفرع.",
  writeNotAllowed: "أقدر أضيف ملاحظات على تذاكر فرعك أنت بس.",
  writeFail: "ما أقدر أحدّث التذاكر الحين.",
  defaultDevice: "الراوتر الرئيسي",
  sinceFallback: "قبل شوي",
  findSiteFound: (site) => `هذا ${site.label}، رقم الموقع ${spellId(site.site_id)}.`,
  statusUp: (site) => `${site.label} شغّال وسليم من جهتنا.`,
  statusDegraded: (site, device) =>
    `${device} في ${site.label} أداؤه ضعيف، وفريقنا يشتغل عليه.`,
  statusDown: (site, device, since, lteDown) => {
    let out = `${device} في ${site.label} توقف عن الاستجابة الساعة ${since}`;
    if (lteDown) out += "، وخط الـ LTE الاحتياطي بعد واقف";
    return `${out}.`;
  },
  incident: (priority, regionLabel, siteCount, time) =>
    `فيه عطل أولوية ${priority} نشط في ${regionLabel} مأثّر على ${siteCount} فروع من الساعة ${time}.`,
  ticket: (id, priority, dueBy) =>
    `التذكرة ${id} أولويتها ${priority}، ورد المهندس متوقع قبل الساعة ${dueBy}.`,
  noteAdded: (id) => `أضفت تحديثك على التذكرة ${id}.`,
};

const CATALOGS: Record<McpLang, SpokenCatalog> = {
  en: EN_CATALOG,
  ar: AR_CATALOG,
};

export const MCP_HOP = "mcp";
// DEBUGLOG #6: one KV op takes ≈1–2 s on the trial project, and a warm actor
// call ≈220 ms, so the region-incident lookup needs a deadline well above one
// KV round trip.
const INCIDENT_DEADLINE_MS = 4000;

export type McpToolOutcome = "ok" | "fallback" | "denied" | "error";

export interface ToolCtx {
  scope: "session" | "ops";
  kv: KvPort;
  actors: ActorPort;
  adapter: SeedAdapter;
  now: () => number;
  session: Session | null;
  lang: McpLang;
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
  outcome: McpToolOutcome;
  errorName?: string;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function spoken(input: {
  speech: string;
  structured?: Record<string, unknown>;
  isError?: true;
  outcome: McpToolOutcome;
  errorName?: string;
}): ToolResult {
  return {
    content: [{ type: "text", text: input.speech }],
    structuredContent: input.structured ?? NONE_IDS,
    ...(input.isError === true ? { isError: true } : {}),
    outcome: input.outcome,
    ...(input.errorName !== undefined ? { errorName: input.errorName } : {}),
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
  timers: Timers,
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
    kv_ms: timers.kv,
    actor_ms: timers.actor,
    ...(target !== null ? { target } : {}),
  });
}

type NotResolvable =
  | { kind: "not_yours"; reason: string; target: string | null }
  | { kind: "no_site" }
  | { kind: "not_found" }
  | { kind: "missing" };
type SiteResolution = { kind: "site"; site: Site } | NotResolvable;
type TicketResolution =
  | { kind: "ticket"; ticketId: string | null; site: Site }
  | NotResolvable;

async function resolveSiteArg(
  ctx: ToolCtx,
  raw: string | undefined,
): Promise<SiteResolution> {
  const arg = usable(raw) ? raw : null;
  if (arg !== null) {
    const site = await ctx.adapter.getSite(arg);
    if (site === null) return { kind: "not_found" };
    if (ctx.scope === "session" && !canRead(sessionOf(ctx) as Session, site)) {
      return { kind: "not_yours", reason: "site_not_read", target: arg };
    }
    return { kind: "site", site };
  }
  if (ctx.scope === "ops") return { kind: "missing" };
  const session = sessionOf(ctx) as Session | null;
  const defaultSiteId = session !== null ? session.sites[0] : undefined;
  if (!usable(defaultSiteId)) return { kind: "no_site" };
  const site = await ctx.adapter.getSite(defaultSiteId);
  if (site === null) return { kind: "not_found" };
  if (!canRead(session as Session, site)) {
    return { kind: "not_yours", reason: "site_not_read", target: defaultSiteId };
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

function nmsSpeech(site: Site, status: NmsStatus, s: SpokenCatalog): string {
  if (status.state === "up") {
    return s.statusUp(site);
  }
  const device = usable(status.device) ? status.device : s.defaultDevice;
  if (status.state === "degraded") {
    return s.statusDegraded(site, device);
  }
  const since =
    status.since !== null ? formatRiyadhTime(status.since) : s.sinceFallback;
  return s.statusDown(
    site,
    device,
    since,
    status.alarms.some((a) => a.toLowerCase().includes("lte")),
  );
}

async function resolveTicketArg(
  ctx: ToolCtx,
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
        return { kind: "not_yours", reason: "ticket_not_in_scope", target: arg };
      }
      return { kind: "not_found" };
    }
    return { kind: "ticket", ticketId: arg, site };
  }
  if (ctx.scope === "ops") return { kind: "missing" };
  const session = sessionOf(ctx) as Session | null;
  const defaultSiteId = session !== null ? session.sites[0] : undefined;
  if (!usable(defaultSiteId)) return { kind: "no_site" };
  const site = await ctx.adapter.getSite(defaultSiteId);
  if (site === null) return { kind: "not_found" };
  if (!canRead(session as Session, site)) {
    return { kind: "not_yours", reason: "site_not_read", target: defaultSiteId };
  }
  return { kind: "ticket", ticketId: null, site };
}

function refusalOf(ctx: ToolCtx, timers: Timers, tool: string, resolved: NotResolvable): ToolResult {
  const s = CATALOGS[ctx.lang];
  switch (resolved.kind) {
    case "not_yours":
      denyLog(ctx, timers, tool, resolved.reason, resolved.target);
      return spoken({ speech: s.notYourSite, outcome: "denied" });
    case "no_site":
      return spoken({ speech: s.notYourSite, outcome: "fallback" });
    case "not_found":
      return spoken({ speech: s.notFound, outcome: "ok" });
    case "missing":
      return spoken({
        speech: OPS_ARG_REQUIRED,
        isError: true,
        outcome: "error",
      });
  }
}

export function registerMcpTools(server: McpServer, base: ToolCtx): void {
  const timers = newTimers();
  const ctx: ToolCtx = {
    ...base,
    kv: timingKv(base.kv, base.now, timers),
    actors: timingActors(base.actors, base.now, timers),
  };
  const s = CATALOGS[ctx.lang];
  const wrap = (name: string, handler: ToolHandler): ToolHandler => {
    return async (args) => {
      const started = ctx.now();
      try {
        const result = await handler(args);
        logEvent("mcp.tool", {
          hop: MCP_HOP,
          tool: name,
          trace_id: traceIdOf(ctx),
          outcome: result.outcome,
          ...(result.errorName !== undefined ? { error: result.errorName } : {}),
          kv_ms: timers.kv,
          actor_ms: timers.actor,
          total_ms: ctx.now() - started,
        });
        return result;
      } catch (err) {
        logEvent("mcp.tool", {
          hop: MCP_HOP,
          tool: name,
          trace_id: traceIdOf(ctx),
          outcome: "error",
          error: err instanceof Error ? err.name : "Error",
          kv_ms: timers.kv,
          actor_ms: timers.actor,
          total_ms: ctx.now() - started,
        });
        throw err;
      }
    };
  };

  server.registerTool(
    "find_site",
    {
      description:
        "Call when the caller names a branch or a garbled site id (e.g. 'the Yasmin branch', 'R U H one one four') and you need its site id. Resolves only branches that belong to the caller's organisation.",
      inputSchema: TOOL_SCHEMAS.find_site.shape,
    },
    wrap("find_site", async (raw) => {
      const args = raw as { description: string };
      if (needsFallback(ctx)) {
        return spoken({ speech: s.sessionFallback, outcome: "fallback" });
      }
      const scope = ctx.scope;
      const customerId = scope === "session" ? (sessionOf(ctx) as Session).customer_id : null;
      if (scope === "session" && customerId === null) {
        return spoken({ speech: s.needVerify, outcome: "fallback" });
      }
      const site =
        scope === "ops"
          ? await ctx.adapter.resolveSiteGlobal(args.description)
          : customerId !== null
            ? await ctx.adapter.resolveSite(args.description, customerId)
            : null;
      if (site === null) {
        return spoken({ speech: s.notFound, outcome: "ok" });
      }
      return spoken({
        speech: s.findSiteFound(site),
        structured: {
          site_id: site.site_id,
          label: site.label,
          region: site.region,
          region_label: site.region_label,
        },
        outcome: "ok",
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
    wrap("get_site_status", async (raw) => {
      const args = raw as { site_id?: string };
      if (needsFallback(ctx)) {
        return spoken({ speech: s.sessionFallback, outcome: "fallback" });
      }
      const resolved = await resolveSiteArg(ctx, args.site_id);
      if (resolved.kind !== "site") return refusalOf(ctx, timers, "get_site_status", resolved);
      const status = await ctx.adapter.getNmsStatus(resolved.site.site_id);
      return spoken({
        speech: nmsSpeech(resolved.site, status, s),
        structured: {
          site_id: resolved.site.site_id,
          label: resolved.site.label,
          state: status.state,
          since_local: status.since !== null ? formatRiyadhTime(status.since) : "none",
          alarms: status.alarms.join("; ") || "none",
          device: status.device || "none",
        },
        outcome: "ok",
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
    wrap("check_known_incidents", async (raw) => {
      const args = raw as { site_id?: string };
      if (needsFallback(ctx)) {
        return spoken({ speech: s.sessionFallback, outcome: "fallback" });
      }
      const resolved = await resolveSiteArg(ctx, args.site_id);
      if (resolved.kind !== "site") {
        return refusalOf(ctx, timers, "check_known_incidents", resolved);
      }
      const outcome = await deadline(
        ctx.actors.region(resolved.site.region).getIncident({
          trace_id: traceIdOf(ctx),
        }),
        INCIDENT_DEADLINE_MS,
        "mcp.getIncident",
      );
      if (!outcome.ok) {
        return spoken({ speech: s.incidentLookupFail, outcome: "fallback" });
      }
      const incident = outcome.value.incident;
      if (incident === null) {
        return spoken({
          speech: s.noIncidents,
          structured: { ...NONE_IDS, site_count: "0" },
          outcome: "ok",
        });
      }
      const siteCount = Object.keys(incident.sites).length;
      return spoken({
        speech: s.incident(
          incident.priority.slice(1),
          resolved.site.region_label,
          siteCount,
          formatRiyadhTime(incident.declaredAt),
        ),
        structured: {
          incident_id: incident.id,
          priority: incident.priority,
          site_count: String(siteCount),
          started_local: formatRiyadhTime(incident.declaredAt),
          region: resolved.site.region,
          region_label: resolved.site.region_label,
        },
        outcome: "ok",
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
    wrap("get_ticket_status", async (raw) => {
      const args = raw as { ticket_id?: string };
      if (needsFallback(ctx)) {
        return spoken({ speech: s.sessionFallback, outcome: "fallback" });
      }
      const resolved = await resolveTicketArg(ctx, args.ticket_id);
      if (resolved.kind !== "ticket") {
        return refusalOf(ctx, timers, "get_ticket_status", resolved);
      }
      const result = await ctx.actors.site(resolved.site.site_id).getTicket({
        trace_id: traceIdOf(ctx),
      });
      const ticket = result.ticket;
      if (
        ticket === null ||
        (resolved.ticketId !== null && ticket.id !== resolved.ticketId)
      ) {
        return spoken({
          speech: s.noTicket,
          structured: { ...NONE_IDS, ticket: "none" },
          outcome: "ok",
        });
      }
      return spoken({
        speech: s.ticket(
          spellId(ticket.id),
          ticket.priority.slice(1),
          formatRiyadhTime(
            ticket.openedAt + responseTargetMinutes(ticket.priority) * 60_000,
          ),
        ),
        structured: {
          ticket_id: ticket.id,
          priority: ticket.priority,
          impact: ticket.impact,
          due_local: formatRiyadhTime(
            ticket.openedAt + responseTargetMinutes(ticket.priority) * 60_000,
          ),
          site_id: resolved.site.site_id,
        },
        outcome: "ok",
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
    wrap("add_ticket_note", async (raw) => {
      const args = raw as { ticket_id?: string; note: string };
      if (ctx.scope === "ops") {
        denyLog(ctx, timers, "add_ticket_note", "ops_write", null);
        return spoken({
          speech: OPS_WRITE_REJECTED,
          isError: true,
          outcome: "denied",
        });
      }
      if (needsFallback(ctx)) {
        return spoken({ speech: s.sessionFallback, outcome: "fallback" });
      }
      const session = sessionOf(ctx) as Session;
      const resolved = await resolveTicketArg(ctx, args.ticket_id);
      if (resolved.kind === "not_yours") {
        denyLog(ctx, timers, "add_ticket_note", "site_not_writable", resolved.target);
        return spoken({ speech: s.writeNotAllowed, outcome: "denied" });
      }
      if (resolved.kind === "no_site") {
        return spoken({ speech: s.writeNotAllowed, outcome: "fallback" });
      }
      if (resolved.kind !== "ticket") {
        return refusalOf(ctx, timers, "add_ticket_note", resolved);
      }
      if (!canWrite(session, resolved.site.site_id)) {
        denyLog(
          ctx,
          timers,
          "add_ticket_note",
          "site_not_writable",
          args.ticket_id ?? resolved.site.site_id,
        );
        return spoken({ speech: s.writeNotAllowed, outcome: "denied" });
      }
      let ticketId = resolved.ticketId;
      if (ticketId === null) {
        const existing = await ctx.actors.site(resolved.site.site_id).getTicket({
          trace_id: traceIdOf(ctx),
        });
        if (existing.ticket === null) {
          return spoken({
            speech: s.noTicket,
            structured: { ...NONE_IDS, ticket: "none" },
            outcome: "ok",
          });
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
          speech: s.noteAdded(spellId(added.ticket.id)),
          structured: {
            ticket_id: added.ticket.id,
            added: added.added ? "true" : "repeat",
            site_id: resolved.site.site_id,
          },
          outcome: "ok",
        });
      } catch (err) {
        if (err instanceof Error && err.message === "ticket_mismatch") {
          return spoken({
            speech: s.noTicket,
            structured: { ...NONE_IDS, ticket: "none" },
            outcome: "ok",
          });
        }
        return spoken({
          speech: s.writeFail,
          outcome: "error",
          errorName: err instanceof Error ? err.name : "Error",
        });
      }
    }),
  );
}
