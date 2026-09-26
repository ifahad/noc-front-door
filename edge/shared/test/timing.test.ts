import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deadline } from "../src/timing";

type RejectionHandler = (reason: unknown) => void;

describe("deadline", () => {
  let unhandled: unknown[];
  let registered: RejectionHandler;
  let original: RejectionHandler | undefined;

  beforeEach(() => {
    unhandled = [];
    registered = (reason: unknown) => unhandled.push(reason);
    const listeners = process.listeners("unhandledRejection");
    if (listeners.length > 0) {
      original = listeners[listeners.length - 1] as RejectionHandler;
      process.off("unhandledRejection", original);
    }
    process.on("unhandledRejection", registered);
  });

  afterEach(() => {
    process.off("unhandledRejection", registered);
    if (original) process.on("unhandledRejection", original);
  });

  const settle = () => new Promise((r) => setTimeout(r, 60));

  it("returns the value when the promise settles in time", async () => {
    const p = Promise.resolve("payload");
    const started = Date.now();
    const result = await deadline(p, 400, "kv.get");
    expect(result).toEqual({ ok: true, value: "payload" });
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("returns timeout and clears the timer when the promise rejects in time", async () => {
    const result = await deadline(
      Promise.reject(new Error("fast-fail")),
      50,
      "actor.call",
    );
    expect(result).toEqual({ ok: false, timeout: true });
    await settle();
    expect(unhandled).toHaveLength(0);
  });

  it("returns timeout when the promise resolves after the deadline", async () => {
    const p = new Promise<string>((resolve) => {
      setTimeout(() => resolve("too-late"), 40);
    });
    const result = await deadline(p, 5, "kv.get");
    expect(result).toEqual({ ok: false, timeout: true });
    await settle();
    expect(unhandled).toHaveLength(0);
  });

  it("returns timeout when the promise rejects after the deadline", async () => {
    const p = new Promise<string>((_resolve, reject) => {
      setTimeout(() => reject(new Error("boom")), 40);
    });
    const result = await deadline(p, 5, "actor.call");
    expect(result).toEqual({ ok: false, timeout: true });
    await settle();
    expect(unhandled).toHaveLength(0);
  });

  it("logs the late rejection with the shared svc and the label", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    const p = new Promise<string>((_resolve, reject) => {
      setTimeout(() => reject(new Error("boom-after-deadline")), 20);
    });
    const result = await deadline(p, 5, "actor.record_call");
    expect(result).toEqual({ ok: false, timeout: true });

    await new Promise((r) => setTimeout(r, 60));
    expect(unhandled).toHaveLength(0);

    const late = lines.filter((l) => l.includes("late_rejection"));
    expect(late).toHaveLength(1);
    const parsed = JSON.parse(late[0]) as Record<string, unknown>;
    expect(parsed.svc).toBe("shared");
    expect(parsed.hop).toBe("timing");
    expect(parsed.lvl).toBe("warn");
    expect(parsed.label).toBe("actor.record_call");
    expect(String(parsed.err)).toContain("boom-after-deadline");
    spy.mockRestore();
  });
});
