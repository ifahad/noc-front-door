import { SITES } from "../../../shared/src/seed";
import type { ActorMode } from "../services/flags";
import { logEvent } from "../log";
import type { ActorPort } from "../services/actorPort";
import type { KvPort } from "../services/kvPort";
import { readLastReport, type LastReportPointer } from "../services/reports";
import { buildStatus, type StatusPayload, type StatusSite } from "./status";

const REGION_BY_SITE = SITES.map((site) => [site.site_id, site.region] as const);

export type BoardSite = StatusSite & { region: string };

export interface BoardPayload extends StatusPayload {
  sites: BoardSite[];
  actor_mode: ActorMode;
  generated_at: string;
  last_report: LastReportPointer | null;
}

export interface BoardActorChoice {
  port: ActorPort;
  mode: ActorMode;
}

export interface BoardDeps {
  kv: KvPort;
  selectActor: () => Promise<BoardActorChoice>;
  now: number;
}

// Viewer protection: the board is the demo page's public read path, so the
// single actor instance must not see one build per viewer. Callers join an
// in-flight build; once a build settles successfully the reuse window runs
// for BOARD_TTL_MS (DEGRADED_TTL_MS when the build was degraded) measured
// from the real settle time, not the request start, so a slow build is not
// thrown away the moment it lands and a 5 s poller amortises one build; a
// rejected build is dropped so the next request rebuilds.
const BOARD_TTL_MS = 30_000;
const DEGRADED_TTL_MS = 10_000;

interface BoardCacheEntry {
  settledAt: number | undefined;
  degraded: boolean;
  promise: Promise<BoardPayload>;
}

const boardCaches = new WeakMap<object, BoardCacheEntry>();

export function getBoard(cacheKey: object, deps: BoardDeps): Promise<BoardPayload> {
  const existing = boardCaches.get(cacheKey);
  if (existing !== undefined) {
    const ttl = existing.degraded ? DEGRADED_TTL_MS : BOARD_TTL_MS;
    if (existing.settledAt === undefined || Date.now() - existing.settledAt < ttl) {
      return existing.promise;
    }
  }
  const promise = buildBoard(deps);
  const entry: BoardCacheEntry = { settledAt: undefined, degraded: false, promise };
  boardCaches.set(cacheKey, entry);
  promise.then(
    (payload) => {
      entry.settledAt = Date.now();
      entry.degraded = payload.degraded === true;
    },
    () => {
      if (boardCaches.get(cacheKey) === entry) boardCaches.delete(cacheKey);
    },
  );
  return promise;
}

// The public /ops/status payload is the board without the board-only fields
// (actor_mode, generated_at, last_report and the per-site region). Serving
// both views from one cached build keeps a single-flight window around every
// status read too (final review F2).
export function statusPayloadOf(board: BoardPayload): StatusPayload {
  const payload: StatusPayload = {
    at: board.at,
    heartbeat: board.heartbeat,
    fault_flags: board.fault_flags,
    regions: board.regions,
    sites: board.sites.map((site) => ({
      site_id: site.site_id,
      label: site.label,
      open_ticket: site.open_ticket,
      recent_calls: site.recent_calls,
    })),
  };
  if (board.degraded === true) payload.degraded = true;
  return payload;
}

async function buildBoard(deps: BoardDeps): Promise<BoardPayload> {
  const started = Date.now();
  const choice = await deps.selectActor();
  const [status, last_report] = await Promise.all([
    buildStatus({ kv: deps.kv, actors: choice.port, now: deps.now }),
    readLastReport(deps.kv),
  ]);
  const regionBySite = new Map(REGION_BY_SITE);
  const sites: BoardSite[] = status.sites.map((site) => ({
    ...site,
    region: regionBySite.get(site.site_id) ?? "unknown",
  }));
  logEvent("ops.board", {
    hop: "ops/board",
    outcome: "ok",
    total_ms: Date.now() - started,
    mode: choice.mode,
    degraded: status.degraded === true,
    last_report: last_report !== null,
  });
  return {
    ...status,
    sites,
    actor_mode: choice.mode,
    generated_at: new Date(deps.now).toISOString(),
    last_report,
  };
}
