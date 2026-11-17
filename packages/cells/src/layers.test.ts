import type { Fault, Layer, Limit } from "@mark1russell7/harness";
import { LAYERS, LAYER_FACTS, layerOf, limitsOf } from "@mark1russell7/harness";
import { describe, expect, it } from "vitest";
import { ALL } from "./all.ts";

/**
 * The facts of each layer tell what its cells apply: the faults that a cell injects, and the limits
 * that its load fills. This test holds the two lists of each layer equal to the cells of `ALL`. A new
 * fault or limit on a layer thus changes `LAYER_FACTS` of the harness in the same change.
 */
const applied = (): ReadonlyMap<Layer, { readonly faults: ReadonlySet<Fault>; readonly limits: ReadonlySet<Limit> }> => {
  const out = new Map(LAYERS.map((layer) => [layer, { faults: new Set<Fault>(), limits: new Set<Limit>() }] as const));
  for (const cell of ALL) {
    const at = out.get(layerOf(cell.topology));
    if (at === undefined) continue;
    if (cell.fault !== "none") at.faults.add(cell.fault);
    for (const limit of limitsOf(cell)) at.limits.add(limit);
  }
  return out;
};

describe("the facts of each layer", () => {
  const cells = applied();

  it.each(LAYERS)("of %s name each fault and each limit of its cells, and nothing else", (layer) => {
    const facts = LAYER_FACTS[layer];
    const at = cells.get(layer);
    expect([...facts.faults].sort()).toEqual([...(at?.faults ?? [])].sort());
    expect([...facts.limits].sort()).toEqual([...(at?.limits ?? [])].sort());
  });
});
