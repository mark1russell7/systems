import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import s2 from "./s2-zone-2026-10-27.json";

const ids = ["iptables", "ipvs", "nftables"].flatMap((mode) => ["endpoints", "lame-duck", "goaway", "session-check"].map((suffix) => `S2.T07.${mode}.${suffix}.zone`));
const middle = (values: readonly (number | null)[]) => [...values].sort((a, b) => (a ?? 0) - (b ?? 0))[1];

describe("the copy of the S2 cells of a lost zone holds the figures of kind run 40500297695", () => {
  it("has the four candidates in each mode, with the time of the removal of the target as the main value", () => {
    expect([s2.hz, s2.runs]).toEqual([1000, 3]);
    expect(s2.cells.map((cell) => cell.id)).toEqual(ids);
    expect(s2.cells.every((cell) => cell.group === "zone" && cell.decision === "holds" && cell.counted === 3 && cell.voided === 0 && cell.failed === 0)).toBe(true);
    // the removal of the target in the median run, in seconds after the fault
    expect(s2.cells.map((cell) => cell.median)).toEqual([50.393, 45.402, 49.002, 50.695, 46.541, 45.697, 45.68, 47.451, 46.149, 46.293, 45.717, 45.539]);
    // the failed requests of the median run. C fails until the 9th retransmission if a session is on the lost node
    expect(s2.cells.map((cell) => middle(cell.failures))).toEqual([21, 13, 5128, 0, 16, 16, 0, 133, 17, 23, 10464, 117]);
  });

  it("gives each counted run a removal and a return in their bands", () => {
    for (const cell of s2.cells) {
      for (const list of [cell.values, cell.failures, cell.lasts, cell.returns]) expect(list.length, cell.id).toBe(cell.counted);
      for (const value of cell.failures) expect(value, cell.id).toBeGreaterThanOrEqual(cell.candidate.expected.low);
      for (const value of cell.failures) expect(value, cell.id).toBeLessThanOrEqual(cell.candidate.expected.high);
      for (const value of cell.values) expect(value, cell.id).toBeGreaterThanOrEqual(cell.candidate.leaves.low);
      for (const value of cell.values) expect(value, cell.id).toBeLessThanOrEqual(cell.candidate.leaves.high);
      // the target is ready again after the heal, when the node lifecycle controller sees the node Ready
      for (const value of cell.returns) expect(value, cell.id).not.toBeNull();
      for (const value of cell.returns) expect(value, cell.id).toBeGreaterThanOrEqual(cell.candidate.returns.low);
      for (const value of cell.returns) expect(value, cell.id).toBeLessThanOrEqual(cell.candidate.returns.high);
    }
    // D sends 0 to 2 PINGs. A, B and C send none
    expect(s2.cells.filter((cell) => cell.candidate.label === "D").map((cell) => cell.pings)).toEqual([[0, 0, 0], [2, 2, 2], [1, 0, 2]]);
    expect(s2.cells.filter((cell) => cell.candidate.label !== "D").every((cell) => cell.pings.every((each) => each === 0))).toBe(true);
  });

  it("has the prediction of each S2 cell of a lost zone in the catalog", () => {
    expect(s2.predictions.map((each) => each.id)).toEqual(ids);
    for (const cell of s2.cells) expect(s2.predictions.find((each) => each.id === cell.id)?.candidate, cell.id).toEqual(cell.candidate);
    const [a, b, c, d] = s2.predictions.filter((each) => each.mode === "iptables").map((each) => each.candidate);
    // the node lifecycle controller removes the target 39.6 s to 55.355 s after the fault, for each candidate
    for (const each of [a, b, c, d]) expect([each?.leaves, each?.returns]).toEqual([{ from: "fault", low: 39.6, high: 55.355 }, { from: "heal", low: 0, high: 26.85 }]);
    expect([a?.expected, b?.expected]).toEqual([{ low: 6, high: 28 }, { low: 6, high: 28 }]);
    // C learns at the 9th TCP retransmission, after the heal. The session check of D bounds it
    expect([c?.expected, c?.end]).toEqual([{ low: 0, high: 10878 }, { from: "fault", low: 67.98, high: 108.78 }]);
    expect([d?.expected, d?.end]).toEqual([{ low: 0, high: 407 }, { from: "fault", low: 0, high: 10.68 }]);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./s2-zone-2026-10-27.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
