import { describe, expect, it } from "vitest";
import {
  canonicalUnit,
  convert,
  convertExact,
  convertible,
  factorOf,
  format,
  isCanonicalUnit,
  kindOf,
  quantity,
  rationals as q,
  whyNotConvertible,
} from "./index.ts";

/** The international (IT) British thermal unit is 1055.05585262 J exactly (ISO 31-4, NIST SP 811, B.8). */
const BTU_IN_J = q.div(q.fromDecimal("105505585262"), q.fromDecimal("100000000"));

/** Stove makers give fuel rates in BTU per hour, and fuel energy in MJ per kilogram. */
describe("the units of fuel", () => {
  it("gives one BTU as 1055.05585262 J, exactly", () => {
    expect(convertExact(q.ONE, "BTU", "J")).toEqual(BTU_IN_J);
    expect(convertExact(q.ONE, "BTU", "J")).toEqual(q.fromDecimal("1055.05585262"));
    expect(convert(quantity(1, "BTU"), "J").value).toBe(1055.05585262);
    expect(factorOf("BTU", "kJ")).toBeCloseTo(1.05505585262, 14);
  });

  it("converts 15000 BTU/h to W and kW, exactly", () => {
    const watts = q.div(q.mul(q.fromDecimal("15000"), BTU_IN_J), q.fromDecimal("3600"));
    expect(convertExact(q.fromDecimal("15000"), "BTU/h", "W")).toEqual(watts);
    expect(q.toNumber(watts)).toBeCloseTo(4396.0660525833, 9);
    expect(convert(quantity(15000, "BTU/h"), "W").value).toBeCloseTo(4396.0660525833, 9);
    expect(convertExact(q.fromDecimal("15000"), "BTU/h", "kW")).toEqual(q.div(watts, q.fromDecimal("1000")));
    expect(kindOf("BTU/h")).toBe("power");
  });

  it("gives one MJ as 1000 kJ, and 1 MJ/kg as 1000 kJ/kg, exactly", () => {
    expect(convertExact(q.ONE, "MJ", "J")).toEqual(q.fromDecimal("1000000"));
    expect(convertExact(q.ONE, "MJ", "kJ")).toEqual(q.fromDecimal("1000"));
    expect(convertExact(q.ONE, "MJ/kg", "kJ/kg")).toEqual(q.fromDecimal("1000"));
    expect(convert(quantity(1, "MJ/kg"), "kJ/kg")).toEqual({ value: 1000, unit: "kJ/kg" });
    expect(kindOf("MJ")).toBe("energy");
  });

  it("reads Btu as BTU, and keeps BTU and MJ as canonical spellings", () => {
    expect(canonicalUnit("Btu")).toBe("BTU");
    expect(canonicalUnit("Btu/h")).toBe("BTU/h");
    expect(isCanonicalUnit("BTU")).toBe(true);
    expect(isCanonicalUnit("BTU/h")).toBe(true);
    expect(isCanonicalUnit("MJ/kg")).toBe(true);
    expect(isCanonicalUnit("Btu")).toBe(false);
    expect(format(quantity(15000, "BTU/h"))).toBe("15,000 BTU/h");
    expect(format(quantity(46, "MJ/kg"))).toBe("46 MJ/kg");
  });

  it("does not convert a BTU or a MJ to a unit of a different dimension", () => {
    expect(convertible("BTU", "kg")).toBe(false);
    expect(convertible("BTU/h", "kJ/kg")).toBe(false);
    expect(convertible("MJ/kg", "MJ")).toBe(false);
    expect(whyNotConvertible("BTU", "kg")).toBeDefined();
    expect(() => convert(quantity(1, "BTU"), "kg")).toThrow();
  });
});
