import { spellId } from "./ids";
import type { Ticket } from "./types";
import { responseTargetMinutes } from "./severity";

const RIYADH_OFFSET_MS = 3 * 3600_000; // Asia/Riyadh is UTC+3 all year (no DST)

export function formatRiyadhTime(epochMs: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Riyadh",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(epochMs);
}

export function riyadhTimeToday(hour: number, minute: number, nowMs: number): number {
  const local = new Date(nowMs + RIYADH_OFFSET_MS);
  const utcMidnight = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  return utcMidnight - RIYADH_OFFSET_MS + (hour * 3600 + minute * 60) * 1000;
}

export interface ReadbackIncident {
  id: string;
  priority: "P1" | "P2" | "P3" | "P4";
  siteCount: number;
  regionLabel: string;
}

export interface TicketReadbackInput {
  ticket: Pick<Ticket, "id" | "priority" | "openedAt">;
  created: boolean;
  priorityRaised: boolean;
  incident: ReadbackIncident | null;
  now: number;
}

export function ticketReadback(input: TicketReadbackInput): string {
  const { ticket, created, priorityRaised, incident, now } = input;
  const spoken = spellId(ticket.id);
  const n = ticket.priority.slice(1);
  let out: string;
  if (created) {
    const by = formatRiyadhTime(now + responseTargetMinutes(ticket.priority) * 60_000);
    out = `Your ticket number is ${spoken}. Priority ${n}. An engineer will respond by ${by} Riyadh time.`;
  } else {
    const minutes = Math.max(0, Math.floor((now - ticket.openedAt) / 60_000));
    out = `There's already an open ticket for this branch: ${spoken}, opened ${minutes} minutes ago. I've added you to it`;
    out += priorityRaised ? ` and raised it to priority ${n}.` : ".";
  }
  if (incident !== null) {
    out +=
      incident.priority === "P1"
        ? ` It now affects ${incident.siteCount} branches and has been raised to priority 1.`
        : ` This is part of incident ${spellId(incident.id)} affecting ${incident.regionLabel}.`;
  }
  return out;
}

export function openTicketNote(ticket: { id: string } | null): string {
  if (ticket === null) return "none";
  return `There's already an open ticket for this branch: ${spellId(ticket.id)}.`;
}

export function incidentAffects(siteCount: number, raisedToP1: boolean): string {
  return raisedToP1
    ? ` It now affects ${siteCount} branches and has been raised to priority 1.`
    : ` It now affects ${siteCount} branches.`;
}

export interface JoinReadbackInput {
  ticket: Pick<Ticket, "id">;
  incident: ReadbackIncident | null;
  priorityRaisedToP1: boolean;
}

export function joinReadback(input: JoinReadbackInput): string {
  const { ticket, incident, priorityRaisedToP1 } = input;
  let out = "";
  if (incident !== null) {
    out += `I've added your branch to incident ${spellId(incident.id)} affecting ${incident.regionLabel}.`;
    out += incidentAffects(incident.siteCount, priorityRaisedToP1);
  }
  if (out.length > 0) out += " ";
  out += `Your ticket number is ${spellId(ticket.id)}.`;
  return out;
}
