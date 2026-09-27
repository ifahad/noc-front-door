import { REGIONS } from "../../../shared/src/seed";
import { formatRiyadhTime } from "../../../shared/src/readback";
import { kvKey } from "../../../shared/src/kvkeys";
import type { Incident } from "../../../shared/src/types";
import { logEvent } from "../log";
import type { ActorPort } from "./actorPort";
import type { KvPort } from "./kvPort";

export const PROJECTION_TTL_SECONDS = 7200;

export interface IncidentProjection {
  id: string;
  version: number;
  region_label: string;
  started_local: string;
  summary: string;
  eta_local: string;
  priority: string;
  site_count: number;
}

export function regionLabelOf(region: string): string {
  return REGIONS.find((r) => r.region === region)?.label ?? region;
}

export function regionCodeOf(region: string): string {
  return REGIONS.find((r) => r.region === region)?.code ?? region;
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

export function incidentSummaryOf(incident: Incident): string {
  const count = Object.keys(incident.sites).length;
  if (count === 1) return "loss of connectivity at one branch";
  const spoken = NUMBER_WORDS[count] ?? String(count);
  return `loss of connectivity at ${spoken} branches`;
}

export function projectionOf(
  incident: Incident,
  region: string,
): IncidentProjection {
  return {
    id: incident.id,
    version: incident.version,
    region_label: regionLabelOf(region),
    started_local: formatRiyadhTime(incident.declaredAt),
    summary: incidentSummaryOf(incident),
    eta_local: formatRiyadhTime(incident.nextUpdateAt),
    priority: incident.priority,
    site_count: Object.keys(incident.sites).length,
  };
}

export interface SyncResult {
  ok: boolean;
  projected: boolean;
}

// The canary syncs every ~10 s, so incident.sync is logged only when the
// projection actually changes (spec §11.1 quiet canary). This isolate's last
// write per (kv, region) is the change detector; syncProjection is the single
// writer of incident/active/<region> (spec §6.3), so the memo is authoritative
// within the isolate. A write or delete still runs every time so the TTL and
// the write path keep being exercised.
const lastProjectionByKv = new WeakMap<KvPort, Map<string, string | null>>();

function lastProjection(kv: KvPort, region: string): string | null | undefined {
  let byRegion = lastProjectionByKv.get(kv);
  if (byRegion === undefined) {
    byRegion = new Map<string, string | null>();
    lastProjectionByKv.set(kv, byRegion);
  }
  return byRegion.get(region);
}

function setLastProjection(kv: KvPort, region: string, value: string | null): void {
  const byRegion = lastProjectionByKv.get(kv);
  if (byRegion !== undefined) byRegion.set(region, value);
}

export async function syncProjection(
  deps: { actors: ActorPort; kv: KvPort },
  region: string,
  trace_id: string,
): Promise<SyncResult> {
  const key = kvKey("incident", "active", region);
  try {
    const { incident } = await deps.actors.region(region).getIncident({ trace_id });
    if (incident === null) {
      const knownAbsent = lastProjection(deps.kv, region) === null;
      if (!knownAbsent) {
        await deps.kv.delete(key);
        setLastProjection(deps.kv, region, null);
        logEvent("incident.sync", {
          hop: "services/incidents",
          trace_id,
          region,
          outcome: "ok",
          projected: false,
        });
      }
      return { ok: true, projected: false };
    }
    const serialized = JSON.stringify(projectionOf(incident, region));
    await deps.kv.put(key, serialized, {
      expirationTtl: PROJECTION_TTL_SECONDS,
    });
    if (lastProjection(deps.kv, region) !== serialized) {
      setLastProjection(deps.kv, region, serialized);
      logEvent("incident.sync", {
        hop: "services/incidents",
        trace_id,
        region,
        outcome: "ok",
        projected: true,
        incident_id: incident.id,
        site_count: Object.keys(incident.sites).length,
      });
    }
    return { ok: true, projected: true };
  } catch (err) {
    logEvent("incident.sync", {
      hop: "services/incidents",
      trace_id,
      region,
      outcome: "error",
      lvl: "warn",
      error: String(err),
    });
    return { ok: false, projected: false };
  }
}
