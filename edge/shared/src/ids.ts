const encoder = new TextEncoder();

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

const SENTINELS = new Set(["none", "unknown"]);

function usable(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !SENTINELS.has(value) &&
    !value.includes("{{")
  );
}

export interface SessionKeyInput {
  call_control_id?: unknown;
  call_key?: unknown;
}

export async function sessionKey(input: SessionKeyInput): Promise<string | null> {
  if (usable(input.call_control_id)) {
    return (await sha256Hex(input.call_control_id)).slice(0, 16);
  }
  if (usable(input.call_key)) {
    return (await sha256Hex(`key:${input.call_key}`)).slice(0, 16);
  }
  return null;
}

export function traceId(k: string): string {
  return `t-${k}`;
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

export function mintTicketId(siteCode: string, seq: number): string {
  return `NJD-${siteCode}${pad2(seq % 100)}`;
}

export function mintIncidentId(regionCode: string, seq: number): string {
  return `INC-${regionCode}${pad3(seq % 1000)}`;
}

export function siteCodeOfTicket(id: string): string | null {
  const m = /^NJD-(\d{2})\d{2}$/.exec(id);
  return m ? m[1] : null;
}

export function spellId(id: string): string {
  const m = /^([A-Za-z]+)-(\d+)$/.exec(id);
  if (!m) return id;
  const letters = m[1].split("").join(" ");
  const digits = m[2].split("").join(" ");
  return `${letters}, ${digits}`;
}
