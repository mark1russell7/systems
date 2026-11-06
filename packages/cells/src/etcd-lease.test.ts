import { describe, expect, it } from "vitest";
import { bandOf, countsOf, ELECTION, floorOf, gapOf, grantedOf, lawOf, LEASE_CELLS, LEASE_SPECS, LOOP, SEND, SLACK, type Hold, type Scenario, type Write } from "./etcd-lease.ts";

const frozen = (contender: Write, write: Write, over: Partial<Hold> = {}): Hold => ({ kind: "hold", ttl: 3, hold: 0, work: 2, frozen: true, contender, write, ...over });
const whereOf = (spec: Scenario, ev: string): readonly unknown[] => countsOf(spec).flatMap((count) => (count.match.ev === ev && count.match.where !== undefined ? [count.match.where] : []));

describe("the terms of the law", () => {
  it("puts the floor of a TTL at 2 s, from 15 ticks of 100 ms", () => {
    expect(floorOf()).toBe(2);
    expect(grantedOf(1)).toBe(2);
    expect(grantedOf(2)).toBe(2);
    expect(grantedOf(3)).toBe(3);
  });

  it("gives a gap of a third of the TTL plus the send loop", () => {
    expect(SEND).toBe(500);
    expect(gapOf(3)).toBe(1_500);
    expect(gapOf(9)).toBe(3_500);
  });

  it("gives a band from the TTL to the TTL, the loop and the slack", () => {
    expect(LOOP).toBe(500);
    expect(SLACK).toBe(300);
    expect(bandOf({ kind: "bare", ttl: 1, restart: null })).toEqual({ low: 2_000, high: 2_800 });
    expect(bandOf({ kind: "bare", ttl: 3, restart: null })).toEqual({ low: 3_000, high: 3_800 });
    expect(bandOf(frozen("none", "none"))).toEqual({ low: 3_000, high: 3_800 });
    expect(bandOf({ kind: "waiter", ttl: 3, work: 5 })).toEqual({ low: 3_000, high: 3_800 });
  });

  it("adds the election timeout after a promotion", () => {
    expect(ELECTION).toBe(1_000);
    expect(bandOf({ kind: "bare", ttl: 3, restart: 1_000 })).toEqual({ low: 4_000, high: 4_800 });
  });

  it("opens the low end by the gap only for a stop after renewals", () => {
    expect(bandOf(frozen("none", "none", { hold: 5_500, work: 8 }))).toEqual({ low: 1_200, high: 3_800 });
  });
});

describe("the law of a scenario", () => {
  it("gives a bare lease its put, then its end", () => {
    const law = lawOf({ kind: "bare", ttl: 1, restart: null });
    expect(law).toMatchObject({ granted: 2, ends: [{ who: "bare", rev: 2 }], deleted: 1, head: 2, writes: [], value: null });
  });

  it("gives a frozen holder no revision but its lock and its end", () => {
    expect(lawOf(frozen("none", "none"))).toMatchObject({ locks: [{ who: "holder", rev: 1 }], queued: null, ends: [{ who: "holder", rev: 2 }], head: 2 });
  });

  it("gives a live holder no end, and its fence holds at the next revision", () => {
    const law = lawOf({ kind: "hold", ttl: 3, hold: 0, work: 9, frozen: false, contender: "plain", write: "fenced" });
    expect(law.ends).toEqual([]);
    expect(law.deleted).toBe(0);
    expect(law.locks).toEqual([{ who: "holder", rev: 1 }]);
    expect(law.writes).toEqual([{ who: "holder", token: "lock", applied: true, rev: 3 }]);
    expect(law).toMatchObject({ value: { who: "holder", rev: 3 }, head: 3, exits: [] });
  });

  it("puts the contender after the end of the lease, on the revision of the deletion", () => {
    const law = lawOf(frozen("plain", "none"));
    expect(law.ends).toEqual([{ who: "holder", rev: 3 }]);
    expect(law.locks).toContainEqual({ who: "contender", rev: 3 });
    expect(law).toMatchObject({ value: { who: "contender", rev: 4 }, head: 4 });
  });

  it("applies the stale write with no fence, and it wins (T13)", () => {
    const law = lawOf(frozen("plain", "plain"));
    expect(law.writes).toEqual([
      { who: "contender", token: "none", applied: true, rev: 4 },
      { who: "holder", token: "none", applied: true, rev: 5 },
    ]);
    expect(law).toMatchObject({ value: { who: "holder", rev: 5 }, head: 5, exits: [{ who: "holder", code: 0, expired: false }] });
  });

  it("fails the stale write with a fence, and the revision stays", () => {
    const law = lawOf(frozen("plain", "fenced"));
    expect(law.writes).toContainEqual({ who: "holder", token: "lock", applied: false, rev: 4 });
    expect(law).toMatchObject({ value: { who: "contender", rev: 4 }, head: 4 });
  });

  it("fails the fence with ETCD_LOCK_REV for a client that waited, and the create revision holds", () => {
    const law = lawOf(frozen("fenced", "none"));
    expect(law.writes).toEqual([
      { who: "contender", token: "lock", applied: false, rev: 3 },
      { who: "contender", token: "create", applied: true, rev: 4 },
    ]);
    expect(law.head).toBe(4);
  });

  it("gives a waiter that lost its lease no lock, and the session error", () => {
    const law = lawOf({ kind: "waiter", ttl: 3, work: 5 });
    expect(law.locks).toEqual([{ who: "holder", rev: 1 }]);
    expect(law.ends).toEqual([{ who: "waiter", rev: 3 }]);
    expect(law.deleted).toBe(2);
    expect(law.exits).toContainEqual({ who: "waiter", code: 1, expired: true });
    expect(law.head).toBe(4);
  });
});

