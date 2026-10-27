import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import s2 from "./s2-gate-2026-10-27.json";

const modes = ["iptables", "ipvs", "nftables"];
const ids = [...modes.map((mode) => `S2.T07.${mode}.shared-gate.dependency`), ...modes.map((mode) => `S2.T07.${mode}.shared-gate.flapping`), ...modes.map((mode) => `S2.T07.${mode}.shared-gate`)];
const cellsOf = (suffix: string) => s2.cells.filter((cell) => cell.id.endsWith(suffix));

describe("the copy of the shared gate (E) holds the figures of kind run 40533209929", () => {
  it("has the 9 cells of E, each one held in 3 of 3 runs", () => {
    expect([s2.hz, s2.runs]).toEqual([1000, 3]);
    expect(s2.cells.map((cell) => cell.id)).toEqual(ids);
    expect(s2.cells.every((cell) => cell.group === "gate" && cell.decision === "holds" && cell.counted === 3 && cell.voided === 0 && cell.failed === 0)).toBe(true);
  });

  it("gives the failed requests of the median run of a shared dependency above each limit of the rule: (a) fails", () => {
    // the limits are half the median of B: kind run 40430856093 (shared) and 40464814086 (flapping)
    expect(cellsOf(".dependency").map((cell) => cell.median)).toEqual([4729, 4325, 4365]);
    expect(cellsOf(".flapping").map((cell) => cell.median)).toEqual([13140, 13199, 13718]);
    cellsOf(".dependency").forEach((cell, at) => expect(cell.median, cell.id).toBeGreaterThan([2086, 2226, 2063][at]!));
    cellsOf(".flapping").forEach((cell, at) => expect(cell.median, cell.id).toBeGreaterThan([6137, 6478, 6604][at]!));
    for (const cell of [...cellsOf(".dependency"), ...cellsOf(".flapping")]) for (const value of cell.values) expect(value, cell.id).toBeGreaterThanOrEqual(3852);
  });

  it("gives the callers a fast 503 at the latch, and a recovery at the heal, in the bands of A", () => {
    for (const cell of [...cellsOf(".dependency"), ...cellsOf(".flapping")]) {
      for (const value of cell.knows ?? []) expect(value ?? Number.NaN, cell.id).toBeGreaterThanOrEqual(7.98);
      for (const value of cell.knows ?? []) expect(value ?? Number.NaN, cell.id).toBeLessThanOrEqual(22);
      for (const value of cell.recovers ?? []) expect(value ?? Number.NaN, cell.id).toBeGreaterThanOrEqual(0);
      for (const value of cell.recovers ?? []) expect(value ?? Number.NaN, cell.id).toBeLessThanOrEqual(9.26);
    }
    // the flapping dependency has one value for each fault of each counted run
    for (const cell of cellsOf(".flapping")) expect([cell.knows?.length, cell.recovers?.length], cell.id).toEqual([9, 9]);
  });

  it("removes the target of a pod that cannot serve in the band of B, with the failed requests of B: (b) holds", () => {
    const pods = cellsOf("shared-gate");
    expect(pods.map((cell) => cell.median)).toEqual([18.616, 18.978, 17.095]);
    const bands = [
      [350, 1913],
      [600, 1350],
      [350, 1913],
    ];
    pods.forEach((cell, at) => {
      for (const value of cell.values) expect(value, cell.id).toBeGreaterThanOrEqual(cell.prediction.band?.low ?? Number.NaN);
      for (const value of cell.values) expect(value, cell.id).toBeLessThanOrEqual(cell.prediction.band?.high ?? Number.NaN);
      for (const value of cell.failures ?? []) expect(value, cell.id).toBeGreaterThanOrEqual(bands[at]![0]!);
      for (const value of cell.failures ?? []) expect(value, cell.id).toBeLessThanOrEqual(bands[at]![1]!);
    });
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./s2-gate-2026-10-27.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
