import { mintTicketId, sha256Hex } from "../../../shared/src/ids";
import type { SeedAdapter } from "../../../shared/src/itsm";
import { kvKey } from "../../../shared/src/kvkeys";
import { deadline } from "../../../shared/src/timing";
import type { Session } from "../../../shared/src/types";
import { logEvent } from "../log";
import type { ActorPort } from "../services/actorPort";
import type { KvPort } from "../services/kvPort";
import { open as openTicket } from "../services/tickets";

// Diagnostic tool webhooks allow up to 8 s, and the opens must all be in
// flight at once, so the ceiling matches the tool budget (LIVE EVIDENCE:
// warm actor calls take ~220 ms, but bursts can queue).
const OPEN_DEADLINE_MS = 8000;
const KV_GAP_MS = 1;
const MIN_N = 1;
const MAX_N = 50;
const LAB_SITE = "TST-001";
const LAB_REGION = "lab";
const LAB_CODE = "99";
const LAB_CUSTOMER = "c-lab";

export type RaceMode = "actor" | "kv";

export class RaceError extends Error {
  status: 422;

  constructor(message: string) {
    super(message);
    this.name = "RaceError";
    this.status = 422;
  }
}

export interface RaceDeps {
  kv: KvPort;
  actors: ActorPort;
  adapter: SeedAdapter;
  now: number;
  trace_id: string;
}

export interface RaceResult {
  mode: RaceMode;
  n: number;
  created_count: number;
  ticket_ids: string[];
}

export function clampN(raw: string | number | null | undefined): number {
  const parsed =
    typeof raw === "number"
      ? raw
      : Number.parseInt(typeof raw === "string" ? raw : "", 10);
  if (!Number.isInteger(parsed)) return 20;
  return Math.max(MIN_N, Math.min(MAX_N, parsed));
}

export function modeOf(raw: string | null | undefined): RaceMode {
  if (raw === "actor" || raw === "kv") return raw;
  throw new RaceError("unknown_mode");
}

export async function runRace(
  deps: RaceDeps,
  rawMode: string | null | undefined,
  rawN: string | number | null | undefined,
  rawRun: string | null | undefined,
): Promise<RaceResult> {
  const mode = modeOf(rawMode);
  const n = clampN(rawN);
  const run =
    typeof rawRun === "string" && rawRun.length > 0
      ? rawRun
      : (await sha256Hex(`race-${deps.now}`)).slice(0, 12);
  await resetLab(deps);
  if (mode === "actor") {
    return actorRace(deps, mode, n, run);
  }
  return kvRace(deps, mode, n, run);
}

async function resetLab(deps: RaceDeps): Promise<void> {
  await deps.actors.site(LAB_SITE).reset({ trace_id: deps.trace_id });
  await deps.actors.region(LAB_REGION).reset({ trace_id: deps.trace_id });
  await deps.actors.site(LAB_SITE).getTicket({ trace_id: deps.trace_id });
}

async function actorRace(deps: RaceDeps, mode: RaceMode, n: number, run: string): Promise<RaceResult> {
  const outcomes = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      deadline(
        openTicket(
          raceCtx(deps),
          actorSession(run, i),
          {
            site_id: LAB_SITE,
            symptom: "race test",
            impact: "site_down",
            service_affecting: "true",
          },
        ),
        OPEN_DEADLINE_MS,
        "race.open",
      ),
    ),
  );
  const ids: string[] = [];
  let created = 0;
  for (const outcome of outcomes) {
    if (!outcome.ok) continue;
    if (outcome.value.created === "true") created += 1;
    if (!ids.includes(outcome.value.ticket_id)) ids.push(outcome.value.ticket_id);
  }
  logEvent("diag.race", {
    hop: "diag/race",
    trace_id: deps.trace_id,
    outcome: "ok",
    mode,
    n,
    created_count: created,
    run,
  });
  return { mode, n, created_count: created, ticket_ids: ids };
}

async function kvRace(deps: RaceDeps, mode: RaceMode, n: number, run: string): Promise<RaceResult> {
  const key = kvKey("race", run, "ticket");
  const ids = await Promise.all(
    Array.from({ length: n }, (_, i) => naiveGetThenPut(deps, key, i)),
  );
  const unique: string[] = [];
  for (const id of ids) {
    if (!unique.includes(id)) unique.push(id);
  }
  logEvent("diag.race", {
    hop: "diag/race",
    trace_id: deps.trace_id,
    outcome: "ok",
    mode,
    n,
    created_count: unique.length,
    run,
  });
  return { mode, n, created_count: unique.length, ticket_ids: unique };
}

async function naiveGetThenPut(deps: RaceDeps, key: string, i: number): Promise<string> {
  const existing = await deps.kv.get(key);
  if (existing !== null) {
    try {
      const stored = JSON.parse(existing) as { id?: unknown };
      if (typeof stored.id === "string") return stored.id;
    } catch {
      return storedId(existing);
    }
    return storedId(existing);
  }
  await gap();
  const id = mintTicketId(LAB_CODE, i + 1);
  await deps.kv.put(key, JSON.stringify({ id }));
  return id;
}

function storedId(raw: string): string {
  return raw.length > 0 ? raw : "none";
}

function gap(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, KV_GAP_MS));
}

function raceCtx(deps: RaceDeps) {
  return {
    actors: deps.actors,
    kv: deps.kv,
    adapter: deps.adapter,
    flags: {
      deflection_enabled: true,
      require_pin: false,
      demo_caller: null,
      fault_open_ticket: null,
      fault_dv_delay_ms: null,
      actor_mode: "per-entity" as const,
    },
    now: deps.now,
    trace_id: deps.trace_id,
  };
}

function actorSession(run: string, i: number): Session {
  return {
    k: `${run}-${i}-pending`,
    trace_id: `t-race-${run}-${i}`,
    identified: true,
    verified: true,
    contact_id: null,
    customer_id: LAB_CUSTOMER,
    sites: [LAB_SITE],
    region: LAB_REGION,
  };
}
