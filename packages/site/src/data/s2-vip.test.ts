import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import s2 from "./s2-vip-2026-11-03.json";

/** SYS-51: the noise of the judge and the request timeout of 1 s, from the catalog. */
const NOISE = 0.1;
/** The ARP rate of kube-vip is 3 s, and the setup of the VIP is 0.5 s. */
const ARP = 3.5;
/** Each client fails a request each 20 ms for approximately 16 s to 24 s, thus 3 clients fail approximately 2400 to 3600 requests. */
const FAILED = { low: 2400, high: 3600 };

const cell = s2.cells.find((each) => each.id === "S2.T07.iptables.vip.zone-loss")!;
const round = (each: number) => Math.round(each * 1000) / 1000;

/** SYS-51: the kube-vip cell of S2, from kind run 41568679669. */
describe("the copy of the kube-vip cell of SYS-51 holds the figures of its kind run", () => {
  it("has the cell with 4 counted runs, and the cell holds", () => {
    expect(s2.cells.map((each) => [each.id, each.decision, each.counted, each.voided, each.failed])).toEqual([["S2.T07.iptables.vip.zone-loss", "holds", 4, 0, 0]]);
    expect(cell.values).toEqual([2660, 3090, 2659, 2652]);
  });

  it("gives the bands of the law, the naive law, the ARP and the thaw", () => {
    expect(s2.bands).toEqual({
      take: { low: 13, high: 23.8 },
      naive: { low: 13, high: 17 },
      arp: { low: 13, high: 27.3 },
      end: { low: 12.98, high: 27.3 },
      thaw: { low: 0, high: 3.5 },
    });
  });

  it("takes the Lease in the band of the law in each run, and in the naive band in 2 runs of 4", () => {
    const takes = cell.vip.map((run) => round(run.take!));
    expect(takes).toEqual([17.648, 19.32, 16.984, 15.143]);
    for (const take of takes) expect([take >= s2.bands.take.low - NOISE, take <= s2.bands.take.high + NOISE]).toEqual([true, true]);
    expect(takes.filter((take) => take >= s2.bands.naive.low - NOISE && take <= s2.bands.naive.high + NOISE)).toEqual([16.984, 15.143]);
  });

  it("moves each outside client to the new holder 0 s to 3.5 s after the take", () => {
    const gaps = cell.vip.flatMap((run) => run.arp.map((arp) => round(arp! - run.take!)));
    expect(gaps).toHaveLength(12);
    for (const gap of gaps) expect([gap >= -NOISE, gap <= ARP + NOISE]).toEqual([true, true]);
    for (const arp of cell.vip.flatMap((run) => run.arp)) expect([arp! >= s2.bands.arp.low, arp! <= s2.bands.arp.high]).toEqual([true, true]);
  });

  it("ends the failures of the fault at the ARP change, and fails a few requests at the heal", () => {
    // the last failure before the heal is at the ARP change in runs 2 and 4, and at the heal in runs 1 and 3
    const lasts = cell.vip.map((run) => run.last.map((last, client) => round(last! - run.arp[client]!)));
    for (const run of [1, 3]) for (const each of lasts[run]!) expect([each >= -0.12, each <= NOISE]).toEqual([true, true]);
    for (const run of [0, 2]) for (const each of lasts[run]!) expect(each).toBeGreaterThan(17);
    expect(cell.vip.map((run) => run.failed)).toEqual([
      { outside: 2663, thaw: 6, inside: 0 },
      { outside: 3090, thaw: 9, inside: 0 },
      { outside: 2662, thaw: 7, inside: 0 },
      { outside: 2652, thaw: 6, inside: 0 },
    ]);
    for (const run of cell.vip) expect(run.thawLast!).toBeLessThan(s2.bands.thaw.high);
  });

  it("fails each request with a timeout, approximately 2660 in the median run", () => {
    const outside = cell.vip.map((run) => run.failed.outside).sort((a, b) => a - b);
    const median = (outside[1]! + outside[2]!) / 2;
    expect([median >= FAILED.low, median <= FAILED.high]).toEqual([true, true]);
    for (const run of cell.vip) expect(Object.keys(run.outcomes)).toEqual(["timeout"]);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./s2-vip-2026-11-03.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
    expect(text).not.toMatch(/([0-9a-f]{2}:){5}[0-9a-f]{2}/i);
  });
});
