import { StatefulActor } from "@telnyx/edge-runtime";
import { logEvent } from "../../shared/src/log";
import { mintIncidentId } from "../../shared/src/ids";
import type { EscState, Incident } from "../../shared/src/types";

const STALE_MS = 6 * 60 * 60 * 1000;
const UPDATE_WINDOW_MS = 30 * 60 * 1000;
const EVENTS_LIMIT = 100;

const P1_ACK_WINDOW_MS = 120_000;
const P2_ACK_WINDOW_MS = 300_000;
const MAX_ESCALATION_LEVEL = 3;
const CLAIM_STALE_MS = 60_000;
const ESC_GRACE_MS = 1_000;
const PAGES_KEY = "pages";

export interface Page {
  id: string;
  level: number;
  region: string;
  created_at: number;
  claimedBy: string | null;
  claimedAt: number | null;
  sentAt: number | null;
}

export interface TickInput {
  now: number;
}

export interface TickResult {
  escalated: boolean;
  level: number | null;
}

export interface ClaimPageInput {
  pageId: string;
  claimer: string;
  now: number;
}

export interface ClaimPageResult {
  claimed: boolean;
  page: Page | null;
}

export interface MarkPageSentInput {
  pageId: string;
  now: number;
}

export interface MarkPageSentResult {
  ok: boolean;
  pageId: string;
}

export interface GetPagesInput {
  trace_id?: string;
}

export interface GetPagesResult {
  pages: Page[];
  trace_id: string;
  actor_ms: number;
}

interface Member {
  ticketId: string;
  firstAt: number;
  lastAt: number;
}

type Members = Record<string, Member>;

export type { Members };

interface ActorEvent {
  evt: string;
  at?: number;
  trace_id?: string;
  site_id?: string;
  ticket_id?: string;
  incident_id?: string;
  priority?: Incident["priority"];
  by?: string;
  declared?: boolean;
  upgraded?: boolean;
}

export interface ReportSiteInput {
  siteId: string;
  ticketId: string;
  regionCode: string;
  trace_id: string;
  at: number;
}

export interface ReportSiteResult {
  incident: Incident | null;
  declared: boolean;
  upgraded: boolean;
  siteCount: number;
  trace_id: string;
  actor_ms: number;
}

export interface WithdrawSiteInput {
  siteId: string;
  ticketId: string;
  trace_id: string;
  at: number;
}

export interface WithdrawSiteResult {
  siteCount: number;
  trace_id: string;
  actor_ms: number;
}

export interface GetIncidentInput {
  trace_id?: string;
}

export interface GetIncidentResult {
  incident: Incident | null;
  trace_id: string;
  actor_ms: number;
}

export interface ResolveInput {
  trace_id: string;
  at?: number;
}

export interface ResolveResult {
  incident: Incident | null;
  trace_id: string;
  actor_ms: number;
}

export interface AckInput {
  by: string;
  trace_id: string;
  at: number;
}

export interface AckResult {
  incident: Incident | null;
  trace_id: string;
  actor_ms: number;
}

export interface ResetInput {
  trace_id?: string;
}

export interface ResetResult {
  ok: true;
  seq: number;
  trace_id: string;
  actor_ms: number;
}

export class RegionState extends StatefulActor {
  async ping(): Promise<{ pong: true; name: string }> {
    return { pong: true, name: String(this.ctx.id) };
  }

