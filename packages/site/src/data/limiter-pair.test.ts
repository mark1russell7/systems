import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pair from "./limiter-pair-2026-10-27.json";

const plans = ["O30.1", "O30.2", "O29.1", "O29.2", "O29.3", "O29.4"];
const middle = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
};

describe("the copy of the paired run of the limiter cells holds the figures of workflow 40471731235", () => {
  it("has each spec in both versions on one shard of six, and each cell holds", () => {
    expect([pair.shards, pair.runs, pair.bootstrap.resamples, pair.bootstrap.seed]).toEqual([6, 11, 10000, 20261027]);
    expect(pair.cells.map((cell) => [cell.plan, cell.shard])).toEqual(plans.map((plan, at) => [plan, `cells-${at}`]));
    expect(pair.summaries.map((row) => [row.name.split(" ")[0], row.shard])).toEqual(plans.flatMap((plan, at) => [[plan, `cells-${at}`], [plan, `cells-${at}`]]));
    expect(pair.summaries.map((row) => / of service (\d+\.\d+),/.exec(row.name)?.[1])).toEqual(plans.flatMap(() => ["0.5", "0.6"]));
    expect(pair.summaries.every((row) => row.decision === "holds" && row.counted === 11 && row.voided === 0)).toBe(true);
    for (const runner of Object.values(pair.runners)) expect(runner.image).toBe("ubuntu24 20261023.334.3");
  });

  it("gives each d from the counted runs, within its tolerance, with an interval that contains 0", () => {
    for (const cell of pair.cells) {
      const [control, candidate] = pair.summaries.filter((row) => row.name.startsWith(`${cell.plan} `));
      expect([cell.control.values.length, cell.candidate.values.length], cell.plan).toEqual([11, 11]);
      // the median of the counted runs is the median of the summary line of the harness
      expect(middle(cell.control.values), cell.plan).toBe(control!.median.value);
      expect(middle(cell.candidate.values), cell.plan).toBe(candidate!.median.value);
      expect(cell.d, cell.plan).toBeCloseTo((cell.candidate.median - cell.control.median) * 1000, 3);
      expect(Math.abs(cell.d), cell.plan).toBeLessThanOrEqual(cell.tolerance);
      expect(cell.interval[0]! <= 0 && 0 <= cell.interval[1]!, cell.plan).toBe(true);
      expect(cell.verdict, cell.plan).toBe("within");
    }
    expect(pair.cells.map((cell) => cell.d)).toEqual([-0.818, -0.006, 0.287, 0.148, -0.056, -0.025]);
    expect(pair.cells.map((cell) => cell.tolerance)).toEqual([1, 1, 1, 1, 0.5, 0.5]);
  });

  it("says which intervals cross their tolerance, and the runs that would fit each one inside it", () => {
    // no detectable shift, not equivalence: four intervals go past the tolerance on one side
    expect(pair.cells.map((cell) => cell.crosses)).toEqual([["low"], ["high"], ["high"], ["high"], [], []]);
    expect(pair.cells.map((cell) => cell.runs_needed)).toEqual([1399, 23, 14, 12, 4, 8]);
    // the unpaired control: O29.1 was over its tolerance of 1 ms
    expect(pair.cells.filter((cell) => Math.abs(cell.unpaired) > cell.tolerance).map((cell) => cell.plan)).toEqual(["O29.1"]);
  });

  it("names no machine: no image digest, address, user or path", () => {
    const text = readFileSync(new URL("./limiter-pair-2026-10-27.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
