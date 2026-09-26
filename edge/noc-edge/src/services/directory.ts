import { digitsOf } from "../../../shared/src/itsm";
import { kvKey } from "../../../shared/src/kvkeys";
import type { Contact } from "../../../shared/src/types";
import type { SeedAdapter } from "../../../shared/src/itsm";
import { logEvent } from "../log";
import type { Flags } from "./flags";
import type { KvPort } from "./kvPort";

const DIR_TTL_SECONDS = 300;
const E164 = /^\+[0-9]{8,15}$/;

export interface DirectoryDeps {
  kv: KvPort;
  adapter: SeedAdapter;
  flags: Flags;
}

export async function lookup(
  deps: DirectoryDeps,
  endUserTarget: string | null | undefined,
): Promise<Contact | null> {
  const target = typeof endUserTarget === "string" ? endUserTarget : "";
  if (!E164.test(target)) {
    if (deps.flags.demo_caller === null) {
      logLookup("none", false);
      return null;
    }
    const demo = await deps.adapter.findContactById(deps.flags.demo_caller);
    if (demo === null) {
      logLookup("none", false);
      return null;
    }
    logLookup("demo_flag", true);
    return demo;
  }
  const digits = digitsOf(target);
  const key = kvKey("dir", digits);
  const cached = await deps.kv.get(key);
  if (cached !== null) {
    const contact = parseContact(cached);
    if (contact !== null) {
      logLookup("kv", true);
      return contact;
    }
  }
  const fromAdapter = await deps.adapter.findContactByPhone(digits);
  if (fromAdapter === null) {
    logLookup("none", false);
    return null;
  }
  await deps.kv.put(key, JSON.stringify(fromAdapter), {
    expirationTtl: DIR_TTL_SECONDS,
  });
  logLookup("adapter", true);
  return fromAdapter;
}

function logLookup(source: "kv" | "adapter" | "demo_flag" | "none", found: boolean): void {
  logEvent("dir.lookup", {
    hop: "services/directory",
    source,
    found,
    outcome: "ok",
  });
}

function parseContact(raw: string): Contact | null {
  try {
    const value = JSON.parse(raw) as Contact;
    return typeof value?.contact_id === "string" && value.contact_id.length > 0
      ? value
      : null;
  } catch {
    return null;
  }
}
