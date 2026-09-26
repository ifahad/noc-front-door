import type { Impact, Priority } from "./types";

export function classify(impact: Impact, serviceAffecting: boolean): Priority {
  if (impact === "site_down") return "P2";
  if (impact === "degraded") return serviceAffecting ? "P3" : "P4";
  return "P4";
}

export function responseTargetMinutes(priority: Priority): number {
  switch (priority) {
    case "P1":
      return 15;
    case "P2":
      return 30;
    case "P3":
      return 240;
    case "P4":
      return 1440;
  }
}
