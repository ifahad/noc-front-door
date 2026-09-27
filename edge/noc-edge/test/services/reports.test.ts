import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KvPort } from "../../src/services/kvPort";
import {
  LAST_REPORT_KEY,
  REPORT_KEY_RE,
  REPORT_PREFIX,
  buildIncidentReport,
  lastReportPointerOf,
  listReports,
  readLastReport,
  readReport,
  reportKey,
  writeLastReportPointer,
  writeReport,
  type IncidentReport,
  type ReportBucket,
  type ReportIncident,
} from "../../src/services/reports";
import { FakeBucket } from "../fakes/bucket";
import { FakeKv } from "../fakes/kv";

const T0 = Date.UTC(2026, 8, 27, 6, 0, 0);

function fixtureIncident(): ReportIncident {
  return {
    id: "INC-1001",
    version: 3,
    declaredAt: T0,
    priority: "P1",
    sites: {
      "RUH-133": { ticketId: "NJD-3301", at: T0 },
      "RUH-121": { ticketId: "NJD-2101", at: T0 + 1000 },
    },
    nextUpdateAt: T0 + 1_800_000,
    ackAt: T0 + 45_000,
    pageSeq: 2,
    esc: { level: 2, dueAt: T0 + 120_000, acked: true },
    pages: [
      { id: "INC-1001:p1", level: 1, created_at: T0 + 120_000, sentAt: T0 + 121_000 },
      { id: "INC-1001:p2", level: 2, created_at: T0 + 240_000, sentAt: null },
    ],
  };
}

