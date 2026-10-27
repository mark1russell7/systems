import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import s2 from "./s2-slow-2026-10-27.json";

const ids = ["iptables", "ipvs", "nftables"].flatMap((mode) => ["endpoints", "lame-duck", "goaway", "session-check"].map((suffix) => `S2.T07.${mode}.${suffix}.slow`));

describe("the copy of the S2 cells of a slow dependency holds the figures of kind run 40521784305", () => {
  it("has the four candidates in each mode, with the failed requests as the main value", () => {
    expect([s2.hz, s2.runs]).toEqual([1000, 3]);
    expect(s2.cells.map((cell) => cell.id)).toEqual(ids);
    expect(s2.cells.every((cell) => cell.group === "slow" && cell.decision === "holds" && cell.counted === 3 && cell.voided === 0 && cell.failed === 0)).toBe(true);
    // the failed requests of the median run: A and B queue their requests on HTTP/1.1, and C and D fail none
    expect(s2.cells.map((cell) => cell.median)).toEqual([3487, 3483, 0, 0, 3486, 3487, 0, 0, 3487, 3482, 0, 0]);
  });

  it("gives each counted run of A and B its failed requests in their band, and its last failure before the heal", () => {
    for (const cell of s2.cells) {
      for (const list of [cell.values, cell.recovers, cell.pings]) expect(list.length, cell.id).toBe(cell.counted);
      for (const value of cell.values) expect(value, cell.id).toBeGreaterThanOrEqual(cell.candidate.expected.low);
      for (const value of cell.values) expect(value, cell.id).toBeLessThanOrEqual(cell.candidate.expected.high);
    }
    const queued = s2.cells.filter((cell) => cell.candidate.label === "A" || cell.candidate.label === "B");
    const recovers = queued.flatMap((cell) => cell.recovers.map((each) => each ?? Number.NaN));
    // the last failure starts 1.70 s to 1.73 s before the heal: up to 38 ms after the band of -2.02 s to -1.74 s, in the noise of the judge (100 ms)
    expect([Math.min(...recovers), Math.max(...recovers)].map((each) => Math.round(each * 1000) / 1000)).toEqual([-1.725, -1.702]);
    for (const value of recovers) expect(value).toBeLessThan(-1.74 + 0.1);
    // C and D fail no request, thus no run has a last failure
    expect(s2.cells.filter((cell) => !queued.includes(cell)).every((cell) => cell.recovers.every((each) => each === null))).toBe(true);
    // no candidate sends a PING: the delay is shorter than the tick of the session check of D
    expect(s2.cells.every((cell) => cell.pings.every((each) => each === 0))).toBe(true);
  });

  it("has the prediction of each S2 cell of a slow dependency in the catalog", () => {
    expect(s2.predictions.map((each) => each.id)).toEqual(ids);
    for (const cell of s2.cells) expect(s2.predictions.find((each) => each.id === cell.id)?.candidate, cell.id).toEqual(cell.candidate);
    const [a, b, c, d] = s2.predictions.filter((each) => each.mode === "iptables").map((each) => each.candidate);
    for (const each of [a, b]) expect([each?.expected, each?.start, each?.end]).toEqual([{ low: 3240, high: 3744 }, { from: "fault", low: 0.96, high: 2.24 }, { from: "heal", low: -2.02, high: -1.74 }]);
    for (const each of [c, d]) expect([each?.expected, each?.start, each?.end]).toEqual([{ low: 0, high: 0 }, null, null]);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./s2-slow-2026-10-27.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
