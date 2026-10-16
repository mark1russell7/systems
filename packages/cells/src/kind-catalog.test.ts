import { describe, expect, it } from "vitest";
import type { KindCell } from "@mark1russell7/kind";
import { clientObjects, describeCell, lintCell, namespaceOf, pausedWindow, planOf, serverObjects, verdictsOf } from "@mark1russell7/kind";
import { valueIn } from "@mark1russell7/quantity";
import { PROPAGATION, s } from "./kind.ts";
import { T07_CELLS } from "./t07.ts";
import { T18_CELLS } from "./t18.ts";

const ALL: readonly KindCell[] = [...T07_CELLS, ...T18_CELLS];

/** the propagation that a cell meets: the pause of kube-proxy on one node, or the calibration of its mode */
const propagationOf = (cell: KindCell) => {
  const e = PROPAGATION[cell.mode];
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
