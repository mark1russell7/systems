import { readFileSync } from "node:fs";
import { median } from "@mark1russell7/rigor-statistics";
import { describe, expect, it } from "vitest";
import sweep from "./s2-detection-2026-11-04.json";

const NOISE = sweep.noise;
const pausesOf = (setting: (typeof sweep.settings)[number]) => setting.runs.flatMap((run) => run.pauses);
const all = sweep.settings.flatMap(pausesOf);

/**
 * SYS-57: the detection sweep of MetalLB. Each test holds a claim of the result in the roadmap against the
 * values of each counted run, from the raw records of the two kind runs.
 */
describe("the copy of the detection sweep of SYS-57 holds the figures of its two kind runs", () => {
  it("has the four settings, each with T0 = I + m × I and the band of its law", () => {
    expect(sweep.settings.map((each) => [each.label, each.t0, each.band.low, each.band.high])).toEqual([
      ["1 s × 4", 5, 5, 7.5],
      ["1 s × 2", 3, 3, 5.5],
      ["500 ms × 4", 2.5, 2.5, 4],
      ["500 ms × 2", 1.5, 1.5, 3],
    ]);
    for (const each of sweep.settings) {
      expect(each.t0).toBe(each.interval + each.interval * each.multiplier);
      expect(each.band.high).toBe(0.5 + 3 * each.interval + each.interval * each.multiplier);
    }
  });

  it("counts 30 runs of the 32: 16 zone-loss runs and 14 pause runs", () => {
    expect(sweep.settings.map((each) => [each.zone.length, each.runs.length])).toEqual([
      [4, 4],
      [4, 4],
      [4, 4],
      [4, 2],
    ]);
    expect(sweep.workflows.map(({ run, counted, voided }) => [run, counted, voided])).toEqual([
      ["41748420837", 30, 2],
      ["41870241848", 0, 4],
    ]);
  });

  it("has each failure time in the band of its setting, and the medians rise with T0", () => {
    for (const each of sweep.settings) {
      for (const run of each.zone) {
        expect(run.dead).toBeGreaterThanOrEqual(each.band.low - NOISE);
        expect(run.dead).toBeLessThanOrEqual(each.band.high + NOISE);
      }
      expect(each.medians.failure).toBeCloseTo(median(each.zone.map((run) => run.dead)), 2);
    }
    expect(sweep.settings.map((each) => each.medians.failure)).toEqual([5.851, 3.71, 2.851, 2.054]);
  });

  it("marks the death m × I after the first suspicion in each zone-loss run", () => {
    for (const each of sweep.settings) for (const run of each.zone) expect(Math.abs(run.suspicion - each.interval * each.multiplier)).toBeLessThanOrEqual(0.05);
  });

  it("gives the failed requests outside the cluster, and none in the cluster in each of the 30 runs", () => {
    expect(sweep.settings.map((each) => each.medians.outside)).toEqual([872.5, 553, 424.5, 306.5]);
    for (const each of sweep.settings) {
      expect(each.medians.outside).toBe(median(each.zone.map((run) => run.outside)));
      for (const run of [...each.zone, ...each.runs]) expect(run.inside).toBe(0);
    }
  });

  it("gives the classes of the 70 pauses: 0 deaths of 30, 30 of 30, and 7 of 10 between them", () => {
    const tally = (group: string) => {
      const pauses = all.filter((pause) => pause.group === group);
      return [pauses.length, pauses.filter((pause) => pause.died).length];
    };
    expect(all).toHaveLength(70);
    expect(tally("never")).toEqual([30, 0]);
    expect(tally("always")).toEqual([30, 30]);
    expect(tally("either")).toEqual([10, 7]);
    const expected = all.filter((pause) => pause.group === "either").reduce((sum, pause) => sum + pause.chance, 0);
    expect(expected).toBeCloseTo(6.4, 1);
  });

  it("puts each pause in the class that its length and the band of its setting give", () => {
    for (const each of sweep.settings) {
      expect(each.pauseBand.low).toBeCloseTo(each.t0 - 0.2 - NOISE, 9);
      expect(each.pauseBand.high).toBeCloseTo(each.t0 + 2 * each.interval + NOISE, 9);
      for (const pause of pausesOf(each)) {
        const group = pause.length < each.pauseBand.low ? "never" : pause.length > each.pauseBand.high ? "always" : "either";
        expect(pause.group).toBe(group);
      }
    }
  });

  it("gives the false deaths in each run, and their medians rise as T0 falls", () => {
    expect(sweep.settings.map((each) => each.runs.map((run) => run.pauses.filter((pause) => pause.died).length))).toEqual([
      [2, 2, 1, 2],
      [2, 3, 2, 3],
      [3, 3, 3, 3],
      [4, 4],
    ]);
    expect(sweep.settings.map((each) => each.medians.deaths)).toEqual([2, 2.5, 3, 4]);
  });

  it("has a pause approximately 140 ms longer than its hold", () => {
    const over = all.map((pause, n) => pause.length - sweep.holds[n % sweep.holds.length]!);
    expect(median(over)).toBeGreaterThan(0.12);
    expect(median(over)).toBeLessThan(0.16);
  });

  it("has no line of the thawed speaker that marks the other speaker dead", () => {
    for (const each of sweep.settings) for (const run of each.runs) expect(run.peer).toBe(0);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./s2-detection-2026-11-04.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
    expect(text).not.toMatch(/([0-9a-f]{2}:){5}[0-9a-f]{2}/i);
  });
});
