import { readFileSync } from "node:fs";
import type { GroupReading } from "@mark1russell7/harness";
import { valueIn } from "@mark1russell7/quantity";
import { checkLadder, ladderVerdict, type RungRecord } from "@mark1russell7/rigor-bench";
import { describe, expect, it } from "vitest";
import { ALL, SCHEDULED_CELLS } from "./all.ts";
import {
  faultedRecords,
  HOLES,
  RECOVERY_CELLS,
  RECOVERY_LADDER,
  RECOVERY_MEASURES,
  RECOVERY_RUNGS,
  RECOVERY_SIZE_CELLS,
  recoveryFlip,
  recoveryRecord,
  recoveryVerdict,
  RPO,
  RTO,
} from "./recovery.ts";

const AT = "2026-11-04T12:00:00.000Z";

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
    const verdict = recoveryVerdict(recordsOf(), AT);
    expect(verdict.rungs.map((rung) => rung.outcome)).toEqual(["within", "within", "within"]);
    expect(verdict.held).toBe("1000");
    expect(verdict.failed).toBe(false);
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
      const verdict = ladderVerdict(RECOVERY_LADDER, recordsOf(run, kept), { now: AT });
      expect(verdict.rungs[0]?.outcome, what).toBe("beyond");
      expect(verdict.held, what).toBeUndefined();
      expect(verdict.failed, what).toBe(true);
    }
  });

  it("cannot decide a rung with too few counted runs", () => {
    const records = recordsOf(() => reading({ void: "the fault never committed" }));
    const verdict = ladderVerdict(RECOVERY_LADDER, records, { now: AT });
    expect(verdict.rungs[0]?.outcome).toBe("cannot decide");
    expect(verdict.held).toBeUndefined();
    expect(verdict.failed).toBe(true);
  });

  it("locks each rung, thus a missing record fails it too", () => {
    expect(RECOVERY_LADDER.rungs.map((rung) => rung.locked)).toEqual([true, true, true]);
    const [first, second] = recordsOf();
    const verdict = recoveryVerdict([first!, second!], AT);
    expect(verdict.held).toBe("100");
    expect(verdict.failed).toBe(true);
  });

  it("holds each locked rung with the last record of the drills, thus a tighter budget fails each pull request", () => {
    const copy = JSON.parse(readFileSync(new URL("../../site/src/data/recovery-2026-11-04.json", import.meta.url), "utf8")) as { readonly records: RungRecord[] };
    const verdict = recoveryVerdict(copy.records, copy.records[0]!.at);
    expect(verdict.reason).toBe("Each of the 3 locked rungs is within.");
    expect(verdict.failed).toBe(false);
  });

  it("turns each locked rung beyond under the fault of each measure (SYS-99)", () => {
    const flips = recoveryFlip(recordsOf(), AT);
    expect(flips.map((each) => each.measure)).toEqual(RECOVERY_MEASURES);
    expect(RECOVERY_MEASURES).toHaveLength(6);
    expect(flips.every((each) => each.stayed.length === 0)).toBe(true);
  });

  it("injects 1.5 x the limit of a budget, or 1 above a limit of 0, and leaves the other measures", () => {
    const [low] = faultedRecords(recordsOf(), RPO);
    expect(low?.evidence.find((each) => each.measure === RPO)).toMatchObject({ values: [129_600, 129_600, 129_600, 129_600] });
    expect(low?.evidence.find((each) => each.measure === RTO)).toMatchObject({ values: [60, 60, 60, 60] });
    const [first] = faultedRecords(recordsOf(), HOLES);
    expect(first?.evidence.find((each) => each.measure === HOLES)).toMatchObject({ values: [1, 1, 1, 1] });
  });

  it("names a rung that a fault cannot turn beyond: a rung with no counted drill", () => {
    const records = recordsOf();
    const empty = records.map((record) =>
      record.rung === "100" ? { ...record, evidence: record.evidence.map((each) => (each.kind === "worst" ? { ...each, values: [] } : each)) } : record,
    );
    expect(recoveryFlip(empty, AT).map((each) => each.stayed)).toEqual(RECOVERY_MEASURES.map(() => ["100"]));
    // fewer drills than a budget needs: a value past the limit is enough for `beyond`
    const short = records.map((record) =>
      record.rung === "100" ? { ...record, evidence: record.evidence.map((each) => (each.kind === "worst" ? { ...each, values: each.values.slice(0, 3) } : each)) } : record,
    );
    expect(recoveryFlip(short, AT).every((each) => each.stayed.length === 0)).toBe(true);
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

  it("has a third size of a restore in the catalog, outside the rungs and outside the Sunday run until its time is measured", () => {
    expect(RECOVERY_SIZE_CELLS.map((cell) => cell.name.split(" ")[0])).toEqual(["RD.8000.restore"]);
    const [eight] = RECOVERY_SIZE_CELLS;
    if (eight === undefined) throw new Error("the drill of 8 GB");
    expect(ALL).toContain(eight);
    expect(eight.drill).toMatchObject({ tenants: 8_000, slices: 3, recovery: "restore" });
    expect(eight.replicaSet?.members).toHaveLength(3);
    const prediction = eight.prediction;
    if (prediction.detects !== true) throw new Error("a detection");
    expect([valueIn(prediction.low, "s"), valueIn(prediction.high, "s")]).toEqual([60, 180]);
    expect(RECOVERY_RUNGS.map((rung) => rung.drill)).not.toContain("RD.8000.restore");
    const sunday = SCHEDULED_CELLS["drills"];
    expect(ALL.filter((cell) => sunday?.test(cell.name)).map((cell) => cell.name)).toEqual(RECOVERY_CELLS.map((cell) => cell.name));
    // the cron of the workflow selects the same cells as the scheduled selection
    expect(readFileSync(new URL("../../../.github/workflows/cells.yml", import.meta.url), "utf8")).toContain(`ONLY='${sunday?.source}'`);
  });

  it("stops the writes of a control before its backup ends", () => {
    expect(named("RD.control").drill).toMatchObject({ quiet: true, recovery: "restore" });
    expect(RECOVERY_CELLS.filter((cell) => cell.drill?.quiet === true)).toHaveLength(1);
  });
});
