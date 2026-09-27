export type Priority = "P1" | "P2" | "P3" | "P4";
export type Impact = "site_down" | "degraded" | "single_user";

export interface Contact {
  contact_id: string;
  name: string;
  customer_id: string;
  customer_name: string;
  site_id: string;
  site_label: string;
  region: string;
  region_label: string;
  preferred_language: "en" | "ar";
}

export interface Site {
  site_id: string;
  code: string; // 2 digits
  customer_id: string;
  label: string;
  region: string;
  region_label: string;
  hidden?: boolean;
}

export interface Ticket {
  id: string;
  priority: Priority;
  impact: Impact;
  serviceAffecting: boolean;
  symptom: string;
  openedAt: number;
  regionReported: boolean;
  reporters: { callerRef: string; k: string; at: number }[];
  notes: { at: number; text: string; k: string }[];
}

export interface EscState {
  level: number;
  dueAt: number;
  acked: boolean;
}

export interface Incident {
  id: string;
  version: number;
  declaredAt: number;
  priority: "P1" | "P2";
  sites: Record<string, { ticketId: string; at: number }>;
  nextUpdateAt: number;
  ackAt: number | null;
  pageSeq: number;
  esc: EscState | null;
  pages: { id: string; claimedBy: string | null; sentAt: number | null }[];
}

export interface Session {
  k: string;
  trace_id: string;
  identified: boolean;
  verified: boolean;
  contact_id: string | null;
  customer_id: string | null;
  sites: string[];
  region: string | null;
}
