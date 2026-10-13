import type { Rational } from "./rational.ts";
import { ONE, div, fromDecimal, mul, pow, rational } from "./rational.ts";

/**
 * These are the base dimensions. A dimension is an exponent vector over them, as in SI, with two
 * more: data (the bit) and money (one currency). A second currency is a second base, because
 * currencies have no fixed rate. Counts and ratios have no dimension, thus a duration times a
 * count is still a duration.
 */
export const BASES = ["time", "length", "mass", "temperature", "data", "money"] as const;
export type Base = (typeof BASES)[number];
export type Vector = Readonly<Partial<Record<Base, number>>>;

/**
 * A kind is a named dimension, which is what a schema asks for: "a time", "an amount of money".
 * A kind has one vector, and a vector can have more than one kind. A transfer rate is a frequency
 * of transfers, and it stays apart, thus 8 GT/s is not a clock. A unit with no dimension is a
 * count, a ratio or a level, by what it is made of.
 */
export type Kind =
  | "time"
  | "length"
  | "mass"
  | "temperature"
  | "data"
  | "money"
  | "count"
  | "ratio"
  | "level"
  | "frequency"
  | "transfer-rate"
  | "data-rate"
  | "speed"
  | "area"
  | "volume"
  | "energy"
  | "power"
  | "specific-power"
  | "specific-volume-rate"
  | "money-rate";

export const KINDS: Readonly<Record<Kind, Vector>> = {
  time: { time: 1 },
  length: { length: 1 },
  mass: { mass: 1 },
  temperature: { temperature: 1 },
  data: { data: 1 },
  money: { money: 1 },
  count: {},
  ratio: {},
  level: {},
  frequency: { time: -1 },
  "transfer-rate": { time: -1 },
  "data-rate": { data: 1, time: -1 },
  speed: { length: 1, time: -1 },
  area: { length: 2 },
  volume: { length: 3 },
  energy: { mass: 1, length: 2, time: -2 },
  power: { mass: 1, length: 2, time: -3 },
  /** The power per body mass is the cost of an exertion, as kcal/(h·kg). */
  "specific-power": { length: 2, time: -3 },
  /** The volume per body mass per time is a VO2 max, as mL/(kg·min). */
  "specific-volume-rate": { length: 3, mass: -1, time: -1 },
  /** The money per time is a monthly limit of a budget, or a subscription. */
  "money-rate": { money: 1, time: -1 },
};

export const KIND_NAMES: readonly Kind[] = Object.keys(KINDS) as Kind[];

/** An atom is one named unit. Its factor converts one of it to the base units of its vector, exactly. */
export interface Atom {
  readonly symbol: string;
  readonly name: string;
  /** This text is how it prints, where that is not its symbol: °F, µs. */
  readonly display?: string;
  readonly vector: Vector;
  readonly factor: Rational;
  /** An affine unit (a temperature) has an offset: base = (value + offset) × factor. */
  readonly offset?: Rational;
  /** A logarithmic level converts only to itself, and it averages by energy. */
  readonly log?: true;
  /** This name is what it counts, when it is a count of something: a GT is 10⁹ transfers, a bpm counts beats. */
  readonly counts?: string;
  /** A percentage makes a unit with no dimension a ratio. */
  readonly percent?: true;
  /** Its size changes with the system that it measures: a jiffy is 1/HZ seconds. */
  readonly param?: "hz";
  /** An amount keeps this many decimal places: money keeps the cent. */
  readonly decimals?: number;
  readonly aliases?: readonly string[];
}

const r = (text: string): Rational => fromDecimal(text);
const atom = (
  symbol: string,
  name: string,
  vector: Vector,
  factor: Rational,
  extra: Omit<Partial<Atom>, "symbol" | "name" | "vector" | "factor"> = {},
): Atom => ({ symbol, name, vector, factor, ...extra });

const T: Vector = { time: 1 };
const L: Vector = { length: 1 };
const M: Vector = { mass: 1 };
const D: Vector = { data: 1 };
const V: Vector = { length: 3 };
const E: Vector = KINDS.energy;
const P: Vector = KINDS.power;
const NONE: Vector = {};

/** The US gallon is 231 cubic inches exactly, and the measures of a kitchen divide it. */
const GALLON = mul(r("231"), pow(r("0.0254"), 3));
const kitchen = (parts: number): Rational => div(GALLON, rational(BigInt(parts)));

/** This is the mean Gregorian year. A month is exactly a twelfth of it, thus USD/mo × 12 is USD/yr. */
const YEAR = r("31556952");

/** The base of mass is the gram, thus a joule (kg·m²/s²) is 1000 base units. */
const JOULE = r("1000");

