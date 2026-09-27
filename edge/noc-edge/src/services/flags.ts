import { kvKey } from "../../../shared/src/kvkeys";
import type { KvPort } from "./kvPort";

export type FaultStatus = 500 | 503 | 504;

export type ActorMode = "per-entity" | "mux";

export interface Flags {
  deflection_enabled: boolean;
  require_pin: boolean;
  demo_caller: string | null;
  fault_open_ticket: FaultStatus | null;
  fault_dv_delay_ms: number | null;
  actor_mode: ActorMode;
}

const MEMO_MS = 5000;
const MAX_DV_DELAY_MS = 12000;
const FAULT_STATUSES: readonly number[] = [500, 503, 504];

const memoByKv = new WeakMap<KvPort, { at: number; flags: Flags }>();

export async function read(kv: KvPort, now: number): Promise<Flags> {
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
