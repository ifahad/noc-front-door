import { describe, expect, it } from "vitest";
import type { OpenOrAttachInput } from "../src/SiteState";
import { makeSiteState } from "./fakes/storage";

const T0 = Date.UTC(2026, 8, 26, 6, 0, 0);
const MIN = 60_000;

const fpA = ["a1", "b2", "c3", "d4", "e5", "f6", "07", "89"].join("");
const fpB = ["b2", "c3", "d4", "e5", "f6", "07", "89", "9a"].join("");
const fpC = ["c3", "d4", "e5", "f6", "07", "89", "9a", "ab"].join("");
const fpD = ["d4", "e5", "f6", "07", "89", "9a", "ab", "bc"].join("");
const k1 = ["1a", "2b", "3c", "4d", "5e", "6f", "7a", "8b"].join("");
const k2 = ["2b", "3c", "4d", "5e", "6f", "7a", "8b", "9c"].join("");
const k3 = ["3c", "4d", "5e", "6f", "7a", "8b", "9c", "ad"].join("");
const k5 = ["5e", "6f", "7a", "8b", "9c", "ad", "be", "cf"].join("");

function invalid(k: string, fp: string, at: number) {
  return { k, valid: false, fp, trace_id: "t-" + k, at };
}

function attachInput(overrides: Partial<OpenOrAttachInput> = {}): OpenOrAttachInput {
  return {
    k: k1,
    trace_id: "t-1",
    callerRef: "c-ref-1",
    symptom: "WAN link down",
    impact: "degraded",
    serviceAffecting: true,
    priority: "P3",
    at: T0,
    siteCode: "14",
    ...overrides,
  };
}

