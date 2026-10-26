import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import s2 from "./s2-prober-2026-10-26.json";

const ids = ["iptables", "ipvs", "nftables"].flatMap((mode) => ["endpoints", "lame-duck", "goaway", "session-check"].map((suffix) => `S2.T07.${mode}.${suffix}.prober`));
/** This time is the noise of a kind cell (KIND_NOISE of the cells, 100 ms). The judge widens each band of the window by it. */
const NOISE = 0.1;

describe("the copy of the S2 cells of a failed prober holds the figures of kind run 40419289511", () => {
  it("has the four candidates in each mode, with the time of the false removal as the main value", () => {
    expect([s2.hz, s2.runs]).toEqual([1000, 3]);
    expect(s2.cells.map((cell) => cell.id)).toEqual(ids);
    expect(s2.cells.every((cell) => cell.group === "prober" && cell.decision === "holds" && cell.counted === 3 && cell.voided === 0 && cell.failed === 0)).toBe(true);
    // the false removal of the median run, in seconds after the fault
    expect(s2.cells.map((cell) => cell.median)).toEqual([16.855, 18.913, 17.843, 15.136, 16.249, 19.087, 19.059, 17.232, 15.014, 20.947, 16.488, 18.422]);
    // the failed requests of the median run: A keeps its connections, and the others close each one at its first refusal
    const middle = (values: readonly number[]) => [...values].sort((a, b) => a - b)[1];
    expect(s2.cells.map((cell) => middle(cell.failures))).toEqual([1690, 25, 5, 4, 1529, 24, 3, 3, 1679, 25, 3, 6]);
  });

  it("gives each counted run a time of the false removal, a count of failed requests and a time of the last failure", () => {
    for (const cell of s2.cells) {
      expect(cell.values.length, cell.id).toBe(cell.counted);
      expect(cell.failures.length, cell.id).toBe(cell.counted);
      expect(cell.lasts.length, cell.id).toBe(cell.counted);
      // the removal is in its band, after the fault
      for (const value of cell.values) expect(value, cell.id).toBeGreaterThanOrEqual(cell.candidate.leaves.low - NOISE);
      for (const value of cell.values) expect(value, cell.id).toBeLessThanOrEqual(cell.candidate.leaves.high + NOISE);
      // each last failure is in the window of the judge: A after the heal, the others after the fault
      const heal = cell.candidate.end.from === "heal" ? 30 : 0;
      for (const last of cell.lasts) {
        if (last === null) continue;
        expect(last, cell.id).toBeGreaterThanOrEqual(heal + cell.candidate.end.low - NOISE);
        expect(last, cell.id).toBeLessThanOrEqual(heal + cell.candidate.end.high + NOISE);
      }
    }
    // one run of C in iptables had no session on the target: no failure, thus no time
    expect(s2.cells.find((cell) => cell.id === "S2.T07.iptables.goaway.prober")?.failures).toEqual([7, 0, 5]);
    expect(s2.cells.find((cell) => cell.id === "S2.T07.iptables.goaway.prober")?.lasts).toEqual([13.8793899, null, 15.1182826]);
    // the gap: one run of C in nftables had 12 failed requests, over the band of 0 to 9 (95 % of the runs). The band stays
    expect(s2.cells.find((cell) => cell.id === "S2.T07.nftables.goaway.prober")?.failures).toEqual([3, 3, 12]);
  });

  it("has the prediction of each S2 cell of a failed prober in the catalog", () => {
    expect(s2.predictions.map((each) => each.id)).toEqual(ids);
    for (const cell of s2.cells) expect(s2.predictions.find((each) => each.id === cell.id)?.candidate, cell.id).toEqual(cell.candidate);
    const [a, b, c, d] = s2.predictions.filter((each) => each.mode === "iptables").map((each) => each.candidate);
    // the removal of each candidate comes from the latch, the probe and the propagation
    for (const each of [a, b, c, d]) expect(each?.leaves).toEqual({ from: "fault", low: 12, high: 24.105 });
    // A: each connection on the target stays open until the readiness of the service recovers after the heal
    expect([a?.expected, a?.end]).toEqual([{ low: 525, high: 2992 }, { from: "heal", low: 0, high: 6.16 }]);
    // B: each refusal closes its connection
    expect([b?.expected, b?.end]).toEqual([{ low: 12, high: 39 }, { from: "fault", low: 8, high: 20.24 }]);
    // C and D: each refusal closes its session with GOAWAY, and the session check closes no session
    expect([c?.expected, c?.end]).toEqual([{ low: 0, high: 9 }, { from: "fault", low: 8, high: 18.22 }]);
    expect([d?.expected, d?.end]).toEqual([c?.expected, c?.end]);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./s2-prober-2026-10-26.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
