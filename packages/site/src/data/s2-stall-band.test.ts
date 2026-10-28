import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import s2 from "./s2-stall-band-2026-10-28.json";

const MODES = ["iptables", "ipvs", "nftables", "cilium"] as const;
/** The term of SYS-45 in the stall cells of C: d.hi of 45 ms for each session, and one slow session of up to 100 ms. */
const D_HI = 0.045;
const SLOWEST = 0.1;
/** Each session on the target fails approximately one request each 20 ms for 10 s, thus approximately 500 requests. */
const EACH = 500;

/** SYS-48: the stall cells of C with the backlog band, from kind run 40643221421. */
describe("the copy of the stall band of SYS-48 holds the figures of its kind run", () => {
  it("has the 4 stall cells of C, 3 counted runs each, and each cell holds", () => {
    expect([s2.runs, s2.hz]).toEqual([3, 1000]);
    expect(s2.cells.map((cell) => cell.id)).toEqual(MODES.map((mode) => `S2.T07.${mode}.goaway.stall`));
    expect(s2.cells.map((cell) => [cell.decision, cell.counted, cell.voided, cell.failed])).toEqual(MODES.map(() => ["holds", 3, 0, 0]));
    expect(s2.cells.map((cell) => cell.median)).toEqual([1000, 1502, 500, 998]);
    for (const cell of s2.cells) expect([cell.candidate.expected, cell.candidate.end], cell.id).toEqual([{ low: 0, high: 1542 }, { from: "fault", low: 9.98, high: 10 }]);
  });

  it("gives each last failure before the close of the backlog band: 10 s + (n − 1) × 45 ms + 100 ms with n sessions", () => {
    const lasts = s2.cells.map((cell) => cell.lasts.map((last) => (last === null ? null : Math.round(last * 1000) / 1000)));
    expect(lasts).toEqual([
      [10.044, 10.036, 10.103],
      [10.062, 10.064, 10.031],
      [10.076, 10.022, 10.065],
      [10.037, 10.033, 10.041],
    ]);
    for (const cell of s2.cells)
      cell.values.forEach((failed, run) => {
        const n = Math.round(failed / EACH);
        const last = cell.lasts[run]!;
        // each run is after the bare end of 10 s, and before the close of its n sessions
        expect([n >= 1, last > 10, last <= 10 + (n - 1) * D_HI + SLOWEST], `${cell.id} run ${run}`).toEqual([true, true, true]);
      });
    // the latest failure: 10.103 s, with 2 sessions on the target, against a close of 10.145 s
    expect(Math.max(...s2.cells.flatMap((cell) => cell.lasts.map((last) => last ?? 0)))).toBeCloseTo(10.103, 3);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./s2-stall-band-2026-10-28.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
