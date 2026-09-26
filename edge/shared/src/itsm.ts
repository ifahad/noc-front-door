import type { Contact, Site } from "./types";
import { constantTimeEqual } from "./ids";
import { NMS_BY_REGION, NMS_DOWN_LOCAL_HOUR, NMS_DOWN_LOCAL_MINUTE, CONTACT_SEED, SITES } from "./seed";
import { riyadhTimeToday } from "./readback";

export interface NmsStatus {
  state: "up" | "down" | "degraded";
  since: number | null;
  alarms: string[];
  device: string;
}

export interface OnCall {
  name: string;
  number: string | null;
}

export interface SeedLocalContact {
  contact_id: string;
  phone_digits: string | null;
  name?: string;
  site_id?: string;
  preferred_language?: "en" | "ar";
}

export interface SeedLocalConfig {
  pins: Record<string, string>;
  contacts: SeedLocalContact[];
}

export interface SeedAdapterOptions {
  seedLocal: SeedLocalConfig;
  pepper: string;
  now?: () => number;
}

export interface ItsmAdapter {
  findContactByPhone(digits: string): Promise<Contact | null>;
  findContactById(contactId: string): Promise<Contact | null>;
  getSite(siteId: string): Promise<Site | null>;
  listSites(customerId: string): Promise<Site[]>;
  resolveSite(description: string, customerId: string): Promise<Site | null>;
  resolveSiteGlobal(description: string): Promise<Site | null>;
  pinHashFor(siteId: string): Promise<string | null>;
  checkPin(pin: string, siteId: string): Promise<boolean>;
  getNmsStatus(siteId: string): Promise<NmsStatus>;
  getOnCall(): Promise<OnCall>;
}

export function digitsOf(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

const DIGIT_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};

function compact(description: string): string {
  const lowered = description.toLowerCase();
  const wordToDigit = lowered.replace(
    /\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/g,
    (w) => DIGIT_WORDS[w],
  );
  return wordToDigit.replace(/[^a-z0-9]/g, "");
}

function idMatcher(site: Site): RegExp {
  const compactId = site.site_id.toLowerCase().replace(/[^a-z0-9]/g, "");
  return new RegExp(`${compactId}(?![0-9])`);
}

