import { kvKey } from "../../../shared/src/kvkeys";
import { mask } from "../../../shared/src/mask";
import { formatRiyadhTime } from "../../../shared/src/readback";
import { REGIONS, SITES } from "../../../shared/src/seed";
import { deadline } from "../../../shared/src/timing";
import { logEvent } from "../log";
import type { ActorPort } from "../services/actorPort";
import type { KvPort } from "../services/kvPort";

// DEBUGLOG #6: one KV op takes ≈1–2 s, so a bounded read must survive a full
// slow round trip before it is treated as failed.
const READ_DEADLINE_MS = 4000;
const HEARTBEAT_MAX_AGE_S = 30;

export interface StatusHeartbeat {
  age_s: number;
  ok: boolean;
}

export interface StatusRegionIncident {
  id: string;
  priority: string;
  site_count: number;
  declared_local: string;
}

export interface StatusRegion {
  region: string;
  label: string;
  incident: StatusRegionIncident | null;
}

export interface StatusOpenTicket {
  id: string;
  priority: string;
  opened_local: string;
}

export interface StatusRecentCall {
  at_local: string;
  trace_id: string;
}

export interface StatusSite {
  site_id: string;
  label: string;
  open_ticket: StatusOpenTicket | null;
  recent_calls: StatusRecentCall[] | null;
}

export interface StatusPayload {
  at: string;
  heartbeat: StatusHeartbeat | null;
  fault_flags: string[];
  regions: StatusRegion[];
  sites: StatusSite[];
  degraded?: true;
}

const FAULT_PREFIX = kvKey("flag", "fault") + "/";

const KNOWN_FAULTS: Record<string, (value: string) => boolean> = {
  open_ticket: (value) => ["500", "503", "504"].includes(value),
  dv_delay_ms: (value) => value.length > 0 && Number.isFinite(Number(value)),
};

interface HeartbeatValue {
  at?: unknown;
  ok?: unknown;
}

function parseHeartbeat(raw: string | null): HeartbeatValue | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as HeartbeatValue;
    if (value === null || typeof value !== "object") return null;
    if (typeof value.at !== "number" || !Number.isFinite(value.at)) return null;
    return value;
  } catch {
    return null;
  }
}

function ageOf(at: number, now: number): number {
  return Math.max(0, Math.floor((now - at) / 1000));
}

function heartbeatOf(raw: string | null, now: number): StatusHeartbeat | null {
  const value = parseHeartbeat(raw);
  if (value === null) return null;
  const age_s = ageOf(value.at as number, now);
  return { age_s, ok: value.ok === true && age_s <= HEARTBEAT_MAX_AGE_S };
}

interface ProjectionValue {
  id?: unknown;
  priority?: unknown;
  site_count?: unknown;
  started_local?: unknown;
}