describe("SiteState", () => {
  it("recordCall is idempotent on k within a day", async () => {
    const h = makeSiteState("RUH-114");
    const first = await h.actor.recordCall({ k: k1, trace_id: "t-a", at: T0 });
    const second = await h.actor.recordCall({ k: k1, trace_id: "t-b", at: T0 + MIN });
    expect(first.callsToday).toBe(1);
    expect(first.openTicket).toBeNull();
    expect(second.callsToday).toBe(1);
    expect(second.trace_id).toBe("t-b");
    expect(typeof first.actor_ms).toBe("number");
  });

  it("recordCall resets on a new day", async () => {
    const h = makeSiteState("RUH-114");
    await h.actor.recordCall({ k: k1, trace_id: "t-a", at: T0 });
    const next = await h.actor.recordCall({
      k: k1,
      trace_id: "t-b",
      at: T0 + 26 * 60 * MIN,
    });
    expect(next.callsToday).toBe(1);
  });

  it("recordCall stays idempotent on k after more than 10 other callers", async () => {
    const h = makeSiteState("RUH-114");
    await h.actor.recordCall({ k: k1, trace_id: "t-1", at: T0 });
    for (let i = 0; i < 11; i++) {
      await h.actor.recordCall({
        k: `caller-${i}`,
        trace_id: `t-x${i}`,
        at: T0 + (i + 1) * 1000,
      });
    }
    const again = await h.actor.recordCall({
      k: k1,
      trace_id: "t-again",
      at: T0 + 13000,
    });
    expect(again.callsToday).toBe(12);
  });

  it("recordPinAttempt: 3 failures lock the call, not the site", async () => {
    const h = makeSiteState("RUH-114");
    const r1 = await h.actor.recordPinAttempt(invalid(k1, fpA, T0));
    const r2 = await h.actor.recordPinAttempt(invalid(k1, fpB, T0 + 1000));
    const r3 = await h.actor.recordPinAttempt(invalid(k1, fpC, T0 + 2000));
    expect(r1).toMatchObject({ result: "invalid", attemptsLeft: 2 });
    expect(r2).toMatchObject({ result: "invalid", attemptsLeft: 1 });
    expect(r3).toMatchObject({ result: "locked", attemptsLeft: 0 });
    const r4 = await h.actor.recordPinAttempt(invalid(k2, fpD, T0 + 3000));
    expect(r4).toMatchObject({ result: "invalid", attemptsLeft: 2 });
    const r5 = await h.actor.recordPinAttempt(invalid(k3, fpA, T0 + 4000));
    expect(r5).toMatchObject({ result: "invalid", attemptsLeft: 2 });
  });

  it("recordPinAttempt: 6 failures from 2 distinct calls lock the site for 15 min", async () => {
    const h = makeSiteState("RUH-114");
    await h.actor.recordPinAttempt(invalid(k1, fpA, T0));
    await h.actor.recordPinAttempt(invalid(k1, fpB, T0 + 1000));
    await h.actor.recordPinAttempt(invalid(k1, fpC, T0 + 2000));
    const s4 = await h.actor.recordPinAttempt(invalid(k2, fpA, T0 + 3000));
    const s5 = await h.actor.recordPinAttempt(invalid(k2, fpB, T0 + 4000));
    const s6 = await h.actor.recordPinAttempt(invalid(k2, fpC, T0 + 5000));
    expect(s4).toMatchObject({ result: "invalid", attemptsLeft: 2 });
    expect(s5).toMatchObject({ result: "invalid", attemptsLeft: 1 });
    expect(s6.result).toBe("locked");
    const stranger = await h.actor.recordPinAttempt(invalid(k3, fpD, T0 + 6000));
    expect(stranger).toMatchObject({ result: "locked", attemptsLeft: 0 });
    const later = await h.actor.recordPinAttempt(invalid(k3, fpD, T0 + 16 * MIN));
    expect(later.result).toBe("invalid");
    expect(later.attemptsLeft).toBe(2);
  });

  it("recordPinAttempt: the site lock trips even when the same attempt already locked the call", async () => {
    const h = makeSiteState("RUH-114");
    await h.actor.recordPinAttempt(invalid(k1, fpA, T0));
    await h.actor.recordPinAttempt(invalid(k1, fpB, T0 + 1000));
    await h.actor.recordPinAttempt(invalid(k1, fpC, T0 + 2000));
    await h.actor.recordPinAttempt(invalid(k2, fpA, T0 + 3000));
    await h.actor.recordPinAttempt(invalid(k2, fpB, T0 + 4000));
    const sixth = await h.actor.recordPinAttempt(invalid(k2, fpC, T0 + 5000));
    expect(sixth.result).toBe("locked");
    const validFromNewCaller = await h.actor.recordPinAttempt({
      k: k5,
      valid: true,
      fp: fpD,
      trace_id: "t-5",
      at: T0 + 6000,
    });
    expect(validFromNewCaller).toMatchObject({ result: "locked", attemptsLeft: 0 });
  });

  it("recordPinAttempt: a repeat (k, fp) is not counted again", async () => {
    const h = makeSiteState("RUH-114");
    const first = await h.actor.recordPinAttempt(invalid(k1, fpA, T0));
    const again = await h.actor.recordPinAttempt(invalid(k1, fpA, T0 + 1000));
    expect(again).toMatchObject({ result: "invalid", attemptsLeft: 2, repeat: true });
    const next = await h.actor.recordPinAttempt(invalid(k1, fpB, T0 + 2000));
    expect(next.attemptsLeft).toBe(1);
    expect(first.repeat).toBeUndefined();
  });

  it("recordPinAttempt: valid clears that call's failures", async () => {
    const h = makeSiteState("RUH-114");
    await h.actor.recordPinAttempt(invalid(k1, fpA, T0));
    await h.actor.recordPinAttempt(invalid(k1, fpB, T0 + 1000));
    const ok = await h.actor.recordPinAttempt({
      k: k1,
      valid: true,
      fp: fpC,
      trace_id: "t-1",
      at: T0 + 2000,
    });
    expect(ok).toMatchObject({ result: "ok", attemptsLeft: 3 });
    const next = await h.actor.recordPinAttempt(invalid(k1, fpD, T0 + 3000));
    expect(next).toMatchObject({ result: "invalid", attemptsLeft: 2 });
  });

  it("recordPinAttempt: attempts older than 15 min are pruned", async () => {
    const h = makeSiteState("RUH-114");
    await h.actor.recordPinAttempt(invalid(k1, fpA, T0));
    await h.actor.recordPinAttempt(invalid(k1, fpB, T0 + MIN));
    const later = await h.actor.recordPinAttempt(invalid(k1, fpC, T0 + 16 * MIN));
    expect(later).toMatchObject({ result: "invalid", attemptsLeft: 2 });
  });

  it("openOrAttach creates the first ticket with the site code", async () => {
    const h = makeSiteState("RUH-114");
    const r = await h.actor.openOrAttach(attachInput());
    expect(r.created).toBe(true);
    expect(r.priorityRaised).toBe(false);
    expect(r.ticket.id).toBe("NJD-1401");
    expect(r.ticket.regionReported).toBe(false);
    expect(r.ticket.reporters).toHaveLength(1);
    expect(r.trace_id).toBe("t-1");
    expect(typeof r.actor_ms).toBe("number");
  });

  it("openOrAttach attaches a different k as a second reporter", async () => {
    const h = makeSiteState("RUH-114");
    await h.actor.openOrAttach(attachInput());
    const r = await h.actor.openOrAttach(
      attachInput({ k: k2, callerRef: "c-ref-2", trace_id: "t-2" }),
    );
    expect(r.created).toBe(false);
    expect(r.priorityRaised).toBe(false);
    expect(r.ticket.reporters).toHaveLength(2);
    expect(r.ticket.reporters[1]).toMatchObject({ k: k2, callerRef: "c-ref-2" });
  });

  it("openOrAttach replays the cached result for the same k and symptom", async () => {
    const h = makeSiteState("RUH-114");
    const first = await h.actor.openOrAttach(attachInput());
    const second = await h.actor.openOrAttach(attachInput({ trace_id: "t-2" }));
    expect(second.created).toBe(true);
    expect(second.ticket.id).toBe(first.ticket.id);
    expect(second.trace_id).toBe("t-2");
    const live = await h.actor.getTicket({ trace_id: "t-2" });
    expect(live.ticket?.reporters).toHaveLength(1);
  });

  it("openOrAttach adds a note for a genuinely second issue from the same call", async () => {
    const h = makeSiteState("RUH-114");
    await h.actor.openOrAttach(attachInput());
    const r = await h.actor.openOrAttach(
      attachInput({
        symptom: "phones also down",
        priority: "P4",
        impact: "single_user",
        serviceAffecting: false,
        trace_id: "t-2",
      }),
    );
    expect(r.created).toBe(false);
    expect(r.ticket.reporters).toHaveLength(1);
    expect(r.ticket.notes).toHaveLength(1);
    expect(r.ticket.notes[0]).toMatchObject({ k: k1, text: "phones also down" });
  });

  it("openOrAttach raises the priority to the worst of the reports", async () => {
    const h = makeSiteState("RUH-114");
    const first = await h.actor.openOrAttach(
      attachInput({ priority: "P4", impact: "single_user", serviceAffecting: false }),
    );
    expect(first.ticket.priority).toBe("P4");
    const second = await h.actor.openOrAttach(
      attachInput({ k: k2, priority: "P2", impact: "site_down", trace_id: "t-2" }),
    );
    expect(second.priorityRaised).toBe(true);
    expect(second.ticket.priority).toBe("P2");
    expect(second.ticket.impact).toBe("site_down");
    expect(second.ticket.serviceAffecting).toBe(true);
  });

  it("markRegionReported sets the flag on the ticket", async () => {
    const h = makeSiteState("RUH-114");
    const created = await h.actor.openOrAttach(attachInput());
    await h.actor.markRegionReported({ ticketId: created.ticket.id, trace_id: "t-2" });
    const live = await h.actor.getTicket({ trace_id: "t-3" });
    expect(live.ticket?.regionReported).toBe(true);
  });

  it("addNote appends once and throws on a wrong ticket id", async () => {
    const h = makeSiteState("RUH-114");
    const created = await h.actor.openOrAttach(attachInput());
    const r = await h.actor.addNote({
      k: k1,
      ticketId: created.ticket.id,
      note: "router blinking amber",
      at: T0 + MIN,
      trace_id: "t-2",
    });
    expect(r.added).toBe(true);
    const repeat = await h.actor.addNote({
      k: k1,
      ticketId: created.ticket.id,
      note: "router blinking amber",
      at: T0 + 2 * MIN,
      trace_id: "t-3",
    });
    expect(repeat.added).toBe(false);
    const live = await h.actor.getTicket({ trace_id: "t-4" });
    expect(live.ticket?.notes).toHaveLength(1);
    await expect(
      h.actor.addNote({
        k: k1,
        ticketId: "NJD-9901",
        note: "x",
        at: T0 + 3 * MIN,
        trace_id: "t-5",
      }),
    ).rejects.toThrow("ticket_mismatch");
  });

  it("resolveTicket returns the ticket and clears it", async () => {
    const h = makeSiteState("RUH-114");
    await h.actor.openOrAttach(attachInput());
    const resolved = await h.actor.resolveTicket({ trace_id: "t-2", at: T0 + MIN });
    expect(resolved.ticket?.id).toBe("NJD-1401");
    const live = await h.actor.getTicket({ trace_id: "t-3" });
    expect(live.ticket).toBeNull();
  });

  it("reset preserves seq, drops the ticket and clears the alarm", async () => {
    const h = makeSiteState("RUH-114");
    await h.actor.openOrAttach(attachInput());
    await h.storage.setAlarm(T0 + 5 * MIN);
    await h.actor.reset({ trace_id: "t-9" });
    expect(await h.storage.getAlarm()).toBeNull();
    expect(h.storage.calls).toContain("deleteAlarm");
    const live = await h.actor.getTicket({ trace_id: "t-2" });
    expect(live.ticket).toBeNull();
    const again = await h.actor.openOrAttach(attachInput());
    expect(again.ticket.id).toBe("NJD-1402");
  });

  it("no return value or actor event contains the pin fingerprint", async () => {
    const h = makeSiteState("RUH-114");
    const created = await h.actor.openOrAttach(attachInput());
    const results: unknown[] = [
      await h.actor.recordCall({ k: k1, trace_id: "t-1", at: T0 }),
      await h.actor.recordPinAttempt(invalid(k1, fpA, T0)),
      await h.actor.recordPinAttempt(invalid(k2, fpB, T0 + 1000)),
      await h.actor.recordPinAttempt({
        k: k1,
        valid: true,
        fp: fpC,
        trace_id: "t-1",
        at: T0 + 2000,
      }),
      created,
      await h.actor.addNote({
        k: k1,
        ticketId: created.ticket.id,
        note: "n",
        at: T0,
        trace_id: "t-1",
      }),
      await h.actor.markRegionReported({ ticketId: created.ticket.id, trace_id: "t-1" }),
      await h.actor.getTicket({ trace_id: "t-1" }),
      await h.actor.resolveTicket({ trace_id: "t-1", at: T0 }),
    ];
    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain(fpA);
    }
    const events = h.storage.raw("events");
    expect(Array.isArray(events)).toBe(true);
    expect((events as unknown[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(fpA);
    const ops = h.storage.raw("ops");
    expect(JSON.stringify(ops ?? [])).not.toContain(fpA);
  });
});
