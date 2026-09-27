import { SITES } from "../../../shared/src/seed";
import type { ActorMode } from "../services/flags";
import { logEvent } from "../log";
import type { ActorPort } from "../services/actorPort";
import type { KvPort } from "../services/kvPort";
import { buildStatus, type StatusPayload, type StatusSite } from "./status";

const REGION_BY_SITE = SITES.map((site) => [site.site_id, site.region] as const);

export type BoardSite = StatusSite & { region: string };

export interface BoardPayload extends StatusPayload {
  sites: BoardSite[];
  actor_mode: ActorMode;
  generated_at: string;
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
// in-flight build regardless of its age; once a build settles successfully the
// reuse window runs for BOARD_TTL_MS from the settle time observed by the
// latest joiner (or the building request itself when nobody joins); a rejected
// build is dropped so the next request rebuilds.
const BOARD_TTL_MS = 8_000;

interface BoardCacheEntry {
  settledAt: number | undefined;
  promise: Promise<BoardPayload>;
}

const boardCaches = new WeakMap<object, BoardCacheEntry>();

export function getBoard(cacheKey: object, deps: BoardDeps): Promise<BoardPayload> {
  const existing = boardCaches.get(cacheKey);
  if (existing !== undefined) {
    if (existing.settledAt === undefined || deps.now - existing.settledAt < BOARD_TTL_MS) {
      if (existing.settledAt === undefined) {
        const observedAt = deps.now;
        existing.promise.then(
          () => {
            existing.settledAt = observedAt;
          },
          () => {},
        );
      }
      return existing.promise;
    }
  }
  const promise = buildBoard(deps);
  const entry: BoardCacheEntry = { settledAt: undefined, promise };
  boardCaches.set(cacheKey, entry);
  promise.then(
    () => {
      entry.settledAt = deps.now;
    },
    () => {
      if (boardCaches.get(cacheKey) === entry) boardCaches.delete(cacheKey);
    },
  );
  return promise;
}

async function buildBoard(deps: BoardDeps): Promise<BoardPayload> {
  const started = Date.now();
  const choice = await deps.selectActor();
  const status = await buildStatus({ kv: deps.kv, actors: choice.port, now: deps.now });
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
  });
  return {
    ...status,
    sites,
    actor_mode: choice.mode,
    generated_at: new Date(deps.now).toISOString(),
  };
}
