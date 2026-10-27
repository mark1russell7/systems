import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import s2 from "./s2-flapping-2026-10-27.json";

const ids = ["iptables", "ipvs", "nftables"].flatMap((mode) => ["endpoints", "lame-duck", "goaway", "session-check"].map((suffix) => `S2.T07.${mode}.${suffix}.flapping`));
/** The schedule of the trigger: 3 faults in each run. */
const FAULTS = 3;
/** This time is the noise of a kind cell (KIND_NOISE of the cells, 100 ms). The judge widens each band of the window by it. */
const NOISE = 0.1;
const middle = (values: readonly (number | null)[]) => [...values].sort((a, b) => (a ?? 0) - (b ?? 0))[1];

describe("the copy of the S2 cells of a flapping dependency holds the figures of kind run 40464814086", () => {
  it("has the four candidates in each mode, with the time of the empty Service after the first fault as the main value", () => {
    expect([s2.hz, s2.runs]).toEqual([1000, 3]);
    expect(s2.cells.map((cell) => cell.id)).toEqual(ids);
    expect(s2.cells.every((cell) => cell.group === "flapping" && cell.decision === "holds" && cell.counted === 3 && cell.voided === 0 && cell.failed === 0)).toBe(true);
    // the empty Service of the median run, in seconds after the first fault
    expect(s2.cells.map((cell) => cell.median)).toEqual([19.941, 17.721, 18.383, 20.211, 20.767, 19.422, 18.852, 18.778, 18.262, 18.156, 19.853, 17.058]);
    // the failed requests of the median run, for the 3 faults. B has the fewest in each mode
    expect(s2.cells.map((cell) => middle(cell.failures))).toEqual([13935, 12274, 13516, 13866, 13434, 12956, 13443, 14144, 14213, 13207, 14102, 13805]);
  });

  it("gives each fault of each counted run a time of the empty Service and the times of the callers", () => {
    for (const cell of s2.cells) {
      for (const list of [cell.values, cell.failures, cell.lasts]) expect(list.length, cell.id).toBe(cell.counted);
      for (const list of [cell.knows, cell.recovers, cell.emptied]) expect(list.length, cell.id).toBe(cell.counted * FAULTS);
      // each count of a run is in the band of 3 faults
      for (const value of cell.failures) expect(value, cell.id).toBeGreaterThanOrEqual(cell.candidate.expected.low);
      for (const value of cell.failures) expect(value, cell.id).toBeLessThanOrEqual(cell.candidate.expected.high);
      // the Service is empty in its band after each fault, not only after the first one
      for (const value of cell.emptied) expect(value, cell.id).toBeGreaterThanOrEqual(cell.candidate.removal.low - NOISE);
      for (const value of cell.emptied) expect(value, cell.id).toBeLessThanOrEqual(cell.candidate.removal.high + NOISE);
      // each recovery is in the band of the end of its window, after its heal
      for (const value of cell.recovers) expect(value, cell.id).not.toBeNull();
      for (const value of cell.recovers) expect(value, cell.id).toBeGreaterThanOrEqual(cell.candidate.end.low);
      for (const value of cell.recovers) expect(value, cell.id).toBeLessThanOrEqual(cell.candidate.end.high);
      for (const value of cell.knows) expect(value, cell.id).toBeGreaterThanOrEqual(cell.candidate.knows.low);
      for (const value of cell.knows) expect(value, cell.id).toBeLessThanOrEqual(cell.candidate.knows.high);
    }
    // a last failure can start before its heal: the band of B, C and D starts at -2 s, from the correction of run 40430856093
    expect(Math.min(...s2.cells.flatMap((cell) => cell.recovers.flatMap((each) => (each === null ? [] : [each]))))).toBe(-1.3560287);
    // D sends PINGs for each fault, approximately 3 times those of one fault. A, B and C send none
    expect(s2.cells.filter((cell) => cell.candidate.label === "D").map((cell) => cell.pings)).toEqual([[123, 135, 122], [131, 138, 124], [112, 123, 126]]);
    expect(s2.cells.filter((cell) => cell.candidate.label !== "D").every((cell) => cell.pings.every((each) => each === 0))).toBe(true);
  });

  it("has the prediction of each S2 cell of a flapping dependency in the catalog", () => {
    expect(s2.predictions.map((each) => each.id)).toEqual(ids);
    for (const cell of s2.cells) expect(s2.predictions.find((each) => each.id === cell.id)?.candidate, cell.id).toEqual(cell.candidate);
    const [a, b, c, d] = s2.predictions.filter((each) => each.mode === "iptables").map((each) => each.candidate);
    for (const each of [a, b, c, d]) expect([each?.removal, each?.start]).toEqual([{ from: "fault", low: 12, high: 26.105 }, { from: "fault", low: 0, high: 0.02 }]);
    // A knows at the latch. B, C and D fail slowly until each heal
    expect(a?.knows).toEqual({ from: "fault", low: 7.98, high: 22 });
    for (const each of [b, c, d]) expect(each?.knows).toEqual({ from: "fault", low: 24.98, high: 27.5 });
    // the band of each fault, and the band of the run: 3 times the band of each fault
    expect([a?.each, a?.expected, a?.end]).toEqual([{ low: 3852, high: 5517 }, { low: 11556, high: 16551 }, { from: "heal", low: 0, high: 9.26 }]);
    expect([b?.each, b?.expected, b?.end]).toEqual([{ low: 3567, high: 5835 }, { low: 10701, high: 17505 }, { from: "heal", low: -2, high: 11.365 }]);
    expect([c?.each, c?.expected, c?.end]).toEqual([{ low: 3567, high: 5814 }, { low: 10701, high: 17442 }, { from: "heal", low: -2, high: 11.225 }]);
    expect([d?.each, d?.expected, d?.end]).toEqual([c?.each, c?.expected, c?.end]);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./s2-flapping-2026-10-27.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
