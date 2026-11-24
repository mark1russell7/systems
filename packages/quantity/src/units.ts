import type { Rational } from "@mark1russell7/rational";
import { ONE, div, mul, pow, rational } from "@mark1russell7/rational";
import type { Atom, Vector } from "./dimensions.ts";
import { JOULE, KINDS, atom, decimal as r } from "./dimensions.ts";
import type { UnitSystem } from "./system.ts";
import { unitSystem } from "./system.ts";
import { DIMENSIONLESS_ATOMS, FREQUENCY_ATOMS, TIME_ATOMS, TIME_SPELLINGS } from "./time-atoms.ts";

export { BASES, KINDS, KIND_NAMES } from "./dimensions.ts";
export type { Atom, Base, Kind, Vector } from "./dimensions.ts";
export { DIMENSIONLESS_ATOMS, FREQUENCY_ATOMS, TIME_ATOMS } from "./time-atoms.ts";

const L: Vector = { length: 1 };
const M: Vector = { mass: 1 };
const D: Vector = { data: 1 };
const V: Vector = { length: 3 };
const E: Vector = KINDS.energy;
const P: Vector = KINDS.power;
const I: Vector = KINDS.current;
const U: Vector = KINDS.voltage;
const Q: Vector = KINDS.charge;
const NONE: Vector = {};
/** A pascal is kg/(m·s²), and a tesla is kg/(A·s²). */
const PRESSURE: Vector = { mass: 1, length: -1, time: -2 };
const TESLA: Vector = { mass: 1, time: -2, current: -1 };
/** A gray is a joule per kilogram: m²/s². */
const DOSE: Vector = { length: 2, time: -2 };

/** The US gallon is 231 cubic inches exactly, and the measures of a kitchen divide it. */
const GALLON = mul(r("231"), pow(r("0.0254"), 3));
const kitchen = (parts: number): Rational => div(GALLON, rational(BigInt(parts)));