export const ATOMS: readonly Atom[] = [
  // time
  atom("ns", "nanosecond", T, r("1e-9"), { aliases: ["nsec", "nanoseconds"] }),
  atom("us", "microsecond", T, r("1e-6"), {
    display: "µs",
    aliases: ["µs", "μs", "usec", "microseconds"],
  }),
  atom("ms", "millisecond", T, r("0.001"), { aliases: ["msec", "milliseconds"] }),
  atom("s", "second", T, ONE, { aliases: ["sec", "secs", "second", "seconds"] }),
  atom("min", "minute", T, r("60"), { aliases: ["mins", "minute", "minutes"] }),
  atom("h", "hour", T, r("3600"), { aliases: ["hr", "hrs", "hour", "hours"] }),
  atom("d", "day", T, r("86400"), { aliases: ["day", "days"] }),
  atom("wk", "week", T, r("604800"), { aliases: ["week", "weeks"] }),
  atom("mo", "month", T, div(YEAR, r("12")), { aliases: ["month", "months"] }),
  atom("yr", "year", T, YEAR, { aliases: ["year", "years"] }),
  atom("jiffy", "jiffy", T, ONE, { param: "hz", aliases: ["jiffies"] }),
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
    aliases: ["°C", "celsius"],
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
  // frequency, and counts per time that say what they count
  atom("Hz", "hertz", { time: -1 }, ONE, { aliases: ["hertz"] }),
  atom("kHz", "kilohertz", { time: -1 }, r("1e3")),
  atom("MHz", "megahertz", { time: -1 }, r("1e6")),
  atom("GHz", "gigahertz", { time: -1 }, r("1e9")),
  atom("bpm", "beats per minute", { time: -1 }, div(ONE, r("60")), { counts: "beat" }),
  // bus transfers: a count, kept apart from bits and from clocks
  atom("transfer", "transfer", NONE, ONE, { counts: "transfer", aliases: ["transfers"] }),
  atom("MT", "megatransfer", NONE, r("1e6"), { counts: "transfer" }),
  atom("GT", "gigatransfer", NONE, r("1e9"), { counts: "transfer" }),
  // energy and power
  atom("J", "joule", E, JOULE, { aliases: ["joule", "joules"] }),
  atom("kJ", "kilojoule", E, mul(JOULE, r("1000"))),
  atom("cal", "calorie", E, mul(JOULE, r("4.184"))),
  atom("kcal", "kilocalorie", E, mul(JOULE, r("4184")), {
    aliases: ["Cal", "kilocalorie", "kilocalories"],
  }),
  atom("Wh", "watt-hour", E, mul(JOULE, r("3600"))),
  atom("kWh", "kilowatt-hour", E, mul(JOULE, r("3600000"))),
  atom("W", "watt", P, JOULE, { aliases: ["watt", "watts"] }),
  atom("kW", "kilowatt", P, mul(JOULE, r("1000"))),
  // money: one currency, kept to the cent
  atom("USD", "US dollar", { money: 1 }, ONE, {
    display: "$",
    decimals: 2,
    aliases: ["$", "usd", "dollar", "dollars"],
  }),
  // dimensionless
  atom("count", "count", NONE, ONE),
  atom("%", "percent", NONE, r("0.01"), { percent: true, aliases: ["percent", "pct"] }),
  atom("dBA", "A-weighted decibel", NONE, ONE, { log: true, aliases: ["dBASPL"] }),
];

/**
 * These are whole spellings that other systems write, and the spellings that replace them before
 * the parse. One export writes "kcal/hr·kg" for per hour per kilogram. Read plainly, that is kcal
 * per hour, times a kilogram.
 */
export const SPELLINGS: Readonly<Record<string, string>> = {
  "kcal/hr·kg": "kcal/(h·kg)",
  "beats/min": "bpm",
  "dB(A)": "dBA",
  mph: "mi/h",
  kph: "km/h",
  "km/hr": "km/h",
  Mbps: "Mbit/s",
  Gbps: "Gbit/s",
  kbps: "kbit/s",
};

const bySpelling = new Map<string, Atom>();
for (const a of ATOMS) {
  for (const spelling of [a.symbol, ...(a.aliases ?? [])]) {
    const taken = bySpelling.get(spelling);
    if (taken !== undefined && taken !== a) {
      throw new Error(`unit spelling ${spelling} names both ${taken.symbol} and ${a.symbol}`);
    }
    bySpelling.set(spelling, a);
  }
}

export const atomBySymbol: ReadonlyMap<string, Atom> = new Map(ATOMS.map((a) => [a.symbol, a]));

/** This function gives the atom that a spelling names: its symbol or one of its aliases. */
export const lookupAtom = (spelling: string): Atom | undefined => bySpelling.get(spelling);
