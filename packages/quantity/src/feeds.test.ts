import { describe, expect, it } from "vitest";
import {
  canonicalUnit,
  convert,
  factorOf,
  format,
  isCanonicalUnit,
  kindOf,
  mean,
  parseUnit,
  quantity,
  round,
  tryParseUnit,
  whyNotConvertible,
} from "./index.ts";

/**
 * These are the units of feeds of public data (SYS-131). Each row has a spelling and a unit of the same dimension.
 * It also has the value of one of the spelling in that unit, and the text of one.
 */
const FEED_UNITS: ReadonlyArray<readonly [spelling: string, other: string, value: number, text: string]> = [
  ["MW", "kW", 1000, "1 MW"],
  ["GW", "MW", 1000, "1 GW"],
  ["MWh", "kWh", 1000, "1 MWh"],
  ["GWh", "MWh", 1000, "1 GWh"],
  ["Gy", "J/kg", 1, "1 Gy"],
  ["Sv", "mSv", 1000, "1 Sv"],
  ["mSv", "uSv", 1000, "1 mSv"],
  ["µSv/h", "nSv/h", 1000, "1 µSv/h"],
  ["nSv", "uSv", 0.001, "1 nSv"],
  ["µg/m^3", "mg/m^3", 0.001, "1 µg/m^3"],
  ["ug", "mg", 0.001, "1 µg"],
  ["mcg", "ug", 1, "1 µg"],
  ["Pa", "hPa", 0.01, "1 Pa"],
  ["hPa", "Pa", 100, "1 hPa"],
  ["Bq/m^3", "Bq/L", 0.001, "1 Bq/m^3"],
  ["ppm", "ppb", 1000, "1 ppm"],
  ["ppb", "%", 1e-7, "1 ppb"],
  ["EUR/L", "EUR/mL", 0.001, "€1/L"],
  ["EUR/MWh", "EUR/kWh", 0.001, "€1/MWh"],
  ["GBP", "GBP", 1, "£1"],
  ["CHF", "CHF", 1, "1 CHF"],
  ["SEK/MWh", "SEK/kWh", 0.001, "1 SEK/MWh"],
  ["JPY", "JPY", 1, "¥1"],
  ["mHz", "Hz", 0.001, "1 mHz"],
  ["nT", "kg/(A·s^2)", 1e-9, "1 nT"],
  ["dB", "dB", 1, "1 dB"],
  ["Cel", "K", 274.15, "1°C"],
  ["kg.m^2/s^2", "J", 1, "1 kg·m^2/s^2"],
  ["nW/(cm^2.sr)", "W/(m^2·sr)", 1e-5, "1 nW/(cm^2·sr)"],
];