function build(overrides: Partial<Parameters<typeof buildIncidentReport>[0]> = {}): IncidentReport {
  return buildIncidentReport({
    region: "riyadh-north",
    regionLabel: "Riyadh North",
    incident: fixtureIncident(),
    resolvedAt: T0 + 90_000,
    trace_id: "t-ops-1",
    ...overrides,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("buildIncidentReport", () => {
  it("produces the noc.incident-report/1 shape from the actor incident", () => {
    const report = build();
    expect(Object.keys(report).sort()).toEqual(
      [
        "schema",
        "incident_id",
        "region",
        "region_label",
        "priority",
        "declared_at",
        "resolved_at",
        "duration_s",
        "sites",
        "branches",
        "escalation",
        "pages",
        "trace_ids",
      ].sort(),
    );
    expect(report.schema).toBe("noc.incident-report/1");
    expect(report.incident_id).toBe("INC-1001");
    expect(report.region).toBe("riyadh-north");
    expect(report.region_label).toBe("Riyadh North");
    expect(report.priority).toBe("P1");
    expect(report.declared_at).toBe("2026-09-27T06:00:00.000Z");
    expect(report.resolved_at).toBe("2026-09-27T06:01:30.000Z");
    expect(report.duration_s).toBe(90);
    expect(report.branches).toBe(2);
    expect(report.sites).toEqual([
      { site_id: "RUH-121", ticket_id: "NJD-2101", priority: "P1", opened_at: "2026-09-27T06:00:01.000Z" },
      { site_id: "RUH-133", ticket_id: "NJD-3301", priority: "P1", opened_at: "2026-09-27T06:00:00.000Z" },
    ]);
    expect(report.escalation).toEqual({
      levels_reached: 2,
      acked: true,
      acked_at: "2026-09-27T06:00:45.000Z",
      time_to_ack_s: 45,
    });
    expect(report.pages).toEqual([
      { id: "INC-1001:p1", level: 1, created_at: "2026-09-27T06:02:00.000Z", sent_at: "2026-09-27T06:02:01.000Z" },
      { id: "INC-1001:p2", level: 2, created_at: "2026-09-27T06:04:00.000Z", sent_at: null },
    ]);
    expect(report.trace_ids).toEqual(["t-ops-1"]);
  });

  it("reports an unacked escalation with null ack fields", () => {
    const incident = fixtureIncident();
    incident.ackAt = null;
    incident.esc = { level: 1, dueAt: T0 + 300_000, acked: false };
    const report = build({ incident });
    expect(report.escalation).toEqual({
      levels_reached: 1,
      acked: false,
      acked_at: null,
      time_to_ack_s: null,
    });
  });

  it("maps a plain getIncident incident without page details to an empty page list", () => {
    const incident = fixtureIncident();
    incident.pages = [];
    const report = build({ incident });
    expect(report.pages).toEqual([]);
  });

  it("is JSON-serialisable", () => {
    const report = build();
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("never serialises pins, fingerprints, tokens, phones or caller names", () => {
    const phone = ["+9665", "0123", "4567"].join("");
    const pin = [String(48), String(21)].join("");
    const token = ["tok_", "sk-live-", "9f8e7d6c"].join("");
    const fingerprint = ["fp_", "a1b2", "c3d4"].join("");
    const dirty = JSON.parse(JSON.stringify(fixtureIncident())) as Record<string, unknown>;
    const sites = dirty.sites as Record<string, Record<string, unknown>>;
    sites["RUH-121"].caller_name = "Fahad Al-Najdi";
    sites["RUH-121"].phone = phone;
    sites["RUH-121"].pin = pin;
    sites["RUH-121"].pin_fingerprint = fingerprint;
    dirty.acked_by_token = token;
    dirty.reporter_phone = phone;
    dirty.escalation_caller = "Ops Duty Fahad";
    const report = build({ incident: dirty as unknown as ReportIncident });
    const serialized = JSON.stringify(report);
    for (const secret of [pin, phone, token, fingerprint, "Fahad", "+9665", "tok_"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe("reportKey", () => {
  it("derives incidents/<id>-<declared iso sans ms with dashes>.json", () => {
    const key = reportKey(build());
    expect(key).toBe("incidents/INC-1001-2026-09-27T06-00-00Z.json");
    expect(key.startsWith(REPORT_PREFIX)).toBe(true);
    expect(REPORT_KEY_RE.test(key)).toBe(true);
  });
});

describe("writeReport", () => {
  it("stores pretty-printed json with the application/json content type", async () => {
    const bucket = new FakeBucket();
    const report = build();
    const out = await writeReport(bucket, report);
    expect(out).toEqual({ ok: true, key: reportKey(report) });
    const raw = bucket.raw(out.key);
    expect(raw).not.toBeNull();
    expect((raw as string).startsWith("{\n")).toBe(true);
    expect(JSON.parse(raw as string)).toEqual(report);
    expect(bucket.contentTypeOf(out.key)).toBe("application/json");
  });

  it("logs one report.write_failed warn line and fails open", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    const bucket = new FakeBucket();
    bucket.failNextPut(1);
    const report = build();
    const out = await writeReport(bucket, report);
    expect(out).toEqual({ ok: false, key: reportKey(report) });
    const failed = logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.evt === "report.write_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].lvl).toBe("warn");
    expect(failed[0].outcome).toBe("error");
    expect(typeof failed[0].total_ms).toBe("number");
  });

  it("gives up after the 8 s deadline and reports the write as failed", async () => {
    vi.useFakeTimers();
    try {
      const bucket = new FakeBucket();
      bucket.putDelayMs = 9000;
      const pending = writeReport(bucket, build());
      await vi.advanceTimersByTimeAsync(8000);
      const out = await pending;
      expect(out.ok).toBe(false);
      expect(bucket.keys()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns ok:false with an empty key when no bucket is bound", async () => {
    const out = await writeReport(null, build());
    expect(out).toEqual({ ok: false, key: reportKey(build()) });
  });
});

describe("listReports", () => {
  function seed(bucket: FakeBucket, count: number): void {
    for (let i = 1; i <= count; i++) {
      const id = `INC-${String(1000 + i).padStart(4, "0")}`;
      bucket.setNow(Date.UTC(2026, 8, 27, 6, 0, i * 1000));
      bucket.put(`incidents/${id}-2026-09-27T06-00-00Z.json`, "{}");
    }
  }

  it("returns the newest 20 report keys with size and uploaded time", async () => {
    const bucket = new FakeBucket();
    seed(bucket, 25);
    const out = await listReports(bucket);
    expect(out.degraded).toBe(false);
    expect(out.reports).toHaveLength(20);
    expect(out.reports[0].key).toBe("incidents/INC-1025-2026-09-27T06-00-00Z.json");
    expect(out.reports[19].key).toBe("incidents/INC-1006-2026-09-27T06-00-00Z.json");
    for (const entry of out.reports) {
      expect(entry.size).toBe(2);
      expect(entry.uploaded).toBe(new Date(bucket.nowMs).toISOString());
    }
  });

  it("filters non-report keys", async () => {
    const bucket = new FakeBucket();
    bucket.put("incidents/INC-1001-2026-09-27T06-00-00Z.json", "{}");
    bucket.put("other/INC-1002-2026-09-27T06-00-00Z.json", "{}");
    bucket.put("incidents/sub/INC-1003-2026-09-27T06-00-00Z.json", "{}");
    bucket.put("incidents/INC-1004-2026-09-27T06-00-00Z.json.bak", "{}");
    const out = await listReports(bucket);
    expect(out.reports.map((r) => r.key)).toEqual(["incidents/INC-1001-2026-09-27T06-00-00Z.json"]);
  });

  it("degrades to an empty list when the bucket fails", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    const bucket = new FakeBucket();
    bucket.failNextList(1);
    const out = await listReports(bucket);
    expect(out).toEqual({ reports: [], degraded: true });
    expect(logs.some((l) => (JSON.parse(l) as Record<string, unknown>).evt === "report.list_failed")).toBe(true);
  });
});

describe("readReport", () => {
  it("reads back the stored json object", async () => {
    const bucket = new FakeBucket();
    const report = build();
    await writeReport(bucket, report);
    const out = await readReport(bucket, reportKey(report));
    expect(out.status).toBe("ok");
    expect(out.status === "ok" && out.report).toEqual(report);
  });

  it("reports missing objects", async () => {
    const out = await readReport(new FakeBucket(), "incidents/INC-9999-2026-09-27T06-00-00Z.json");
    expect(out.status).toBe("missing");
  });

  it("rejects keys outside the incidents/ namespace", async () => {
    const bucket = new FakeBucket();
    for (const key of [
      "other/x.json",
      "incidents/sub/x.json",
      "incidents/x.json.bak",
      "incidents/",
      "INC-1001.json",
    ]) {
      expect(await readReport(bucket, key)).toEqual({ status: "invalid_key" });
    }
  });

  it("reports storage errors as error", async () => {
    const bucket = new FakeBucket();
    bucket.failNextGet(1);
    const out = await readReport(bucket, "incidents/INC-1001-2026-09-27T06-00-00Z.json");
    expect(out.status).toBe("error");
  });
});

describe("last-report pointer", () => {
  it("writes and parses the pointer round trip", async () => {
    const kv = new FakeKv();
    const report = build();
    const key = reportKey(report);
    expect(await writeLastReportPointer(kv, report, key)).toBe(true);
    expect(kv.raw(LAST_REPORT_KEY)).toBe(
      JSON.stringify({ key, incident_id: report.incident_id, resolved_at: report.resolved_at }),
    );
    expect(await readLastReport(kv)).toEqual({
      key,
      incident_id: report.incident_id,
      resolved_at: report.resolved_at,
    });
  });

  it("parses malformed or absent pointers as null", async () => {
    expect(lastReportPointerOf(null)).toBeNull();
    expect(lastReportPointerOf("not json")).toBeNull();
    expect(lastReportPointerOf('{"key":"other/x.json","incident_id":"INC-1","resolved_at":"x"}')).toBeNull();
    expect(lastReportPointerOf('{"key":"incidents/x.json"}')).toBeNull();
    const kv = new FakeKv();
    expect(await readLastReport(kv)).toBeNull();
  });

  it("fails open when the kv read fails", async () => {
    const kv = new FakeKv();
    kv.failNext(1);
    expect(await readLastReport(kv)).toBeNull();
  });

  it("fails open when the kv read exceeds the pointer deadline", async () => {
    vi.useFakeTimers();
    try {
      const inner = new FakeKv();
      const slow: KvPort = {
        get: (key) => new Promise(() => inner.get(key)),
        put: (key, value, opts) => inner.put(key, value, opts),
        delete: (key) => inner.delete(key),
        list: (prefix) => inner.list(prefix),
      };
      const pending = readLastReport(slow);
      await vi.advanceTimersByTimeAsync(4000);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("kv key charset", () => {
  it("keeps the pointer key inside the KV charset", () => {
    expect(LAST_REPORT_KEY).toMatch(/^[-/_=.a-zA-Z0-9]+$/);
  });
});
