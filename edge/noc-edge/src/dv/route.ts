import type { Contact } from "../../../shared/src/types";
import type { Flags } from "../services/flags";

export interface RouteHintInput {
  sessionWritten: boolean;
  flags: Flags;
  contact: Contact | null;
  incident: { id: string } | null;
}

export function routeHint(input: RouteHintInput): "unverified" | "known_incident" | "verified" {
  if (!input.sessionWritten) return "unverified";
  if (input.flags.require_pin) return "unverified";
  if (input.contact === null) return "unverified";
  if (input.flags.deflection_enabled && input.incident !== null) return "known_incident";
  return "verified";
}
