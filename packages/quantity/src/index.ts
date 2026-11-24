// @mark1russell7/quantity: amounts in typed units, and exact arithmetic on them.
//
// A unit resolves from its spelling into an exponent vector over seven bases (time, length, mass,
// temperature, data, money, current), an exact rational factor, and what it counts. A kind names a
// dimension that a schema can ask for. Conversions are exact for decimal inputs, so money adds to
// the cent and 7875 s is exactly 131.25 min.
//
// This entry does not import zod. The schemas are in the entry "@mark1russell7/quantity/schema":
// a bundle that uses only the amounts does not get zod (approximately 95 kB of gzip).

export type { Rational } from "@mark1russell7/rational";
// the exact arithmetic itself, for an engine that computes with amounts
export * as rationals from "@mark1russell7/rational";
export type { Atom, Base, Kind, Vector } from "./units.ts";
export {
  ATOMS,
  BASES,
  DIMENSIONLESS_ATOMS,
  FREQUENCY_ATOMS,
  KINDS,
  KIND_NAMES,
  SPELLINGS,
  TIME_ATOMS,
  UNITS,
  atomBySymbol,
  lookupAtom,
} from "./units.ts";
export type { UnitSystem } from "./system.ts";
export { unitSystem } from "./system.ts";
export type { Component, Unit } from "./parse.ts";
export {
  UnitError,
  atomAbove,
  canonicalUnit,
  convertExact,
  convertible,
  divideUnits,
  factorOf,
  isCanonicalUnit,
  kindOf,
  multiplyUnits,
  parseUnit,
  sameVector,
  tryParseUnit,
  whyNotConvertible,
} from "./parse.ts";
export type { Extent, MeasuredOn, Quantity, Statistic, Unbounded, Unknown } from "./quantity.ts";
export {
  STATISTICS,
  add,
  compare,
  convert,
  divide,
  isQuantity,
  isUnbounded,
  kindOfQuantity,
  max,
  mean,
  min,
  multiply,
  quantity,
  round,
  scale,
  sub,
  sum,
  toNanoseconds,
  unbounded,
  valueIn,
} from "./quantity.ts";
export type { FormatOptions, Scale, ScaleCompound, ScaleStep } from "./format.ts";
export { BYTES_1000, BYTES_1024, DURATION_MS, format, formatDuration, formatOnScale, formatUnit } from "./format.ts";
