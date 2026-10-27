import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import s2 from "./s2-backlog-cilium-2026-10-27.json";

const SESSIONS = [1, 2, 3, 6];
const ids = SESSIONS.map((n) => `S2.T07.cilium.goaway.backlog.n${n}`);
/** This time is the noise of a kind cell (KIND_NOISE of the cells, 100 ms). The judge widens each band of the window by it. */
const NOISE = 0.1;
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

describe("the copy of the backlog cells of SYS-40 holds the figures of kind run 40575359112", () => {
  it("has C of the stall with 1, 2, 3 and 6 sessions on the target: each one holds in 5 counted runs", () => {
    expect(s2.runs).toBe(5);
    expect(s2.cells.map((cell) => cell.id)).toEqual(ids);
    expect(s2.cells.every((cell) => cell.group === "backlog" && cell.decision === "holds" && cell.counted === 5 && cell.voided === 0 && cell.failed === 0)).toBe(true);
    expect(s2.cells.map((cell) => cell.median)).toEqual([493, 988, 1487, 3005]);
  });

  it("records n sessions on the target in each run, and the stall at the fault for its hold", () => {
    s2.cells.forEach((cell, at) => {
      expect(cell.sessions, cell.id).toEqual(Array(5).fill(SESSIONS[at]));
      for (const start of cell.stallStarts) expect(start, cell.id).toBeLessThanOrEqual(0.003);
      for (const held of cell.helds) expect(held, cell.id).toBeCloseTo(12, 2);
    });
  });

  it("gives the overshoot after the band end, linear in n and below the band of d = 40 ms to 70 ms", () => {
    const overshoots = s2.cells.map((cell) => cell.lasts.map((last) => (last === null ? Number.NaN : last - cell.bandEnd)));
    // the medians: 13 ms, 59 ms, 73 ms and 156 ms
    expect(overshoots.map((each) => Math.round(median(each) * 1000))).toEqual([13, 59, 73, 156]);
    // the decision rule: the term stays linear if the overshoot with 6 sessions is 420 ms or less
    expect(Math.max(...overshoots[3]!)).toBeLessThan(0.42);
    // the miss: 19 of 20 runs came before n × 40 ms, and no run passed n × 46 ms
    const below = overshoots.flatMap((each, at) => each.filter((over) => over < SESSIONS[at]! * 0.04));
    expect(below.length).toBe(19);
    overshoots.forEach((each, at) => {
      for (const over of each) expect(over).toBeLessThan(SESSIONS[at]! * 0.046);
    });
    // each last failure is in the window of the judge
    for (const cell of s2.cells) for (const last of cell.lasts) expect(last ?? 0, cell.id).toBeLessThanOrEqual(cell.candidate.end.high + NOISE);
  });

  it("fails fewer requests than the band in each run with 1, 2 or 3 sessions: the timer of the client is late", () => {
    s2.cells.forEach((cell) => {
      const low = cell.candidate.expected.low;
      const below = cell.failures.filter((failures) => failures < low).length;
      expect(below, cell.id).toBe(cell.id.endsWith("n6") ? 1 : 5);
    });
  });

  it("has the prediction of each cell of the backlog in the catalog", () => {
    expect(s2.predictions.map((each) => each.id)).toEqual(ids);
    expect(s2.predictions.map((each) => [each.onTarget, each.bandEnd, each.overshoot.low, each.overshoot.high])).toEqual([
      [1, 10, 0.04, 0.07],
      [2, 10, 0.08, 0.14],
      [3, 10, 0.12, 0.21],
      [6, 10, 0.24, 0.42],
    ]);
    for (const cell of s2.cells) expect(s2.predictions.find((each) => each.id === cell.id)?.candidate, cell.id).toEqual(cell.candidate);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./s2-backlog-cilium-2026-10-27.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
