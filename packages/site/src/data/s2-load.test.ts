import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import cannotServe from "./s2-load-2026-10-27.json";
import dependency from "./s2-dependency-load-2026-10-27.json";
import partition from "./s2-partition-load-2026-10-27.json";
import prober from "./s2-prober-load-2026-10-27.json";
import stall from "./s2-stall-load-2026-10-27.json";

// the copies of kind run 40440516571: the 15 cells of D, with the PINGs that the clients counted
const NAMES = ["./s2-load-2026-10-27.json", "./s2-partition-load-2026-10-27.json", "./s2-stall-load-2026-10-27.json", "./s2-prober-load-2026-10-27.json", "./s2-dependency-load-2026-10-27.json"];
const COPIES = [
  ["cannot serve", "", cannotServe],
  ["partition", ".partition", partition],
  ["stall", ".stall", stall],
  ["false failure", ".prober", prober],
  ["shared dependency", ".dependency", dependency],
] as const;
const MODES = ["iptables", "ipvs", "nftables"] as const;
// the bands of commit 47909ad (`pingsOf` of the cells), for iptables, IPVS and nftables
const BANDS: Readonly<Record<(typeof COPIES)[number][0], ReadonlyArray<readonly [number, number]>>> = {
  "cannot serve": [[0, 0], [0, 0], [0, 0]],
  partition: [[0, 3], [0, 3], [0, 3]],
  stall: [[0, 9], [0, 3], [0, 9]],
  "false failure": [[0, 0], [0, 0], [0, 0]],
  "shared dependency": [[3, 126], [3, 126], [3, 126]],
};

describe("the copies of the PINGs of D, from kind run 40440516571", () => {
  it("have each cell of D, held in 3 of 3 runs, with a count of the PINGs in each run", () => {
    for (const [, tail, copy] of COPIES) {
      expect(copy.ranAt).toBe("2026-10-27");
      expect(copy.cells.map((each) => each.id)).toEqual(MODES.map((mode) => `S2.T07.${mode}.session-check${tail}`));
      for (const cell of copy.cells) {
        expect([cell.decision, cell.counted], cell.id).toEqual(["holds", 3]);
        expect([cell.pings.length, cell.acks.length, cell.seconds.length], cell.id).toEqual([3, 3, 3]);
      }
    }
  });

  it("give the PINGs that the prediction of commit 47909ad gave, in each band", () => {
    const counts = COPIES.map(([, , copy]) => copy.cells.map((each) => each.pings));
    expect(counts).toEqual([
      [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
      [[3, 1, 1], [3, 3, 3], [0, 1, 2]],
      [[2, 1, 8], [3, 3, 3], [0, 1, 3]],
      [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
      [[51, 44, 33], [33, 45, 47], [33, 45, 51]],
    ]);
    for (const [fault, , copy] of COPIES)
      copy.cells.forEach((cell, at) => {
        const [lo, hi] = BANDS[fault][at]!;
        for (const value of cell.pings) expect(value, cell.id).toBeGreaterThanOrEqual(lo);
        for (const value of cell.pings) expect(value, cell.id).toBeLessThanOrEqual(hi);
      });
    // a silent target sends no ACK. In the shared dependency, the server answers each PING that it gets before the close of its session
    for (const [fault, , copy] of COPIES)
      for (const cell of copy.cells) {
        if (fault === "shared dependency") cell.acks.forEach((acks, at) => expect(cell.pings[at]! - acks!, cell.id).toBeLessThanOrEqual(2));
        else expect(cell.acks, cell.id).toEqual([0, 0, 0]);
      }
  });

  it("name no machine: no image digest, address, pod, user or path", () => {
    for (const name of NAMES) {
      const text = readFileSync(new URL(name, import.meta.url), "utf8");
      expect(text, name).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
      expect(text, name).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
    }
  });
});
