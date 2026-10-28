import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import s2 from "./s2-backlog-terms-cilium-2026-10-28.json";

const SESSIONS = [1, 2];
const ids = SESSIONS.map((n) => `S2.T07.cilium.goaway.backlog-terms.n${n}`);
/** These are the bands of the backlog term of SYS-42 and SYS-43: d = 10 ms to 45 ms for each session. */
const D = { lo: 0.01, hi: 0.045 };
/** The terms of SYS-45: one turn of approximately 20 ms for the early start, and one slow session of up to 100 ms. */
const TURN = 0.02;
const SLOWEST = 0.1;
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/** SYS-45: the terms band, from kind run 40622388164. */
describe("the copy of the terms band of SYS-45 holds the figures of its kind run", () => {
  it("has C of the stall with 1 and 2 sessions on the target, 10 counted runs each, and both cells hold", () => {
    expect(s2.runs).toBe(10);
    expect(s2.cells.map((cell) => cell.id)).toEqual(ids);
    expect(s2.cells.map((cell) => [cell.counted, cell.voided])).toEqual([
      [10, 0],
      [10, 0],
    ]);
    s2.cells.forEach((cell, at) => {
      expect(cell.group, cell.id).toBe("backlog");
      expect(cell.sessions, cell.id).toEqual(Array(cell.counted).fill(SESSIONS[at]));
    });
    expect(s2.cells.map((cell) => [cell.decision, cell.failed])).toEqual([
      ["holds", 0],
      ["holds", 0],
    ]);
  });

  it("gives each overshoot in the terms band, with runs in the zones of both terms", () => {
    const overshoots = s2.cells.map((cell) => cell.lasts.map((last) => (last === null ? Number.NaN : last - cell.bandEnd)));
    // the medians: 16 ms and 54 ms
    expect(overshoots.map((each) => Math.round(median(each) * 1000))).toEqual([16, 54]);
    expect(overshoots[0]!.map((over) => Math.round(over * 1000)).sort((a, b) => a - b)).toEqual([3, 3, 4, 5, 8, 16, 18, 26, 29, 78]);
    expect(overshoots[1]!.map((over) => Math.round(over * 1000)).sort((a, b) => a - b)).toEqual([30, 41, 47, 50, 52, 54, 56, 78, 82, 94]);
    s2.predictions.forEach((each, at) => {
      const n = SESSIONS[at]!;
      expect([each.overshoot.low, each.overshoot.high]).toEqual([n * D.lo - TURN, (n - 1) * D.hi + SLOWEST].map((x) => Math.round(x * 1000) / 1000));
      for (const over of overshoots[at]!) expect(over >= each.overshoot.low && over <= each.overshoot.high, `${each.id} ${over}`).toBe(true);
    });
    // the zone of the early start, below n × d.lo: 5 of 10 runs with 1 session, none with 2
    const early = overshoots.map((each, at) => each.filter((over) => over < SESSIONS[at]! * D.lo).length);
    expect(early).toEqual([5, 0]);
    // the zone of the slow session, above n × d.hi: 78 ms with 1 session and 94 ms with 2 sessions
    const slow = overshoots.map((each, at) => each.filter((over) => over > SESSIONS[at]! * D.hi).length);
    expect(slow).toEqual([1, 1]);
  });

  it("counts each run at its mean period, with the drain of the slow session: each count is in its band", () => {
    const outside = s2.cells.map((cell) => cell.failures.filter((failures, run) => failures < cell.counts![run]!.low || failures > cell.counts![run]!.high).length);
    expect(outside).toEqual([0, 0]);
    // the mean period of each run: 10.11 ms to 10.24 ms, for a setting of 10 ms
    for (const cell of s2.cells) for (const period of cell.periods!) expect(period > 0.01011 && period < 0.01024, cell.id).toBe(true);
    // for example, 497 failed requests with 1 session are in 490 to 501 at 10.18 ms
    expect([s2.cells[0]!.failures[2], s2.cells[0]!.counts![2]]).toEqual([497, { low: 490, high: 501 }]);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./s2-backlog-terms-cilium-2026-10-28.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