function projectionOf(raw: string | null): StatusRegionIncident | null {
  if (raw === null) return null;
  let value: ProjectionValue;
  try {
    value = JSON.parse(raw) as ProjectionValue;
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const id = typeof value.id === "string" ? value.id : null;
  const priority = typeof value.priority === "string" ? value.priority : null;
  const siteCount =
    typeof value.site_count === "number" && Number.isInteger(value.site_count)
      ? value.site_count
      : null;
  const startedLocal = typeof value.started_local === "string" ? value.started_local : null;
  if (id === null || priority === null || siteCount === null || startedLocal === null) {
    return null;
  }
  return { id, priority, site_count: siteCount, declared_local: startedLocal };
}

async function readBounded<T>(
  port: Promise<T>,
  label: string,
  failed: { failed: boolean },
): Promise<T | null> {
  const raced = await deadline(port, READ_DEADLINE_MS, label);
  if (!raced.ok) {
    failed.failed = true;
    return null;
  }
  return raced.value;
}

async function heartbeatRead(
  kv: KvPort,
  now: number,
  failed: { failed: boolean },
): Promise<StatusHeartbeat | null> {
  const raw = await readBounded(kv.get(kvKey("ops", "heartbeat")), "status.heartbeat", failed);
  if (raw === null) return null;
  return heartbeatOf(raw, now);
}

async function faultFlags(kv: KvPort, failed: { failed: boolean }): Promise<string[]> {
  const keys = await readBounded(kv.list(FAULT_PREFIX), "status.flags", failed);
  if (keys === null) return [];
  const active: string[] = [];
  for (const key of keys) {
    if (!key.startsWith(FAULT_PREFIX)) continue;
    const name = key.slice(FAULT_PREFIX.length);
    if (name.length === 0) continue;
    const value = await readBounded(kv.get(key), `status.flags.${name}`, failed);
    if (value === null) continue;
    const check = KNOWN_FAULTS[name];
    if (check !== undefined && !check(value)) continue;
    active.push(name);
  }
  return active.sort();
}

const PUBLIC_REGIONS = REGIONS.filter((r) => r.region !== "lab");

async function regionIncidents(
  kv: KvPort,
  failed: { failed: boolean },
): Promise<StatusRegion[]> {
  const regions = await Promise.all(
    PUBLIC_REGIONS.map(async (seed) => {
      const raw = await readBounded(
        kv.get(kvKey("incident", "active", seed.region)),
        `status.incident.${seed.region}`,
        failed,
      );
      return {
        region: seed.region,
        label: seed.label,
        incident: projectionOf(raw),
      };
    }),
  );
  return regions;
}

interface SiteRead {
  site_id: string;
  label: string;
  open_ticket: StatusOpenTicket | null;
  recent_calls: StatusRecentCall[] | null;
}

async function readSite(
  siteId: string,
  label: string,
  actors: ActorPort,
  failed: { failed: boolean },
): Promise<SiteRead> {
  const [ticketOut, recentsOut] = await Promise.all([
    readBounded(actors.site(siteId).getTicket({ trace_id: "none" }), `status.ticket.${siteId}`, failed),
    readBounded(actors.site(siteId).getRecents({ trace_id: "none" }), `status.recents.${siteId}`, failed),
  ]);
  const ticket = ticketOut?.ticket ?? null;
  const recent = recentsOut?.calls ?? null;
  return {
    site_id: siteId,
    label,
    open_ticket:
      ticket === null
        ? null
        : {
            id: ticket.id,
            priority: ticket.priority,
            opened_local: formatRiyadhTime(ticket.openedAt),
          },
    recent_calls:
      recent === null
        ? null
        : recent.map((c) => ({ at_local: formatRiyadhTime(c.at), trace_id: mask(c.trace_id) })),
  };
}

export async function buildStatus(deps: {
  kv: KvPort;
  actors: ActorPort;
  now: number;
}): Promise<StatusPayload> {
  const started = Date.now();
  const failed = { failed: false };
  const [heartbeat, fault_flags, regions, sites] = await Promise.all([
    heartbeatRead(deps.kv, deps.now, failed),
    faultFlags(deps.kv, failed),
    regionIncidents(deps.kv, failed),
    Promise.all(
      SITES.filter((s) => !s.hidden).map((s) =>
        readSite(s.site_id, s.label, deps.actors, failed),
      ),
    ) as Promise<StatusSite[]>,
  ]);
  const payload: StatusPayload = {
    at: new Date(deps.now).toISOString(),
    heartbeat,
    fault_flags,
    regions,
    sites,
  };
  if (failed.failed) payload.degraded = true;
  logEvent("ops.status", {
    hop: "ops/status",
    outcome: "ok",
    total_ms: Date.now() - started,
    degraded: failed.failed,
    sites: sites.length,
  });
  return payload;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderStatusHtml(payload: StatusPayload): string {
  const rows: string[] = [];
  const heartbeat =
    payload.heartbeat === null
      ? "none"
      : `${payload.heartbeat.ok ? "ok" : "red"}, ${payload.heartbeat.age_s}s old`;
  rows.push(`<tr><th>heartbeat</th><td class="${payload.heartbeat !== null && payload.heartbeat.ok ? "" : "red"}">${escapeHtml(heartbeat)}</td></tr>`);
  rows.push(
    `<tr><th>fault flags</th><td class="red">${escapeHtml(
      payload.fault_flags.length === 0 ? "none" : payload.fault_flags.join(", "),
    )}</td></tr>`,
  );
  for (const region of payload.regions) {
    const incident =
      region.incident === null
        ? "none"
        : `${region.incident.id} ${region.incident.priority}, ${region.incident.site_count} sites since ${region.incident.declared_local}`;
    rows.push(`<tr><th>region ${escapeHtml(region.label)}</th><td>${escapeHtml(incident)}</td></tr>`);
  }
  for (const site of payload.sites) {
    const ticket =
      site.open_ticket === null
        ? "none"
        : `${site.open_ticket.id} ${site.open_ticket.priority} since ${site.open_ticket.opened_local}`;
    const calls =
      site.recent_calls === null
        ? "read failed"
        : site.recent_calls.length === 0
          ? "none"
          : site.recent_calls.map((c) => `${c.at_local} ${c.trace_id}`).join(", ");
    rows.push(
      `<tr><th>site ${escapeHtml(site.site_id)}</th><td>${escapeHtml(
        `${site.label}: ${ticket}`,
      )}</td></tr>`,
    );
    rows.push(`<tr><th>recent calls</th><td>${escapeHtml(calls)}</td></tr>`);
  }
  if (payload.degraded === true) {
    rows.push(
      `<tr><th>degraded</th><td>some reads failed; data may be incomplete</td></tr>`,
    );
  }
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    '<meta http-equiv="refresh" content="5">',
    "<style>td.red{color:#b91c1c;font-weight:bold}</style>",
    "<title>NOC status</title></head><body>",
    `<h1>NOC status (${escapeHtml(payload.at)})</h1>`,
    `<table><tbody>${rows.join("")}</tbody></table>`,
    "</body></html>",
    "",
  ].join("\n");
}
