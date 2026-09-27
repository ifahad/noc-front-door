import { sha256Hex } from "../../../shared/src/ids";
import type { SeedAdapter } from "../../../shared/src/itsm";
import { kvKey } from "../../../shared/src/kvkeys";
import { mask } from "../../../shared/src/mask";
import { REGIONS, SITES } from "../../../shared/src/seed";
import { formatRiyadhTime } from "../../../shared/src/readback";
import type { Session } from "../../../shared/src/types";
import { logEvent } from "../log";
import type { MuxBinding } from "../actors";
import type { ActorPort } from "../services/actorPort";
import type { ActorMode } from "../services/flags";
import {
  projectionOf,
  regionLabelOf,
  syncProjection,
  type IncidentProjection,
} from "../services/incidents";
import { MUX_ACTOR_NAME } from "../services/muxActorPort";
import type { KvPort } from "../services/kvPort";
import {
  buildIncidentReport,
  writeLastReportPointer,
  writeReport,
  type ReportBucket,
  type ReportIncident,
  type ReportWriteResult,
} from "../services/reports";
import { open as openTicket } from "../services/tickets";

export interface ActionDeps {
  kv: KvPort;
  actors: ActorPort;
  adapter: SeedAdapter;
  now: number;
  trace_id: string;
  reports?: ReportBucket | null;
}

export interface ActionItem {
  item: string;
  ok: boolean;
  error?: string;
}

export interface ActionReport {
  items: ActionItem[];
}

export interface StageResult {
  region: string;
  incident: (IncidentProjection & { region: string }) | null;
  tickets: string[];
}

export interface AckResult {
  region: string;
  acked: boolean;
}

export interface ResolveResult {
  region: string;
  resolved: string | null;
  report: ReportWriteResult;
}

export interface UnlockResult {
  site: string;
  ok: boolean;
  note: string;
}

export class OpsActionError extends Error {
  status: 422;

  constructor(message: string) {
    super(message);
    this.name = "OpsActionError";
    this.status = 422;
  }
}

export class OpsBadRequestError extends Error {
  status: 400;

  constructor(message: string) {
    super(message);
    this.name = "OpsBadRequestError";
    this.status = 400;
  }
}

export interface MuxTickSummary {
  fired: string[];
  failed: string[];
  next: number | null;
}

export interface RegionTickResult {
  region: string;
  escalated: boolean;
  level: number | null;
  error?: string;
}

export interface OpsTickResult {
  mode: ActorMode;
  mux?: MuxTickSummary;
  regions?: RegionTickResult[];
}

export interface PendingPage {
  id: string;
  region: string;
  level: number;
  created_local: string;
}

export interface PageClaimResult {
  region: string;
  pageId: string;
  claimed: boolean;
}

export interface PageSentResult {
  region: string;
  pageId: string;
  ok: boolean;
}

type PagingDeps = Pick<ActionDeps, "actors" | "now" | "trace_id">;

