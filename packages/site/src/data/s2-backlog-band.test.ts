import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import s2 from "./s2-backlog-band-cilium-2026-10-27.json";

const SESSIONS = [1, 2, 3, 6];
const ids = SESSIONS.map((n) => `S2.T07.cilium.goaway.backlog-band.n${n}`);
/** These are the bands of the backlog term of SYS-42: d = 10 ms to 45 ms for each session. */
const D = { lo: 0.01, hi: 0.045 };
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/** SYS-42: the backlog band, from kind runs 40591832542 (n = 1, 2, 3) and 40601022555 (n = 6). */
describe("the copy of the backlog band of SYS-42 holds the figures of its kind runs", () => {
  it("has C of the stall with 1, 2, 3 and 6 sessions on the target, each with 5 counted runs and n sessions in each run", () => {
    expect(s2.runs).toBe(5);
    expect(s2.cells.map((cell) => cell.id)).toEqual(ids);
    s2.cells.forEach((cell, at) => {
      expect(cell.group, cell.id).toBe("backlog");
      expect([cell.counted, cell.voided], cell.id).toEqual([5, 0]);
      expect(cell.sessions, cell.id).toEqual(Array(5).fill(SESSIONS[at]));
      for (const start of cell.stallStarts) expect(start, cell.id).toBeLessThanOrEqual(0.003);
      for (const held of cell.helds) expect(held, cell.id).toBeCloseTo(12, 2);
    });
    // each cell fails in the judge: the count band misses in 1, 2, 1 and 5 runs
    expect(s2.cells.map((cell) => [cell.decision, cell.failed])).toEqual([
      ["fails", 1],
      ["fails", 2],
      ["fails", 1],
      ["fails", 5],
    ]);
  });

  it("gives the overshoot after the band end in the window band of n × 10 ms to n × 45 ms, except one run with 1 session", () => {
    const overshoots = s2.cells.map((cell) => cell.lasts.map((last) => (last === null ? Number.NaN : last - cell.bandEnd)));
    // the medians: 36 ms, 58 ms, 49 ms and 117 ms
    expect(overshoots.map((each) => Math.round(median(each) * 1000))).toEqual([36, 58, 49, 117]);
    const outside = overshoots.map((each, at) => each.filter((over) => over < SESSIONS[at]! * D.lo || over > SESSIONS[at]! * D.hi).length);
    expect(outside).toEqual([1, 0, 0, 0]);
    // the one miss: 90 ms with 1 session, above 45 ms
    expect(Math.round(Math.max(...overshoots[0]!) * 1000)).toBe(90);
    s2.predictions.forEach((each, at) => expect([each.overshoot.low, each.overshoot.high]).toEqual([SESSIONS[at]! * D.lo, SESSIONS[at]! * D.hi].map((x) => Math.round(x * 1000) / 1000)));
  });

  it("counts each run at its mean period: the count misses above, in each run with 6 sessions", () => {
    const above = s2.cells.map((cell) => cell.failures.filter((failures, run) => failures > cell.counts![run]!.high).length);
    const below = s2.cells.map((cell) => cell.failures.filter((failures, run) => failures < cell.counts![run]!.low).length);
    expect(above).toEqual([1, 2, 1, 5]);
    expect(below).toEqual([0, 0, 0, 0]);
    // the mean period of each run: 10.18 ms to 10.25 ms, for a setting of 10 ms
    for (const cell of s2.cells) for (const period of cell.periods!) expect(period > 0.01018 && period < 0.01025, cell.id).toBe(true);
    // the failures of each session: approximately 494 with 1 to 3 sessions, and approximately 496 with 6
    expect(s2.cells.map((cell, at) => Math.round(median(cell.failures) / SESSIONS[at]!))).toEqual([494, 495, 494, 496]);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./s2-backlog-band-cilium-2026-10-27.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
