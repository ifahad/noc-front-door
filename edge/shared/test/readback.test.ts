import { describe, expect, it } from "vitest";
import {
  formatRiyadhTime,
  openTicketNote,
  riyadhTimeToday,
  ticketReadback,
  type ReadbackIncident,
} from "../src/readback";

const NOW = Date.UTC(2026, 8, 25, 22, 52); // 01:52 Asia/Riyadh on 2026-09-26

describe("formatRiyadhTime", () => {
  it("formats h:mm AM in Asia/Riyadh", () => {
    expect(formatRiyadhTime(NOW)).toBe("1:52 AM");
  });

  it("formats afternoon times with a 12-hour clock", () => {
    expect(formatRiyadhTime(NOW + 13 * 3600_000 + 23 * 60_000)).toBe("3:15 PM");
  });

  it("never drifts with DST (Riyadh is fixed UTC+3)", () => {
    expect(riyadhTimeToday(1, 52, NOW)).toBe(NOW);
  });
});

describe("riyadhTimeToday", () => {
  it("returns 01:52 on the current Riyadh day", () => {
    expect(riyadhTimeToday(1, 52, NOW + 3600_000)).toBe(NOW);
  });

  it("rolls back to the previous day before local midnight", () => {
    expect(riyadhTimeToday(1, 52, NOW - 2 * 3600_000)).toBe(
      NOW - 24 * 3600_000,
    );
  });
});

const ticket = {
  id: "NJD-1407",
  priority: "P2" as const,
  openedAt: NOW,
};

const incident: ReadbackIncident = {
  id: "INC-1002",
  priority: "P2",
  siteCount: 2,
  regionLabel: "Riyadh North",
};

describe("ticketReadback (created)", () => {
  it("reads the id, priority and response target", () => {
    expect(
      ticketReadback({ ticket, created: true, priorityRaised: false, incident: null, now: NOW }),
    ).toBe(
      "Your ticket number is N J D, 1 4 0 7. Priority 2. An engineer will respond by 2:22 AM Riyadh time.",
    );
  });

  it("uses each priority's response target", () => {
    const p1 = { ...ticket, priority: "P1" as const };
    const out = ticketReadback({ ticket: p1, created: true, priorityRaised: false, incident: null, now: NOW });
    expect(out).toContain("Priority 1.");
    expect(out).toContain("respond by 2:07 AM Riyadh time");
  });

  it("appends the incident note when an incident is present", () => {
    const out = ticketReadback({ ticket, created: true, priorityRaised: false, incident, now: NOW });
    expect(out.endsWith(" This is part of incident I N C, 1 0 0 2 affecting Riyadh North.")).toBe(true);
  });

  it("uses the upgrade wording for a P1 incident", () => {
    const out = ticketReadback({
      ticket,
      created: true,
      priorityRaised: false,
      incident: { ...incident, priority: "P1", siteCount: 3 },
      now: NOW,
    });
    expect(out.endsWith(" It now affects 3 branches and has been raised to priority 1.")).toBe(true);
  });
});

describe("ticketReadback (attached)", () => {
  it("announces the existing ticket and the minutes open", () => {
    expect(
      ticketReadback({
        ticket: { ...ticket, openedAt: NOW - 12 * 60_000 },
        created: false,
        priorityRaised: false,
        incident: null,
        now: NOW,
      }),
    ).toBe(
      "There's already an open ticket for this branch: N J D, 1 4 0 7, opened 12 minutes ago. I've added you to it.",
    );
  });

  it("adds the raise clause when the priority was raised", () => {
    const out = ticketReadback({
      ticket: { ...ticket, openedAt: NOW - 12 * 60_000 },
      created: false,
      priorityRaised: true,
      incident,
      now: NOW,
    });
    expect(out).toContain("raised it to priority 2");
    expect(out).toContain(" This is part of incident I N C, 1 0 0 2 affecting Riyadh North.");
  });

  it("clamps negative elapsed time to 0 minutes", () => {
    const out = ticketReadback({
      ticket: { ...ticket, openedAt: NOW + 30_000 },
      created: false,
      priorityRaised: false,
      incident: null,
      now: NOW,
    });
    expect(out).toContain("opened 0 minutes ago");
  });
});

describe("openTicketNote", () => {
  it("returns none when there is no ticket", () => {
    expect(openTicketNote(null)).toBe("none");
  });

  it("renders a spoken note for the dynamic variables", () => {
    expect(openTicketNote({ id: "NJD-1407" })).toBe(
      "There's already an open ticket for this branch: N J D, 1 4 0 7.",
    );
  });
});
