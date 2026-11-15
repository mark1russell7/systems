import { readFileSync } from "node:fs";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { ALL } from "./all.ts";
import { BFD_FABRIC, BGP_FABRIC, FABRIC_CELLS, moveOf, silencePrediction } from "./fabric.ts";

const cell = (name: string) => {
  const found = FABRIC_CELLS.find((each) => each.name === name);
  if (found === undefined) throw new Error(`no cell ${name}`);
  return found;
};

const recovers = (name: string) => {
  const { prediction } = cell(name);
  if (prediction.detects !== false || prediction.recovers === undefined) throw new Error(`${name} does not recover`);
  return prediction.recovers;
};

describe("the cells of the first fabric", () => {
  it("are in the list of all cells, each on a fabric, with four runs in two labs", () => {
    for (const each of FABRIC_CELLS) {
      expect(ALL.map((other) => other.name)).toContain(each.name);
      expect(each.name.startsWith("E3.")).toBe(true);
      expect(each.topology?.fabric).toBeDefined();
      expect(each.topology?.hops).toEqual([]);
      expect(each.runs).toBe(4);
      expect(each.environments).toBe(2);
    }
  });

  it("takes the move from the timers of each detector", () => {
    expect(moveOf(BGP_FABRIC).low).toBe(4);
    expect(moveOf(BGP_FABRIC).high).toBeCloseTo(6.1, 9);
    expect(moveOf(BFD_FABRIC).low).toBeCloseTo(0.48, 9);
    expect(moveOf(BFD_FABRIC).high).toBeCloseTo(0.8, 9);
  });

  it("recovers at firing 5 after the hold timer, and at firing 2 after BFD", () => {
    expect(recovers("E3.F1.bgp").firing).toBe(5);
    expect(recovers("E3.F1.bfd").firing).toBe(2);
  });

  it("holds each move strictly inside the band of its firing", () => {
    for (const [name, fabric] of [
      ["E3.F1.bgp", BGP_FABRIC],
      ["E3.F1.bfd", BFD_FABRIC],
    ] as const) {
      const { low, high } = moveOf(fabric);
      const { heal } = recovers(name);
      expect(valueIn(heal.low, "s")).toBeLessThan(low);
      expect(valueIn(heal.high, "s")).toBeGreaterThan(high);
    }
  });

  it("stops when a detector can land on a firing", () => {
    // 300 ms x 3 gives a move from 0.6 s to 0.98 s, and firing 2 comes near 0.8 s at each HZ
    const slow = { ...BFD_FABRIC, bfd: { interval: { value: 300, unit: "ms" }, multiplier: 3 } };
    expect(() => silencePrediction("a move across a firing", slow)).toThrow("a move");
  });
});

describe("the workflow of the cells", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/cells.yml", import.meta.url), "utf8");

  it("installs the pinned containerlab for a shard with a cell on a fabric only", () => {
    expect(workflow).toContain("containerlab_0.82.0_linux_amd64.deb");
    expect(workflow).toContain("770e18f19ef75732eb9f4e362541f509abb2b6eeadde2d5c98140190b19b519a");
    expect(workflow).toContain("pnpm exec tsx packages/cells/src/needs-cli.ts");
    expect(workflow).toContain("if: steps.needs.outputs.containerlab == 'true'");
    expect(workflow).not.toContain("contains(inputs.only, 'E3')");
  });
});
