import { getSecret, type SecretsLike } from "../env";

// The demo guide is an Edge secret (DEMO_GUIDE) so no PIN literal ever lives
// in source control. Anything invalid falls back to null, and the page then
// points the reviewer at the README guide instead of rendering PINs.
export type GuideScenarioKey = "join" | "new";

export interface GuideScenario {
  key: GuideScenarioKey;
  site: string;
  pin: string;
}

export interface DemoGuide {
  scenarios: GuideScenario[];
}

const SITE_RE = /^[A-Z]{3}-\d{3}$/;
const PIN_RE = /^\d{4}$/;
const KEYS: readonly GuideScenarioKey[] = ["join", "new"];

export function parseDemoGuide(raw: string | null): DemoGuide | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const scenariosRaw = (parsed as Record<string, unknown>).scenarios;
  if (!Array.isArray(scenariosRaw)) return null;
  const scenarios: GuideScenario[] = [];
  for (const entry of scenariosRaw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const { key, site, pin } = entry as Record<string, unknown>;
    if (typeof key !== "string" || !(KEYS as readonly string[]).includes(key)) return null;
    if (typeof site !== "string" || !SITE_RE.test(site)) return null;
    if (typeof pin !== "string" || !PIN_RE.test(pin)) return null;
    scenarios.push({ key: key as GuideScenarioKey, site, pin });
  }
  return { scenarios };
}

export async function loadDemoGuide(env: SecretsLike): Promise<DemoGuide | null> {
  return parseDemoGuide(await getSecret(env, "DEMO_GUIDE"));
}