  async reportSite(input: ReportSiteInput): Promise<ReportSiteResult> {
    const started = Date.now();
    const members = (await this.ctx.storage.get<Members>("members")) ?? {};
    let membersDirty = this.pruneMembers(members, input.at);
    const existing = members[input.siteId];
    if (existing && existing.ticketId === input.ticketId) {
      if (existing.lastAt !== input.at) {
        existing.lastAt = input.at;
        membersDirty = true;
      }
    } else {
      members[input.siteId] = {
        ticketId: input.ticketId,
        firstAt: input.at,
        lastAt: input.at,
      };
      membersDirty = true;
    }
    const siteCount = Object.keys(members).length;
    if (membersDirty) {
      await this.ctx.storage.put("members", members);
      await this.pushEvent({
        evt: "site_reported",
        at: input.at,
        trace_id: input.trace_id,
        site_id: input.siteId,
        ticket_id: input.ticketId,
      });
    }
    const incident = (await this.ctx.storage.get<Incident | null>("incident")) ?? null;
    if (!incident) {
      if (siteCount < 2) {
        return {
          incident: null,
          declared: false,
          upgraded: false,
          siteCount,
          trace_id: input.trace_id,
          actor_ms: Date.now() - started,
        };
      }
      const seq = ((await this.ctx.storage.get<number>("seq")) ?? 0) + 1;
      const priority: Incident["priority"] = siteCount >= 3 ? "P1" : "P2";
      const esc = this.freshEsc(input.at, priority);
      const created: Incident = {
        id: mintIncidentId(input.regionCode, seq),
        version: 1,
        declaredAt: input.at,
        priority,
        sites: this.snapshot(members),
        nextUpdateAt: input.at + UPDATE_WINDOW_MS,
        ackAt: null,
        pageSeq: 0,
        esc,
        pages: [],
      };
      await this.ctx.storage.put("seq", seq);
      await this.ctx.storage.put("incident", created);
      await this.ctx.storage.setAlarm(esc.dueAt);
      await this.pushEvent({
        evt: "incident_declared",
        at: input.at,
        trace_id: input.trace_id,
        incident_id: created.id,
        priority: created.priority,
        declared: true,
      });
      return {
        incident: created,
        declared: true,
        upgraded: false,
        siteCount,
        trace_id: input.trace_id,
        actor_ms: Date.now() - started,
      };
    }
    const nextSites = this.snapshot(members);
    const sitesChanged = !this.sitesEqual(incident.sites, nextSites);
    let upgraded = false;
    if (incident.priority === "P2" && siteCount >= 3) {
      incident.priority = "P1";
      upgraded = true;
    }
    if (sitesChanged || upgraded) {
      incident.sites = nextSites;
      incident.version += 1;
      if (upgraded) {
        incident.nextUpdateAt = input.at + UPDATE_WINDOW_MS;
        const esc = this.freshEsc(input.at, incident.priority);
        incident.esc = esc;
        await this.ctx.storage.put("incident", incident);
        await this.ctx.storage.setAlarm(esc.dueAt);
      } else {
        await this.ctx.storage.put("incident", incident);
      }
      await this.pushEvent({
        evt: upgraded ? "incident_upgraded" : "incident_sites_updated",
        at: input.at,
        trace_id: input.trace_id,
        incident_id: incident.id,
        priority: incident.priority,
        upgraded,
      });
    }
    return {
      incident,
      declared: false,
      upgraded,
      siteCount,
      trace_id: input.trace_id,
      actor_ms: Date.now() - started,
    };
  }

  async withdrawSite(input: WithdrawSiteInput): Promise<WithdrawSiteResult> {
    const started = Date.now();
    const members = (await this.ctx.storage.get<Members>("members")) ?? {};
    let membersDirty = this.pruneMembers(members, input.at);
    const existing = members[input.siteId];
    if (existing && existing.ticketId === input.ticketId) {
      delete members[input.siteId];
      membersDirty = true;
      await this.pushEvent({
        evt: "site_withdrawn",
        at: input.at,
        trace_id: input.trace_id,
        site_id: input.siteId,
        ticket_id: input.ticketId,
      });
    }
    if (membersDirty) {
      await this.ctx.storage.put("members", members);
      const incident = (await this.ctx.storage.get<Incident | null>("incident")) ?? null;
      if (incident) {
        const nextSites = this.snapshot(members);
        if (!this.sitesEqual(incident.sites, nextSites)) {
          incident.sites = nextSites;
          incident.version += 1;
          await this.ctx.storage.put("incident", incident);
          await this.pushEvent({
            evt: "incident_sites_updated",
            trace_id: input.trace_id,
            incident_id: incident.id,
            priority: incident.priority,
            upgraded: false,
          });
        }
      }
    }
    return {
      siteCount: Object.keys(members).length,
      trace_id: input.trace_id,
      actor_ms: Date.now() - started,
    };
  }

