import { describe, expect, it } from "vitest";
import { isFresh, verifyTelnyxSignature, type SigResult } from "../src/ed25519";

const encoder = new TextEncoder();

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function pemFromSpki(spki: Uint8Array): string {
  const lines = b64(spki).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----\n`;
}

function pemEscaped(pem: string): string {
  return pem.replace(/\n/g, "\\n");
}

async function makeKeys(): Promise<{ rawB64: string; pem: string; priv: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { rawB64: b64(raw), pem: pemFromSpki(spki), priv: pair.privateKey };
}

async function sign(priv: CryptoKey, timestamp: string, body: string): Promise<string> {
  const msg = encoder.encode(`${timestamp}|${body}`);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, priv, msg));
  return b64(sig);
}

describe("verifyTelnyxSignature", () => {
  it("returns valid with a raw base64 32-byte public key (Headers)", async () => {
    const { rawB64, priv } = await makeKeys();
    const ts = "1700000000";
    const body = '{"event":"probe"}';
    const sig = await sign(priv, ts, body);
    const headers = new Headers({
      "telnyx-signature-ed25519": sig,
      "telnyx-timestamp": ts,
    });
    const res = await verifyTelnyxSignature(headers, body, rawB64);
    expect(res).toBe<SigResult>("valid");
  });

  it("returns valid with a PEM SPKI public key (record headers)", async () => {
    const { pem, priv } = await makeKeys();
    const ts = "1700000001";
    const body = '{"event":"probe2"}';
    const sig = await sign(priv, ts, body);
    const res = await verifyTelnyxSignature(
      { "telnyx-signature-ed25519": sig, "telnyx-timestamp": ts },
      body,
      pem,
    );
    expect(res).toBe<SigResult>("valid");
  });

  it("returns valid with a PEM containing literal \\n escapes", async () => {
    const { pem, priv } = await makeKeys();
    const ts = "1700000002";
    const body = '{"event":"probe3"}';
    const sig = await sign(priv, ts, body);
    const res = await verifyTelnyxSignature(
      { "telnyx-signature-ed25519": sig, "telnyx-timestamp": ts },
      body,
      pemEscaped(pem),
    );
    expect(res).toBe<SigResult>("valid");
  });

  it("returns invalid for a tampered body", async () => {
    const { rawB64, priv } = await makeKeys();
    const ts = "1700000003";
    const sig = await sign(priv, ts, '{"n":1}');
    const res = await verifyTelnyxSignature(
      { "telnyx-signature-ed25519": sig, "telnyx-timestamp": ts },
      '{"n":2}',
      rawB64,
    );
    expect(res).toBe<SigResult>("invalid");
  });

  it("returns invalid for a wrong key", async () => {
    const { rawB64: otherKey } = await makeKeys();
    const { priv } = await makeKeys();
    const ts = "1700000004";
    const body = '{"a":true}';
    const sig = await sign(priv, ts, body);
    const res = await verifyTelnyxSignature(
      { "telnyx-signature-ed25519": sig, "telnyx-timestamp": ts },
      body,
      otherKey,
    );
    expect(res).toBe<SigResult>("invalid");
  });

  it("returns absent when the signature header is missing", async () => {
    const { rawB64 } = await makeKeys();
    const res = await verifyTelnyxSignature(
      { "telnyx-timestamp": "1700000005" },
      "{}",
      rawB64,
    );
    expect(res).toBe<SigResult>("absent");
  });

  it("returns absent when the timestamp header is missing", async () => {
    const { rawB64, priv } = await makeKeys();
    const sig = await sign(priv, "1700000006", "{}");
    const res = await verifyTelnyxSignature(
      { "telnyx-signature-ed25519": sig },
      "{}",
      rawB64,
    );
    expect(res).toBe<SigResult>("absent");
  });

  it("returns error for a garbage public key", async () => {
    const { priv } = await makeKeys();
    const ts = "1700000007";
    const body = "{}";
    const sig = await sign(priv, ts, body);
    const res = await verifyTelnyxSignature(
      { "telnyx-signature-ed25519": sig, "telnyx-timestamp": ts },
      body,
      "definitely-not-a-key",
    );
    expect(res).toBe<SigResult>("error");
  });

  it("returns error for malformed base64 signature bytes", async () => {
    const { rawB64 } = await makeKeys();
    const res = await verifyTelnyxSignature(
      { "telnyx-signature-ed25519": "!!!not-base64!!!", "telnyx-timestamp": "1700000008" },
      "{}",
      rawB64,
    );
    expect(res).toBe<SigResult>("error");
  });
});

describe("isFresh", () => {
  const NOW = 1_700_000_000;

  it("accepts a timestamp within the skew", () => {
    expect(isFresh(String(NOW - 300), NOW)).toBe(true);
    expect(isFresh(String(NOW + 300), NOW)).toBe(true);
    expect(isFresh(String(NOW), NOW)).toBe(true);
  });

  it("rejects a 301 s skew", () => {
    expect(isFresh(String(NOW - 301), NOW)).toBe(false);
    expect(isFresh(String(NOW + 301), NOW)).toBe(false);
  });

  it("rejects a null header", () => {
    expect(isFresh(null, NOW)).toBe(false);
  });

  it("rejects a non-numeric header", () => {
    expect(isFresh("yesterday", NOW)).toBe(false);
    expect(isFresh("", NOW)).toBe(false);
  });
});
