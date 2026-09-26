import { StatefulActor } from "@telnyx/edge-runtime";
import { mintIncidentId } from "../../shared/src/ids";
import type { Incident } from "../../shared/src/types";

const STALE_MS = 6 * 60 * 60 * 1000;
const UPDATE_WINDOW_MS = 30 * 60 * 1000;
const EVENTS_LIMIT = 100;

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
    let declared = false;
    let upgraded = false;
    if (!incident && siteCount >= 2) {
      const seq = ((await this.ctx.storage.get<number>("seq")) ?? 0) + 1;
      const created: Incident = {
        id: mintIncidentId(input.regionCode, seq),
        version: 1,
        declaredAt: input.at,
        priority: "P2",
        sites: this.snapshot(members),
        nextUpdateAt: input.at + UPDATE_WINDOW_MS,
        ackAt: null,
        esc: null,
        pages: [],
      };
      await this.ctx.storage.put("seq", seq);
      await this.ctx.storage.put("incident", created);
      declared = true;
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
        declared,
        upgraded,
        siteCount,
        trace_id: input.trace_id,
        actor_ms: Date.now() - started,
      };
    }
    if (incident && siteCount >= 3 && incident.priority === "P2") {
      incident.priority = "P1";
      incident.version += 1;
      incident.sites = this.snapshot(members);
      incident.nextUpdateAt = input.at + UPDATE_WINDOW_MS;
      upgraded = true;
      await this.ctx.storage.put("incident", incident);
      await this.pushEvent({
        evt: "incident_upgraded",
        at: input.at,
        trace_id: input.trace_id,
        incident_id: incident.id,
        priority: incident.priority,
        upgraded: true,
      });
    }
    return {
      incident,
      declared,
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
    }
    return {
      siteCount: Object.keys(members).length,
      trace_id: input.trace_id,
      actor_ms: Date.now() - started,
    };
  }

  async getIncident(input: GetIncidentInput = {}): Promise<GetIncidentResult> {
    const started = Date.now();
    const incident = (await this.ctx.storage.get<Incident | null>("incident")) ?? null;
    return {
      incident,
      trace_id: input.trace_id ?? "none",
      actor_ms: Date.now() - started,
    };
  }

  async resolve(input: ResolveInput): Promise<ResolveResult> {
    const started = Date.now();
    const incident = (await this.ctx.storage.get<Incident | null>("incident")) ?? null;
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
      await this.ctx.storage.put("incident", incident);
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

  async alarm(): Promise<void> {}

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
        at: members[siteId].lastAt,
      };
    }
    return sites;
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