  async getIncident(input: GetIncidentInput = {}): Promise<GetIncidentResult> {
    const started = Date.now();
    const incident = await this.incidentWithPages();
    return {
      incident,
      trace_id: input.trace_id ?? "none",
      actor_ms: Date.now() - started,
    };
  }

  // The escalated pages live under their own storage key (PAGES_KEY); the
  // stored incident object's pages field stays empty. Callers that read the
  // incident — getIncident and resolve — get the full page history for that
  // incident (sent and unsent) merged in, so reports can show the timeline.
  private async incidentWithPages(): Promise<Incident | null> {
    const incident = (await this.ctx.storage.get<Incident | null>("incident")) ?? null;
    if (incident === null) return null;
    const all = (await this.ctx.storage.get<Page[]>(PAGES_KEY)) ?? [];
    const prefix = incident.id + ":p";
    return { ...incident, pages: all.filter((page) => page.id.startsWith(prefix)) };
  }

  async resolve(input: ResolveInput): Promise<ResolveResult> {
    const started = Date.now();
    const incident = await this.incidentWithPages();
    await this.ctx.storage.deleteAlarm();
    if (incident) {
      await this.ctx.storage.delete("incident");
      await this.ctx.storage.delete("members");
      await this.pushEvent({
        evt: "incident_resolved",
        at: input.at,
        trace_id: input.trace_id,
        incident_id: incident.id,
        priority: incident.priority,
      });
    }
    return {
      incident,
      trace_id: input.trace_id,
      actor_ms: Date.now() - started,
    };
  }

  async ack(input: AckInput): Promise<AckResult> {
    const started = Date.now();
    const incident = (await this.ctx.storage.get<Incident | null>("incident")) ?? null;
    if (incident && incident.ackAt === null) {
      incident.ackAt = input.at;
      incident.version += 1;
      if (incident.esc !== null) {
        incident.esc.acked = true;
      }
      await this.ctx.storage.put("incident", incident);
      await this.ctx.storage.deleteAlarm();
      await this.pushEvent({
        evt: "incident_acked",
        at: input.at,
        trace_id: input.trace_id,
        incident_id: incident.id,
        by: input.by,
      });
    }
    return {
      incident,
      trace_id: input.trace_id,
      actor_ms: Date.now() - started,
    };
  }

  async reset(input: ResetInput = {}): Promise<ResetResult> {
    const started = Date.now();
    const seq = (await this.ctx.storage.get<number>("seq")) ?? 0;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("seq", seq);
    return {
      ok: true,
      seq,
      trace_id: input.trace_id ?? "none",
      actor_ms: Date.now() - started,
    };
  }

