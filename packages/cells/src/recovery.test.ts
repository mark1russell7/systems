import type { GroupReading } from "@mark1russell7/harness";
import { valueIn } from "@mark1russell7/quantity";
import { checkLadder, ladderVerdict } from "@mark1russell7/rigor-bench";
import { describe, expect, it } from "vitest";
import { ALL } from "./all.ts";
import { RECOVERY_CELLS, RECOVERY_LADDER, RECOVERY_RUNGS, RPO, recoveryRecord } from "./recovery.ts";

const NOW = new Date("2026-11-04T12:00:00Z");
const AT = NOW.toISOString();

const named = (prefix: string) => {
  const found = RECOVERY_CELLS.find((cell) => cell.name.startsWith(`${prefix} `));
  if (found === undefined) throw new Error(`no cell ${prefix}`);
  return found;
};

/** This function gives one counted run of a drill that restores. */
const reading = (over: { excess?: number | null; rto?: number; lost?: number; holes?: number; after?: number | null; same?: boolean | null; void?: string } = {}): GroupReading =>
  ({
    outcome: { kind: "answered" },
    elapsed: { value: over.rto ?? 60, unit: "s" },
    socket: null,
    noticed: null,
    void: over.void ?? null,
    finding: null,
    group: {
      writes: { sent: 10, acked: 10, old: 0, lost: Array.from({ length: over.lost ?? 3 }, (_, n) => n), unknown: [] },
      recovery: {
        rpo: { value: 10, unit: "s" },
        excess: over.excess === null ? null : { value: over.excess ?? 0.1, unit: "s" },
        holes: Array.from({ length: over.holes ?? 0 }, (_, n) => n),
        afterBackup: over.after === undefined ? 3 : over.after,
        sameData: over.same === undefined ? true : over.same,
      },
    },
  }) as unknown as GroupReading;

const noLoss = (): GroupReading => reading({ lost: 0 });
const four = (run: () => GroupReading): GroupReading[] => [run(), run(), run(), run()];

const recordsOf = (run: () => GroupReading = reading, kept: () => GroupReading = noLoss) =>
  RECOVERY_RUNGS.map((rung) => recoveryRecord(rung, { [rung.drill]: four(run), [rung.kept]: four(kept) }, "abc", AT));

describe("the ladder of recovery", () => {
  it("is a valid ladder, and each drill of a rung is a cell", () => {
    expect(checkLadder(RECOVERY_LADDER)).toEqual([]);
    for (const rung of RECOVERY_RUNGS) {
      expect(named(rung.drill).drill?.tenants, rung.name).toBe(rung.tenants);
      expect(named(rung.kept).prediction.group?.lost, rung.name).toEqual({ low: 0, high: 0 });
    }
  });

  it("keeps each schedule under the RPO of its rung, with room for a backup", () => {
    for (const rung of RECOVERY_RUNGS) expect(valueIn(rung.schedule, "s"), rung.name).toBeLessThan(valueIn(rung.rpo, "s"));
  });

  it("holds each rung with clean drills", () => {
    const verdict = ladderVerdict(RECOVERY_LADDER, recordsOf(), { now: NOW });
    expect(verdict.rungs.map((rung) => rung.outcome)).toEqual(["within", "within", "within"]);
    expect(verdict.held).toBe("1000");
  });

  it("adds the interval of the rung to the excess of a drill", () => {
    const [record] = recordsOf();
    expect(record?.evidence.find((each) => each.measure === RPO)).toMatchObject({ kind: "worst", values: [82_800.1, 82_800.1, 82_800.1, 82_800.1] });
  });

  it("stops at the first rung with a broken rule", () => {
    const cases: ReadonlyArray<readonly [string, () => GroupReading, () => GroupReading]> = [
      ["excess past the budget", () => reading({ excess: 4_000 }), noLoss],
      ["restore past the budget", () => reading({ rto: 15_000 }), noLoss],
      ["a hole", () => reading({ holes: 1 }), noLoss],
      ["lost writes that the backups do not explain", () => reading({ lost: 9 }), noLoss],
      ["data that changed", () => reading({ same: false }), noLoss],
      ["a write lost with a copy left", reading, () => reading({ lost: 1 })],
    ];
    for (const [what, run, kept] of cases) {
      const verdict = ladderVerdict(RECOVERY_LADDER, recordsOf(run, kept), { now: NOW });
      expect(verdict.rungs[0]?.outcome, what).toBe("beyond");
      expect(verdict.held, what).toBeUndefined();
    }
  });

  it("cannot decide a rung with too few counted runs", () => {
    const records = recordsOf(() => reading({ void: "the fault never committed" }));
    const verdict = ladderVerdict(RECOVERY_LADDER, records, { now: NOW });
    expect(verdict.rungs[0]?.outcome).toBe("cannot decide");
    expect(verdict.held).toBeUndefined();
  });

  it("states what is real and what is made up", () => {
    const [low, high] = recordsOf();
    expect(low?.real.join(" ")).toContain("mongorestore");
    expect(high?.real.join(" ")).toContain("slices of the oplog");
    expect(low?.synthetic.join(" ")).toContain("no detection time and no human time");
  });
});

describe("the drills", () => {
  it("are in the catalog, with a name of their own", () => {
    for (const cell of RECOVERY_CELLS) expect(ALL).toContain(cell);
    expect(RECOVERY_CELLS.map((cell) => cell.name.split(" ")[0])).toEqual(["RD.1", "RD.100.failover", "RD.100.restore", "RD.1000.failover", "RD.1000.restore", "RD.control"]);
  });

  it("starts an election above the election timeout less a heartbeat, and it gives a restore a tenth of its budget", () => {
    const failover = named("RD.100.failover").prediction;
    if (failover.detects !== true) throw new Error("a detection");
    expect(failover.low).toEqual({ value: 8000, unit: "ms" });
    expect(failover.group).toMatchObject({ lands: "new", failover: true, lost: { low: 0, high: 0 } });
    const restore = named("RD.100.restore").prediction;
    if (restore.detects !== true) throw new Error("a detection");
    expect(valueIn(restore.high, "s")).toBe(180);
    expect(restore.group).toMatchObject({ lands: "same", failover: false, lost: { low: 1, high: 202 } });
    const one = named("RD.1").prediction;
    if (one.detects !== true) throw new Error("a detection");
    expect(valueIn(one.high, "s")).toBe(1440);
    expect(one.group?.lost).toEqual({ low: 1, high: 1202 });
  });

  it("has three sizes, thus a time reads against the size", () => {
    expect(RECOVERY_RUNGS.map((rung) => rung.tenants)).toEqual([1, 100, 1000]);
    expect(named("RD.1000.restore").drill?.tenants).toBe(1000);
    expect(named("RD.1000.failover").drill?.recovery).toBe("election");
  });

  it("stops the writes of a control before its backup ends", () => {
    expect(named("RD.control").drill).toMatchObject({ quiet: true, recovery: "restore" });
    expect(RECOVERY_CELLS.filter((cell) => cell.drill?.quiet === true)).toHaveLength(1);
  });
});
