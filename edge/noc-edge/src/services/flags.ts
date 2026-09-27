import { kvKey } from "../../../shared/src/kvkeys";
import type { KvPort } from "./kvPort";

export type FaultStatus = 500 | 503 | 504;

export type ActorMode = "per-entity" | "mux";

// Deploy-time fallback for a cold isolate whose flags read times out
// (FLAGS_BUDGET_MS in router.ts): per-entity bindings return 502 after ~30 s
// on this account (DEBUGLOG #4), so the known-good mux contingency is the
// documented default. lastKnownMode still wins whenever a flags read has
// succeeded in this isolate.
export const ACTOR_MODE_DEFAULT: ActorMode = "mux";

export interface Flags {
  deflection_enabled: boolean;
  require_pin: boolean;
  demo_caller: string | null;
  fault_open_ticket: FaultStatus | null;
  fault_dv_delay_ms: number | null;
  actor_mode: ActorMode;
}

// Flag changes propagate within 60 s; KV reads on this account cost ~1.5 s
// (LIVE EVIDENCE, DEBUGLOG #6), so the memo horizon must be long enough to
// make the read amortisable across the external prober and /dv traffic.
const MEMO_MS = 60_000;
const MAX_DV_DELAY_MS = 12000;
const FAULT_STATUSES: readonly number[] = [500, 503, 504];

const memoByKv = new WeakMap<KvPort, { at: number; flags: Flags }>();
const inFlightByKv = new WeakMap<KvPort, Promise<Flags>>();

export interface FlagsRead {
  flags: Flags;
  memo_hit: boolean;
}

export async function readDetailed(kv: KvPort, now: number): Promise<FlagsRead> {
  const memo = memoByKv.get(kv);
  if (memo !== undefined && now - memo.at < MEMO_MS) {
    return { flags: memo.flags, memo_hit: true };
  }
  const existing = inFlightByKv.get(kv);
  if (existing !== undefined) return { flags: await existing, memo_hit: false };
  const flight = doRead(kv, now);
  inFlightByKv.set(kv, flight);
  flight
    .finally(() => {
      if (inFlightByKv.get(kv) === flight) inFlightByKv.delete(kv);
    })
    .catch(() => {});
  return { flags: await flight, memo_hit: false };
}

export function read(kv: KvPort, now: number): Promise<Flags> {
  return readDetailed(kv, now).then((outcome) => outcome.flags);
}

async function doRead(kv: KvPort, now: number): Promise<Flags> {
  const memo = memoByKv.get(kv);
  if (memo !== undefined && now - memo.at < MEMO_MS) return memo.flags;
  const [deflection, requirePin, demo, faultOpen, faultDelay, actorMode] = await Promise.all([
    kv.get(kvKey("flag", "deflection_enabled")),
    kv.get(kvKey("flag", "require_pin")),
    kv.get(kvKey("flag", "demo_caller")),
    kv.get(kvKey("flag", "fault", "open_ticket")),
    kv.get(kvKey("flag", "fault", "dv_delay_ms")),
    kv.get(kvKey("flag", "actor_mode")),
  ]);
  const flags: Flags = {
    deflection_enabled: deflection !== "false",
    require_pin: requirePin === "true",
    demo_caller: typeof demo === "string" && demo.length > 0 ? demo : null,
    fault_open_ticket: parseFaultStatus(faultOpen),
    fault_dv_delay_ms: parseDvDelay(faultDelay),
    actor_mode: actorMode === "mux" ? "mux" : "per-entity",
  };
  memoByKv.set(kv, { at: now, flags });
  return flags;
}

function parseFaultStatus(raw: string | null): FaultStatus | null {
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value)) return null;
  return (FAULT_STATUSES as readonly number[]).includes(value)
    ? (value as FaultStatus)
    : null;
}

function parseDvDelay(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(MAX_DV_DELAY_MS, Math.floor(value)));
}
