import { readFileSync } from "node:fs";
import { valueIn } from "@mark1russell7/quantity";
import type { Arm } from "@mark1russell7/rigor-bench";
import { checkPairedTime, firstArm, timeVerdict } from "@mark1russell7/rigor-bench";
import { describe, expect, it } from "vitest";
import bench from "./limiter-bench-2026-11-03.json";

const plans = ["O30.1", "O30.2", "O29.1", "O29.2", "O29.3", "O29.4"];
const records = bench.records as unknown as readonly { pair: string; measure: string; case: string; round: number; first: Arm; a: { value: number; unit: "s" }; b: { value: number; unit: "s" } }[];
// the landing script checked each line against the plan of limiterBench (packages/cells) and against paired.ndjson
const of = (measure: string, block: string) =>
  records
    .filter((line) => line.measure === measure && line.pair === block)
    .map((line) => checkPairedTime({ case: line.case, round: line.round, first: line.first, a: valueIn(line.a, "s"), b: valueIn(line.b, "s") }));

describe(`the copy of the paired run of the limiter cells holds the verdicts of rigor-bench of workflow ${bench.workflow}`, () => {
  it("has each slot of the plan of the pair, and each cell holds", () => {
    expect([bench.pair, bench.only, bench.shards, bench.rounds]).toEqual([{ control: "0.5.6", candidate: "0.6.0" }, "^O(29|30)[.]", 6, 7]);
    expect([bench.cells.count, bench.cells.holds, bench.cells.again, bench.slots.length]).toEqual([168, 168, 0, 168]);
    expect(new Set(bench.slots.map((slot) => slot.name)).size).toBe(168);
    // each round of each spec has the A/B pair, then the A/A pair, and the runner of each spec is shard k % 6
    bench.slots.forEach((slot, at) => {
      expect([slot.plan, at % 6], slot.name).toEqual([plans[slot.offset], slot.offset]);
      const candidate = slot.block === "ab" && slot.arm === "b";
      expect(slot.service, slot.name).toBe(candidate ? "0.6.0" : "0.5.6");
      expect(slot.first, slot.name).toBe(firstArm(slot.round, slot.offset));
      expect(slot.decision, slot.name).toBe("holds");
    });
    for (const runner of Object.values(bench.runners)) expect([runner.cpus, runner.hz]).toEqual([4, 1000]);
  });

  it("turns the order of each pair each round with firstArm, on the A/B pair and the A/A pair", () => {
    for (const line of records) {
      const offset = plans.findIndex((plan) => line.case.startsWith(`${plan} `));
      expect(line.first, line.case).toBe(firstArm(line.round, offset));
    }
    for (const block of ["ab", "aa"]) {
      for (const name of new Set(records.filter((line) => line.pair === block).map((line) => line.case))) {
        const rounds = records.filter((line) => line.pair === block && line.case === name);
        const firsts = rounds.filter((line) => line.first === "a").length;
        expect(Math.abs(2 * firsts - rounds.length), `${block} ${name}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("keeps each time as an amount in seconds, above 0", () => {
    for (const line of records) {
      for (const time of [line.a, line.b]) {
        expect(time.unit).toBe("s");
        expect(valueIn(time, "s")).toBeGreaterThan(0);
      }
    }
  });

  it("gives the same verdict of each measure again from the records, with 5 or more A/A cases", () => {
    expect(bench.bench).toMatchObject({ package: "@mark1russell7/rigor-bench", options: { rule: "difference", margin: 0.05 } });
    // 0.2 tests the margin before faster and slower (rigor#25): the verdicts come from that order
    expect(bench.bench.version).toMatch(/^0\.2\.\d+$/);
    expect(bench.verdicts.map((verdict) => verdict.measure)).toEqual(["retry", "answer"]);
    for (const copied of bench.verdicts) {
      expect(copied.cases.aa, copied.measure).toBeGreaterThanOrEqual(5);
      const verdict = timeVerdict(of(copied.measure, "ab"), of(copied.measure, "aa"), { rule: "difference", margin: 0.05 });
      expect([verdict.outcome, verdict.reason], copied.measure).toEqual([copied.outcome, copied.reason]);
    }
    expect(bench.verdicts.map((verdict) => verdict.outcome)).toEqual(["same", "cannot decide"]);
  });

  it("names no machine: no address, identifier, path or user", () => {
    const text = readFileSync(new URL("./limiter-bench-2026-11-03.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    // an @ is only the scope of rigor-bench, or the clock of a CPU model ("CPU @ 2.80GHz")
    expect(text).not.toMatch(/@(?!mark1russell7\/rigor-bench"| \d)|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
