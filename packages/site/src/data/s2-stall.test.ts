import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import s2 from "./s2-stall-2026-10-26.json";

const ids = ["iptables", "ipvs", "nftables"].flatMap((mode) => ["endpoints", "lame-duck", "goaway", "session-check"].map((suffix) => `S2.T07.${mode}.${suffix}.stall`));
/** This time is the noise of a kind cell (KIND_NOISE of the cells, 100 ms). The judge widens each band of the window by it. */
const NOISE = 0.1;
const lastsOf = (label: string) => s2.cells.filter((cell) => cell.candidate.label === label).flatMap((cell) => cell.lasts.flatMap((last) => (last === null ? [] : [last])));

describe("the copy of the S2 cells of a stalled pod holds the figures of kind run 40406199754", () => {
  it("has the four candidates in each mode: each one holds in 3 counted runs", () => {
    expect([s2.hz, s2.runs]).toEqual([1000, 3]);
    expect(s2.cells.map((cell) => cell.id)).toEqual(ids);
    expect(s2.cells.every((cell) => cell.group === "stall" && cell.decision === "holds" && cell.counted === 3 && cell.voided === 0 && cell.failed === 0)).toBe(true);
    expect(s2.cells.map((cell) => cell.median)).toEqual([22, 18, 498, 280, 24, 24, 1498, 191, 25, 21, 498, 274]);
  });

  it("gives each counted run a count of failed requests in the prediction, and a time of the last failure in the window of the judge", () => {
    for (const cell of s2.cells) {
      expect(cell.lasts.length, cell.id).toBe(cell.counted);
      for (const value of cell.values) expect(value, cell.id).toBeGreaterThanOrEqual(cell.candidate.expected.low);
      for (const value of cell.values) expect(value, cell.id).toBeLessThanOrEqual(cell.candidate.expected.high);
      expect(cell.candidate.end.from, cell.id).toBe("fault");
      for (const last of cell.lasts) {
        if (last === null) continue;
        expect(last, cell.id).toBeGreaterThanOrEqual(cell.candidate.end.low - NOISE);
        expect(last, cell.id).toBeLessThanOrEqual(cell.candidate.end.high + NOISE);
      }
    }
    // A and B learn in about 1.2 s at the most, D before the latest removal (7.3 s), and C only at the resume, 10 s after the fault
    expect(Math.max(...lastsOf("A"), ...lastsOf("B"))).toBeLessThan(1.2);
    expect(Math.max(...lastsOf("D"))).toBeLessThan(7.3);
    expect(Math.min(...lastsOf("C"))).toBeGreaterThan(9.99);
    // the loop of C resumes at 12 s, but the close of its session reaches the client about 70 ms later at the most, in the noise of the judge
    expect(Math.max(...lastsOf("C"))).toBeGreaterThan(10);
    expect(Math.max(...lastsOf("C"))).toBeLessThan(10 + NOISE);
    // one run of C in iptables had no session on the target: no failure, thus no time
    expect(s2.cells.find((cell) => cell.id === "S2.T07.iptables.goaway.stall")?.lasts).toEqual([9.9993782, null, 10.0164164]);
  });

  it("has the prediction of each S2 cell of a stall in the catalog", () => {
    expect(s2.predictions.map((each) => each.id)).toEqual(ids);
    for (const cell of s2.cells) expect(s2.predictions.find((each) => each.id === cell.id)?.candidate, cell.id).toEqual(cell.candidate);
    // A and B are the same: the service stays ready, thus each one fails one request on each connection that picks the target
    const [a, b, c, d] = s2.predictions.filter((each) => each.mode === "iptables").map((each) => each.candidate);
    expect([a?.expected, a?.end]).toEqual([{ low: 12, high: 39 }, { from: "fault", low: 0, high: 2.24 }]);
    expect([b?.expected, b?.end]).toEqual([a?.expected, a?.end]);
    // C: the session on the target fails each stream until one timeout before the resume
    expect([c?.expected, c?.end]).toEqual([{ low: 0, high: 1503 }, { from: "fault", low: 9.98, high: 10 }]);
    // D: the removal ends each chain of the session check
    expect([d?.expected, d?.end]).toEqual([{ low: 0, high: 534 }, { from: "fault", low: 0, high: 8.105 }]);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./s2-stall-2026-10-26.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
