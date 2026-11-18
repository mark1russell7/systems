import type { Layer, Limit } from "@mark1russell7/harness";
import { LAYERS, LAYER_FACTS, layerOf, limitsOf } from "@mark1russell7/harness";
import { describe, expect, it } from "vitest";
import { ALL } from "./all.ts";
import { KIND_CATALOG } from "./kinds.ts";

/**
 * The facts of each layer tell what its cells apply: the faults that a cell injects, and the limits
 * that its load fills. This test holds the two lists of each layer equal to the cells of `ALL` and of
 * `KIND_CATALOG`. A new fault or limit on a layer thus changes `LAYER_FACTS` of the harness in the same
 * change. A cell of the harness is on E1 or E3 by its topology. A cell of kind is on E2, and its fault is
 * the kind of its trigger.
 */
const applied = (): ReadonlyMap<Layer, { readonly faults: ReadonlySet<string>; readonly limits: ReadonlySet<Limit> }> => {
  const out = new Map(LAYERS.map((layer) => [layer, { faults: new Set<string>(), limits: new Set<Limit>() }] as const));
  const add = (layer: Layer, fault: string, limits: readonly Limit[]): void => {
    const at = out.get(layer);
    if (at === undefined) return;
    if (fault !== "none") at.faults.add(fault);
    for (const limit of limits) at.limits.add(limit);
  };
  for (const cell of ALL) add(layerOf(cell.topology), cell.fault, limitsOf(cell));
  for (const cell of KIND_CATALOG) add("E2", cell.trigger.kind, limitsOf(cell));
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
