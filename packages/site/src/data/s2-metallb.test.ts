import { readFileSync } from "node:fs";
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

/** SYS-53: the MetalLB cell of S2, from kind run 41654669260. */
describe("the copy of the MetalLB cell of SYS-53 holds the figures of its kind run", () => {
  it("has the cell with 2 counted runs and 2 void runs, and the cell holds", () => {
    expect(s2.cells.map((each) => [each.id, each.decision, each.counted, each.voided, each.failed])).toEqual([["S2.T07.iptables.metallb.zone-loss", "holds", 2, 2, 0]]);
    expect(cell.values).toEqual([1001, 762]);
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

  it("marks the lost node dead one suspicion timeout after its first suspicion, in the band of the law in 1 run of 2", () => {
    const deads = cell.metallb.map((run) => round(run.dead!));
    expect(deads).toEqual([6.737, 5.107]);
    for (const run of cell.metallb) expect(Math.abs(run.dead! - run.suspect! - SUSPICION)).toBeLessThan(0.01);
    // the first failed probe of run 1 starts 1.737 s after the fault, past the probe band: memberlist probed no node at one tick
    expect(cell.metallb.map((run) => round(run.suspect! - 1))).toEqual([1.737, 0.106]);
    expect(deads.filter((dead) => dead >= s2.bands.dead.low - NOISE && dead <= s2.bands.dead.high + NOISE)).toEqual([5.107]);
    expect(deads.filter((dead) => dead >= s2.bands.naive.low - NOISE && dead <= s2.bands.naive.high + NOISE)).toEqual([]);
  });

  it("moves each outside client to the other worker in the ARP band, at most 10 ms after the death", () => {
    const gaps = cell.metallb.flatMap((run) => run.arp.map((arp) => round(arp! - run.dead!)));
    expect(gaps).toHaveLength(6);
    for (const gap of gaps) expect([gap >= 0, gap <= 0.01]).toEqual([true, true]);
    for (const arp of cell.metallb.flatMap((run) => run.arp)) expect([arp! >= s2.bands.arp.low - NOISE, arp! <= s2.bands.arp.high + NOISE]).toEqual([true, true]);
  });

  it("ends the failures at the ARP change, with no failure and no change of MAC after the heal", () => {
    const lasts = cell.metallb.flatMap((run) => run.last.map((last, client) => round(last! - run.arp[client]!)));
    for (const each of lasts) expect([each >= -0.12, each <= NOISE]).toEqual([true, true]);
    expect(cell.metallb.map((run) => run.failed)).toEqual([
      { outside: 1001, thaw: 0, inside: 0 },
      { outside: 762, thaw: 0, inside: 0 },
    ]);
    expect(cell.metallb.map((run) => run.moves)).toEqual([0, 0]);
  });

  it("withdraws the announce of the other speaker approximately 1 s after the heal", () => {
    expect(cell.metallb.map((run) => round(run.withdraw!))).toEqual([1.125, 1.018]);
  });

  it("fails each request with a timeout, approximately 880 in the median run", () => {
    const median = (cell.metallb[0]!.failed.outside + cell.metallb[1]!.failed.outside) / 2;
    expect(median).toBe(881.5);
    expect([median >= FAILED.low, median <= FAILED.high]).toEqual([true, true]);
    for (const run of cell.metallb) expect(Object.keys(run.outcomes)).toEqual(["timeout"]);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./s2-metallb-2026-11-03.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
    expect(text).not.toMatch(/([0-9a-f]{2}:){5}[0-9a-f]{2}/i);
  });
});
