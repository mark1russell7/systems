import type { Rational } from "@mark1russell7/rational";
import { fromDecimal } from "@mark1russell7/rational";

/**
 * These are the base dimensions. A dimension is an exponent vector over them, as in SI, with two
 * more: data (the bit) and money. Each currency is money with a name of its own (`Atom.apart`),
 * because currencies have no fixed rate. Thus a price in EUR is money, and it does not convert to
 * USD. Counts and ratios have no dimension, thus a duration times a
 * count is still a duration. The electric current (the ampere) is the last base, thus a volt is
 * a watt per ampere.
 */
export const BASES = ["time", "length", "mass", "temperature", "data", "money", "current"] as const;
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
  | "current"
  | "voltage"
  | "charge"
  | "resistance"
  | "specific-power"
  | "specific-volume-rate"
  | "money-rate"
  | "energy-price";

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
  /** The electric current is the rating of a breaker or of a cable, as A. */
  current: { current: 1 },
  /** The voltage of a circuit, as V. A volt times an ampere is a watt. */
  voltage: { mass: 1, length: 2, time: -3, current: -1 },
  /** The charge is the capacity of a battery, as Ah. */
  charge: { current: 1, time: 1 },
  /** The resistance is a volt per ampere, as ohm. */
  resistance: { mass: 1, length: 2, time: -3, current: -2 },
  /** The power per body mass is the cost of an exertion, as kcal/(h·kg). */
  "specific-power": { length: 2, time: -3 },
  /** The volume per body mass per time is a VO2 max, as mL/(kg·min). */
  "specific-volume-rate": { length: 3, mass: -1, time: -1 },
  /** The money per time is a monthly limit of a budget, or a subscription. */
  "money-rate": { money: 1, time: -1 },
  /** The money per energy is the price of electricity, as USD/kWh. */
  "energy-price": { money: 1, mass: -1, length: -2, time: 2 },
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
  /**
   * This name keeps the atom apart from the atoms of the same vector that do not have it. A sievert is a
   * weighted dose, thus it is not a gray. Each currency has its own name, because currencies have no fixed
   * rate. A steradian is apart from a plain ratio.
   */
  readonly apart?: string;
  /** A percentage makes a unit with no dimension a ratio. */
  readonly percent?: true;
  /** Its size changes with the system that it measures: a jiffy is 1/HZ seconds. */
  readonly param?: "hz";
  /** An amount keeps this many decimal places: money keeps the cent. */
  readonly decimals?: number;
  readonly aliases?: readonly string[];
}

/** This function gives the exact rational of a decimal text. */
export const decimal = (text: string): Rational => fromDecimal(text);

/** This function makes an atom. */
export const atom = (
  symbol: string,
  name: string,
  vector: Vector,
  factor: Rational,
  extra: Omit<Partial<Atom>, "symbol" | "name" | "vector" | "factor"> = {},
): Atom => ({ symbol, name, vector, factor, ...extra });

/** The base of mass is the gram, thus a joule (kg·m²/s²) is 1000 base units. */
export const JOULE: Rational = decimal("1000");
