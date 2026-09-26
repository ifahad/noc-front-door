const PHONE_RE = /\+[0-9]{8,15}(?![0-9])/g;

function mask(value: string): string {
  return value.replace(PHONE_RE, (m) => `${m.slice(0, 5)}****${m.slice(-3)}`);
}

function deepMask(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return mask(value);
  if (depth >= 8) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => deepMask(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepMask(v, depth + 1);
    }
    return out;
  }
  return value;
}

export type LogLine = {
  ts: string;
  lvl: string;
  svc: string;
  evt: string;
} & Record<string, unknown>;

export function logEvent(evt: string, fields: Record<string, unknown> = {}): void {
  const { lvl, ...rest } = fields;
  const line: LogLine = {
    ts: new Date().toISOString(),
    lvl: typeof lvl === "string" ? lvl : "info",
    svc: "noc-edge",
    evt,
    ...(deepMask(rest) as Record<string, unknown>),
  };
  console.log(JSON.stringify(line));
}
