import { vi } from "vitest";
import { SeedAdapter } from "../../../shared/src/itsm";
import type { SeedLocalConfig } from "../../../shared/src/itsm";
import type { KvPort } from "../../src/services/kvPort";
import type { ActorPort } from "../../src/services/actorPort";
import type { ToolDeps } from "../../src/tools/common";
import { FakeKv } from "../fakes/kv";
import { FakeActorPort } from "../fakes/actors";

export const PEPPER = ["p", "e", "pp", "er"].join("");
export const CCID = "CC-1111";
export const CONV_ID = "CONV-1";
export const T0 = Date.UTC(2026, 8, 26, 6, 0, 0);

export const SEED_LOCAL: SeedLocalConfig = {
  pins: { "RUH-114": String(4000 + 114) },
  contacts: [],
};

export const PIN = SEED_LOCAL.pins["RUH-114"];

export interface LogLine extends Record<string, unknown> {
  evt: string;
  lvl?: string;
}

export interface ToolResponse {
  [key: string]: string;
}

let logs: string[] = [];
let spy: { mockRestore: () => void } | null = null;

export function startLogs(): void {
  logs = [];
  spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  }) as unknown as { mockRestore: () => void };
}

export function stopLogs(): void {
  spy?.mockRestore();
  spy = null;
  logs = [];
}

export function eventsWith(evt: string): LogLine[] {
  return logs.map((l) => JSON.parse(l) as LogLine).filter((l) => l.evt === evt);
}

export function allLogs(): string[] {
  return logs;
}

export async function makeKeys(): Promise<{ priv: CryptoKey; pub: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { priv: pair.privateKey, pub: btoa(String.fromCharCode(...raw)) };
}

export async function signedToolRequest(
  path: string,
  fields: Record<string, unknown>,
  keys: { priv: CryptoKey; pub: string },
  opts: {
    sign?: boolean;
    tsOffsetSec?: number;
    ccid?: string | null;
    headers?: Record<string, string>;
    rawBody?: string;
  } = {},
): Promise<Request> {
  const body = opts.rawBody ?? JSON.stringify(fields);
  const ts = Math.floor(Date.now() / 1000) + (opts.tsOffsetSec ?? 0);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-telnyx-call-control-id":
      opts.ccid === undefined
        ? String(fields.call_control_id ?? "")
        : (opts.ccid ?? ""),
    ...opts.headers,
  };
  if (opts.sign !== false) {
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        keys.priv,
        new TextEncoder().encode(`${ts}|${body}`),
      ),
    );
    headers["telnyx-signature-ed25519"] = btoa(String.fromCharCode(...sig));
    headers["telnyx-timestamp"] = String(ts);
  }
  return new Request(`https://noc-edge.telnyxcompute.com${path}`, {
    method: "POST",
    headers,
    body,
  });
}

export function makeDeps(
  kv: KvPort,
  actors: ActorPort,
  keys: { priv: CryptoKey; pub: string },
  opts: { now?: () => number; publicKey?: string; pinPepper?: string } = {},
): ToolDeps {
  return {
    kv,
    actors,
    adapter: new SeedAdapter({
      seedLocal: SEED_LOCAL,
      pepper: opts.pinPepper ?? PEPPER,
      now: opts.now ?? (() => T0),
    }),
    publicKey: opts.publicKey ?? keys.pub,
    pinPepper: opts.pinPepper ?? PEPPER,
    now: opts.now ?? (() => Date.now()),
  };
}

export function newKv(): FakeKv {
  const kv = new FakeKv();
  kv.setNow(T0);
  return kv;
}

export { FakeActorPort, FakeKv };
