import { StatefulActor } from "@telnyx/edge-runtime";
import { mintTicketId, sha256Hex } from "../../shared/src/ids";
import type { Impact, Priority, Ticket } from "../../shared/src/types";

const PIN_WINDOW_MS = 15 * 60 * 1000;
const CALL_TIER_LIMIT = 3;
const SITE_TIER_FAILURES = 6;
const SITE_TIER_DISTINCT_K = 2;
const OPS_LIMIT = 50;
const EVENTS_LIMIT = 100;
const RECENT_CALLS_LIMIT = 10;

const PRIORITY_RANK: Record<Priority, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };
const IMPACT_RANK: Record<Impact, number> = {
  single_user: 1,
  degraded: 2,
  site_down: 3,
};

type PinResult = "ok" | "invalid" | "locked";

interface CallState {
  day: string;
  count: number;
  recent: { k: string; trace_id: string; at: number }[];
  seen: string[];
}

interface PinAttemptOutcome {
  result: PinResult;
  attemptsLeft: number;
  at: number;
}

interface PinCallState {
  failures: number[];
  results: Record<string, PinAttemptOutcome>;
}

interface PinState {
  byCall: Record<string, PinCallState>;
  site: { failures: { k: string; ts: number }[]; lockedUntil: number | null };
}

interface ActorEvent {
  evt: string;
  at?: number;
  k?: string;
  trace_id?: string;
  ticket_id?: string;
  result?: PinResult;
}

interface CachedOpenResult {
  created: boolean;
  priorityRaised: boolean;
  ticket: Ticket;
}

export interface RecordCallInput {
  k: string;
  trace_id: string;
  at: number;
}

export interface PinAttemptInput {
  k: string;
  valid: boolean;
  fp: string;
  trace_id: string;
  at: number;
}

export interface OpenOrAttachInput {
  k: string;
  trace_id: string;
  callerRef: string;
  symptom: string;
  impact: Impact;
  serviceAffecting: boolean;
  priority: Priority;
  at: number;
  siteCode: string;
}

export interface MarkRegionReportedInput {
  ticketId: string;
  trace_id: string;
  at?: number;
}

export interface GetTicketInput {
  trace_id?: string;
}

export interface AddNoteInput {
  k: string;
  ticketId: string;
  note: string;
  at: number;
  trace_id: string;
}

export interface ResolveTicketInput {
  trace_id: string;
  at?: number;
}

export interface ResetInput {
  trace_id?: string;
}

export interface RecordCallResult {
  callsToday: number;
  openTicket: string | null;
  trace_id: string;
  actor_ms: number;
}

export interface PinAttemptResult {
  result: PinResult;
  attemptsLeft: number;
  repeat?: boolean;
  trace_id: string;
  actor_ms: number;
}

export interface OpenOrAttachResult {
  created: boolean;
  priorityRaised: boolean;
  ticket: Ticket;
  trace_id: string;
  actor_ms: number;
}

export interface MarkRegionReportedResult {
  ticket: Ticket;
  trace_id: string;
  actor_ms: number;
}

export interface GetTicketResult {
  ticket: Ticket | null;
  trace_id: string;
  actor_ms: number;
}

export interface AddNoteResult {
  added: boolean;
  ticket: Ticket;
  trace_id: string;
  actor_ms: number;
}

export interface ResolveTicketResult {
  ticket: Ticket | null;
  trace_id: string;
  actor_ms: number;
}

export interface ResetResult {
  ok: true;
  seq: number;
  trace_id: string;
  actor_ms: number;
}

export interface RecentCall {
  k: string;
  trace_id: string;
  at: number;
}

export interface GetRecentsInput {
  trace_id?: string;
}

export interface GetRecentsResult {
  calls: RecentCall[];
  trace_id: string;
  actor_ms: number;
}

export class SiteState extends StatefulActor {
  async ping(): Promise<{ pong: true; name: string }> {
    return { pong: true, name: String(this.ctx.id) };
  }

  async recordCall(input: RecordCallInput): Promise<RecordCallResult> {
    const started = Date.now();
    const day = new Date(input.at).toISOString().slice(0, 10);
    const calls =
      (await this.ctx.storage.get<CallState>("calls")) ?? {
        day,
        count: 0,
        recent: [],
        seen: [],
      };
    if (calls.day !== day) {
      calls.day = day;
      calls.count = 0;
      calls.recent = [];
      calls.seen = [];
    }
    if (!Array.isArray(calls.seen)) calls.seen = [];
    if (!calls.seen.includes(input.k)) {
      calls.count += 1;
      calls.seen.push(input.k);
      calls.recent.push({ k: input.k, trace_id: input.trace_id, at: input.at });
      while (calls.recent.length > RECENT_CALLS_LIMIT) calls.recent.shift();
      await this.ctx.storage.put("calls", calls);
      await this.pushEvent({
        evt: "call_recorded",
        at: input.at,
        k: input.k,
        trace_id: input.trace_id,
      });
    }
    const ticket = (await this.ctx.storage.get<Ticket | null>("ticket")) ?? null;
    return {
      callsToday: calls.count,
      openTicket: ticket ? ticket.id : null,
      trace_id: input.trace_id,
      actor_ms: Date.now() - started,
    };
  }

