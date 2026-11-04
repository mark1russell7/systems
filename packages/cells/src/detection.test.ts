import { clusterNameOf, faultSpan, planOf } from "@mark1russell7/kind";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { DETECTION_CELLS, DETECTION_SETTINGS, PAUSES, detectionOf, nextProbeShare } from "./detection.ts";
import { s } from "./kind.ts";
import { KIND_CATALOG } from "./kinds.ts";
import { metallbOf } from "./metallb.ts";
import { VIP_HOLD, VIP_WORKLOAD } from "./vip.ts";

describe("the sweep of the detection settings of MetalLB (SYS-57)", () => {
  it("has a zone loss and a schedule of pauses for each of 4 settings, with the settings on the VIP", () => {
    expect(DETECTION_CELLS.map((cell) => cell.id)).toEqual([
      "S2.T07.iptables.metallb.zone-loss.i1000-m4",
      "S2.T07.iptables.metallb.pauses.i1000-m4",
      "S2.T07.iptables.metallb.zone-loss.i1000-m2",
      "S2.T07.iptables.metallb.pauses.i1000-m2",
      "S2.T07.iptables.metallb.zone-loss.i500-m4",
      "S2.T07.iptables.metallb.pauses.i500-m4",
      "S2.T07.iptables.metallb.zone-loss.i500-m2",
      "S2.T07.iptables.metallb.pauses.i500-m2",
    ]);
    for (const [index, cell] of DETECTION_CELLS.entries()) {
      expect(cell.vip?.memberlist).toBe(DETECTION_SETTINGS[Math.floor(index / 2)]);
      expect(cell.name).toContain("MetalLB detection");
    }
    for (const settings of DETECTION_SETTINGS) expect(valueIn(settings.probeTimeout, "ms")).toBe(valueIn(settings.probeInterval, "ms") / 2);
  });

  it("puts both cells of a setting on one cluster, and each setting on a cluster of its own", () => {
    const names = DETECTION_CELLS.map((cell) => clusterNameOf(cell, 0));
    expect(names).toEqual([
      "lab-iptables-2-zones-mlb1000x4-0",
      "lab-iptables-2-zones-mlb1000x4-0",
      "lab-iptables-2-zones-mlb1000x2-0",
      "lab-iptables-2-zones-mlb1000x2-0",
      "lab-iptables-2-zones-mlb500x4-0",
      "lab-iptables-2-zones-mlb500x4-0",
      "lab-iptables-2-zones-mlb500x2-0",
      "lab-iptables-2-zones-mlb500x2-0",
    ]);
  });

  it("gives each cell of each kind catalog a kind name of 32 characters at most: lowercase letters, digits and dashes", () => {
    // SYS-53 lost a dispatch to a name of 34 characters. The last environment of a run has one digit
    for (const cell of KIND_CATALOG) expect(clusterNameOf(cell, 9), cell.id).toMatch(/^[a-z0-9-]{1,32}$/);
  });

  it("predicts the death of the lost node with the later law: I + S to the act, 3I and S", () => {
    const dead = DETECTION_SETTINGS.map((settings) => metallbOf(VIP_WORKLOAD, VIP_HOLD, 2, { memberlist: settings, ticks: 2 }).dead);
    expect(dead).toEqual([
      { lo: s(5), hi: s(7.5) },
      { lo: s(3), hi: s(5.5) },
      { lo: s(2.5), hi: s(4) },
      { lo: s(1.5), hi: s(3) },
    ]);
    // the law of SYS-53 stays as it was for its cell
    expect(metallbOf(VIP_WORKLOAD, VIP_HOLD).dead).toEqual({ lo: s(5), hi: s(6.5) });
  });

  it("gives the next probe from a random phase: 4/7 of the phases in one interval, each one in two", () => {
    expect(nextProbeShare(0, 1)).toBe(0);
    expect(nextProbeShare(1, 1)).toBeCloseTo(4 / 7, 12);
    expect(nextProbeShare(0.25, 0.5)).toBeCloseTo(2 / 7, 12);
    expect(nextProbeShare(2, 1)).toBe(1);
    expect(nextProbeShare(5, 1)).toBe(1);
  });

  it("predicts the false deaths of each setting for the schedule 1, 2, 4, 6 and 9 s", () => {
    expect(PAUSES.map((pause) => valueIn(pause, "s"))).toEqual([1, 2, 4, 6, 9]);
    const predicted = DETECTION_SETTINGS.map((settings) => detectionOf(settings));
    expect(predicted.map((each) => valueIn(each.floor, "s"))).toEqual([5, 3, 2.5, 1.5]);
    expect(predicted.map((each) => each.pauses.map((pause) => pause.class))).toEqual([
      ["never", "never", "never", "either", "always"],
      ["never", "never", "either", "always", "always"],
      ["never", "never", "always", "always", "always"],
      ["never", "either", "always", "always", "always"],
    ]);
    expect(predicted.map((each) => [each.deaths.lo, each.deaths.hi])).toEqual([
      [1, 2],
      [2, 3],
      [3, 3],
      [3, 4],
    ]);
    expect(predicted.map((each) => each.deaths.mean)).toEqual([1.571429, 2.571429, 3, 3.571429]);
  });

  it("pauses the speaker of the owner with a SIGSTOP and a SIGCONT, each pause 20 s after the last one", () => {
    const pauses = DETECTION_CELLS[1]!;
    const plan = planOf(pauses);
    expect(plan.inject).toEqual([{ do: "signal", target: "speaker", signal: "SIGSTOP" }]);
    expect(plan.flaps?.map((flap) => [valueIn(flap.rest, "s"), valueIn(flap.hold, "s")])).toEqual([
      [20, 2],
      [20, 4],
      [20, 6],
      [20, 9],
    ]);
    expect(valueIn(faultSpan(pauses.trigger), "s")).toBe(102);
    expect(pauses.prediction.kind).toBe("measured");
  });
});
