import { describe, expect, it } from "vitest";
import { verifySigned } from "../../src/lib/signed";
import { makeKeys } from "./helpers";

const BODY = JSON.stringify({ hello: "world" });

async function requestWith(
  keys: { priv: CryptoKey; pub: string },
  opts: { sign?: boolean; tsOffsetSec?: number } = {},
): Promise<Request> {
  const ts = Math.floor(Date.now() / 1000) + (opts.tsOffsetSec ?? 0);
  const headers: Record<string, string> = {};
  if (opts.sign !== false) {
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        keys.priv,
        new TextEncoder().encode(`${ts}|${BODY}`),
      ),
    );
    headers["telnyx-signature-ed25519"] = btoa(String.fromCharCode(...sig));
    headers["telnyx-timestamp"] = String(ts);
  }
  return new Request("https://noc-edge.telnyxcompute.com/tools/x", {
    method: "POST",
    headers,
    body: BODY,
  });
}

describe("verifySigned", () => {
  it("accepts a fresh valid signature", async () => {
    const keys = await makeKeys();
    const result = await verifySigned(
      await requestWith(keys),
      BODY,
      keys.pub,
      Date.now(),
    );
    expect(result).toBe("ok");
  });

  it("rejects an absent signature", async () => {
    const keys = await makeKeys();
    const result = await verifySigned(
      await requestWith(keys, { sign: false }),
      BODY,
      keys.pub,
      Date.now(),
    );
    expect(result).toBe("absent");
  });

  it("rejects an invalid signature", async () => {
    const keys = await makeKeys();
    const other = await makeKeys();
    const result = await verifySigned(
      await requestWith(other),
      BODY,
      keys.pub,
      Date.now(),
    );
    expect(result).toBe("invalid");
  });

  it("rejects a stale timestamp", async () => {
    const keys = await makeKeys();
    const result = await verifySigned(
      await requestWith(keys, { tsOffsetSec: -1000 }),
      BODY,
      keys.pub,
      Date.now(),
    );
    expect(result).toBe("stale");
  });

  it("fails closed when no public key is configured", async () => {
    const keys = await makeKeys();
    const result = await verifySigned(
      await requestWith(keys),
      BODY,
      "",
      Date.now(),
    );
    expect(result).toBe("no_key");
  });
});