// One entity's failure must not lose the others' ticks (review focus 3).
export async function tickRegions(
  deps: PagingDeps,
  mux: MuxBinding | null,
): Promise<OpsTickResult> {
  if (mux !== null) {
    const summary = (await mux
      .idFromName(MUX_ACTOR_NAME)
      .tick(deps.now)) as MuxTickSummary;
    logEvent("ops.tick", {
      hop: "ops/tick",
      trace_id: deps.trace_id,
      outcome: "ok",
      mode: "mux",
      fired: summary.fired?.length ?? 0,
      failed: summary.failed?.length ?? 0,
    });
    return { mode: "mux", mux: summary };
  }
  const regions: RegionTickResult[] = [];
  for (const seed of REGIONS) {
    try {
      const out = await deps.actors.region(seed.region).tick({ now: deps.now });
      regions.push({
        region: seed.region,
        escalated: out.escalated,
        level: out.level,
      });
    } catch (err) {
      regions.push({
        region: seed.region,
        escalated: false,
        level: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logEvent("ops.tick", {
    hop: "ops/tick",
    trace_id: deps.trace_id,
    outcome: "ok",
    mode: "per-entity",
    regions: regions.length,
    escalated: regions.filter((r) => r.escalated).length,
  });
  return { mode: "per-entity", regions };
}

export async function pendingPages(deps: PagingDeps): Promise<PendingPage[]> {
  const pages: PendingPage[] = [];
  for (const seed of REGIONS) {
    let out;
    try {
      out = await deps.actors.region(seed.region).getPages({ trace_id: deps.trace_id });
    } catch (err) {
      logEvent("ops.pages_region_failed", {
        lvl: "warn",
        hop: "ops/pages-pending",
        trace_id: deps.trace_id,
        outcome: "fallback",
        region: seed.region,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const page of out.pages) {
      pages.push({
        id: mask(page.id),
        region: seed.region,
        level: page.level,
        created_local: formatRiyadhTime(page.created_at),
      });
    }
  }
  logEvent("ops.pages_pending", {
    hop: "ops/pages-pending",
    trace_id: deps.trace_id,
    outcome: "ok",
    pages: pages.length,
  });
  return pages;
}

export async function claimRegionPage(
  deps: PagingDeps,
  input: { region: string; pageId: string; claimer: string },
): Promise<PageClaimResult> {
  const out = await deps.actors
    .region(input.region)
    .claimPage({ pageId: input.pageId, claimer: input.claimer, now: deps.now });
  logEvent("ops.page_claim", {
    hop: "ops/pages-claim",
    trace_id: deps.trace_id,
    outcome: "ok",
    region: input.region,
    page_id: input.pageId,
    claimed: out.claimed,
  });
  return { region: input.region, pageId: input.pageId, claimed: out.claimed };
}

export async function markRegionPageSent(
  deps: PagingDeps,
  input: { region: string; pageId: string },
): Promise<PageSentResult> {
  const out = await deps.actors
    .region(input.region)
    .markPageSent({ pageId: input.pageId, now: deps.now });
  logEvent("ops.page_sent", {
    hop: "ops/pages-sent",
    trace_id: deps.trace_id,
    outcome: "ok",
    region: input.region,
    page_id: input.pageId,
    ok: out.ok,
  });
  return { region: input.region, pageId: input.pageId, ok: out.ok };
}

export function pageClaimInput(body: unknown): {
  region: string;
  pageId: string;
  claimer: string;
} {
  const fields = (body ?? null) as Record<string, unknown> | null;
  const region = typeof fields?.region === "string" ? fields.region : "";
  const pageId = typeof fields?.pageId === "string" ? fields.pageId : "";
  const claimer = typeof fields?.claimer === "string" ? fields.claimer : "";
  if (!REGIONS.some((r) => r.region === region)) {
    throw new OpsBadRequestError("unknown_region");
  }
  if (pageId.length === 0) throw new OpsBadRequestError("missing_pageId");
  if (claimer.length === 0) throw new OpsBadRequestError("missing_claimer");
  return { region, pageId, claimer };
}

export function pageSentInput(body: unknown): { region: string; pageId: string } {
  const fields = (body ?? null) as Record<string, unknown> | null;
  const region = typeof fields?.region === "string" ? fields.region : "";
  const pageId = typeof fields?.pageId === "string" ? fields.pageId : "";
  if (!REGIONS.some((r) => r.region === region)) {
    throw new OpsBadRequestError("unknown_region");
  }
  if (pageId.length === 0) throw new OpsBadRequestError("missing_pageId");
  return { region, pageId };
}

const FAULT_PREFIX = kvKey("flag", "fault") + "/";

function reportEntry(items: ActionItem[], item: string, run: () => Promise<unknown>): Promise<void> {
  return run()
    .then(() => {
      items.push({ item, ok: true });
    })
    .catch((err: unknown) => {
      items.push({ item, ok: false, error: String(err) });
    });
}

export async function resetAll(deps: ActionDeps): Promise<ActionReport> {
  const items: ActionItem[] = [];
  for (const site of SITES) {
    await reportEntry(items, `site/${site.site_id}`, () =>
      deps.actors.site(site.site_id).reset({ trace_id: deps.trace_id }),
    );
  }
  for (const region of REGIONS) {
    await reportEntry(items, `region/${region.region}`, () =>
      deps.actors.region(region.region).reset({ trace_id: deps.trace_id }),
    );
  }
  for (const region of REGIONS) {
    await reportEntry(items, `projection/${region.region}`, () =>
      deps.kv.delete(kvKey("incident", "active", region.region)),
    );
  }
  const faultKeys = await safeList(deps);
  for (const key of faultKeys) {
    const name = key.slice(FAULT_PREFIX.length);
    await reportEntry(items, `flag/fault/${name.length > 0 ? name : key}`, () =>
      deps.kv.delete(key),
    );
  }
  await reportEntry(items, "flag/deflection_enabled", () =>
    deps.kv.put(kvKey("flag", "deflection_enabled"), "true"),
  );
  await reportEntry(items, "flag/require_pin", () =>
    deps.kv.put(kvKey("flag", "require_pin"), "false"),
  );
  logEvent("ops.reset", {
    hop: "ops/reset",
    trace_id: deps.trace_id,
    outcome: "ok",
    items: items.length,
    failures: items.filter((i) => !i.ok).length,
  });
  return { items };
}

async function safeList(deps: ActionDeps): Promise<string[]> {
  try {
    return await deps.kv.list(FAULT_PREFIX);
  } catch {
    return [];
  }
}

export async function stageIncident(deps: ActionDeps, region: string): Promise<StageResult> {
  const scripted = SITES.filter((s) => s.site_id === "RUH-121" || s.site_id === "RUH-133");
  if (!REGIONS.some((r) => r.region === region)) {
    throw new OpsActionError("unknown_region");
  }
  if (scripted.some((s) => s.region !== region)) {
    throw new OpsActionError("region_has_no_scripted_sites");
  }
  const tickets: string[] = [];
  for (const site of scripted) {
    const session = await syntheticSession(deps, site.site_id, site.customer_id);
    const opened = await openTicket(
      {
        actors: deps.actors,
        kv: deps.kv,
        adapter: deps.adapter,
        flags: {
          deflection_enabled: true,
          require_pin: false,
          demo_caller: null,
          fault_open_ticket: null,
          fault_dv_delay_ms: null,
          actor_mode: "per-entity",
        },
        now: deps.now,
        trace_id: deps.trace_id,
      },
      session,
      {
        site_id: site.site_id,
        symptom: "WAN link down",
        impact: "site_down",
        service_affecting: "true",
      },
    );
    tickets.push(opened.ticket_id);
  }
  await syncProjection({ actors: deps.actors, kv: deps.kv }, region, deps.trace_id);
  const { incident } = await deps.actors.region(region).getIncident({ trace_id: deps.trace_id });
  logEvent("ops.stage", {
    hop: "ops/stage-incident",
    trace_id: deps.trace_id,
    outcome: incident === null ? "error" : "ok",
    region,
    incident_id: incident?.id ?? "none",
  });
  return {
    region,
    incident:
      incident === null
        ? null
        : { ...projectionOf(incident, region), region },
    tickets,
  };
}

async function syntheticSession(
  deps: ActionDeps,
  siteId: string,
  customerId: string,
): Promise<Session> {
  const k = (await sha256Hex(`stage:${siteId}`)).slice(0, 16);
  return {
    k,
    trace_id: `t-${k}`,
    identified: true,
    verified: true,
    contact_id: null,
    customer_id: customerId,
    sites: [siteId],
    region: SITES.find((s) => s.site_id === siteId)?.region ?? null,
  };
}

export async function ackIncident(deps: ActionDeps, region: string): Promise<AckResult> {
  if (!REGIONS.some((r) => r.region === region)) {
    throw new OpsActionError("unknown_region");
  }
  const before = await deps.actors.region(region).getIncident({ trace_id: deps.trace_id });
  const alreadyAcked = before.incident !== null && before.incident.ackAt !== null;
  const { incident } = await deps.actors
    .region(region)
    .ack({ by: "ops", trace_id: deps.trace_id, at: deps.now });
  await syncProjection({ actors: deps.actors, kv: deps.kv }, region, deps.trace_id);
  logEvent("ops.ack", {
    hop: "ops/ack",
    trace_id: deps.trace_id,
    outcome: "ok",
    region,
    incident_id: incident?.id ?? "none",
    acked: incident !== null && !alreadyAcked,
  });
  return { region, acked: incident !== null && !alreadyAcked };
}

export async function resolveIncident(
  deps: ActionDeps,
  region: string,
): Promise<ResolveResult> {
  if (!REGIONS.some((r) => r.region === region)) {
    throw new OpsActionError("unknown_region");
  }
  // The incident is gone once resolve lands, so read the actor truth first.
  const before = await deps.actors.region(region).getIncident({ trace_id: deps.trace_id });
  const { incident } = await deps.actors
    .region(region)
    .resolve({ trace_id: deps.trace_id, at: deps.now });
  await syncProjection({ actors: deps.actors, kv: deps.kv }, region, deps.trace_id);
  const report =
    before.incident === null
      ? { ok: false, key: "" }
      : await writeReportAfterResolve(deps, region, before.incident);
  logEvent("ops.resolve", {
    hop: "ops/resolve",
    trace_id: deps.trace_id,
    outcome: "ok",
    region,
    incident_id: incident?.id ?? "none",
    report_ok: report.ok,
  });
  return { region, resolved: incident?.id ?? null, report };
}

// A failed report write (bucket error, timeout, pointer error) never fails
// the resolve that already succeeded.
async function writeReportAfterResolve(
  deps: ActionDeps,
  region: string,
  incident: ReportIncident | null,
): Promise<ReportWriteResult> {
  const started = Date.now();
  if (incident === null) return { ok: false, key: "" };
  try {
    const report = buildIncidentReport({
      region,
      regionLabel: regionLabelOf(region),
      incident,
      resolvedAt: deps.now,
      trace_id: deps.trace_id,
    });
    const out = await writeReport(deps.reports ?? null, report);
    if (out.ok) {
      await writeLastReportPointer(deps.kv, report, out.key);
      logEvent("report.written", {
        hop: "ops/resolve",
        trace_id: deps.trace_id,
        outcome: "ok",
        incident_id: report.incident_id,
        key: out.key,
        total_ms: Date.now() - started,
      });
    }
    return out;
  } catch (err) {
    logEvent("report.write_failed", {
      lvl: "warn",
      hop: "ops/resolve",
      trace_id: deps.trace_id,
      incident_id: incident.id,
      outcome: "error",
      total_ms: Date.now() - started,
      error: String(err),
    });
    return { ok: false, key: "" };
  }
}

export async function unlockSite(deps: ActionDeps, siteId: string): Promise<UnlockResult> {
  const site = SITES.find((s) => s.site_id === siteId);
  if (site === undefined) {
    throw new OpsActionError("unknown_site");
  }
  await deps.actors.site(site.site_id).reset({ trace_id: deps.trace_id });
  const note =
    "demo-only: SiteState.reset also cleared any open ticket and call history for this site";
  logEvent("ops.unlock", {
    hop: "ops/unlock",
    trace_id: deps.trace_id,
    outcome: "ok",
    site: site.site_id,
  });
  return { site: site.site_id, ok: true, note };
}
