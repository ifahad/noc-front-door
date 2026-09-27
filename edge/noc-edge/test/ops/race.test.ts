import { beforeEach, describe, expect, it, vi } from "vitest";
import { SeedAdapter } from "../../../shared/src/itsm";
import { kvKey } from "../../../shared/src/kvkeys";
import { mintTicketId } from "../../../shared/src/ids";
import { runRace, RaceError, type RaceDeps } from "../../src/ops/race";
import { FakeActorPort } from "../fakes/actors";
import { FakeKv } from "../fakes/kv";
import { PEPPER, T0 } from "./helpers";

const DEPS = (opts: { actors?: FakeActorPort } = {}): RaceDeps => ({
  kv: new FakeKv(),
  actors: opts.actors ?? new FakeActorPort({ serialise: true }),
  adapter: new SeedAdapter({ seedLocal: { pins: {}, contacts: [] }, pepper: PEPPER, now: () => T0 }),
  now: T0,
  trace_id: "t-race-1",
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("diag race", () => {
  it("actor mode creates exactly one ticket for 20 concurrent opens", async () => {
    // storageDelayMs makes the fake's gets yield between racers, so this test
    // fails if the port ever stops serialising one actor's turns (see the
    // unserialised contrast below).
    const actors = new FakeActorPort({ serialise: true, storageDelayMs: 1 });
    const deps = DEPS({ actors });
    const result = await runRace(deps, "actor", 20, "r1");
    expect(result).toMatchObject({ mode: "actor", n: 20, created_count: 1 });
    expect(result.ticket_ids).toHaveLength(1);
    expect(result.ticket_ids[0]).toBe("NJD-9901");
    const members = actors.regionMembers("lab") as Record<string, { ticketId: string }>;
    expect(Object.keys(members)).toEqual(["TST-001"]);
  });

  it("the delayed fake really races when serialisation is off (fidelity)", async () => {
    const actors = new FakeActorPort({ serialise: false, storageDelayMs: 1 });
    const deps = DEPS({ actors });
    const result = await runRace(deps, "actor", 20, "r8");
    expect(result.created_count).toBeGreaterThan(1);
    expect(new Set(result.ticket_ids).size).toBe(result.created_count);
  });

  it("kv mode creates more than one ticket when gets interleave before puts", async () => {
    const deps = DEPS();
    const result = await runRace(deps, "kv", 20, "r2");
    expect(result.mode).toBe("kv");
    expect(result.created_count).toBeGreaterThan(1);
    expect(new Set(result.ticket_ids).size).toBe(result.created_count);
  });

  it("resets the lab actors before racing", async () => {
    const actors = new FakeActorPort({ serialise: true });
    const deps = DEPS({ actors });
    await actors.site("TST-001").openOrAttach({
      k: "pre-existing",
      trace_id: "t-pre",
      callerRef: "none",
      symptom: "WAN link down",
      impact: "site_down",
      serviceAffecting: true,
      priority: "P2",
      at: T0,
      siteCode: "99",
    });
    const result = await runRace(deps, "actor", 5, "r3");
    expect(result.created_count).toBe(1);
  });

  it("stores the naive kv ticket under the race key", async () => {
    const kv = new FakeKv();
    const deps = DEPS();
    deps.kv = kv;
    await runRace(deps, "kv", 3, "r4");
    const raw = kv.raw(kvKey("race", "r4", "ticket")) as string | null;
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw as string) as { id: string };
    expect(stored.id).toBe(mintTicketId("99", 3));
  });

  it("clamps n into a sane range", async () => {
    const deps = DEPS();
    const low = await runRace(deps, "kv", 0, "r5");
    expect(low.n).toBe(1);
    expect(low.created_count).toBe(1);
    const high = await runRace(deps, "kv", 999, "r6");
    expect(high.n).toBe(50);
  });

  it("rejects an unknown mode", async () => {
    const deps = DEPS();
    await expect(runRace(deps, "nope", 20, "r7")).rejects.toThrow(RaceError);
  });
});
