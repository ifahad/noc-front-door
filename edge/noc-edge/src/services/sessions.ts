import { traceId } from "../../../shared/src/ids";
import { kvKey } from "../../../shared/src/kvkeys";
import type { Session } from "../../../shared/src/types";
import type { KvPort } from "./kvPort";

export const SESSION_TTL_SECONDS = 3600;

export interface DvSession {
  trace_id: string;
  identified: boolean;
  contact_id: string | null;
  customer_id: string | null;
  sites: string[];
  region: string | null;
}

export interface AuthSession {
  verified: true;
  site_id: string;
  customer_id: string;
  at: number;
}

const DEFAULT_DV: DvSession = {
  trace_id: "none",
  identified: false,
  contact_id: null,
  customer_id: null,
  sites: [],
  region: null,
};

export async function putDv(
  kv: KvPort,
  k: string,
  dv: DvSession,
): Promise<void> {
  await kv.put(kvKey("call", k, "dv"), JSON.stringify(dv), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

export async function putAuth(
  kv: KvPort,
  k: string,
  auth: AuthSession,
): Promise<void> {
  await kv.put(kvKey("call", k, "auth"), JSON.stringify(auth), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

export async function get(kv: KvPort, k: string): Promise<Session> {
  const [dvRaw, authRaw] = await Promise.all([
    kv.get(kvKey("call", k, "dv")),
    kv.get(kvKey("call", k, "auth")),
  ]);
  const dv = parseDv(dvRaw) ?? { ...DEFAULT_DV, trace_id: traceId(k) };
  const auth = parseAuth(authRaw);
  return {
    k,
    trace_id: dv.trace_id,
    identified: dv.identified,
    verified: auth !== null,
    contact_id: dv.contact_id,
    customer_id: auth?.customer_id ?? dv.customer_id,
    sites: auth ? [auth.site_id] : dv.sites,
    region: dv.region,
  };
}

export async function linkConversation(
  kv: KvPort,
  convId: string,
  k: string,
): Promise<void> {
  await kv.put(kvKey("conv", convId), k, {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

export async function byConversation(
  kv: KvPort,
  convId: string,
): Promise<string | null> {
  const k = await kv.get(kvKey("conv", convId));
  return typeof k === "string" && k.length > 0 ? k : null;
}

function parseDv(raw: string | null): DvSession | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<DvSession>;
    if (typeof value.trace_id !== "string" || value.trace_id.length === 0) {
      return null;
    }
    return {
      trace_id: value.trace_id,
      identified: value.identified === true,
      contact_id: typeof value.contact_id === "string" ? value.contact_id : null,
      customer_id: typeof value.customer_id === "string" ? value.customer_id : null,
      sites: Array.isArray(value.sites)
        ? value.sites.filter((s): s is string => typeof s === "string")
        : [],
      region: typeof value.region === "string" ? value.region : null,
    };
  } catch {
    return null;
  }
}

function parseAuth(raw: string | null): AuthSession | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<AuthSession>;
    if (value.verified !== true) return null;
    if (typeof value.site_id !== "string" || value.site_id.length === 0) return null;
    if (typeof value.customer_id !== "string" || value.customer_id.length === 0) return null;
    if (typeof value.at !== "number") return null;
    return { verified: true, site_id: value.site_id, customer_id: value.customer_id, at: value.at };
  } catch {
    return null;
  }
}
