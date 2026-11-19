// @mark1russell7/quantity/time: the units of time, of frequency and the units with no dimension.
//
// This entry converts times, rates and counts exactly, as the root entry does, but its table has
// only these units. A bundle that converts only times and counts uses this entry, because the full
// table of the root entry adds 3.8 kB of minified code. A spelling of a unit outside the
// table (m, kB, USD) gives a UnitError here.

import type { Rational } from "@mark1russell7/rational";
import type { Kind } from "./dimensions.ts";
import type { MeasuredOn, Unit, UnitSystem } from "./system.ts";
import { unitSystem } from "./system.ts";
import { DIMENSIONLESS_ATOMS, FREQUENCY_ATOMS, TIME_ATOMS, TIME_SPELLINGS } from "./time-atoms.ts";

export type { Rational } from "@mark1russell7/rational";
// the exact arithmetic itself, for an engine that computes with amounts
export * as rationals from "@mark1russell7/rational";
export type { Atom, Base, Kind, Vector } from "./dimensions.ts";
export type { Component, MeasuredOn, Unit, UnitSystem } from "./system.ts";
export { UnitError, sameVector, unitSystem } from "./system.ts";
export type { Quantity } from "./quantity.ts";
export { DIMENSIONLESS_ATOMS, FREQUENCY_ATOMS, TIME_ATOMS, TIME_SPELLINGS } from "./time-atoms.ts";

/** This is the unit system of the times, the frequencies and the units with no dimension. */
export const TIME_UNITS: UnitSystem = unitSystem(
  [...TIME_ATOMS, ...FREQUENCY_ATOMS, ...DIMENSIONLESS_ATOMS],
  TIME_SPELLINGS,
);

/** This function resolves a unit of the table of this entry from its spelling. */
export const parseUnit: (spelling: string) => Unit = TIME_UNITS.parseUnit;

/** This function gives the unit of a spelling, or undefined when the spelling names no unit of this table. */
export const tryParseUnit: (spelling: string) => Unit | undefined = TIME_UNITS.tryParseUnit;

/** This function tells if stored data can have this spelling. Only the canonical spelling is correct. */
export const isCanonicalUnit: (spelling: string) => boolean = TIME_UNITS.isCanonicalUnit;

/** This function gives the canonical spelling of a unit: "hr" is "h". */
export const canonicalUnit: (spelling: string) => string = TIME_UNITS.canonicalUnit;

export const kindOf: (spelling: string) => Kind | "derived" = TIME_UNITS.kindOf;

/** This function gives the reason that `from` cannot become `to`, or undefined when it can. */
export const whyNotConvertible: (from: string, to: string) => string | undefined =
  TIME_UNITS.whyNotConvertible;

export const convertible: (from: string, to: string) => boolean = TIME_UNITS.convertible;

/** This function converts a value in one unit, exactly, into another unit. */
export const convertExact: (
  value: Rational,
  from: string,
  to: string,
  on?: MeasuredOn,
) => Rational = TIME_UNITS.convertExact;

/** This function gives the canonical spelling of the product of two units of this table, as `multiplyUnits` of the root entry does. */
export const multiplyUnits: (a: string, b: string) => string = TIME_UNITS.multiplyUnits;

/** This function gives the canonical spelling of the quotient of two units of this table: `a` divided by `b`. */
export const divideUnits: (a: string, b: string) => string = TIME_UNITS.divideUnits;
