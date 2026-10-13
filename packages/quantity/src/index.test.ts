import { describe, expect, it } from "vitest";
import type { Extent } from "./index.ts";
import {
  ATOMS,
  add,
  canonicalUnit,
  compare,
  convert,
  extentSchema,
  format,
  formatDuration,
  isCanonicalUnit,
  isQuantitySchema,
  kindOf,
  mean,
  min,
  quantity,
  quantitySchema,
  round,
  sum,
  toNanoseconds,
  unbounded,
  unitSchema,
  valueIn,
  whyNotConvertible,
} from "./index.ts";

describe("units", () => {
  it("converts exactly by rational factors (SYSTEMS.md §9)", () => {
    // keepalive at the defaults: 7200 s + 9 × 75 s
    expect(convert(quantity(7875, "s"), "min").value).toBe(131.25);
    expect(convert(quantity(1, "mi"), "km").value).toBe(1.609344);
    expect(convert(quantity(1, "cup"), "mL").value).toBe(236.5882365);
    expect(convert(quantity(3, "tsp"), "tbsp").value).toBe(1);
    expect(convert(quantity(1, "lb"), "g").value).toBe(453.59237);
    expect(convert(quantity(1, "KiB"), "B").value).toBe(1024);
    expect(convert(quantity(1, "kB"), "B").value).toBe(1000);
    expect(convert(quantity(1, "Gbit/s"), "MB/s").value).toBe(125);
    expect(convert(quantity(1, "mo"), "d").value).toBe(30.436875);
    expect(convert(quantity(500, "USD/mo"), "USD/yr").value).toBe(6000);
    expect(convert(quantity(1, "kcal/(h·kg)"), "W/kg").value).toBeCloseTo(1.1622, 4);
  });

  it("converts the affine temperature scales, and a compound of one as a difference", () => {
    expect(convert(quantity(212, "degF"), "degC").value).toBe(100);
    expect(convert(quantity(-40, "degC"), "degF").value).toBe(-40);
    expect(convert(quantity(0, "degC"), "K").value).toBe(273.15);
    // a rate of change has no zero point: 9 °F/h is 5 °C/h
    expect(convert(quantity(9, "degF/h"), "degC/h").value).toBe(5);
  });

  it("measures a jiffy by the kernel's HZ, and refuses to guess it", () => {
    expect(convert(quantity(1, "jiffy"), "ms", { hz: 250 }).value).toBe(4);
    expect(convert(quantity(250, "jiffy"), "s", { hz: 250 }).value).toBe(1);
    expect(() => convert(quantity(1, "jiffy"), "ms")).toThrow(/depends on the kernel's HZ/);
  });

  it("names the dimension of every unit, and keeps transfers apart from clocks", () => {
    expect(kindOf("GT/s")).toBe("transfer-rate");
    expect(kindOf("GHz")).toBe("frequency");
    expect(kindOf("bpm")).toBe("frequency");
    expect(kindOf("{set}/wk")).toBe("frequency");
    expect(kindOf("Gbit/s")).toBe("data-rate");
    expect(kindOf("mi/h")).toBe("speed");
    expect(kindOf("kcal/(h·kg)")).toBe("specific-power");
    expect(kindOf("mL/(kg·min)")).toBe("specific-volume-rate");
    expect(kindOf("USD/mo")).toBe("money-rate");
    expect(kindOf("%{1RM}")).toBe("ratio");
    expect(kindOf("{rep}")).toBe("count");
    expect(kindOf("dBA")).toBe("level");
    // 8 GT/s is not 8 GHz, and bits are not transfers
    expect(whyNotConvertible("GT/s", "GHz")).toMatch(/counts transfer and GHz nothing/);
    expect(whyNotConvertible("GT/s", "Gbit/s")).toMatch(
      /is a transfer-rate and Gbit\/s is a data-rate/,
    );
  });

  it("converts only between what counts the same thing", () => {
    expect(whyNotConvertible("bpm", "Hz")).toMatch(/counts beat/);
    expect(whyNotConvertible("{rep}", "count")).toMatch(/counts rep/);
    expect(whyNotConvertible("%{1RM}", "%")).toMatch(/of 1RM/);
    expect(whyNotConvertible("kg", "s")).toBe("kg is a mass and s is a time");
    expect(convert(quantity(3, "{set}/wk"), "{set}/d").value).toBeCloseTo(3 / 7, 12);
  });

  it("reads other systems' spellings into ours, and stores only ours", () => {
    // Health Auto Export's, as the ledger holds them
    expect(canonicalUnit("kcal/hr·kg")).toBe("kcal/(h·kg)");
    expect(canonicalUnit("mi/hr")).toBe("mi/h");
    expect(canonicalUnit("ml/(kg·min)")).toBe("mL/(kg·min)");
    expect(canonicalUnit("dBASPL")).toBe("dBA");
    expect(canonicalUnit("count/min")).toBe("count/min");
    expect(canonicalUnit("Tbsp")).toBe("tbsp");
    expect(canonicalUnit("fl. oz")).toBe("fl oz");
    expect(isCanonicalUnit("hr")).toBe(false);
    expect(isCanonicalUnit("h")).toBe(true);
    expect(() => canonicalUnit("furlong")).toThrow(/unknown unit furlong/);
    expect(() => canonicalUnit("m/s/s")).toThrow(/at most one \//);
  });

  it("gives every spelling one meaning", () => {
    const spellings = ATOMS.flatMap((atom) => [atom.symbol, ...(atom.aliases ?? [])]);
    expect(new Set(spellings).size).toBe(spellings.length);
  });
});

describe("arithmetic", () => {
  it("adds money to the cent, in the first amount's unit", () => {
    expect(add(quantity(0.1, "USD"), quantity(0.2, "USD")).value).toBe(0.3);
    expect(sum([quantity(19.99, "USD"), quantity(0.01, "USD"), quantity(-5, "USD")]).value).toBe(
      15,
    );
    expect(sum([], "USD")).toEqual({ value: 0, unit: "USD" });
    expect(add(quantity(1, "h"), quantity(30, "min"))).toEqual({ value: 1.5, unit: "h" });
    expect(round(quantity(10 / 3, "USD"))).toEqual({ value: 3.33, unit: "USD" });
    expect(() => add(quantity(1, "kg"), quantity(1, "s"))).toThrow(/cannot convert s to kg/);
  });

  it("averages a level by its energy, and refuses to add one", () => {
    // 60 and 70 dBA together are 67.4 dBA, not 65
    expect(mean([quantity(60, "dBA"), quantity(70, "dBA")]).value).toBeCloseTo(67.4, 1);
    expect(() => add(quantity(60, "dBA"), quantity(60, "dBA"))).toThrow(/use meanLevel/);
    expect(mean([quantity(60, "min"), quantity(2, "h")], "min").value).toBe(90);
  });

  it("orders amounts across units, with no bound above every one", () => {
    expect(compare(quantity(90, "s"), quantity(1.5, "min"))).toBe(0);
    expect(compare(quantity(61, "s"), quantity(1, "min"))).toBe(1);
    expect(min<Extent>(unbounded("s"), quantity(7875, "s"))).toEqual({ value: 7875, unit: "s" });
    expect(compare(unbounded("s"), quantity(1e9, "yr"))).toBe(1);
  });

  it("keeps the simulator's clock in whole nanoseconds, or refuses", () => {
    expect(toNanoseconds(quantity(1.5, "s"))).toBe(1_500_000_000);
    expect(toNanoseconds(quantity(200, "ms"))).toBe(200_000_000);
    expect(toNanoseconds(quantity(1, "jiffy"), { hz: 250 })).toBe(4_000_000);
    expect(() => toNanoseconds(quantity(0.5, "ns"))).toThrow(/not a whole number of ns/);
    expect(() => toNanoseconds(quantity(1, "yr"))).toThrow(/past what a double holds/);
  });
});

describe("format", () => {
  it("prints each kind as people read it", () => {
    expect(format(quantity(1234.5, "USD"))).toBe("$1,234.50");
    expect(format(quantity(-12.3, "USD"))).toBe("-$12.30");
    // money shows its cents only when it has any, unless asked for a number of places
    expect(format(quantity(500, "USD/mo"))).toBe("$500/mo");
    expect(format(quantity(400, "USD"))).toBe("$400");
    expect(format(quantity(400, "USD"), { digits: 2 })).toBe("$400.00");
    expect(format(quantity(1234.5, "USD"), { digits: 0 })).toBe("$1,235");
    // the calendar's units read as words on their own, and as symbols in a compound
    expect(format(quantity(6, "d"))).toBe("6 days");
    expect(format(quantity(1, "wk"))).toBe("1 week");
    expect(format(quantity(2.5, "yr"))).toBe("2.5 years");
    expect(format(quantity(7875, "s"))).toBe("7,875 s");
    expect(format(quantity(34.5, "%"))).toBe("34.5%");
    expect(format(quantity(72, "degF"))).toBe("72°F");
    expect(format(quantity(12, "{rep}"))).toBe("12 reps");
    expect(format(quantity(1, "{rep}"))).toBe("1 rep");
    // a size reads the same for many, and a bare count is its number
    expect(format(quantity(5, "{large}"))).toBe("5 large");
    expect(format(quantity(15, "count"))).toBe("15");
    expect(format(quantity(3, "{set}/wk"))).toBe("3 sets/wk");
    expect(format(quantity(85, "%{1RM}"))).toBe("85% of 1RM");
    expect(format(quantity(72, "bpm"))).toBe("72 bpm");
    expect(format(quantity(8, "mi/h"))).toBe("8 mph");
    expect(format(quantity(4.5, "kcal/(h·kg)"))).toBe("4.5 kcal/(h·kg)");
    expect(format(quantity(250, "us"))).toBe("250 µs");
    expect(format(unbounded("s"))).toBe("∞ s");
    expect(format({ unknown: "not published", unit: "s" })).toBe("unknown: not published");
    expect(format(quantity(2.5, "min"), { signed: true })).toBe("+2.5 min");
  });

  it("says a time in the units people use, rounding the smallest", () => {
    expect(formatDuration(quantity(7875, "s"))).toBe("2 h 11 min 15 s");
    expect(formatDuration(quantity(45, "min"))).toBe("45 min");
    expect(formatDuration(quantity(90, "min"))).toBe("1 h 30 min");
    expect(formatDuration(quantity(3599.6, "s"), 2)).toBe("1 h");
    expect(formatDuration(quantity(250, "ms"))).toBe("250 ms");
    expect(formatDuration(quantity(2, "d"))).toBe("2 days");
    expect(formatDuration(quantity(27, "h"))).toBe("1 day 3 h");
  });
});

describe("schemas", () => {
  it("takes a quantity in a canonical unit of the kind asked for, and says what was wrong", () => {
    const time = quantitySchema("time");
    expect(time.parse({ value: 45, unit: "min" })).toEqual({ value: 45, unit: "min" });
    const issues = (input: unknown): string[] =>
      time.safeParse(input).error?.issues.map((issue) => issue.message) ?? [];
    expect(issues({ value: 45, unit: "hr" })).toEqual(["write h, not hr"]);
    expect(issues({ value: 45, unit: "kg" })).toEqual(["kg is a mass, and this is a time"]);
    expect(issues({ value: 45, unit: "fortnight" })).toEqual([
      "fortnight is not a known unit",
    ]);
    expect(time.safeParse({ value: Number.POSITIVE_INFINITY, unit: "s" }).success).toBe(false);
    expect(time.safeParse({ value: 1, unit: "s", note: "x" }).success).toBe(false);
  });

  it("takes no bound where a schema allows one, and marks quantity fields for codegen", () => {
    expect(extentSchema("time").parse({ value: "infinite", unit: "s" })).toEqual({
      value: "infinite",
      unit: "s",
    });
    expect(quantitySchema("time").safeParse({ value: "infinite", unit: "s" }).success).toBe(false);
    expect(isQuantitySchema(quantitySchema("money").optional())).toBe(true);
    expect(isQuantitySchema(unitSchema("time"))).toBe(false);
    expect(unitSchema(["money", "money-rate"]).safeParse("USD/mo").success).toBe(true);
    const positive = quantitySchema("time", { positive: true });
    expect(positive.safeParse({ value: 0, unit: "min" }).success).toBe(false);
    expect(positive.safeParse({ value: 30, unit: "min" }).success).toBe(true);
  });

  it("reads a value in the unit a reader computes in", () => {
    expect(valueIn(quantity(2, "h"), "min")).toBe(120);
  });
});
