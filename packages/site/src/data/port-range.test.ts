import { describe, expect, it } from "vitest";
import copy from "./port-range-2026-11-17.json";

const cell = (plan: string) => {
  const found = copy.cells.find((each) => each.plan === plan);
  if (found === undefined || found.result === null) throw new Error(`the copy has no result of ${plan}`);
  return { ...found, result: found.result };
};
const runs = (plan: string) => cell(plan).result.runs;
const total = (plan: string, connects: string) => runs(plan).reduce((sum, run) => sum + ((run.counts as Readonly<Record<string, number>>)[connects] ?? 0), 0);
const firstFreed = (plan: string) => runs(plan).map((run) => run.firstFreed ?? Number.NaN);

describe("the copy of the port range holds the figures of its CI run", () => {
  it("has the 8 cells at one commit, on Linux 7.0 at HZ 1000, with 4 runs in 2 environments", () => {
    expect([copy.commit, copy.kernel, copy.hz, copy.runs, copy.low]).toEqual(["9398ddbbd62aad8bb3acc79d3851975acd65683d", "7.0.0", 1000, 4, 40000]);
    expect(copy.cells.map((each) => each.plan)).toEqual(["PR.1", "PR.2", "PR.3", "PR.4", "PR.5", "PR.6", "PR.7", "PR.8"]);
    // the page: "Each of the 8 cells holds", "32 counted runs, and no run is void"
    for (const each of copy.cells) {
      expect([each.plan, each.result?.decision, each.result?.counted, each.result?.voided]).toEqual([each.plan, "holds", 4, 0]);
      expect(each.result?.runs.map((run) => run.environment)).toEqual([0, 0, 1, 1]);
    }
  });

  it("gives the counts of the searches as the page gives them", () => {
    // "16 connects in each of the 200 searches of PR.1", "in 120 µs or less"
    expect([total("PR.1", "16"), Math.max(...runs("PR.1").map((run) => run.refusal ?? Number.NaN))]).toEqual([200, 0.00012]);
    expect(total("PR.2", "2")).toBe(200);
    // "5 connects in 1,303 of the 1,600 searches of PR.3", "0.8 to 0.8275"
    expect([total("PR.3", "5"), total("PR.3", "4")]).toEqual([1303, 297]);
    expect([Math.min(...runs("PR.3").map((run) => run.share ?? Number.NaN)), Math.max(...runs("PR.3").map((run) => run.share ?? Number.NaN))]).toEqual([0.8, 0.8275]);
    expect(cell("PR.3").prediction.share).toEqual({ count: 5, low: 0.7291, high: 0.9194 });
    expect(total("PR.4", "16")).toBe(400);
  });

  it("gives the times of the held ports inside their bands, as the page gives them", () => {
    // "60.551 s to 61.121 s", "1.001 s to 1.011 s", "203.1 ms to 213.9 ms"
    expect([Math.min(...firstFreed("PR.5")), Math.max(...firstFreed("PR.5"))]).toEqual([60.551381, 61.120951]);
    expect([Math.min(...firstFreed("PR.6")), Math.max(...firstFreed("PR.6"))]).toEqual([1.00121, 1.01104]);
    expect([Math.min(...firstFreed("PR.8")), Math.max(...firstFreed("PR.8"))]).toEqual([0.203131, 0.213895]);
    for (const plan of ["PR.5", "PR.6", "PR.8"]) {
      const band = cell(plan).prediction.freed;
      for (const time of firstFreed(plan)) expect(band !== null && time >= band.low && time <= band.high, `${plan} ${time}`).toBe(true);
    }
    // "4 retransmissions, one for each port", and PR.7: "with no retransmission"
    expect(runs("PR.8").map((run) => run.retransmissions)).toEqual([4, 4, 4, 4]);
    expect(runs("PR.7").map((run) => [run.searches, run.counts["4" as keyof typeof run.counts], run.retransmissions])).toEqual(Array.from({ length: 4 }, () => [10, 10, 0]));
  });
});
