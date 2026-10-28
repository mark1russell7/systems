import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import s2 from "./s2-backlog-drain-cilium-2026-10-28.json";

const SESSIONS = [1, 2, 3, 6];
const ids = SESSIONS.map((n) => `S2.T07.cilium.goaway.backlog-drain.n${n}`);
/** These are the bands of the backlog term of SYS-42 and SYS-43: d = 10 ms to 45 ms for each session. */
const D = { lo: 0.01, hi: 0.045 };
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/** SYS-43: the drain band, from kind run 40608863500. */
describe("the copy of the drain band of SYS-43 holds the figures of its kind run", () => {
  it("has C of the stall with 1, 2, 3 and 6 sessions on the target, with n sessions in each counted run", () => {
    expect(s2.runs).toBe(5);
    expect(s2.cells.map((cell) => cell.id)).toEqual(ids);
    // the run with 6 sessions has one void run: the VM was not quiet in 300 s
    expect(s2.cells.map((cell) => [cell.counted, cell.voided])).toEqual([
      [5, 0],
      [5, 0],
      [5, 0],
      [4, 1],
    ]);
    s2.cells.forEach((cell, at) => {
      expect(cell.group, cell.id).toBe("backlog");
      expect(cell.sessions, cell.id).toEqual(Array(cell.counted).fill(SESSIONS[at]));
      for (const held of cell.helds) expect(held, cell.id).toBeCloseTo(12, 2);
    });
    expect(s2.cells.map((cell) => [cell.decision, cell.failed])).toEqual([
      ["holds", 0],
      ["holds", 0],
      ["holds", 0],
      ["holds", 0],
    ]);
  });

  it("gives the overshoot after the band end in the window band of n × 10 ms to n × 45 ms, except three runs with 1 session", () => {
    const overshoots = s2.cells.map((cell) => cell.lasts.map((last) => (last === null ? Number.NaN : last - cell.bandEnd)));
    // the medians: 37 ms, 36 ms, 54 ms and 171 ms
    expect(overshoots.map((each) => Math.round(median(each) * 1000))).toEqual([37, 36, 54, 171]);
    const below = overshoots.map((each, at) => each.filter((over) => over < SESSIONS[at]! * D.lo).length);
    const above = overshoots.map((each, at) => each.filter((over) => over > SESSIONS[at]! * D.hi).length);
    // with 1 session: 9 ms below 10 ms, and 50 ms and 58 ms above 45 ms
    expect(below).toEqual([1, 0, 0, 0]);
    expect(above).toEqual([2, 0, 0, 0]);
    expect(overshoots[0]!.map((over) => Math.round(over * 1000)).sort((a, b) => a - b)).toEqual([9, 21, 37, 50, 58]);
  });

  it("counts each run at its mean period, with the drain: each count is in its band", () => {
    const outside = s2.cells.map((cell) => cell.failures.filter((failures, run) => failures < cell.counts![run]!.low || failures > cell.counts![run]!.high).length);
    expect(outside).toEqual([0, 0, 0, 0]);
    // the mean period of each run: 10.12 ms to 10.24 ms, for a setting of 10 ms
    for (const cell of s2.cells) for (const period of cell.periods!) expect(period > 0.01012 && period < 0.01024, cell.id).toBe(true);
    // for example, 3010 failed requests with 6 sessions are in 2928 to 3048 at 10.21 ms
    expect([s2.cells[3]!.failures[0], s2.cells[3]!.counts![0]]).toEqual([3010, { low: 2928, high: 3048 }]);
    s2.predictions.forEach((each, at) => expect([each.overshoot.low, each.overshoot.high]).toEqual([SESSIONS[at]! * D.lo, SESSIONS[at]! * D.hi].map((x) => Math.round(x * 1000) / 1000)));
  });

  it("keeps the CI facts: the hang of the run of SYS-42 and the void of the bounded wait", () => {
    expect(s2.ci.hangs).toEqual([expect.objectContaining({ run: 40591832542, shard: 3, sessions: 6, step: "The cells", outcome: "cancelled" })]);
    expect(s2.ci.voids.map((each) => each.why)).toEqual(["the VM was not quiet in 300 s: 59% idle, other lab containers: none"]);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./s2-backlog-drain-cilium-2026-10-28.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
