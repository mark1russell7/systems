import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import s2 from "./s2-pulsar-2026-11-04.json";

/** SYS-56: the bands of the cell, from the catalog, in seconds from the crash. */
const FLIP = { low: 20.5, high: 33 };
const SETUP = { low: 0, high: 3 };
/** SYS-56: the return of a producer is at the stop try, or at the try after it. */
const MODES = [
  { low: 29, high: 33 },
  { low: 75, high: 85.2 },
];

const cell = s2.cells[0]!;

/** SYS-56: the Pulsar cell of S2, from kind run 41870080724. */
describe("the copy of the Pulsar cell of SYS-56 holds the figures of its kind run", () => {
  it("has one cell with 4 counted runs, no void run and no failed run, and the cell holds", () => {
    expect(s2.cells.map((each) => [each.id, each.decision, each.counted, each.voided, each.failed])).toEqual([["S2.T07.iptables.pulsar.broker-crash", "holds", 4, 0, 0]]);
    expect(cell.median).toBe(54.7945);
    expect(cell.values).toEqual([79.369, 30.22, 80.103, 29.843]);
  });

  it("keeps the bands of the catalog", () => {
    expect(s2.bands.flip).toEqual(FLIP);
    expect(s2.bands.setup).toEqual(SETUP);
    expect(cell.prediction.band).toEqual(FLIP);
  });

  it("names another owner in 1 run: the crashed broker takes the bundle back in the other 3", () => {
    expect(cell.pulsar.map((run) => run.flip)).toEqual([null, null, 30.3749952, null]);
    expect(cell.pulsar.filter((run) => run.why.startsWith("the stopped broker owns the topic again"))).toHaveLength(3);
  });

  it("brings each producer back in one of the two modes, with 2 runs in each", () => {
    const backs = cell.pulsar.map((run) => run.returns.map((each) => each.back));
    for (const back of backs.flat()) expect(MODES.filter((mode) => back >= mode.low && back <= mode.high)).toHaveLength(1);
    const late = cell.pulsar.filter((run) => run.returns.every((each) => each.back >= MODES[1]!.low));
    expect(late).toHaveLength(2);
  });

  it("gives the two producers of a run the same count of tries, and a setup in its band", () => {
    for (const run of cell.pulsar) {
      expect(new Set(run.returns.map((each) => each.tries)).size).toBe(1);
      for (const each of run.returns) expect([each.setup >= SETUP.low, each.setup <= SETUP.high]).toEqual([true, true]);
    }
  });

  it("fails no request of the control, and each failed send is late or a timeout", () => {
    for (const run of cell.pulsar) {
      expect(run.failed.control).toBe(0);
      expect(Object.keys(run.failed.sends).filter((name) => name !== "late" && name !== "timeout")).toEqual([]);
    }
  });

  it("names no machine: no image digest, address, user or path", () => {
    const text = readFileSync(new URL("./s2-pulsar-2026-11-04.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
