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

export async function syncProjection(
  deps: { actors: ActorPort; kv: KvPort },
  region: string,
  trace_id: string,
): Promise<void> {
  try {
    const { incident } = await deps.actors.region(region).getIncident({ trace_id });
    const key = kvKey("incident", "active", region);
    if (incident === null) {
      await deps.kv.delete(key);
      logEvent("incident.sync", {
        hop: "services/incidents",
        trace_id,
        region,
        outcome: "ok",
        projected: false,
      });
      return;
    }
    await deps.kv.put(key, JSON.stringify(projectionOf(incident, region)), {
      expirationTtl: PROJECTION_TTL_SECONDS,
    });
    logEvent("incident.sync", {
      hop: "services/incidents",
      trace_id,
      region,
      outcome: "ok",
      projected: true,
      incident_id: incident.id,
    });
  } catch (err) {
    logEvent("incident.sync", {
      hop: "services/incidents",
      trace_id,
      region,
      outcome: "error",
      lvl: "warn",
      error: String(err),
    });
  }
}