  async recordPinAttempt(input: PinAttemptInput): Promise<PinAttemptResult> {
    const started = Date.now();
    const pin =
      (await this.ctx.storage.get<PinState>("pin")) ?? {
        byCall: {},
        site: { failures: [], lockedUntil: null },
      };
    this.prunePin(pin, input.at);
    const existing = pin.byCall[input.k];
    const prior = existing?.results[input.fp];
    if (prior) {
      await this.ctx.storage.put("pin", pin);
      return {
        result: prior.result,
        attemptsLeft: prior.attemptsLeft,
        repeat: true,
        trace_id: input.trace_id,
        actor_ms: Date.now() - started,
      };
    }
    if (pin.site.lockedUntil !== null && input.at < pin.site.lockedUntil) {
      await this.ctx.storage.put("pin", pin);
      return {
        result: "locked",
        attemptsLeft: 0,
        trace_id: input.trace_id,
        actor_ms: Date.now() - started,
      };
    }
    const call: PinCallState = existing ?? { failures: [], results: {} };
    let result: PinResult;
    let attemptsLeft: number;
    if (input.valid) {
      call.failures = [];
      result = "ok";
      attemptsLeft = CALL_TIER_LIMIT;
    } else {
      call.failures.push(input.at);
      pin.site.failures.push({ k: input.k, ts: input.at });
      const distinctKs = new Set(pin.site.failures.map((f) => f.k));
      if (
        pin.site.failures.length >= SITE_TIER_FAILURES &&
        distinctKs.size >= SITE_TIER_DISTINCT_K
      ) {
        pin.site.lockedUntil = input.at + PIN_WINDOW_MS;
      }
      if (call.failures.length >= CALL_TIER_LIMIT || pin.site.lockedUntil !== null) {
        result = "locked";
        attemptsLeft = 0;
      } else {
        result = "invalid";
        attemptsLeft = CALL_TIER_LIMIT - call.failures.length;
      }
    }
    call.results[input.fp] = { result, attemptsLeft, at: input.at };
    pin.byCall[input.k] = call;
    await this.ctx.storage.put("pin", pin);
    await this.pushEvent({
      evt: "pin_attempt",
      at: input.at,
      k: input.k,
      trace_id: input.trace_id,
      result,
    });
    return { result, attemptsLeft, trace_id: input.trace_id, actor_ms: Date.now() - started };
  }

  private prunePin(pin: PinState, at: number): void {
    const cutoff = at - PIN_WINDOW_MS;
    for (const key of Object.keys(pin.byCall)) {
      const entry = pin.byCall[key];
      entry.failures = entry.failures.filter((ts) => ts > cutoff);
      for (const fp of Object.keys(entry.results)) {
        if (entry.results[fp].at <= cutoff) delete entry.results[fp];
      }
      if (entry.failures.length === 0 && Object.keys(entry.results).length === 0) {
        delete pin.byCall[key];
      }
    }
    pin.site.failures = pin.site.failures.filter((f) => f.ts > cutoff);
    if (pin.site.lockedUntil !== null && at >= pin.site.lockedUntil) {
      pin.site.lockedUntil = null;
    }
  }

  async openOrAttach(input: OpenOrAttachInput): Promise<OpenOrAttachResult> {
    const started = Date.now();
    const opKey = input.k + (await sha256Hex(input.symptom));
    const ops =
      (await this.ctx.storage.get<Record<string, CachedOpenResult>>("ops")) ?? {};
    const cached = ops[opKey];
    if (cached) {
      return {
        created: cached.created,
        priorityRaised: cached.priorityRaised,
        ticket: cached.ticket,
        trace_id: input.trace_id,
        actor_ms: Date.now() - started,
      };
    }
    const existing = (await this.ctx.storage.get<Ticket | null>("ticket")) ?? null;
    let created: boolean;
    let priorityRaised = false;
    let ticket: Ticket;
    if (!existing) {
      const seq = ((await this.ctx.storage.get<number>("seq")) ?? 0) + 1;
      await this.ctx.storage.put("seq", seq);
      ticket = {
        id: mintTicketId(input.siteCode, seq),
        priority: input.priority,
        impact: input.impact,
        serviceAffecting: input.serviceAffecting,
        symptom: input.symptom,
        openedAt: input.at,
        regionReported: false,
        reporters: [{ callerRef: input.callerRef, k: input.k, at: input.at }],
        notes: [],
      };
      await this.ctx.storage.put("ticket", ticket);
      created = true;
      ops[opKey] = { created: true, priorityRaised: false, ticket };
      await this.pushEvent({
        evt: "ticket_created",
        at: input.at,
        k: input.k,
        trace_id: input.trace_id,
        ticket_id: ticket.id,
      });
    } else {
      priorityRaised = PRIORITY_RANK[input.priority] < PRIORITY_RANK[existing.priority];
      if (priorityRaised) existing.priority = input.priority;
      if (IMPACT_RANK[input.impact] > IMPACT_RANK[existing.impact]) {
        existing.impact = input.impact;
      }
      if (input.serviceAffecting) existing.serviceAffecting = true;
      const alreadyReported = existing.reporters.some((r) => r.k === input.k);
      if (alreadyReported) {
        existing.notes.push({ at: input.at, text: input.symptom, k: input.k });
        await this.pushEvent({
          evt: "ticket_noted",
          at: input.at,
          k: input.k,
          trace_id: input.trace_id,
          ticket_id: existing.id,
        });
      } else {
        existing.reporters.push({ callerRef: input.callerRef, k: input.k, at: input.at });
        await this.pushEvent({
          evt: "ticket_attached",
          at: input.at,
          k: input.k,
          trace_id: input.trace_id,
          ticket_id: existing.id,
        });
      }
      await this.ctx.storage.put("ticket", existing);
      created = false;
      ticket = existing;
      ops[opKey] = { created: false, priorityRaised, ticket };
    }
    while (Object.keys(ops).length > OPS_LIMIT) {
      delete ops[Object.keys(ops)[0]];
    }
    await this.ctx.storage.put("ops", ops);
    return {
      created,
      priorityRaised,
      ticket,
      trace_id: input.trace_id,
      actor_ms: Date.now() - started,
    };
  }