function labelKeywords(site: Site): string[] {
  let name = site.label;
  if (name.startsWith("the ")) name = name.slice(4);
  if (name.endsWith(" branch")) name = name.slice(0, -" branch".length);
  return name
    .split(/\s+/)
    .filter((token) => token.length >= 4)
    .map((token) => token.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((token) => token !== "");
}

const UP: NmsStatus = { state: "up", since: null, alarms: [], device: "" };

export class SeedAdapter implements ItsmAdapter {
  private readonly seedLocal: SeedLocalConfig;
  private readonly pepper: string;
  private readonly nowFn: () => number;
  private hmacKey: Promise<CryptoKey> | null = null;

  constructor(options: SeedAdapterOptions) {
    this.seedLocal = options.seedLocal;
    this.pepper = options.pepper;
    this.nowFn = options.now ?? (() => Date.now());
  }

  private customerName(customerId: string): string {
    return customerId === "c-alwaha" ? "Al-Waha Pharmacies" : "Rawda Cafés";
  }

  private enrich(
    contactId: string,
    base: { name: string; customer_id: string; site_id: string; preferred_language: "en" | "ar" },
    override: SeedLocalContact | undefined,
  ): Contact {
    const siteId = override?.site_id ?? base.site_id;
    const site = SITES.find((s) => s.site_id === siteId);
    return {
      contact_id: contactId,
      name: override?.name ?? base.name,
      customer_id: base.customer_id,
      customer_name: this.customerName(base.customer_id),
      site_id: siteId,
      site_label: site?.label ?? siteId,
      region: site?.region ?? "",
      region_label: site?.region_label ?? "",
      preferred_language: override?.preferred_language ?? base.preferred_language,
    };
  }

  async findContactByPhone(digits: string): Promise<Contact | null> {
    const wanted = digitsOf(digits);
    if (wanted === "") return null;
    const match = this.seedLocal.contacts.find(
      (c) => c.phone_digits !== null && digitsOf(c.phone_digits) === wanted,
    );
    if (!match) return null;
    return this.findContactById(match.contact_id);
  }

  async findContactById(contactId: string): Promise<Contact | null> {
    const seedContact = CONTACT_SEED.find((c) => c.contact_id === contactId);
    const override = this.seedLocal.contacts.find((c) => c.contact_id === contactId);
    if (seedContact) {
      return this.enrich(contactId, seedContact, override);
    }
    if (!override) return null;
    const site = override.site_id
      ? SITES.find((s) => s.site_id === override.site_id)
      : undefined;
    return {
      contact_id: override.contact_id,
      name: override.name ?? "",
      customer_id: site?.customer_id ?? "",
      customer_name: site ? this.customerName(site.customer_id) : "",
      site_id: override.site_id ?? "",
      site_label: site?.label ?? "",
      region: site?.region ?? "",
      region_label: site?.region_label ?? "",
      preferred_language: override.preferred_language ?? "en",
    };
  }

  async getSite(siteId: string): Promise<Site | null> {
    return SITES.find((s) => s.site_id === siteId) ?? null;
  }

  async listSites(customerId: string): Promise<Site[]> {
    return SITES.filter((s) => s.customer_id === customerId && !s.hidden);
  }

  async resolveSite(description: string, customerId: string): Promise<Site | null> {
    const text = compact(description);
    if (text === "") return null;
    const candidates = SITES.filter(
      (s) => s.customer_id === customerId && !s.hidden,
    );
    for (const site of candidates) {
      if (idMatcher(site).test(text)) return site;
    }
    for (const site of candidates) {
      if (labelKeywords(site).some((keyword) => text.includes(keyword))) return site;
    }
    return null;
  }

  async resolveSiteGlobal(description: string): Promise<Site | null> {
    const wanted = description.trim().toUpperCase();
    if (wanted !== "") {
      for (const site of SITES) {
        if (site.hidden) continue;
        if (site.site_id.toUpperCase() === wanted) return site;
      }
    }
    const text = compact(description);
    if (text === "") return null;
    for (const site of SITES) {
      if (site.hidden) continue;
      if (idMatcher(site).test(text)) return site;
    }
    return null;
  }

  private async hmac(payload: string): Promise<string> {
    if (this.hmacKey === null) {
      this.hmacKey = crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(this.pepper),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    }
    const key = await this.hmacKey;
    const digest = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payload),
    );
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async pinHashFor(siteId: string): Promise<string | null> {
    const pin = this.seedLocal.pins[siteId];
    if (pin === undefined) return null;
    const digits = digitsOf(pin);
    if (digits === "") return null;
    return this.hmac(`${siteId}|${digits}`);
  }

  async checkPin(pin: string, siteId: string): Promise<boolean> {
    const candidate = digitsOf(pin);
    if (candidate === "") return false;
    const site = SITES.find((s) => s.site_id === siteId);
    if (!site) return false;
    const configured = this.seedLocal.pins[siteId];
    if (configured === undefined) return false;
    const configuredDigits = digitsOf(configured);
    if (configuredDigits === "") return false;
    const candidateHash = await this.hmac(`${siteId}|${candidate}`);
    const configuredHash = await this.hmac(`${siteId}|${configuredDigits}`);
    return constantTimeEqual(candidateHash, configuredHash);
  }

  async getNmsStatus(siteId: string): Promise<NmsStatus> {
    const site = SITES.find((s) => s.site_id === siteId);
    const template = site ? NMS_BY_REGION[site.region] : undefined;
    if (!template) return UP;
    if (template.state !== "down") {
      return { state: template.state, since: null, alarms: template.alarms, device: template.device };
    }
    return {
      state: template.state,
      since: riyadhTimeToday(NMS_DOWN_LOCAL_HOUR, NMS_DOWN_LOCAL_MINUTE, this.nowFn()),
      alarms: template.alarms,
      device: template.device,
    };
  }

  async getOnCall(): Promise<OnCall> {
    return { name: "On-call engineer", number: null };
  }
}
