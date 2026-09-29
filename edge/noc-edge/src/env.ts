import { SeedAdapter } from "../../shared/src/itsm";
import type {
  SeedAdapterOptions,
  SeedLocalConfig,
  SeedLocalContact,
} from "../../shared/src/itsm";
import { makeTokenCache, type SecretGetter } from "./auth";
import { logEvent } from "./log";

export type SecretName = Parameters<Env["SECRETS"]["get"]>[0];
export type SecretsLike = Pick<Env, "SECRETS">;

const secretGetters = new WeakMap<SecretsLike, Map<string, SecretGetter>>();
const inFlightReads = new WeakMap<
  SecretsLike,
  Map<string, Promise<string | null>>
>();

const SECRET_ATTEMPTS = 3;
const SECRET_BACKOFF_MS = [50, 100] as const;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// One retry loop per (env, secret name): concurrent callers await the same
// in-flight read instead of hammering the store, and it is cleared when it
// settles. A read fails when SECRETS.get throws or returns an empty or
// non-string value; it is retried up to SECRET_ATTEMPTS times with 50 ms
// then 100 ms backoff. There is deliberately no per-attempt timeout: a
// normal SECRETS.get on this platform takes longer than 150 ms. Only the
// last attempt's error is rethrown, so callers can still tell a failed
// store from a missing or empty secret.
async function readSecretWithRetry(
  env: SecretsLike,
  name: SecretName,
): Promise<string | null> {
  let byName = inFlightReads.get(env);
  if (byName === undefined) {
    byName = new Map<string, Promise<string | null>>();
    inFlightReads.set(env, byName);
  }
  const existing = byName.get(name);
  if (existing !== undefined) return existing;
  const pending = (async () => {
    let lastAttemptError: unknown = null;
    for (let attempt = 1; attempt <= SECRET_ATTEMPTS; attempt += 1) {
      lastAttemptError = null;
      let error = "empty";
      try {
        const raw = await env.SECRETS.get(name);
        if (typeof raw === "string" && raw.length > 0) {
          if (attempt > 1) {
            logEvent("secret.read_recovered", {
              hop: "env",
              secret_name: name,
              attempts: attempt,
            });
          }
          return raw;
        }
      } catch (err) {
        lastAttemptError = err;
        error =
          err instanceof Error && err.message.length > 0
            ? err.message
            : "error";
      }
      logEvent("secret.read_failed", {
        hop: "env",
        lvl: "warn",
        secret_name: name,
        attempt,
        outcome: "error",
        error,
      });
      if (attempt < SECRET_ATTEMPTS) {
        await sleep(
          SECRET_BACKOFF_MS[attempt - 1] ??
            SECRET_BACKOFF_MS[SECRET_BACKOFF_MS.length - 1],
        );
      }
    }
    if (lastAttemptError !== null) throw lastAttemptError;
    return null;
  })();
  byName.set(name, pending);
  try {
    return await pending;
  } finally {
    if (byName.get(name) === pending) byName.delete(name);
  }
}

export function getSecret(
  env: SecretsLike,
  name: SecretName,
): Promise<string | null> {
  let byName = secretGetters.get(env);
  if (byName === undefined) {
    byName = new Map<string, SecretGetter>();
    secretGetters.set(env, byName);
  }
  let get = byName.get(name);
  if (get === undefined) {
    get = makeTokenCache(async () => {
      try {
        return await readSecretWithRetry(env, name);
      } catch {
        return null;
      }
    });
    byName.set(name, get);
  }
  return get();
}

const DEFAULT_SEED_LOCAL: SeedLocalConfig = { pins: {}, contacts: [] };
const seedLocalCache = new WeakMap<SecretsLike, SeedLocalConfig>();

// A missing or unparsable SEED_LOCAL silently disables every verify_site PIN
// (checkPin fails for all sites), so surface it once per isolate — never the
// value itself. The deep-health config check reports the same failure.
const seedLocalInvalidLogged = new WeakMap<SecretsLike, boolean>();

function reportSeedLocalInvalid(env: SecretsLike, reason: string): void {
  if (seedLocalInvalidLogged.get(env) === true) return;
  seedLocalInvalidLogged.set(env, true);
  logEvent("config.seed_local_invalid", {
    hop: "env",
    lvl: "error",
    outcome: "error",
    reason,
  });
}

export async function loadSeedLocal(env: SecretsLike): Promise<SeedLocalConfig> {
  const cached = seedLocalCache.get(env);
  if (cached !== undefined) return cached;
  let raw: string | null;
  try {
    raw = await readSecretWithRetry(env, "SEED_LOCAL");
  } catch {
    reportSeedLocalInvalid(env, "read_failed");
    return DEFAULT_SEED_LOCAL;
  }
  if (raw === null) {
    reportSeedLocalInvalid(env, "missing");
    return DEFAULT_SEED_LOCAL;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    reportSeedLocalInvalid(env, "unparsable");
    return DEFAULT_SEED_LOCAL;
  }
  const config = normaliseSeedLocal(parsed);
  seedLocalCache.set(env, config);
  return config;
}

function normaliseSeedLocal(value: unknown): SeedLocalConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_SEED_LOCAL;
  }
  const record = value as Record<string, unknown>;
  const pins: Record<string, string> = {};
  const rawPins = record.pins;
  if (rawPins !== null && typeof rawPins === "object" && !Array.isArray(rawPins)) {
    for (const [siteId, pin] of Object.entries(rawPins)) {
      if (typeof pin === "string" && pin.length > 0) pins[siteId] = pin;
    }
  }
  const contacts: SeedLocalContact[] = [];
  const rawContacts = record.contacts;
  if (Array.isArray(rawContacts)) {
    for (const raw of rawContacts) {
      if (raw === null || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.contact_id !== "string" || entry.contact_id.length === 0) {
        continue;
      }
      contacts.push({
        contact_id: entry.contact_id,
        phone_digits:
          typeof entry.phone_digits === "string" && entry.phone_digits.length > 0
            ? entry.phone_digits
            : null,
        name: typeof entry.name === "string" ? entry.name : undefined,
        site_id: typeof entry.site_id === "string" ? entry.site_id : undefined,
        preferred_language:
          entry.preferred_language === "ar" ? "ar" : entry.preferred_language === "en" ? "en" : undefined,
      });
    }
  }
  return { pins, contacts };
}

const adapterCache = new WeakMap<SecretsLike, SeedAdapter>();

export async function makeAdapter(env: SecretsLike): Promise<SeedAdapter> {
  const cached = adapterCache.get(env);
  if (cached !== undefined) return cached;
  const [pepper, seedLocal] = await Promise.all([
    getSecret(env, "PIN_PEPPER"),
    loadSeedLocal(env),
  ]);
  const options: SeedAdapterOptions = {
    seedLocal,
    pepper: pepper ?? "",
  };
  const adapter = new SeedAdapter(options);
  if (pepper !== null) adapterCache.set(env, adapter);
  return adapter;
}
