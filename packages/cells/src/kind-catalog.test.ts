import { describe, expect, it } from "vitest";
import type { KindCell } from "@mark1russell7/kind";
import { clientObjects, describeCell, lintCell, namespaceOf, pausedWindow, planOf, serverObjects, verdictsOf } from "@mark1russell7/kind";
import { valueIn } from "@mark1russell7/quantity";
import { PROPAGATION, SYN_SENT, afterSync, s } from "./kind.ts";
import { T07_CELLS } from "./t07.ts";
import { T18_CELLS } from "./t18.ts";

const ALL: readonly KindCell[] = [...T07_CELLS, ...T18_CELLS];

/** the propagation that a cell meets: the pause of kube-proxy on one node, the wait after a sync in a rolling update, or the calibration of its mode */
const propagationOf = (cell: KindCell) => {
  const e = PROPAGATION[cell.mode];
  if (cell.template === "T07" && cell.trigger.kind === "rolling-update") return afterSync(cell.mode);
  if (cell.template !== "T07" || cell.trigger.kind !== "freeze-process") return e;
  const window = pausedWindow(cell.declaration, cell.pod.preStop, cell.trigger.lead!, cell.trigger.hold!, e);
  return { ...e, hi: s(valueIn(window.resume, "s") + valueIn(e.hi, "s")) };
};