describe("the units of the feeds of public data", () => {
  it.each(FEED_UNITS)("parses %s, converts it to %s and formats it again", (spelling, other, value, text) => {
    expect(tryParseUnit(spelling)).toBeDefined();
    const unit = canonicalUnit(spelling);
    expect(isCanonicalUnit(unit)).toBe(true);
    expect(convert(quantity(1, unit), canonicalUnit(other)).value).toBeCloseTo(value, 12);
    expect(format(quantity(1, unit))).toBe(text);
  });

  it("writes the micro of a unit as u, and reads µ (U+00B5), μ (U+03BC) and mcg", () => {
    expect(canonicalUnit("µSv/h")).toBe("uSv/h");
    expect(canonicalUnit("μSv/h")).toBe("uSv/h");
    expect(canonicalUnit("µg/m^3")).toBe("ug/m^3");
    expect(canonicalUnit("mcg")).toBe("ug");
    expect(canonicalUnit("Cel")).toBe("degC");
  });

  it("reads the . of UCUM between two factors, but not inside a spelling of the table or an annotation", () => {
    expect(canonicalUnit("nW/(cm^2.sr)")).toBe("nW/(cm^2·sr)");
    expect(canonicalUnit("kcal/(h.kg)")).toBe(canonicalUnit("kcal/(h·kg)"));
    expect(canonicalUnit("fl. oz")).toBe("fl oz");
    expect(canonicalUnit("fl. oz/h")).toBe("fl oz/h");
    expect(canonicalUnit("{set 1.5}/wk")).toBe("{set 1.5}/wk");
    expect(tryParseUnit("kg.")).toBeUndefined();
    expect(tryParseUnit("kg.parsec")).toBeUndefined();
  });

  it.each([
    ["[in_i]", "in"],
    ["[ft_i]", "ft"],
    ["[yd_i]", "yd"],
    ["[mi_i]", "mi"],
    ["[oz_av]", "oz"],
    ["[lb_av]", "lb"],
    ["[tsp_us]", "tsp"],
    ["[tbs_us]", "tbsp"],
    ["[foz_us]", "fl oz"],
    ["[cup_us]", "cup"],
    ["[pt_us]", "pt"],
    ["[qt_us]", "qt"],
    ["[gal_us]", "gal"],
    ["[degF]", "degF"],
    ["[Btu_IT]", "BTU"],
  ])("reads the UCUM code %s as %s", (code, symbol) => {
    expect(canonicalUnit(code)).toBe(symbol);
    expect(canonicalUnit(`USD/${code}`)).toBe(`USD/${symbol}`);
  });

  it("gives the UCUM factors: 7000 grains of 64.79891 mg in a pound, and 231 cubic inches in a gallon", () => {
    expect(factorOf("[lb_av]", "mg")).toBeCloseTo(7000 * 64.79891, 6);
    expect(factorOf("[oz_av]", "[lb_av]")).toBeCloseTo(1 / 16, 12);
    expect(factorOf("[gal_us]", "[in_i]^3")).toBeCloseTo(231, 9);
    expect(factorOf("[foz_us]", "[tbs_us]")).toBeCloseTo(2, 12);
    expect(factorOf("[tbs_us]", "[tsp_us]")).toBeCloseTo(3, 12);
    expect(factorOf("[mi_i]", "[ft_i]")).toBeCloseTo(5280, 9);
  });

  it("keeps a weighted dose, a count of decays, each currency, a level and a steradian apart", () => {
    expect(whyNotConvertible("Sv", "Gy")).toBe("Sv (weighted dose) and Gy (plain) stay apart");
    expect(whyNotConvertible("uSv/h", "Gy/h")).toBe("uSv/h (weighted dose) and Gy/h (plain) stay apart");
    expect(whyNotConvertible("Bq", "Hz")).toBe("Bq counts decay and Hz nothing in particular");
    expect(whyNotConvertible("EUR", "USD")).toBe("EUR (euro) and USD (US dollar) stay apart");
    expect(whyNotConvertible("EUR/MWh", "USD/kWh")).toBe("EUR/MWh (euro) and USD/kWh (US dollar) stay apart");
    expect(whyNotConvertible("dB", "%")).toBe("dB and % are levels, and a level converts only to itself");
    expect(whyNotConvertible("dB", "dBA")).toBe("dB and dBA are levels, and a level converts only to itself");
    expect(whyNotConvertible("nW/(cm^2·sr)", "W/m^2")).toBe("nW/(cm^2·sr) (per steradian) and W/m^2 (plain) stay apart");
    expect(whyNotConvertible("sr", "%")).toBe("sr (steradian) and % (plain) stay apart");
    // a name that divides out leaves a plain unit: EUR per EUR is a ratio
    expect(whyNotConvertible("EUR/EUR", "%")).toBeUndefined();
    expect(parseUnit("EUR/EUR").apart).toBeUndefined();
  });

  it("names the kind of each new unit by its vector, whatever keeps it apart", () => {
    expect(kindOf("EUR")).toBe("money");
    expect(kindOf("JPY/mo")).toBe("money-rate");
    expect(kindOf("EUR/MWh")).toBe("energy-price");
    expect(kindOf("MW")).toBe("power");
    expect(kindOf("GWh")).toBe("energy");
    expect(kindOf("Bq")).toBe("frequency");
    expect(kindOf("mHz")).toBe("frequency");
    expect(kindOf("ppm")).toBe("ratio");
    expect(kindOf("sr")).toBe("ratio");
    expect(kindOf("dB")).toBe("level");
    expect(kindOf("Gy")).toBe("derived");
    // a gray per second is a watt per kilogram, thus a dose rate has the kind of a power per mass, but a weighted
    // dose rate does not convert to the cost of an exertion
    expect(kindOf("uSv/h")).toBe("specific-power");
    expect(whyNotConvertible("uSv/h", "kcal/(h·kg)")).toBe("uSv/h (weighted dose) and kcal/(h·kg) (plain) stay apart");
  });

  it("keeps the cent of each currency but the yen, and prints a currency without a symbol after the number", () => {
    expect(round(quantity(10 / 3, "EUR"))).toEqual({ value: 3.33, unit: "EUR" });
    expect(round(quantity(1234.5, "JPY"))).toEqual({ value: 1235, unit: "JPY" });
    expect(format(quantity(1234.5, "JPY"))).toBe("¥1,235");
    expect(format(quantity(42.5, "EUR/MWh"))).toBe("€42.50/MWh");
    expect(format(quantity(-12.5, "CHF"))).toBe("-12.50 CHF");
    expect(format(quantity(85, "SEK/MWh"))).toBe("85 SEK/MWh");
    expect(format(quantity(3.2, "GBP/mo"))).toBe("£3.20/mo");
  });

  it("prints a ratio other than a percentage with a space, and averages a level by its energy", () => {
    expect(format(quantity(410.5, "ppm"))).toBe("410.5 ppm");
    expect(format(quantity(34.5, "%"))).toBe("34.5%");
    expect(convert(quantity(410, "ppm"), "%").value).toBeCloseTo(0.041, 12);
    expect(mean([quantity(60, "dB"), quantity(70, "dB")]).value).toBeCloseTo(67.4, 1);
  });
});
