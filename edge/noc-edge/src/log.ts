import { logEvent as sharedLogEvent, type LogLevel } from "../../shared/src/log";

export type LogLine = {
  ts: string;
  lvl: string;
  svc: string;
  evt: string;
} & Record<string, unknown>;

export function logEvent(evt: string, fields: Record<string, unknown> = {}): void {
  const { hop, lvl, ...rest } = fields;
  sharedLogEvent({
    svc: "noc-edge",
    hop: typeof hop === "string" && hop.length > 0 ? hop : "none",
    evt,
    ...(typeof lvl === "string" ? { lvl: lvl as LogLevel } : {}),
    ...rest,
  });
}
