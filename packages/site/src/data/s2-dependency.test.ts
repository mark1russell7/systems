import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import s2 from "./s2-dependency-2026-10-27.json";

const ids = ["iptables", "ipvs", "nftables"].flatMap((mode) => ["endpoints", "lame-duck", "goaway", "session-check"].map((suffix) => `S2.T07.${mode}.${suffix}.dependency`));
/** This time is the noise of a kind cell (KIND_NOISE of the cells, 100 ms). The judge widens each band of the window by it. */
const NOISE = 0.1;
const middle = (values: readonly (number | null)[]) => [...values].sort((a, b) => (a ?? 0) - (b ?? 0))[1];

describe("the copy of the S2 cells of a black-holed shared dependency holds the figures of kind run 40430856093", () => {
  it("has the four candidates in each mode, with the time of the empty Service as the main value", () => {
    expect([s2.hz, s2.runs]).toEqual([1000, 3]);
    expect(s2.cells.map((cell) => cell.id)).toEqual(ids);
    expect(s2.cells.every((cell) => cell.group === "dependency" && cell.counted === 3 && cell.voided === 0)).toBe(true);
    // the gap: one run of B in nftables recovered before its window could end
    expect(s2.cells.map((cell) => cell.failed)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]);
    // the empty Service of the median run, in seconds after the fault
    expect(s2.cells.map((cell) => cell.median)).toEqual([18.165, 17.524, 16.982, 18.006, 19.418, 19.713, 18.288, 18.38, 18.549, 19.298, 17.59, 19.652]);
    // the failed requests of the median run: no replica can serve, thus each candidate fails each request until it recovers
    expect(s2.cells.map((cell) => middle(cell.failures))).toEqual([5019, 4173, 4403, 4690, 4530, 4452, 4492, 4778, 4714, 4126, 4677, 4932]);
  });

  it("gives each counted run a time of the empty Service, a count of failed requests, and the times of the callers", () => {
    for (const cell of s2.cells) {
      for (const list of [cell.values, cell.failures, cell.lasts, cell.knows, cell.recovers]) expect(list.length, cell.id).toBe(cell.counted);
      // each empty Service is in its band, after the fault
      for (const value of cell.values) expect(value, cell.id).toBeGreaterThanOrEqual(cell.candidate.removal.low - NOISE);
      for (const value of cell.values) expect(value, cell.id).toBeLessThanOrEqual(cell.candidate.removal.high + NOISE);
      // each recovery is under the end of its window, after the heal
      for (const value of cell.recovers) if (value !== null) expect(value, cell.id).toBeLessThanOrEqual(cell.candidate.end.high);
    }
    // A keeps its connections, thus its callers get a 503 at once after the latch trips
    for (const cell of s2.cells.filter((each) => each.candidate.label === "A")) for (const knows of cell.knows) expect(knows, cell.id).toBeLessThanOrEqual(cell.candidate.knows.high);
    // the gap: B, C and D fail slowly on the empty Service until the heal, after the band of 7.98 s to 22 s
    for (const cell of s2.cells.filter((each) => each.candidate.label !== "A")) for (const knows of cell.knows) expect(knows, cell.id).toBeGreaterThan(26);
    // the gap: the last failure of one run of B in nftables started before the heal, and that run had 3953 failed requests, under the band of 3954
    const late = s2.cells.find((cell) => cell.id === "S2.T07.nftables.lame-duck.dependency");
    expect([late?.failures, late?.recovers]).toEqual([[4392, 3953, 4126], [2.3613126, null, 0.533418]]);
  });

  it("has the prediction of each S2 cell of a shared dependency in the catalog", () => {
    expect(s2.predictions.map((each) => each.id)).toEqual(ids);
    for (const cell of s2.cells) expect(s2.predictions.find((each) => each.id === cell.id)?.candidate, cell.id).toEqual(cell.candidate);
    const [a, b, c, d] = s2.predictions.filter((each) => each.mode === "iptables").map((each) => each.candidate);
    for (const each of [a, b, c, d]) {
      // the Service is empty for each candidate, and the first failure comes at the fault
      expect([each?.removal, each?.knows, each?.start]).toEqual([{ from: "fault", low: 12, high: 26.105 }, { from: "fault", low: 7.98, high: 22 }, { from: "fault", low: 0, high: 0.02 }]);
    }
    // A recovers with the readiness of the service, and B, C and D also wait for the kubelet and the propagation
    expect([a?.expected, a?.end]).toEqual([{ low: 3954, high: 5742 }, { from: "heal", low: 0, high: 9.26 }]);
    expect([b?.expected, b?.end]).toEqual([{ low: 3954, high: 6060 }, { from: "heal", low: 0, high: 11.365 }]);
    expect([c?.expected, c?.end]).toEqual([{ low: 3954, high: 6039 }, { from: "heal", low: 0, high: 11.225 }]);
    expect([d?.expected, d?.end]).toEqual([c?.expected, c?.end]);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./s2-dependency-2026-10-27.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
