import type { StopWay } from "@mark1russell7/service";
import { lint, lintStop } from "@mark1russell7/service";
import { describe, expect, it } from "vitest";
import type { Declaration, TriggerKind } from "./cell.ts";
import * as entry from "@mark1russell7/service/rules";
import { DESIGN, cellOf } from "./cells.fixture.ts";
import * as kind from "./index.ts";
import { DRAIN_RULES, O04, O09, O10, O16, describeCell, lintCell, scenarioOf, stopOf } from "./rules.ts";

const s = (value: number) => ({ value, unit: "s" });
const b = (lo: number, hi: number) => ({ lo: s(lo), hi: s(hi) });
const E = { ...b(0.05, 0.4), from: "a test" };

describe("the drain rules come from the entry ./rules of the service (SYS-32)", () => {
  it("gives the same objects as the entry, from this module and from the root of kind", () => {
    expect([O04, O09, O10, O16]).toEqual(entry.DRAIN_RULES);
    expect(DRAIN_RULES).toBe(entry.DRAIN_RULES);
    for (const name of ["DRAIN_RULES", "O04", "O09", "O10", "O16"] as const) expect(kind[name], name).toBe(entry[name]);
  });

  it("gives lintCell() the findings of lint() with the rules of the entry, for each trigger", () => {
    const triggers: TriggerKind[] = ["pod-deletion", "rolling-update", "liveness-restart", "crash", "rst", "freeze-process"];
    const noHold: Declaration = { ...DESIGN, phases: DESIGN.phases.map(([stage, cap]) => [stage, stage === "fail readiness" ? s(0) : cap]) };
    for (const declaration of [DESIGN, noHold])
      for (const trigger of triggers) {
        const cell = cellOf(trigger, declaration);
        const description = describeCell(cell);
        const way: StopWay | null = stopOf(cell);
        const scenario = scenarioOf(cell, E);
        const expected = way === null ? lint(description, scenario, entry.DRAIN_RULES) : lintStop(description, scenario, entry.DRAIN_RULES, way);
        expect(lintCell(description, cell, E), trigger).toEqual(expected);
      }
  });
});
