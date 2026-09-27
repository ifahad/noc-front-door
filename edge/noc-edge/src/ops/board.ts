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
// single actor instance must not see one build per viewer. A finished build
// is reused for BOARD_TTL_MS; concurrent requests join the in-flight build;
// a rejected build is dropped so the next request rebuilds.
const BOARD_TTL_MS = 8_000;

interface BoardCacheEntry {
  at: number;
  promise: Promise<BoardPayload>;
}

const boardCaches = new WeakMap<object, BoardCacheEntry>();

export function getBoard(cacheKey: object, deps: BoardDeps): Promise<BoardPayload> {
  const existing = boardCaches.get(cacheKey);
  if (existing !== undefined && deps.now - existing.at < BOARD_TTL_MS) {
    return existing.promise;
  }
  const promise = buildBoard(deps);
  const entry: BoardCacheEntry = { at: deps.now, promise };
  boardCaches.set(cacheKey, entry);
  promise.catch(() => {
    if (boardCaches.get(cacheKey) === entry) boardCaches.delete(cacheKey);
  });
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
