import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { Cell, Prediction } from "./cell.ts";
import type { LayerState, Limit } from "./layers.ts";
import { LAYERS, LAYER_FACTS, LIMITS, layerOf, limitsOf } from "./layers.ts";

/** This file is the plan of the layers. Its table "The layers" is the source of each text of `LAYER_FACTS`. */
const S7 = readFileSync(new URL("../../../docs/S7.md", import.meta.url), "utf8");

/** The states of the table, by their first word. */
const STATES: Readonly<Record<string, LayerState>> = { Today: "today", New: "new", Later: "later", Waits: "waiting" };

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** This function gives the rows of the table "The layers", by layer, as its cells. */
const tableRows = (): ReadonlyMap<string, readonly string[]> => {
  const section = S7.slice(S7.indexOf("## The layers"), S7.indexOf("## An answer for each link"));
  const rows = section
    .split("\n")
    .filter((line) => /^\| E\d /.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
  return new Map(rows.map((cells) => [cells[0] ?? "", cells.slice(1)]));
};

describe("the facts of the layers", () => {
  const rows = tableRows();

  it("have one row of the table of S7 for each layer, in the order of the table", () => {
    expect([...rows.keys()]).toEqual([...LAYERS]);
  });

  it.each(LAYERS)("of %s are the texts of its row", (layer) => {
    const [name, proves, cannot, tools, state] = rows.get(layer) ?? [];
    const facts = LAYER_FACTS[layer];
    expect(facts.name).toBe(name);
    expect(facts.proves).toBe(proves);
    expect(facts.cannot).toEqual(cannot === "Nothing that this plan covers" ? [] : (cannot ?? "").split(/, | and /).map(capital));
    expect(facts.tools).toEqual((tools ?? "").split(", ").map((tool) => tool.replaceAll("`", "")));
    expect(facts.state).toBe(STATES[(state ?? "").split(/[ ,]/)[0] ?? ""]);
  });

  it("keep the faults of a layer once each, and its limits in the order of LIMITS", () => {
    for (const layer of LAYERS) {
      const { faults, limits } = LAYER_FACTS[layer];
      expect(new Set(faults).size).toBe(faults.length);
      expect(limits).toEqual(LIMITS.filter((limit) => limits.includes(limit)));
    }
  });
});

describe("the layer of a lab", () => {
  it("is E3 with a fabric and E1 without one", () => {
    expect(layerOf(undefined)).toBe("E1");
    expect(layerOf({ name: "direct", hops: [] })).toBe("E1");
    const fabric = { fabric: {} } as unknown as NonNullable<Cell["topology"]>;
    expect(layerOf(fabric)).toBe("E3");
  });
});

/** A measured prediction is the prediction of a cell with no detection. Only it has the laws of a limit. */
type Measured = Extract<Prediction, { readonly detects: null }>;

/**
 * These keys of a measured prediction are not the laws of a limit. Some keys are the frame of the
 * measure. The other keys are the laws of a group, a request, a reconnect, the counts of lines, a paused
 * consumer and a load.
 */
const NOT_LIMITS = ["detects", "window", "why", "from", "ends", "group", "request", "reconnects", "counts", "pause", "load"] as const;

describe("the limits of a cell", () => {
  it("are each law of a resource in a measured prediction, and no other key", () => {
    // A new key of `Prediction` fails this check until it is in LIMITS or in NOT_LIMITS.
    expectTypeOf<Exclude<keyof Measured, Limit | (typeof NOT_LIMITS)[number]>>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<Limit, keyof Measured>>().toEqualTypeOf<never>();
    expect(LIMITS.filter((limit) => (NOT_LIMITS as readonly string[]).includes(limit))).toEqual([]);
  });

  it("are the laws of a limit that its prediction names, in the order of LIMITS", () => {
    expect(limitsOf({ prediction: { detects: null, why: "a test", memory: {}, queue: {}, ports: undefined } })).toEqual(["queue", "memory"]);
    expect(limitsOf({ prediction: { kind: "stays", why: "a cell of kind" } })).toEqual([]);
  });
});
