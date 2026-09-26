import { bufferOf } from "./util";

export type SigResult = "valid" | "invalid" | "absent" | "error";

export interface SigInput {
  publicKey: string | null;
  signature: string | null;
  timestamp: string | null;
  rawBody: Uint8Array;
}

export interface ParsedKey {
  kind: "raw" | "spki";
  bytes: Uint8Array;
}

const encoder = new TextEncoder();

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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

export async function verifyTelnyxSignature(input: SigInput): Promise<SigResult> {
  if (!input.signature || !input.timestamp) return "absent";
  try {
    const { kind, bytes } = parsePublicKey(input.publicKey ?? "");
    const key = await crypto.subtle.importKey(
      kind,
      bufferOf(bytes),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    const sig = base64ToBytes(input.signature);
    const tsPrefix = encoder.encode(`${input.timestamp}|`);
    const message = new Uint8Array(tsPrefix.length + input.rawBody.length);
    message.set(tsPrefix, 0);
    message.set(input.rawBody, tsPrefix.length);
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      bufferOf(sig),
      bufferOf(message)
    );
    return ok ? "valid" : "invalid";
  } catch {
    return "error";
  }
}