export const ATOMS: readonly Atom[] = [
  ...TIME_ATOMS,
  // length
  atom("mm", "millimetre", L, r("0.001"), { aliases: ["millimeter", "millimeters"] }),
  atom("cm", "centimetre", L, r("0.01"), { aliases: ["centimeter", "centimeters"] }),
  atom("m", "metre", L, ONE, { aliases: ["meter", "meters", "metre", "metres"] }),
  atom("km", "kilometre", L, r("1000"), { aliases: ["kilometer", "kilometers"] }),
  atom("in", "inch", L, r("0.0254"), { aliases: ["inch", "inches"] }),
  atom("ft", "foot", L, r("0.3048"), { aliases: ["foot", "feet"] }),
  atom("yd", "yard", L, r("0.9144"), { aliases: ["yard", "yards"] }),
  atom("mi", "mile", L, r("1609.344"), { aliases: ["mile", "miles"] }),
  // mass (avoirdupois for oz and lb)
  atom("ug", "microgram", M, r("1e-6"), {
    display: "µg",
    aliases: ["µg", "μg", "mcg", "microgram", "micrograms"],
  }),
  atom("mg", "milligram", M, r("0.001"), { aliases: ["milligram", "milligrams"] }),
  atom("g", "gram", M, ONE, { aliases: ["gram", "grams"] }),
  atom("kg", "kilogram", M, r("1000"), { aliases: ["kgs", "kilogram", "kilograms"] }),
  atom("oz", "ounce", M, r("28.349523125"), { aliases: ["ounce", "ounces"] }),
  atom("lb", "pound", M, r("453.59237"), { aliases: ["lbs", "pound", "pounds"] }),
  // volume (US customary for the kitchen measures)
  atom("mL", "millilitre", V, r("1e-6"), { aliases: ["ml", "milliliter", "milliliters"] }),
  atom("L", "litre", V, r("0.001"), { aliases: ["l", "liter", "liters", "litre", "litres"] }),
  atom("tsp", "teaspoon", V, kitchen(768), { aliases: ["teaspoon", "teaspoons"] }),
  atom("tbsp", "tablespoon", V, kitchen(256), {
    aliases: ["Tbsp", "Tbs", "tbs", "tablespoon", "tablespoons"],
  }),
  atom("fl oz", "fluid ounce", V, kitchen(128), {
    aliases: ["floz", "fl. oz", "fl. oz.", "fluid ounce", "fluid ounces"],
  }),
  atom("cup", "cup", V, kitchen(16), { aliases: ["cups"] }),
  atom("pt", "pint", V, kitchen(8), { aliases: ["pint", "pints"] }),
  atom("qt", "quart", V, kitchen(4), { aliases: ["quart", "quarts"] }),
  atom("gal", "gallon", V, GALLON, { aliases: ["gallon", "gallons"] }),
  // temperature: kelvin is the base, and the Celsius and Fahrenheit scales are affine
  atom("K", "kelvin", { temperature: 1 }, ONE, { aliases: ["kelvin"] }),
  atom("degC", "degree Celsius", { temperature: 1 }, ONE, {
    offset: r("273.15"),
    display: "°C",
    aliases: ["°C", "celsius", "Cel"],
  }),
  atom("degF", "degree Fahrenheit", { temperature: 1 }, div(r("5"), r("9")), {
    offset: r("459.67"),
    display: "°F",
    aliases: ["°F", "fahrenheit"],
  }),
  // data: decimal prefixes for decimal multiples (KB is 1000 bytes), binary ones for KiB
  atom("bit", "bit", D, ONE, { aliases: ["bits"] }),
  atom("kbit", "kilobit", D, r("1e3"), { aliases: ["kb", "Kbit"] }),
  atom("Mbit", "megabit", D, r("1e6"), { aliases: ["Mb"] }),
  atom("Gbit", "gigabit", D, r("1e9"), { aliases: ["Gb"] }),
  atom("Tbit", "terabit", D, r("1e12"), { aliases: ["Tb"] }),
  atom("B", "byte", D, r("8"), { aliases: ["byte", "bytes"] }),
  atom("kB", "kilobyte", D, r("8e3"), { aliases: ["KB"] }),
  atom("MB", "megabyte", D, r("8e6")),
  atom("GB", "gigabyte", D, r("8e9")),
  atom("TB", "terabyte", D, r("8e12")),
  atom("KiB", "kibibyte", D, r(String(8 * 1024))),
  atom("MiB", "mebibyte", D, r(String(8 * 1024 ** 2))),
  atom("GiB", "gibibyte", D, r(String(8 * 1024 ** 3))),
  atom("TiB", "tebibyte", D, r(String(8 * 1024 ** 4))),
  ...FREQUENCY_ATOMS,
  // bus transfers: a count, kept apart from bits and from clocks
  atom("transfer", "transfer", NONE, ONE, { counts: "transfer", aliases: ["transfers"] }),
  atom("MT", "megatransfer", NONE, r("1e6"), { counts: "transfer" }),
  atom("GT", "gigatransfer", NONE, r("1e9"), { counts: "transfer" }),
  // energy and power
  atom("J", "joule", E, JOULE, { aliases: ["joule", "joules"] }),
  atom("kJ", "kilojoule", E, mul(JOULE, r("1000"))),
  atom("MJ", "megajoule", E, mul(JOULE, r("1e6"))),
  atom("cal", "calorie", E, mul(JOULE, r("4.184"))),
  atom("kcal", "kilocalorie", E, mul(JOULE, r("4184")), {
    aliases: ["Cal", "kilocalorie", "kilocalories"],
  }),
  // the international (IT) British thermal unit is 1055.05585262 J exactly (ISO 31-4, NIST SP 811)
  atom("BTU", "British thermal unit", E, mul(JOULE, r("1055.05585262")), { aliases: ["Btu"] }),
  atom("Wh", "watt-hour", E, mul(JOULE, r("3600"))),
  atom("kWh", "kilowatt-hour", E, mul(JOULE, r("3600000"))),
  atom("MWh", "megawatt-hour", E, mul(JOULE, r("3.6e9"))),
  atom("GWh", "gigawatt-hour", E, mul(JOULE, r("3.6e12"))),
  atom("nW", "nanowatt", P, mul(JOULE, r("1e-9"))),
  atom("W", "watt", P, JOULE, { aliases: ["watt", "watts"] }),
  atom("kW", "kilowatt", P, mul(JOULE, r("1000"))),
  atom("MW", "megawatt", P, mul(JOULE, r("1e6"))),
  atom("GW", "gigawatt", P, mul(JOULE, r("1e9"))),
  // pressure: a pascal is a newton per square metre
  atom("Pa", "pascal", PRESSURE, JOULE, { aliases: ["pascal", "pascals"] }),
  atom("hPa", "hectopascal", PRESSURE, mul(JOULE, r("100"))),
  // the magnetic field: a tesla is a volt-second per square metre, and the field of the Earth is some 50,000 nT
  atom("nT", "nanotesla", TESLA, mul(JOULE, r("1e-9"))),
  // radiation: a gray is an absorbed dose (J/kg). A sievert is a dose weighted by the kind of the radiation and
  // the tissue, thus it stays apart from a gray. A becquerel counts decays, thus it is not a hertz.
  atom("Gy", "gray", DOSE, ONE, { aliases: ["gray"] }),
  atom("Sv", "sievert", DOSE, ONE, { apart: "weighted dose", aliases: ["sievert", "sieverts"] }),
  atom("mSv", "millisievert", DOSE, r("1e-3"), { apart: "weighted dose" }),
  atom("uSv", "microsievert", DOSE, r("1e-6"), { apart: "weighted dose", display: "µSv", aliases: ["µSv", "μSv"] }),
  atom("nSv", "nanosievert", DOSE, r("1e-9"), { apart: "weighted dose" }),
  atom("Bq", "becquerel", { time: -1 }, ONE, { counts: "decay", aliases: ["becquerel", "becquerels"] }),
  // a solid angle: the ratio of an area to the square of a radius. A radiance per steradian is not an irradiance.
  atom("sr", "steradian", NONE, ONE, { percent: true, apart: "steradian", aliases: ["steradian", "steradians"] }),
  // electricity: the ampere is the base of the current, and a volt is a watt per ampere. A
  // volt-ampere has the vector of a watt, but it is not a real power, thus the package does not have it.
  atom("A", "ampere", I, ONE, { aliases: ["amp", "amps", "ampere", "amperes"] }),
  atom("mA", "milliampere", I, r("0.001"), { aliases: ["milliampere", "milliamperes"] }),
  atom("V", "volt", U, JOULE, { aliases: ["volt", "volts"] }),
  atom("mV", "millivolt", U, mul(JOULE, r("0.001"))),
  atom("kV", "kilovolt", U, mul(JOULE, r("1000"))),
  atom("Ah", "ampere-hour", Q, r("3600"), { aliases: ["ampere-hour", "ampere-hours"] }),
  atom("mAh", "milliampere-hour", Q, r("3.6")),
  atom("ohm", "ohm", KINDS.resistance, JOULE, { display: "Ω", aliases: ["Ω", "ohms"] }),
  // money: each currency stays apart, because currencies have no fixed rate. Each keeps the cent, and the yen
  // keeps no decimals. A currency without a symbol of its own prints its code: 12.50 CHF.
  atom("USD", "US dollar", { money: 1 }, ONE, {
    display: "$",
    decimals: 2,
    apart: "US dollar",
    aliases: ["$", "usd", "dollar", "dollars"],
  }),
  atom("EUR", "euro", { money: 1 }, ONE, {
    display: "€",
    decimals: 2,
    apart: "euro",
    aliases: ["€", "eur", "euro", "euros"],
  }),
  atom("GBP", "pound sterling", { money: 1 }, ONE, { display: "£", decimals: 2, apart: "pound sterling", aliases: ["£", "gbp"] }),
  atom("CHF", "Swiss franc", { money: 1 }, ONE, { decimals: 2, apart: "Swiss franc", aliases: ["chf"] }),
  atom("SEK", "Swedish krona", { money: 1 }, ONE, { decimals: 2, apart: "Swedish krona", aliases: ["sek"] }),
  atom("JPY", "yen", { money: 1 }, ONE, { display: "¥", decimals: 0, apart: "yen", aliases: ["¥", "jpy", "yen"] }),
  ...DIMENSIONLESS_ATOMS,
];

/**
 * These are whole spellings that other systems write, and the spellings that replace them before
 * the parse. One export writes "kcal/hr·kg" for per hour per kilogram. Read plainly, that is kcal
 * per hour, times a kilogram.
 */
export const SPELLINGS: Readonly<Record<string, string>> = {
  "kcal/hr·kg": "kcal/(h·kg)",
  ...TIME_SPELLINGS,
  mph: "mi/h",
  kph: "km/h",
  "km/hr": "km/h",
  Mbps: "Mbit/s",
  Gbps: "Gbit/s",
  kbps: "kbit/s",
};

/** This is the unit system of all atoms. The functions of the root entry use it. */
export const UNITS: UnitSystem = unitSystem(ATOMS, SPELLINGS);

export const atomBySymbol: ReadonlyMap<string, Atom> = UNITS.atomBySymbol;

/** This function gives the atom that a spelling names: its symbol or one of its aliases. */
export const lookupAtom: (spelling: string) => Atom | undefined = UNITS.lookupAtom;
