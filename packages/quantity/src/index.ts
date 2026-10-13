// @mark1russell7/quantity: amounts in typed units, and exact arithmetic on them.
//
// A unit resolves from its spelling into an exponent vector over six bases (time, length, mass,
// temperature, data, money), an exact rational factor, and what it counts. A kind names a
// dimension that a schema can ask for. Conversions are exact for decimal inputs, so money adds to
// the cent and 7875 s is exactly 131.25 min.

export type { Rational } from "./rational.ts";
// the exact arithmetic itself, for an engine that computes with amounts
export * as rationals from "./rational.ts";
export type { Atom, Base, Kind, Vector } from "./units.ts";
export { ATOMS, BASES, KINDS, KIND_NAMES, SPELLINGS, atomBySymbol, lookupAtom } from "./units.ts";
export type { Component, Unit } from "./parse.ts";
export {
  UnitError,
  canonicalUnit,
  isCanonicalUnit,
  kindOf,
  parseUnit,
  sameVector,
  tryParseUnit,
} from "./parse.ts";
export type { Extent, MeasuredOn, Quantity, Statistic, Unbounded, Unknown } from "./quantity.ts";
export {
  STATISTICS,
  add,
  compare,
  convert,
  convertExact,
  convertible,
  isQuantity,
  isUnbounded,
  kindOfQuantity,
  max,
  mean,
  min,
  quantity,
  round,
  scale,
  sub,
  sum,
  toNanoseconds,
  unbounded,
  valueIn,
  whyNotConvertible,
} from "./quantity.ts";
export type { FormatOptions } from "./format.ts";
export { format, formatDuration, formatUnit } from "./format.ts";
export type { KindOrDerived, QuantityOptions } from "./schema.ts";
export {
  extentSchema,
  isQuantitySchema,
  quantitySchema,
  statisticSchema,
  unitSchema,
  unknownSchema,
} from "./schema.ts";