describe("the counts of a scenario", () => {
  it("gives each line with its fields, and a total for each kind", () => {
    const spec = frozen("plain", "fenced");
    expect(whereOf(spec, "locked")).toEqual([
      { who: "holder", rev: 1, after: true },
      { who: "contender", rev: 3, after: true },
    ]);
    expect(whereOf(spec, "lease-end")).toEqual([{ who: "holder", rev: 3, within: true }]);
    expect(whereOf(spec, "final")).toEqual([{ head: 4, value: "contender", rev: 4 }]);
    const total = (ev: string): number | undefined => countsOf(spec).find((count) => count.match.ev === ev && count.match.where === undefined)?.count;
    expect(total("locked")).toBe(2);
    expect(total("lease-end")).toBe(1);
    expect(total("deleted")).toBe(1);
    expect(total("write")).toBe(2);
    expect(total("exit")).toBe(1);
  });

  it("gives a final line with no value if no write was applied", () => {
    expect(whereOf(frozen("none", "none"), "final")).toEqual([{ head: 2 }]);
  });

  it("gives zero for the ends of the live control", () => {
    const counts = countsOf({ kind: "hold", ttl: 3, hold: 0, work: 9, frozen: false, contender: "plain", write: "fenced" });
    expect(counts.find((count) => count.match.ev === "lease-end")?.count).toBe(0);
    expect(counts.find((count) => count.match.ev === "deleted")?.count).toBe(0);
  });
});

describe("the cells of SYS-73", () => {
  it("has one cell for each spec, with the plan first and one target program", () => {
    expect(LEASE_CELLS).toHaveLength(LEASE_SPECS.length);
    expect(new Set(LEASE_CELLS.map((cell) => cell.name)).size).toBe(LEASE_CELLS.length);
    for (const [at, cell] of LEASE_CELLS.entries()) {
      expect(cell.name.startsWith(`EL.${at + 1} `)).toBe(true);
      expect(cell.fault).toBe("none");
      expect(cell.runs).toBe(4);
      expect(cell.environments).toBe(2);
      expect(cell.target.command?.slice(0, 2)).toEqual(["node", "/srv/lease.ts"]);
    }
  });

  it("gives the program the scenario with its band", () => {
    for (const [at, cell] of LEASE_CELLS.entries()) {
      const spec = LEASE_SPECS[at]!;
      expect(JSON.parse(cell.target.command!.at(-1)!)).toEqual({ ...spec.scenario, ...bandOf(spec.scenario) });
    }
  });

  it("freezes a holder while its section sleeps, and each scenario fits in its window", () => {
    for (const { scenario, window } of LEASE_SPECS) {
      if (scenario.kind === "bare") continue;
      expect(scenario.work * 1_000 + 8_000).toBeLessThan(window * 1_000);
      if (scenario.kind === "hold") expect(scenario.hold).toBeLessThan(scenario.work * 1_000);
    }
  });

  it("makes the control outlast several TTLs", () => {
    const control = LEASE_SPECS.find((spec) => spec.plan === "EL.6")!.scenario;
    expect(control).toMatchObject({ frozen: false });
    if (control.kind === "hold") expect(control.work).toBeGreaterThanOrEqual(3 * control.ttl);
  });
});
