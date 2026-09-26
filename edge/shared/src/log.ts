import { mask } from "./mask";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogOutcome = "ok" | "fallback" | "denied" | "error";

export interface LogEventFields {
  svc: string;
  hop: string;
  evt: string;
  lvl?: LogLevel;
  trace_id?: string;
  outcome?: LogOutcome;
  total_ms?: number;
  [k: string]: unknown;
}

const SECRET_KEYS = new Set([
  "pin",
  "fp",
  "pinfingerprint",
  "authorization",
  "token",
  "secret",
  "apikey",
]);

const REDACTED = "[redacted]";
const MAX_DEPTH = 8;

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase());
}

function deepScrub(value: unknown, depth: number): unknown {
  if (typeof value === "string") return mask(value);
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value.map((v) => deepScrub(v, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? REDACTED : deepScrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function logEvent(f: LogEventFields): void {
  const { svc, hop, evt, lvl, ...rest } = f;
  const scrubbed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    scrubbed[k] = isSecretKey(k) ? REDACTED : deepScrub(v, 0);
  }
  const asText = (v: unknown): string =>
    typeof v === "string" ? mask(v) : String(v);
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    lvl: lvl ?? "info",
    svc: asText(svc),
    hop: asText(hop),
    evt: asText(evt),
    ...scrubbed,
  };
  console.log(JSON.stringify(line));
}