  async markRegionReported(
    input: MarkRegionReportedInput,
  ): Promise<MarkRegionReportedResult> {
    const started = Date.now();
    const ticket = (await this.ctx.storage.get<Ticket | null>("ticket")) ?? null;
    if (!ticket || ticket.id !== input.ticketId) {
      throw new Error("ticket_mismatch");
    }
    ticket.regionReported = true;
    await this.ctx.storage.put("ticket", ticket);
    await this.pushEvent({
      evt: "region_reported",
      at: input.at,
      trace_id: input.trace_id,
      ticket_id: ticket.id,
    });
    return { ticket, trace_id: input.trace_id, actor_ms: Date.now() - started };
  }

  async getTicket(input: GetTicketInput = {}): Promise<GetTicketResult> {
    const started = Date.now();
    const ticket = (await this.ctx.storage.get<Ticket | null>("ticket")) ?? null;
    return {
      ticket,
      trace_id: input.trace_id ?? "none",
      actor_ms: Date.now() - started,
    };
  }

  async getRecents(input: GetRecentsInput = {}): Promise<GetRecentsResult> {
    const started = Date.now();
    const calls =
      (await this.ctx.storage.get<CallState>("calls"))?.recent ?? [];
    const safe = Array.isArray(calls)
      ? calls.filter(
          (c) =>
            c !== null &&
            typeof c === "object" &&
            typeof c.trace_id === "string" &&
            typeof c.at === "number",
        )
      : [];
    return {
      calls: safe.map((c) => ({ k: c.k, trace_id: c.trace_id, at: c.at })),
      trace_id: input.trace_id ?? "none",
      actor_ms: Date.now() - started,
    };
  }

  async addNote(input: AddNoteInput): Promise<AddNoteResult> {
    const started = Date.now();
    const ticket = (await this.ctx.storage.get<Ticket | null>("ticket")) ?? null;
    if (!ticket || ticket.id !== input.ticketId) {
      throw new Error("ticket_mismatch");
    }
    let added = true;
    if (ticket.notes.some((n) => n.k === input.k && n.text === input.note)) {
      added = false;
    } else {
      ticket.notes.push({ at: input.at, text: input.note, k: input.k });
      await this.ctx.storage.put("ticket", ticket);
      await this.pushEvent({
        evt: "note_added",
        at: input.at,
        k: input.k,
        trace_id: input.trace_id,
        ticket_id: ticket.id,
      });
    }
    return { added, ticket, trace_id: input.trace_id, actor_ms: Date.now() - started };
  }

  async resolveTicket(input: ResolveTicketInput): Promise<ResolveTicketResult> {
    const started = Date.now();
    const ticket = (await this.ctx.storage.get<Ticket | null>("ticket")) ?? null;
    if (ticket) {
      await this.ctx.storage.delete("ticket");
      await this.pushEvent({
        evt: "ticket_resolved",
        at: input.at,
        trace_id: input.trace_id,
        ticket_id: ticket.id,
      });
    }
    return { ticket, trace_id: input.trace_id, actor_ms: Date.now() - started };
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

  private async pushEvent(event: ActorEvent): Promise<void> {
    const events = (await this.ctx.storage.get<ActorEvent[]>("events")) ?? [];
    events.push(event);
    if (events.length > EVENTS_LIMIT) {
      events.splice(0, events.length - EVENTS_LIMIT);
    }
    await this.ctx.storage.put("events", events);
  }
}
