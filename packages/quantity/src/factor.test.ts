import { random } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { UnitError, convertible, divideUnits, factorOf, multiplyUnits, quantity, valueIn, whyNotConvertible } from "./index.ts";

/** These pairs convert. Each pair has a factor that `valueIn` also gives. */
const PAIRS: readonly (readonly [string, string])[] = [
  ["MiB", "B"],
  ["B", "MiB"],
  ["ms", "s"],
  ["{request}/s", "{request}/min"],
  ["{core}·ms/s", "{core}"],
  ["Gbit/s", "B/s"],
  ["s", "s"],
];

describe("factorOf", () => {
  it("gives the factor that valueIn gives for one of the unit, for each pair", () => {
    for (const [from, to] of PAIRS) expect(factorOf(from, to)).toBeCloseTo(valueIn(quantity(1, from), to), 12);
    expect(factorOf("MiB", "B")).toBe(1048576);
    expect(factorOf("s", "s")).toBe(1);
  });

  it("gives an amount times the factor near the exact conversion, for random amounts", () => {
    const draw = random("factorOf amounts");
    for (let index = 0; index < 200; index += 1) {
      const value = (draw.next() - 0.5) * 10 ** Math.floor(draw.next() * 12);
      for (const [from, to] of PAIRS) {
        const exact = valueIn(quantity(value, from), to);
        expect(Math.abs(value * factorOf(from, to) - exact)).toBeLessThanOrEqual(Math.abs(exact) * 1e-12 + 1e-300);
      }
    }
  });

  it("gives the same factor on each call", () => {
    expect(factorOf("MiB", "B")).toBe(factorOf("MiB", "B"));
  });

  it("gives a UnitError for a pair that does not convert, an absolute temperature and a unit of the HZ", () => {
    expect(() => factorOf("s", "B")).toThrow(UnitError);
    expect(() => factorOf("Cel", "K")).toThrow(/absolute temperature/);
    expect(() => factorOf("jiffy", "s")).toThrow(/HZ/);
  });
});

describe("the caches of the pairs", () => {
  it("keep the reason, the product and the quotient of each pair", () => {
    expect(whyNotConvertible("s", "B")).toBe(whyNotConvertible("s", "B"));
    expect(whyNotConvertible("ms", "s")).toBeUndefined();
    expect(convertible("ms", "s")).toBe(true);
    expect(multiplyUnits("{request}/s", "{core}·ms/{request}")).toBe("{core}·ms/s");
    expect(multiplyUnits("{request}/s", "{core}·ms/{request}")).toBe("{core}·ms/s");
    expect(divideUnits("{core}·ms/s", "{request}/s")).toBe(divideUnits("{core}·ms/s", "{request}/s"));
  });
});
