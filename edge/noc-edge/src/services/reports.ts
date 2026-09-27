import type { Incident } from "../../../shared/src/types";
import { kvKey } from "../../../shared/src/kvkeys";
import { deadline } from "../../../shared/src/timing";
import { logEvent } from "../log";
import type { KvPort } from "./kvPort";

// Storage latency is unknown, so every bucket call is bounded by the same
// deadline and a failure never fails the caller (Plan 2, P2-4 adjustment).
export const REPORTS_DEADLINE_MS = 8000;
// The pointer is one KV op (1–2 s on this account, DEBUGLOG #6).
export const REPORT_POINTER_DEADLINE_MS = 4000;

export const REPORT_PREFIX = "incidents/";
export const REPORT_KEY_RE = /^incidents\/[A-Za-z0-9._-]+\.json$/;
export const REPORTS_LIST_LIMIT = 20;
export const REPORT_SCHEMA = "noc.incident-report/1";

// Minimal structural view of the CloudStorageBucket binding (telnyx.toml
// [storage.cloudstorage.REPORTS]) so tests can run against a fake.
export interface ReportBucket {
  put(
    key: string,
    body: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<ReportRead | null>;
  list(options?: { prefix?: string; limit?: number }): Promise<{ objects: ReportObjectMeta[] }>;
}

export interface ReportRead {
  key: string;
  json?(): Promise<unknown>;
}

export interface ReportObjectMeta {
  key: string;
  size?: number;
  uploaded?: Date;
}

// The incident object as returned by RegionState.getIncident. RegionState
// keeps escalated pages in their own storage key, so page entries may or may
// not carry level/created_at; the builder maps what is present.
export interface ReportPageInput {
  id: string;
  level?: number;
  created_at?: number;
  sentAt?: number | null;
}

export type ReportIncident = Omit<Incident, "pages"> & {
  pages?: readonly ReportPageInput[];
};

export interface IncidentReportSite {
  site_id: string;
  ticket_id: string;
  priority: string;
  opened_at: string;
}

export interface IncidentReportPage {
  id: string;
  level: number;
  created_at: string | null;
  sent_at: string | null;
}

export interface IncidentReportEscalation {
  levels_reached: number;
  acked: boolean;
  acked_at: string | null;
  time_to_ack_s: number | null;
}

export interface IncidentReport {
  schema: typeof REPORT_SCHEMA;
  incident_id: string;
  region: string;
  region_label: string;
  priority: string;
  declared_at: string;
  resolved_at: string;
  duration_s: number;
  sites: IncidentReportSite[];
  branches: number;
  escalation: IncidentReportEscalation;
  pages: IncidentReportPage[];
  trace_ids: string[];
}

// Reports carry operational facts only: no PINs, fingerprints, tokens, phone
// numbers or caller names are ever copied into the report object.
export function buildIncidentReport(input: {
  region: string;
  regionLabel: string;
  incident: ReportIncident;
  resolvedAt: number;
  trace_id: string;
}): IncidentReport {
  const { incident } = input;
  const sites: IncidentReportSite[] = Object.keys(incident.sites)
    .sort()
    .map((siteId) => ({
      site_id: siteId,
      ticket_id: incident.sites[siteId].ticketId,
      priority: incident.priority,
      opened_at: isoOf(incident.sites[siteId].at),
    }));
  const pages: IncidentReportPage[] = (incident.pages ?? []).map((page) => ({
    id: page.id,
    level: typeof page.level === "number" ? page.level : 0,
    created_at: typeof page.created_at === "number" ? isoOf(page.created_at) : null,
    sent_at: typeof page.sentAt === "number" ? isoOf(page.sentAt) : null,
  }));
  const ackedAt = incident.ackAt;
  return {
    schema: REPORT_SCHEMA,
    incident_id: incident.id,
    region: input.region,
    region_label: input.regionLabel,
    priority: incident.priority,
    declared_at: isoOf(incident.declaredAt),
    resolved_at: isoOf(input.resolvedAt),
    duration_s: secondsBetween(incident.declaredAt, input.resolvedAt),
    sites,
    branches: sites.length,
    escalation: {
      levels_reached: incident.esc?.level ?? 0,
      acked: incident.ackAt !== null || incident.esc?.acked === true,
      acked_at: ackedAt === null ? null : isoOf(ackedAt),
      time_to_ack_s: ackedAt === null ? null : secondsBetween(incident.declaredAt, ackedAt),
    },
    pages,
    trace_ids: [input.trace_id],
  };
}

export function reportKey(report: Pick<IncidentReport, "incident_id" | "declared_at">): string {
  const stamp = report.declared_at.replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
  return `${REPORT_PREFIX}${report.incident_id}-${stamp}.json`;
}

export interface ReportWriteResult {
  ok: boolean;
  key: string;
}

export async function writeReport(
  bucket: ReportBucket | null,
  report: IncidentReport,
): Promise<ReportWriteResult> {
  const key = reportKey(report);
  if (bucket === null) return { ok: false, key };
  const started = Date.now();
  const trace_id = report.trace_ids[0] ?? "none";
  const result = await deadline(
    bucket.put(key, JSON.stringify(report, null, 2), {
      httpMetadata: { contentType: "application/json" },
    }),
    REPORTS_DEADLINE_MS,
    "report.put",
  );
  if (!result.ok) {
    logEvent("report.write_failed", {
      lvl: "warn",
      hop: "services/reports",
      trace_id,
      incident_id: report.incident_id,
      outcome: "error",
      total_ms: Date.now() - started,
    });
    return { ok: false, key };
  }
  return { ok: true, key };
}

export interface ReportEntry {
  key: string;
  size: number | null;
  uploaded: string | null;
}

export interface ReportListResult {
  reports: ReportEntry[];
  degraded: boolean;
}

export async function listReports(bucket: ReportBucket | null): Promise<ReportListResult> {
  if (bucket === null) return { reports: [], degraded: true };
  const started = Date.now();
  const page = await deadline(
    bucket.list({ prefix: REPORT_PREFIX }),
    REPORTS_DEADLINE_MS,
    "report.list",
  );
  if (!page.ok) {
    logEvent("report.list_failed", {
      lvl: "warn",
      hop: "ops/reports",
      outcome: "error",
      total_ms: Date.now() - started,
    });
    return { reports: [], degraded: true };
  }
  const reports = page.value.objects
    .filter((object) => REPORT_KEY_RE.test(object.key))
    // Newest upload first; objects whose upload time is unknown sort last and
    // are then ordered by key descending.
    .sort((a, b) => {
      const ta = a.uploaded instanceof Date ? a.uploaded.getTime() : 0;
      const tb = b.uploaded instanceof Date ? b.uploaded.getTime() : 0;
      if (ta !== tb) return tb - ta;
      return b.key.localeCompare(a.key);
    })
    .slice(0, REPORTS_LIST_LIMIT)
    .map((object) => ({
      key: object.key,
      size: typeof object.size === "number" ? object.size : null,
      uploaded: object.uploaded instanceof Date ? object.uploaded.toISOString() : null,
    }));
  logEvent("report.list", {
    hop: "ops/reports",
    outcome: "ok",
    total_ms: Date.now() - started,
    count: reports.length,
  });
  return { reports, degraded: false };
}

export type ReportReadResult =
  | { status: "ok"; report: unknown }
  | { status: "missing" }
  | { status: "invalid_key" }
  | { status: "error" };

export async function readReport(bucket: ReportBucket | null, key: string): Promise<ReportReadResult> {
  if (!REPORT_KEY_RE.test(key)) return { status: "invalid_key" };
  if (bucket === null) return { status: "error" };
  const result = await deadline(bucket.get(key), REPORTS_DEADLINE_MS, "report.get");
  if (!result.ok) return { status: "error" };
  const object = result.value;
  if (object === null || typeof object.json !== "function") return { status: "missing" };
  try {
    return { status: "ok", report: await object.json() };
  } catch {
    return { status: "error" };
  }
}

// KV pointer under report/last: one writer (resolveIncident), read by the
// board. The board never touches the bucket.
export const LAST_REPORT_KEY = kvKey("report", "last");

export interface LastReportPointer {
  key: string;
  incident_id: string;
  resolved_at: string;
}

export function lastReportPointerOf(raw: string | null): LastReportPointer | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const fields = value as Record<string, unknown>;
  const key = typeof fields.key === "string" ? fields.key : null;
  const incidentId = typeof fields.incident_id === "string" ? fields.incident_id : null;
  const resolvedAt = typeof fields.resolved_at === "string" ? fields.resolved_at : null;
  if (key === null || incidentId === null || resolvedAt === null) return null;
  if (!REPORT_KEY_RE.test(key)) return null;
  return { key, incident_id: incidentId, resolved_at: resolvedAt };
}

export async function readLastReport(kv: KvPort): Promise<LastReportPointer | null> {
  const result = await deadline(
    kv.get(LAST_REPORT_KEY),
    REPORT_POINTER_DEADLINE_MS,
    "report.pointer_read",
  );
  if (!result.ok) return null;
  return lastReportPointerOf(result.value);
}

export async function writeLastReportPointer(
  kv: KvPort,
  report: IncidentReport,
  key: string,
): Promise<boolean> {
  const result = await deadline(
    kv.put(LAST_REPORT_KEY, JSON.stringify({
      key,
      incident_id: report.incident_id,
      resolved_at: report.resolved_at,
    })),
    REPORT_POINTER_DEADLINE_MS,
    "report.pointer_write",
  );
  if (!result.ok) {
    logEvent("report.pointer_failed", {
      lvl: "warn",
      hop: "services/reports",
      trace_id: report.trace_ids[0] ?? "none",
      incident_id: report.incident_id,
      outcome: "error",
    });
    return false;
  }
  return true;
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

function secondsBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.round((toMs - fromMs) / 1000));
}
