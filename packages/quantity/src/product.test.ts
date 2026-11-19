import { describe, expect, it } from "vitest";
import {
  TIME_ATOMS,
  UnitError,
  convert,
  convertExact,
  convertible,
  divide,
  divideUnits,
  isCanonicalUnit,
  multiply,
  multiplyUnits,
  parseUnit,
  quantity,
  rationals,
  unitSystem,
  valueIn,
} from "./index.ts";
import * as time from "./time.ts";

/** These units have counts, prefixes, powers, a divisor of two factors and a jiffy. Each pair of them has a product. */
const UNITS_OF_TEST = [
  "{request}/s",
  "{core}·ms/{request}",
  "B/{request}",
  "ms",
  "s",
  "m^2",
  "kg·m/s^2",
  "W",
  "USD/kWh",
  "kWh",
  "{rep}",
  "count",
  "%",
  "Hz",
  "KiB/(s·{core})",
  "jiffy",
] as const;

/** This function gives the factor that converts one of `unit` to the base units of its vector. */
const factorOf = (unit: string): rationals.Rational => parseUnit(unit).factor;

describe("multiplyUnits", () => {
  it.each([
    ["{request}/s", "{core}·ms/{request}", "{core}·ms/s"],
    ["{core}·ms/{request}", "{request}/s", "{core}·ms/s"],
    ["B/{request}", "{request}/s", "B/s"],
    ["s", "s", "s^2"],
    ["m/s", "s", "m"],
    ["W", "h", "W·h"],
    ["USD/kWh", "kWh", "USD"],
    ["ms", "Hz", "ms·Hz"],
    ["{rep}", "{rep}", "{rep}^2"],
    ["KiB/(s·{core})", "{core}", "KiB/s"],
    ["m^2", "m/s^2", "m^3/s^2"],
  ])("%s times %s is %s", (a, b, product) => {
    expect(multiplyUnits(a, b)).toBe(product);
    expect(isCanonicalUnit(product)).toBe(true);
  });

  it("gives count when each factor cancels", () => {
    expect(multiplyUnits("{request}/s", "s/{request}")).toBe("count");
    expect(divideUnits("B/{request}", "B/{request}")).toBe("count");
  });

  it("gives a unit that converts to the unit of the instance", () => {
    expect(convertible(multiplyUnits("{request}/s", "{core}·ms/{request}"), "{core}")).toBe(true);
    expect(convertible(multiplyUnits("{request}/s", "B/{request}"), "bit/s")).toBe(true);
    expect(convertible(multiplyUnits("{request}/s", "B/{request}"), "{core}")).toBe(false);
  });

  it("refuses an absolute temperature, and a product that leaves one", () => {
    expect(() => multiplyUnits("degC", "s")).toThrow(UnitError);
    expect(() => multiplyUnits("s", "degF")).toThrow(/absolute temperature/);
    expect(() => multiplyUnits("degC·s", "Hz")).not.toThrow();
    expect(() => divideUnits("degC·s", "s")).toThrow(/leaves degC alone/);
    expect(divideUnits("degC/min", "s")).toBe("degC/(min·s)");
  });

  it("refuses a level and a spelling that is not a unit", () => {
    expect(() => multiplyUnits("dB", "s")).toThrow(UnitError);
    expect(() => multiplyUnits("s", "parsec")).toThrow(UnitError);
  });

  it("uses the table of its system", () => {
    expect(time.multiplyUnits("ms", "Hz")).toBe("ms·Hz");
    expect(time.divideUnits("{rep}", "min")).toBe("{rep}/min");
    expect(() => time.multiplyUnits("ms", "m")).toThrow(UnitError);
    const bare = unitSystem(TIME_ATOMS.filter((atom) => atom.symbol !== "count"));
    expect(() => bare.divideUnits("s", "s")).toThrow(/no unit count/);
  });

  it("has the laws of multiplication for each pair and each triple of the units of the test", () => {
    // a jiffy converts only with the HZ of the kernel
    const on = { hz: 250 };
    for (const a of UNITS_OF_TEST) {
      // a unit divided by itself is the unit 1
      expect(divideUnits(a, a)).toBe("count");
      for (const b of UNITS_OF_TEST) {
        const ab = multiplyUnits(a, b);
        const ba = multiplyUnits(b, a);
        expect(isCanonicalUnit(ab)).toBe(true);
        // the order changes the spelling at most: the amount is the same
        expect(convertible(ab, ba)).toBe(true);
        expect(convertExact(rationals.ONE, ab, ba, on)).toEqual(rationals.ONE);
        // the factor of a product is the product of the factors
        expect(factorOf(ab)).toEqual(rationals.mul(factorOf(a), factorOf(b)));
        // a quotient undoes a product
        expect(convertExact(rationals.ONE, divideUnits(ab, b), a, on)).toEqual(rationals.ONE);
        for (const c of UNITS_OF_TEST.slice(0, 6)) {
          expect(convertExact(rationals.ONE, multiplyUnits(ab, c), multiplyUnits(a, multiplyUnits(b, c)), on)).toEqual(rationals.ONE);
        }
      }
    }
  });
});

describe("multiply and divide", () => {
  it("give the CPU of a rate of requests, in cores", () => {
    const cpu = multiply(quantity(50, "{request}/s"), quantity(4, "{core}·ms/{request}"));
    expect(cpu).toEqual({ value: 200, unit: "{core}·ms/s" });
    expect(valueIn(cpu, "{core}")).toBe(0.2);
  });

  it("give the bits of the network of a rate of requests", () => {
    const network = multiply(quantity(1000, "{request}/s"), quantity(1.5, "KiB/{request}"));
    expect(valueIn(network, "bit/s")).toBe(12_288_000);
  });

  it("are exact for decimal inputs", () => {
    expect(multiply(quantity(0.1, "USD/kWh"), quantity(0.3, "kWh"))).toEqual({ value: 0.03, unit: "USD" });
    expect(divide(quantity(0.3, "kWh"), quantity(0.1, "h"))).toEqual({ value: 3, unit: "kWh/h" });
    expect(convert(divide(quantity(0.3, "kWh"), quantity(0.1, "h")), "kW").value).toBe(3);
  });

  it("refuse a quotient by 0 and a level", () => {
    expect(() => divide(quantity(1, "s"), quantity(0, "s"))).toThrow(RangeError);
    expect(() => multiply(quantity(60, "dB"), quantity(2, "count"))).toThrow(/level/);
  });
});
