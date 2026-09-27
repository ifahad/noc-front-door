import { digitsOf } from "../../../shared/src/itsm";
import { kvKey } from "../../../shared/src/kvkeys";
import type { Contact } from "../../../shared/src/types";
import type { SeedAdapter } from "../../../shared/src/itsm";
import { logEvent } from "../log";
import type { Flags } from "./flags";
import type { KvPort } from "./kvPort";

export const E164 = /^\+[0-9]{8,15}$/;

export interface DirectoryDeps {
  kv: KvPort;
  adapter: SeedAdapter;
  flags?: Flags;
}

export async function lookup(
  deps: DirectoryDeps,
  endUserTarget: string | null | undefined,
): Promise<Contact | null> {
  const target = typeof endUserTarget === "string" ? endUserTarget : "";
  if (!E164.test(target)) {
    const demoId = deps.flags?.demo_caller ?? null;
    if (demoId === null) {
      logLookup("none", false);
      return null;
    }
    const demo = await deps.adapter.findContactById(demoId);
    if (demo === null) {
      logLookup("none", false);
      return null;
    }
    logLookup("demo_flag", true);
    return demo;
  }
  const digits = digitsOf(target);
  // The SeedAdapter is in-memory, so it is the hot path: consult it before
  // touching KV (~1.5 s per read on this account). The KV cache get remains
  // only as a fallback for a future remote system of record.
  const fromAdapter = await deps.adapter.findContactByPhone(digits);
  if (fromAdapter !== null) {
    logLookup("adapter", true);
    return fromAdapter;
  }
  const cached = await deps.kv.get(kvKey("dir", digits));
  const contact = cached !== null ? parseContact(cached) : null;
  logLookup(contact !== null ? "kv" : "none", contact !== null);
  return contact;
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
