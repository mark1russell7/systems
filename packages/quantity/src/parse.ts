import type { Rational } from "@mark1russell7/rational";
import type { Base, Kind } from "./dimensions.ts";
import type { MeasuredOn, Unit } from "./system.ts";
import { sameVector } from "./system.ts";
import { UNITS } from "./units.ts";

export type { Component, Unit } from "./system.ts";
export { UnitError, sameVector } from "./system.ts";

/**
 * This function resolves a unit from its spelling. The spelling has symbols or their aliases,
 * factors joined by `·` or `*`, and one `/` at most. All that follows the slash divides: "kcal/h·kg"
 * is per hour per kilogram. A factor can have a power (`m^2`) and say what it counts (`{rep}`).
 */
export const parseUnit: (spelling: string) => Unit = UNITS.parseUnit;

/** This function gives the unit of a spelling, or undefined when the spelling names no unit. */
export const tryParseUnit: (spelling: string) => Unit | undefined = UNITS.tryParseUnit;

/** This function tells if stored data can have this spelling. Only the canonical spelling is correct. */
export const isCanonicalUnit: (spelling: string) => boolean = UNITS.isCanonicalUnit;

/** This function gives the canonical spelling of a unit, for data from another system: "hr" is "h". */
export const canonicalUnit: (spelling: string) => string = UNITS.canonicalUnit;

/**
 * This function gives the kind of a unit from its dimensions only. It ignores what a factor counts:
 * "g/{each}" is mass and "{set}/wk" is frequency. Two units of one kind can still not convert,
 * because their counts differ: ask convertible.
 */
export const kindOf: (spelling: string) => Kind | "derived" = UNITS.kindOf;

/**
 * This function gives the reason that `from` cannot become `to`, or undefined when it can. A spelling that names no unit
 * gives a reason, not an error: `whyNotConvertible("can", "kg")` is "can names no unit".
 */
export const whyNotConvertible: (from: string, to: string) => string | undefined =
  UNITS.whyNotConvertible;

/** This function tells if `from` can become `to`. A spelling that names no unit gives false, not an error. */
export const convertible: (from: string, to: string) => boolean = UNITS.convertible;

/**
 * This function gives the number that one `from` is in `to`, as a double: `factorOf("MiB", "B")` is 1048576. It keeps
 * the factor of each pair, thus a loop over many amounts converts each pair one time. Use `convertExact` for an exact sum.
 */
export const factorOf: (from: string, to: string) => number = UNITS.factorOf;

/** This function converts a value in one unit, exactly, into another unit. */
export const convertExact: (
  value: Rational,
  from: string,
  to: string,
  on?: MeasuredOn,
) => Rational = UNITS.convertExact;

/**
 * This function gives the canonical spelling of the product of two units. The exponents of one
 * factor add, and a factor with the exponent 0 cancels: `{request}/s` times `{core}·ms/{request}`
 * is `{core}·ms/s`. A factor does not cancel a different atom: `ms/s` stays.
 */
export const multiplyUnits: (a: string, b: string) => string = UNITS.multiplyUnits;

/** This function gives the canonical spelling of the quotient of two units: `a` divided by `b`, as `multiplyUnits` does. */
export const divideUnits: (a: string, b: string) => string = UNITS.divideUnits;

/**
 * This function gives the symbol of the one atom above the slash of a unit, when that atom has the dimension `base`
 * alone. For example, it gives `USD` for `USD/wk` and for `USD/{each}` with the base `money`. It gives undefined when
 * the unit has a different factor above, a power other than 1, or a count in braces on the atom. It also gives
 * undefined for a spelling that does not parse.
 *
 * @param unit - A unit of any unit system, or a spelling of the default system
 * @param base - The base dimension of the atom, for example `money`
 */
export function atomAbove(unit: Unit | string, base: Base): string | undefined {
  const parsed = typeof unit === "string" ? UNITS.tryParseUnit(unit) : unit;
  if (parsed === undefined) return undefined;
  const above = parsed.components.filter((component) => component.exponent > 0);
  const [only] = above;
  if (above.length !== 1 || only === undefined || only.exponent !== 1 || only.annotation !== undefined || only.atom === undefined) return undefined;
  return sameVector(only.atom.vector, { [base]: 1 }) ? only.atom.symbol : undefined;
}
