import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import s2 from "./s2-dns-2026-11-03.json";

/** SYS-50: the hold of 6 s, the timeout of 1 s and the act of the lab, from the catalog. */
const TIMEOUT = 1;
const ACT = 0.5;
/** Each client fails a request each 20 ms for approximately 6.7 s, thus 3 clients fail approximately 1000 requests. */
const FAILED = { low: 900, high: 1050 };

const blackhole = s2.cells.find((cell) => cell.id === "S2.T07.iptables.dns.blackhole")!;
const kept = s2.cells.find((cell) => cell.id === "S2.T07.iptables.dns.kept")!;

/** SYS-50: the CoreDNS cells of S2, from kind run 41559060726. */
describe("the copy of the CoreDNS cells of SYS-50 holds the figures of its kind run", () => {
  it("has the black hole with 4 counted runs and the control with 3, and each cell holds", () => {
    expect(s2.cells.map((cell) => [cell.id, cell.decision, cell.counted, cell.voided, cell.failed])).toEqual([
      ["S2.T07.iptables.dns.blackhole", "holds", 4, 0, 0],
      ["S2.T07.iptables.dns.kept", "holds", 3, 0, 0],
    ]);
    expect(kept.values).toEqual([0, 0, 0]);
    expect(kept.recovers).toEqual([null, null, null]);
  });

  it("fails each request of the black hole with a timeout, approximately 1000 in each run", () => {
    expect(blackhole.values).toEqual([1000, 997, 1000, 997]);
    expect(blackhole.median).toBe(998.5);
    expect([blackhole.median >= FAILED.low, blackhole.median <= FAILED.high]).toEqual([true, true]);
    blackhole.outcomes.forEach((outcomes, run) => expect(outcomes, `run ${run}`).toEqual({ timeout: blackhole.values[run] }));
  });

  it("ends the failures 0.70 s to 0.75 s after the heal: in the band of the phase, and near its low edge", () => {
    const recovers = blackhole.recovers.map((each) => Math.round(each! * 1000) / 1000);
    expect(recovers).toEqual([0.752, 0.699, 0.699, 0.728]);
    // each run is in the band of the law (−1 s to 2.5 s) and in the band of the phase
    for (const each of recovers) expect([each >= -TIMEOUT, each <= 2.5, each >= s2.phase.low, each <= s2.phase.high]).toEqual([true, true, true, true]);
    expect(s2.phase).toEqual({ low: 0.5, high: 1.5 });
  });

  it("changes the drops of each client pod in less than the act of the catalog", () => {
    const acts = s2.cells.flatMap((cell) => cell.acts.flat());
    expect(acts).toHaveLength(42);
    expect(Math.max(...acts)).toBeLessThan(0.3);
    expect(Math.max(...acts)).toBeLessThan(ACT);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./s2-dns-2026-11-03.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
