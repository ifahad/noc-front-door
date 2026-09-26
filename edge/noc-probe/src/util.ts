const encoder = new TextEncoder();

export function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer as ArrayBuffer;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function uuid8(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function pickCallKey(body: unknown): string {
  const cci = (body as Record<string, unknown> | null)?.data as
    | { payload?: { call_control_id?: unknown } }
    | undefined;
  const value = cci?.payload?.call_control_id;
  if (typeof value === "string" && value.length > 0) return value;
  return `dv-${uuid8()}`;
}

export function pickToolCallKey(body: unknown): string {
  const value = (body as { call_key?: unknown } | null)?.call_key;
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "none" &&
    !value.includes("{{")
  ) {
    return value;
  }
  return `tool-${uuid8()}`;
}

export function constantTimeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}

const MAX_WALK_DEPTH = 8;

export function keyPaths(value: unknown, prefix = ""): string[] {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return prefix ? [prefix] : [];
    const out: string[] = [];
    for (const [k, v] of entries) {
      out.push(...keyPaths(v, prefix ? `${prefix}.${k}` : k));
    }
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return prefix ? [prefix] : [];
    const out: string[] = [];
    value.forEach((v, i) => {
      out.push(...keyPaths(v, prefix ? `${prefix}.${i}` : `${i}`));
    });
    return out;
  }
  return prefix ? [prefix] : [];
}

export function findValue(root: unknown, key: string): unknown {
  return findValueInner(root, key, 0);
}

function findValueInner(value: unknown, key: string, depth: number): unknown {
  if (depth > MAX_WALK_DEPTH) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findValueInner(item, key, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (key in record) return record[key];
    for (const k of Object.keys(record)) {
      const found = findValueInner(record[k], key, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
