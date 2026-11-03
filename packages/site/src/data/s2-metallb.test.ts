import { readFileSync } from "node:fs";
import { median } from "@mark1russell7/rigor-statistics";
import { describe, expect, it } from "vitest";
import s2 from "./s2-metallb-2026-11-03.json";

/** SYS-53: the noise of the judge, from the catalog. */
const NOISE = 0.1;
/** The suspicion timeout of memberlist with 2 members: 4 × max(1, log10 2) × 1 s. */
const SUSPICION = 4;
/** Each client fails a request each 20 ms for approximately 5 s to 7 s, thus 3 clients fail approximately 750 to 1050 requests. */
const FAILED = { low: 750, high: 1050 };

const cell = s2.cells.find((each) => each.id === "S2.T07.iptables.metallb.zone-loss")!;
const round = (each: number) => Math.round(each * 1000) / 1000;

/**
 * SYS-53: the MetalLB cell of S2. Kind run 41654669260 gave 2 counted runs and 2 void runs. The pre-registered rule
 * permits one re-dispatch, and kind run 41696343708 gave the next 2 counted runs. Its 2 later counted runs are extra.
 */
describe("the copy of the MetalLB cell of SYS-53 holds the figures of its two kind runs", () => {
  it("has the cell with 4 counted runs and 2 void runs, and the cell holds", () => {
    expect(s2.cells.map((each) => [each.id, each.decision, each.counted, each.voided, each.failed])).toEqual([["S2.T07.iptables.metallb.zone-loss", "holds", 4, 2, 0]]);
    expect(cell.values).toEqual([1001, 762, 867, 1036]);
  });

  it("names the two dispatches, and takes the first 4 counted runs", () => {
    expect(cell.dispatches).toMatchObject([
      { run: "41654669260", decision: "holds", counted: 2, voided: 2, taken: 2 },
      { run: "41696343708", decision: "holds", counted: 4, voided: 0, taken: 2 },
    ]);
  });

  it("names the cause of each void run: the quiet check before the fault, not the measured value", () => {
    for (const dispatch of cell.dispatches) expect(dispatch.voids).toHaveLength(dispatch.voided);
    // the second counted run of each cluster waited 300 s for a quiet VM, and the VM stayed below the idle share of 60 %
    expect(cell.dispatches[0]!.voids.map(({ env, index }) => [env, index])).toEqual([
      [0, 1],
      [1, 1],
    ]);
    const quiet = /^the VM was not quiet in 300 s: (\d+)% idle, other lab containers: none$/;
    for (const each of cell.dispatches.flatMap((dispatch) => dispatch.voids)) expect(each.why).toMatch(quiet);
    expect(cell.dispatches[0]!.voids.map((each) => Number(quiet.exec(each.why)![1]))).toEqual([52, 55]);
  });

  it("gives the bands of the probe, the law, the naive law, the ARP and the thaw", () => {
    expect(s2.bands).toEqual({
      probe: { low: 0, high: 1.5 },
      dead: { low: 5, high: 6.5 },
      naive: { low: 2.908485, high: 3.908485 },
      arp: { low: 5, high: 7 },
      end: { low: 4.98, high: 7 },
      thaw: { low: 0, high: 0.5 },
    });
  });

  it("marks the lost node dead one suspicion timeout after its first suspicion, in the band of the law in 2 runs of 4", () => {
    const deads = cell.metallb.map((run) => round(run.dead!));
    expect(deads).toEqual([6.737, 5.107, 5.813, 6.96]);
    for (const run of cell.metallb) expect(Math.abs(run.dead! - run.suspect! - SUSPICION)).toBeLessThan(0.01);
    // the first failed probe of runs 1 and 4 starts past the probe band: memberlist probed no node at one tick
    expect(cell.metallb.map((run) => round(run.suspect! - 1))).toEqual([1.737, 0.106, 0.812, 1.959]);
    expect(deads.filter((dead) => dead >= s2.bands.dead.low - NOISE && dead <= s2.bands.dead.high + NOISE)).toEqual([5.107, 5.813]);
    expect(deads.filter((dead) => dead >= s2.bands.naive.low - NOISE && dead <= s2.bands.naive.high + NOISE)).toEqual([]);
  });

  it("moves each outside client to the other worker in the ARP band, at most 10 ms after the death", () => {
    const gaps = cell.metallb.flatMap((run) => run.arp.map((arp) => round(arp! - run.dead!)));
    expect(gaps).toHaveLength(12);
    for (const gap of gaps) expect([gap >= 0, gap <= 0.01]).toEqual([true, true]);
    for (const arp of cell.metallb.flatMap((run) => run.arp)) expect([arp! >= s2.bands.arp.low - NOISE, arp! <= s2.bands.arp.high + NOISE]).toEqual([true, true]);
  });

  it("ends the failures at the ARP change, with no failure and no change of MAC after the heal", () => {
    const lasts = cell.metallb.flatMap((run) => run.last.map((last, client) => round(last! - run.arp[client]!)));
    expect(lasts).toHaveLength(12);
    for (const each of lasts) expect([each >= -0.12, each <= NOISE]).toEqual([true, true]);
    expect(cell.metallb.map((run) => run.failed)).toEqual([
      { outside: 1001, thaw: 0, inside: 0 },
      { outside: 762, thaw: 0, inside: 0 },
      { outside: 867, thaw: 0, inside: 0 },
      { outside: 1036, thaw: 0, inside: 0 },
    ]);
    expect(cell.metallb.map((run) => run.moves)).toEqual([0, 0, 0, 0]);
  });

  it("withdraws the announce of the other speaker approximately 1 s after the heal", () => {
    expect(cell.metallb.map((run) => round(run.withdraw!))).toEqual([1.125, 1.018, 1.094, 1.08]);
  });

  it("fails each request with a timeout, approximately 930 in the median run", () => {
    const middle = median(cell.metallb.map((run) => run.failed.outside));
    expect(middle).toBe(934);
    expect(cell.median).toBe(934);
    expect([middle >= FAILED.low, middle <= FAILED.high]).toEqual([true, true]);
    for (const run of cell.metallb) expect(Object.keys(run.outcomes)).toEqual(["timeout"]);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./s2-metallb-2026-11-03.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
    expect(text).not.toMatch(/([0-9a-f]{2}:){5}[0-9a-f]{2}/i);
  });
});
