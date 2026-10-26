import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import s2 from "./s2-partition-2026-10-26.json";

const ids = ["iptables", "ipvs", "nftables"].flatMap((mode) => [`S2.T07.${mode}.endpoints.partition`, `S2.T07.${mode}.lame-duck.partition`, `S2.T07.${mode}.goaway.partition`]);

describe("the copy of the S2 cells of a partitioned pod holds the figures of their kind run", () => {
  it("has the three candidates in each mode: each one holds in 3 counted runs", () => {
    expect([s2.hz, s2.runs]).toEqual([1000, 3]);
    expect(s2.cells.map((cell) => cell.id)).toEqual(ids);
    expect(s2.cells.every((cell) => cell.group === "partition" && cell.decision === "holds" && cell.counted === 3 && cell.voided === 0 && cell.failed === 0)).toBe(true);
    expect(s2.cells.map((cell) => cell.median)).toEqual([27, 18, 1325, 24, 24, 3953, 19, 26, 1304]);
  });

  it("gives each counted run a count of failed requests and a time of the last failure in the prediction", () => {
    for (const cell of s2.cells) {
      expect(cell.lasts.length, cell.id).toBe(cell.counted);
      for (const value of cell.values) expect(value, cell.id).toBeGreaterThanOrEqual(cell.candidate.expected.low);
      for (const value of cell.values) expect(value, cell.id).toBeLessThanOrEqual(cell.candidate.expected.high);
      expect(cell.candidate.end.from, cell.id).toBe("fault");
      for (const last of cell.lasts) {
        if (last === null) continue;
        expect(last, cell.id).toBeGreaterThanOrEqual(cell.candidate.end.low);
        expect(last, cell.id).toBeLessThanOrEqual(cell.candidate.end.high);
      }
    }
    // A and B learn in about 1.4 s at the most, and C only about 26 s after the fault, after the heal
    const latest = (label: string) => Math.max(...s2.cells.filter((cell) => cell.candidate.label === label).flatMap((cell) => cell.lasts.flatMap((last) => (last === null ? [] : [last]))));
    expect([latest("A"), latest("B")].every((each) => each < 1.5)).toBe(true);
    expect(Math.min(...s2.cells.filter((cell) => cell.candidate.label === "C").flatMap((cell) => cell.lasts.flatMap((last) => (last === null ? [] : [last]))))).toBeGreaterThan(26);
    // one run of C in nftables had no session on the target: no failure, thus no time
    expect(s2.cells.find((cell) => cell.id === "S2.T07.nftables.goaway.partition")?.lasts).toEqual([26.222634, null, 26.314664]);
  });

  it("has the prediction of each S2 cell of a partition in the catalog", () => {
    expect(s2.predictions.map((each) => each.id)).toEqual(ids);
    for (const cell of s2.cells) expect(s2.predictions.find((each) => each.id === cell.id)?.candidate, cell.id).toEqual(cell.candidate);
    // A and B are the same: the readiness stays, thus each one fails one request on each connection that picks the target
    const [a, b, c] = s2.predictions.filter((each) => each.mode === "iptables").map((each) => each.candidate);
    expect([a?.expected, a?.end]).toEqual([{ low: 12, high: 39 }, { from: "fault", low: 0, high: 2.24 }]);
    expect([b?.expected, b?.end]).toEqual([a?.expected, a?.end]);
    // C: the session on the target is stuck until the first retransmission after the heal
    expect([c?.expected, c?.end]).toEqual([{ low: 0, high: 4048 }, { from: "fault", low: 23.479, high: 26.988 }]);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./s2-partition-2026-10-26.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
