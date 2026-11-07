import type { Quantity } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import type { Cell, Pair, Run } from "./cell.ts";
import { cancelsOf, INSERT, numbersOf, pairArgs, peersOf, standbyCommand } from "./standby.ts";
import { measureGroup, writesOf } from "./timeline.ts";

const ms = (value: number): number => value * 1e6;
const interval: Quantity = { value: 50, unit: "ms" };
const pair: Pair = { synchronous: true, writers: 4, interval, cuts: "standby" };

const cell = (outcomes: NonNullable<NonNullable<Cell["prediction"]["group"]>["outcomes"]>, lost = { low: 0, high: 0 }): Cell =>
  ({
    name: "lab pair",
    pair,
    hold: { value: 10, unit: "s" },
    probe: { mode: "stream", keepalive: false },
    fault: "blackhole",
    sysctls: {},
    prediction: { detects: null, window: { value: 40, unit: "s" }, why: "", from: "fault", group: { lands: "new", failover: true, stages: [], lost, outcomes } },
    runs: 1,
    environments: 1,
  }) as unknown as Cell;

/** This run has three writes with an ack, and three with no reply: one on each server, and one on neither. */
const pairRun = (): Run =>
  ({
    environment: 0,
    index: 0,
    events: [
      { ev: "ready", t: ms(-2000) },
      { ev: "sent", t: ms(-100), n: 1 },
      { ev: "ack", t: ms(-99), n: 1 },
      { ev: "sent", t: ms(-50), n: 2 },
      { ev: "ack", t: ms(-49), n: 2 },
      { ev: "sent", t: ms(10), n: 3 },
      { ev: "notice", t: ms(3000), severity: "WARNING", message: "canceling wait for synchronous replication due to user request" },
      { ev: "notice", t: ms(3000), severity: "NOTICE", message: "a line that does not count" },
      { ev: "ack", t: ms(3001), n: 3 },
      { ev: "sent", t: ms(3050), n: 4 },
      { ev: "sent", t: ms(3051), n: 5 },
      { ev: "sent", t: ms(3052), n: 6 },
      { ev: "done", t: ms(12_000) },
    ],
    fault: { t0: ms(0), t1: ms(0.2) },
    heal: { t0: ms(10_000), t1: ms(10_000.1) },
    kernel: [{ ev: "clock", mono: ms(13_000), lost: 0 }],
    netns: 1,
    targetNetns: 2,
    lost: 0,
    group: {
      members: { primary: { ip: "10.0.0.2", netns: 2 }, standby: { ip: "10.0.0.3", netns: 3 } },
      sentinels: {},
      primary: "primary",
      at: "primary",
      timeline: [],
      after: "standby",
      holds: [1, 2, 4],
      oldHolds: [1, 2, 3, 4, 5],
    },
  }) as unknown as Run;

describe("the commands of a pair", () => {
  it("starts a standby from a base backup with its replication settings, then the server", () => {
    const [, , script] = standbyCommand("10.0.0.2");
    expect(script).toContain("pg_basebackup -h 10.0.0.2 -U postgres");
    expect(script).toContain("-X stream -c fast -R");
    expect(script).toMatch(/exec gosu postgres postgres$/);
  });

  it("gives the client the stream of K writers and its numbered write", () => {
    const args = pairArgs(cell({}), { targetIp: "10.0.0.9", targetPort: 6432 });
    expect(args.slice(0, 2)).toEqual(["10.0.0.9", "6432"]);
    expect(args[args.indexOf("--writers") + 1]).toBe("4");
    expect(args[args.indexOf("--interval-ms") + 1]).toBe("50");
    expect(args[args.indexOf("--query") + 1]).toBe(INSERT);
    expect(INSERT).toContain("$n");
  });

  it("cuts the standby, or each peer of the primary", () => {
    const lab = { topology: { targetPeer: "10.0.0.8" } as NonNullable<Parameters<typeof peersOf>[2]["topology"]>, clientIp: "10.0.0.7" };
    expect(peersOf(pair, "10.0.0.3", lab)).toEqual(["10.0.0.3"]);
    expect(peersOf({ ...pair, cuts: "all" }, "10.0.0.3", lab)).toEqual(["10.0.0.3", "10.0.0.8"]);
  });

  it("puts the cancels at equal parts of the hold", () => {
    expect(cancelsOf(pair, 9e9)).toEqual([]);
    expect(cancelsOf({ ...pair, cancels: 2 }, 9e9)).toEqual([3e9, 6e9]);
  });

  it("reads the final read of a server", () => {
    expect(numbersOf("3\n1\n\n2\n")).toEqual([1, 2, 3]);
  });
});

describe("the sets of a COMMIT with no reply", () => {
  it("splits the writes with no reply by the two final reads", () => {
    const writes = writesOf(pairRun(), ms(0), "primary");
    expect(writes.lost).toEqual([3]);
    expect(writes.sets).toEqual({ unknown: 3, kept: 1, stranded: 1, absent: 1, missing: 0, warnings: 1 });
  });

  it("counts an ack that the old primary does not hold", () => {
    const run = pairRun();
    const missing = { ...run, group: { ...run.group!, oldHolds: [1, 3, 4, 5] } };
    expect(writesOf(missing, ms(0), "primary").sets?.missing).toBe(1);
  });

  it("gives no sets to a run with no second final read", () => {
    const run = pairRun();
    const { oldHolds: _, ...group } = run.group!;
    expect(writesOf({ ...run, group }, ms(0), "primary").sets).toBeUndefined();
  });

  it("holds if each band holds", () => {
    const band = (count: number) => ({ low: count, high: count });
    const read = measureGroup(cell({ unknown: band(3), kept: band(1), absent: band(1), warnings: band(1) }, { low: 1, high: 1 }), pairRun());
    expect(read.void).toBeNull();
    expect(read.finding).toBeNull();
  });

  it("names the count outside its band", () => {
    const read = measureGroup(cell({ absent: { low: 0, high: 0 } }, { low: 1, high: 1 }), pairRun());
    expect(read.finding).toBe("the count of absent is 1, outside [0, 0]");
  });

  it("judges the lost writes by the band of the group", () => {
    const read = measureGroup(cell({}), pairRun());
    expect(read.finding).toBe("the group lost 1 accepted writes, outside [0, 0]");
  });
});