  // §12.1: both alarm() and tick() drive the same escalation step. They are
  // catch-all guarded: a throwing alarm handler loses its alarm on the
  // platform, so nothing in here may propagate.
  async alarm(): Promise<void> {
    try {
      await this.escalateIfDue(Date.now());
    } catch (err) {
      logEvent({
        svc: "noc-actors",
        hop: "region/alarm",
        evt: "region.alarm_failed",
        lvl: "error",
        outcome: "error",
        region: String(this.ctx.id),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async tick(input: TickInput): Promise<TickResult> {
    try {
      return await this.escalateIfDue(input.now);
    } catch (err) {
      logEvent({
        svc: "noc-actors",
        hop: "region/tick",
        evt: "region.tick_failed",
        lvl: "error",
        outcome: "error",
        region: String(this.ctx.id),
        error: err instanceof Error ? err.message : String(err),
      });
      return { escalated: false, level: null };
    }
  }

  async claimPage(input: ClaimPageInput): Promise<ClaimPageResult> {
    const pages = (await this.ctx.storage.get<Page[]>(PAGES_KEY)) ?? [];
    const page = pages.find((p) => p.id === input.pageId);
    if (page === undefined || page.sentAt !== null) {
      return { claimed: false, page: null };
    }
    if (
      page.claimedBy !== null &&
      (page.claimedAt === null || input.now - page.claimedAt <= CLAIM_STALE_MS)
    ) {
      return { claimed: false, page: null };
    }
    page.claimedBy = input.claimer;
    page.claimedAt = input.now;
    await this.ctx.storage.put(PAGES_KEY, pages);
    return { claimed: true, page };
  }

  async markPageSent(input: MarkPageSentInput): Promise<MarkPageSentResult> {
    const pages = (await this.ctx.storage.get<Page[]>(PAGES_KEY)) ?? [];
    const page = pages.find((p) => p.id === input.pageId);
    if (page === undefined) {
      return { ok: false, pageId: input.pageId };
    }
    page.sentAt = input.now;
    await this.ctx.storage.put(PAGES_KEY, pages);
    return { ok: true, pageId: input.pageId };
  }

  async getPages(input: GetPagesInput = {}): Promise<GetPagesResult> {
    const started = Date.now();
    const pages = (await this.ctx.storage.get<Page[]>(PAGES_KEY)) ?? [];
    return {
      pages: pages.filter((p) => p.sentAt === null),
      trace_id: input.trace_id ?? "none",
      actor_ms: Date.now() - started,
    };
  }

  private ackWindow(priority: Incident["priority"]): number {
    return priority === "P1" ? P1_ACK_WINDOW_MS : P2_ACK_WINDOW_MS;
  }

  private freshEsc(at: number, priority: Incident["priority"]): EscState {
    return { level: 0, dueAt: at + this.ackWindow(priority), acked: false };
  }

  // §12.1: a duplicate or early delivery must be harmless, so anything due
  // within the grace window escalates exactly one level.
  private async escalateIfDue(now: number): Promise<TickResult> {
    const incident = (await this.ctx.storage.get<Incident | null>("incident")) ?? null;
    const esc = incident?.esc ?? null;
    if (
      incident === null ||
      esc === null ||
      esc.acked ||
      esc.level >= MAX_ESCALATION_LEVEL ||
      now < esc.dueAt - ESC_GRACE_MS
    ) {
      return { escalated: false, level: null };
    }
    const level = esc.level + 1;
    // pageSeq is a monotonic per-incident counter that upgrades never reset,
    // so a page id minted after a mid-ladder ladder reset can never collide
    // with an earlier (possibly already-sent) page.
    const pageSeq = (incident.pageSeq ?? 0) + 1;
    incident.pageSeq = pageSeq;
    const pages = (await this.ctx.storage.get<Page[]>(PAGES_KEY)) ?? [];
    pages.push({
      id: incident.id + ":p" + pageSeq,
      level,
      region: String(this.ctx.id),
      created_at: now,
      claimedBy: null,
      claimedAt: null,
      sentAt: null,
    });
    await this.ctx.storage.put(PAGES_KEY, pages);
    esc.level = level;
    esc.dueAt = now + this.ackWindow(incident.priority);
    await this.ctx.storage.put("incident", incident);
    if (level < MAX_ESCALATION_LEVEL) {
      await this.ctx.storage.setAlarm(esc.dueAt);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
    return { escalated: true, level };
  }

  private pruneMembers(members: Members, at: number): boolean {
    const cutoff = at - STALE_MS;
    let changed = false;
    for (const siteId of Object.keys(members)) {
      if (members[siteId].lastAt < cutoff) {
        delete members[siteId];
        changed = true;
      }
    }
    return changed;
  }

  private snapshot(members: Members): Incident["sites"] {
    const sites: Incident["sites"] = {};
    for (const siteId of Object.keys(members).sort()) {
      sites[siteId] = {
        ticketId: members[siteId].ticketId,
        at: members[siteId].firstAt,
      };
    }
    return sites;
  }

  private sitesEqual(
    a: Incident["sites"],
    b: Incident["sites"],
  ): boolean {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) {
      return false;
    }
    return ka.every((siteId) => {
      const ea = a[siteId];
      const eb = b[siteId];
      return !!eb && ea.ticketId === eb.ticketId && ea.at === eb.at;
    });
  }

  private async pushEvent(event: ActorEvent): Promise<void> {
    const events = (await this.ctx.storage.get<ActorEvent[]>("events")) ?? [];
    events.push(event);
    if (events.length > EVENTS_LIMIT) {
      events.splice(0, events.length - EVENTS_LIMIT);
    }
    await this.ctx.storage.put("events", events);
  }
}
