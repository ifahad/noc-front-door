import { sha256Hex } from "../../../shared/src/ids";
import type { SeedAdapter } from "../../../shared/src/itsm";
import { kvKey } from "../../../shared/src/kvkeys";
import { REGIONS, SITES } from "../../../shared/src/seed";
import type { Session } from "../../../shared/src/types";
import { logEvent } from "../log";
import type { ActorPort } from "../services/actorPort";
import { projectionOf, syncProjection, type IncidentProjection } from "../services/incidents";
import type { KvPort } from "../services/kvPort";
import { open as openTicket } from "../services/tickets";

export interface ActionDeps {
  kv: KvPort;
  actors: ActorPort;
  adapter: SeedAdapter;
  now: number;
  trace_id: string;
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
  const { incident } = await deps.actors
    .region(region)
    .resolve({ trace_id: deps.trace_id, at: deps.now });
  await syncProjection({ actors: deps.actors, kv: deps.kv }, region, deps.trace_id);
  logEvent("ops.resolve", {
    hop: "ops/resolve",
    trace_id: deps.trace_id,
    outcome: "ok",
    region,
    incident_id: incident?.id ?? "none",
  });
  return { region, resolved: incident?.id ?? null };
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
