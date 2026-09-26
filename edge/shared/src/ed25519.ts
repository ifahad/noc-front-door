const encoder = new TextEncoder();

export type SigResult = "valid" | "invalid" | "absent" | "error";

const SIG_HEADER = "telnyx-signature-ed25519";
const TS_HEADER = "telnyx-timestamp";

export function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer as ArrayBuffer;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface ParsedKey {
  kind: "raw" | "spki";
  bytes: Uint8Array;
}

export function parsePublicKey(value: string): ParsedKey {
  if (value.includes("-----BEGIN")) {
    const body = value
      .replace(/\\n/g, "\n")
      .replace(/-----BEGIN [^-]+-----/, "")
      .replace(/-----END [^-]+-----/, "")
      .replace(/\s+/g, "");
    return { kind: "spki", bytes: base64ToBytes(body) };
  }
  const bytes = base64ToBytes(value);
  if (bytes.length !== 32 && bytes[0] === 0x30) {
    return { kind: "spki", bytes };
  }
  return { kind: "raw", bytes };
}

type HeaderSource = Headers | Record<string, string>;

function headerGet(source: HeaderSource, name: string): string | null {
  const maybe = source as { get?: (n: string) => string | null };
  if (typeof maybe.get === "function") return maybe.get(name);
  const record = source as Record<string, string>;
  const key = Object.keys(record).find(
    (k) => k.toLowerCase() === name.toLowerCase(),
  );
  return key === undefined ? null : record[key];
}

export async function verifyTelnyxSignature(
  headers: HeaderSource,
  rawBody: string,
  publicKeyB64: string,
): Promise<SigResult> {
  const signature = headerGet(headers, SIG_HEADER);
  const timestamp = headerGet(headers, TS_HEADER);
  if (!signature || !timestamp) return "absent";
  try {
    const { kind, bytes } = parsePublicKey(publicKeyB64 ?? "");
    const key = await crypto.subtle.importKey(
      kind,
      bufferOf(bytes),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const sig = base64ToBytes(signature);
    const tsPrefix = encoder.encode(`${timestamp}|`);
    const body = encoder.encode(rawBody);
    const message = new Uint8Array(tsPrefix.length + body.length);
    message.set(tsPrefix, 0);
    message.set(body, tsPrefix.length);
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      bufferOf(sig),
      bufferOf(message),
    );
    return ok ? "valid" : "invalid";
  } catch {
    return "error";
  }
}

export function isFresh(tsHeader: string | null, nowSec: number, skewSec = 300): boolean {
  if (tsHeader === null) return false;
  const ts = Number.parseInt(tsHeader, 10);
  if (Number.isNaN(ts)) return false;
  return Math.abs(nowSec - ts) <= skewSec;
}
