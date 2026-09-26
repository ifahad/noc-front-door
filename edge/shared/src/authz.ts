import type { Session, Site } from "./types";
import { siteCodeOfTicket } from "./ids";

export function canRead(session: Session, site: Site): boolean {
  return session.customer_id !== null && site.customer_id === session.customer_id;
}

export function canWrite(session: Session, siteId: string): boolean {
  return session.sites.includes(siteId) && (session.verified || session.identified);
}

export function siteForTicket(ticketId: string, sites: Site[]): Site | null {
  const code = siteCodeOfTicket(ticketId);
  if (code === null) return null;
  return sites.find((s) => s.code === code) ?? null;
}