describe("the kind catalogs", () => {
  it("names each cell by a cell of the plan, or as a calibration, and each name once", () => {
    for (const cell of ALL) expect(cell.id, cell.name).toMatch(/^(T07|T18)\.(defaults|border-off)\.\d+$|^CAL\.T07\.(iptables|ipvs|nftables)$/);
    expect(new Set(ALL.map((cell) => cell.name)).size).toBe(ALL.length);
    expect(new Set(ALL.map(namespaceOf)).size).toBe(ALL.length);
  });

  it("runs each declaration pair of T07 in the three kube-proxy modes", () => {
    for (const mode of ["iptables", "ipvs", "nftables"] as const) {
      const cells = T07_CELLS.filter((cell) => cell.mode === mode && (cell.trigger.kind === "pod-deletion" || cell.trigger.kind === "freeze-process"));
      expect(cells.length, mode).toBe(5);
    }
  });

  it("gives each cell a prediction or the reason that it has none, and a plan for its trigger", () => {
    for (const cell of ALL) {
      expect(cell.prediction.why.length, cell.name).toBeGreaterThan(10);
      expect(() => planOf(cell), cell.name).not.toThrow();
      const objects = serverObjects(cell, namespaceOf(cell), "image");
      expect(objects.length).toBe(2);
      expect(clientObjects(cell, namespaceOf(cell), "image", "10.96.0.1:80").length).toBe(1);
    }
  });

  it("predicts no failed request exactly where lint() finds that O04 holds", () => {
    for (const cell of T07_CELLS.filter((each) => each.trigger.kind !== "crash" && each.trigger.kind !== "liveness-restart")) {
      const verdicts = verdictsOf(lintCell(describeCell(cell), cell, propagationOf(cell)));
      expect(verdicts["O04"] === "holds", cell.name).toBe(cell.prediction.kind === "none");
    }
  });

  it("gives the clients of T07 a timeout longer than the first SYN retransmission, at 1 s and 64 ms of the wheel", () => {
    for (const cell of T07_CELLS) expect(valueIn(cell.workload.timeout, "s"), cell.name).toBeGreaterThan(1.064);
    for (const cell of T18_CELLS) expect(cell.workload.timeout, cell.name).toEqual(s(1));
  });

  it("lets a stale SYN_SENT entry fail the paused node up to its life after the window, and before the intake from an earlier run", () => {
    const life = valueIn(SYN_SENT, "s") + 2;
    for (const mode of ["iptables", "ipvs", "nftables"] as const) {
      const paused = T07_CELLS.find((cell) => cell.mode === mode && cell.name.endsWith("pauses 5 s on one node, the design's hold of 2 s"))!;
      const prediction = paused.prediction;
      if (prediction.kind !== "window" || prediction.end === null) throw new Error(`${paused.name}: no window`);
      expect([prediction.nodes, prediction.certain, prediction.start.from, prediction.end.from]).toEqual(["paused", true, "intake", "resume"]);
      expect(prediction.start.band.lo).toEqual(s(-life));
      expect(prediction.end.band).toEqual({ lo: PROPAGATION[mode].lo, hi: s(valueIn(PROPAGATION[mode].hi, "s") + life) });
      const held = T07_CELLS.find((cell) => cell.mode === mode && cell.name.endsWith("pauses 5 s on one node, a hold of 8 s"))!;
      expect(held.prediction.kind).toBe("none");
    }
  });

  it("waits for the end of a sync and minSyncPeriod before the rules drop the old pod of a rolling update", () => {
    // a sync of up to one idle propagation at the deletion, minSyncPeriod (1 s) after its end, then the idle propagation
    for (const mode of ["iptables", "ipvs", "nftables"] as const)
      expect(valueIn(afterSync(mode).hi, "s"), mode).toBeCloseTo(1 + 2 * valueIn(PROPAGATION[mode].hi, "s"), 9);
    expect(afterSync("iptables")).toMatchObject({ lo: s(0), hi: s(1.21) });
    // the latest drop of an old pod: 1.391 s in IPVS (kind run 40128267098), 1.065 s in iptables (39090689204)
    expect(valueIn(afterSync("ipvs").hi, "s")).toBeGreaterThan(1.391);
    expect(valueIn(afterSync("iptables").hi, "s")).toBeGreaterThan(1.065);
    const update = T07_CELLS.find((cell) => cell.trigger.kind === "rolling-update")!;
    expect(update.prediction.kind).toBe("none");
    expect(update.prediction.why).toMatch(/1\.21 s at the most, a sync of up to 0\.105 s at the change, minSyncPeriod/);
  });

  it("fits the drain of each declaration in its grace: O10 and O16 hold", () => {
    for (const cell of ALL) {
      const verdicts = verdictsOf(lintCell(describeCell(cell), cell, PROPAGATION[cell.mode]));
      expect(verdicts["O10"], cell.name).toBe("holds");
      expect(verdicts["O16"], cell.name).toBe("holds");
    }
  });

  it("gives T18 the bands of the research at the defaults: the Service is empty from 28 s, and each replica restarts in 28–50 s", () => {
    const e = { lo: valueIn(PROPAGATION.iptables.lo, "s"), hi: valueIn(PROPAGATION.iptables.hi, "s") };
    const b = (lo: number, hi: number) => ({ lo: s(lo), hi: s(hi) });
    const band = (name: RegExp) => {
      const prediction = T18_CELLS.find((cell) => name.test(cell.name))!.prediction;
      return "band" in prediction ? prediction.band : null;
    };
    expect(band(/^T18 rst/)).toEqual(b(28 + e.lo, 48 + e.hi));
    expect(band(/^T18 Redis frozen/)).toEqual(b(28 + e.lo, 50 + e.hi));
    expect(band(/readiness fails liveness/)).toEqual(b(28, 50));
    expect(band(/event loop/)).toEqual(b(21 + e.lo, 31 + e.hi));
    // the hold of each fault outlasts its band
    for (const cell of T18_CELLS) {
      const b = "band" in cell.prediction ? cell.prediction.band : null;
      if (b !== null && cell.trigger.kind !== "app-stall") expect(valueIn(cell.trigger.hold!, "s"), cell.name).toBeGreaterThan(valueIn(b.hi, "s"));
    }
    expect(T18_CELLS.find((cell) => cell.trigger.kind === "app-stall")!.trigger.hold).toEqual(s(40));
  });
});
