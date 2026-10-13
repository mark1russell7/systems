import type { Unit } from "./parse.ts";
import { UnitError, isCanonicalUnit, parseUnit, sameVector } from "./parse.ts";
import type { Rational } from "./rational.ts";
import * as q from "./rational.ts";
import type { Kind } from "./units.ts";

/** A quantity is an amount in a unit: `{ "value": 7200, "unit": "s" }`. Its unit is always canonical. */
export interface Quantity {
  readonly value: number;
  readonly unit: string;
}

/** An unbounded extent has no limit at all. A timer that nothing sets is the most frequent example. */
export interface Unbounded {
  readonly value: "infinite";
  readonly unit: string;
}

export type Extent = Quantity | Unbounded;

/** An unknown is a value that nobody can give, and the reason. Most internals of a cloud are not published. */
export interface Unknown {
  readonly unknown: string;
  readonly unit?: string | undefined;
}

/** A statistic tells which part of its distribution a value is. The p99 of a path is not the sum of the p99 of its steps. */
export const STATISTICS = [
  "exact",
  "at-least",
  "at-most",
  "mean",
  "p50",
  "p90",
  "p99",
  "p999",
  "min",
  "max",
] as const;
export type Statistic = (typeof STATISTICS)[number];

/** These are the facts about the measured system that a conversion uses. */
export interface MeasuredOn {
  /** The timer frequency of the kernel converts jiffies: at 250, one jiffy is 4 ms. */
  readonly hz?: number | undefined;
}

export const isUnbounded = (extent: Extent): extent is Unbounded => extent.value === "infinite";

/** This function tells if a value from data is a quantity: a finite number and a canonical unit. */
export const isQuantity = (value: unknown): value is Quantity => {
  if (typeof value !== "object" || value === null) return false;
  const { value: amount, unit } = value as { value?: unknown; unit?: unknown };
  return (
    typeof amount === "number" &&
    Number.isFinite(amount) &&
    typeof unit === "string" &&
    isCanonicalUnit(unit)
  );
};

/** This function makes a quantity, and checks that it has a finite value and a canonical unit. */
export const quantity = (value: number, unit: string): Quantity => {
  if (!Number.isFinite(value))
    throw new RangeError(`not a finite amount: ${String(value)} ${unit}`);
  if (!isCanonicalUnit(unit)) {
    throw new UnitError(`${unit} is not a canonical unit; write ${parseUnit(unit).symbol}`);
  }
  return { value, unit };
};

export const unbounded = (unit: string): Unbounded => ({
  value: "infinite",
  unit: parseUnit(unit).symbol,
});

const factorOn = (unit: Unit, on: MeasuredOn | undefined): Rational => {
  if (unit.param !== "hz") return unit.factor;
  const hz = on?.hz;
  if (hz === undefined || !Number.isInteger(hz) || hz <= 0) {
    throw new UnitError(`${unit.symbol} depends on the kernel's HZ: say which, as { hz: 250 }`);
  }
  const jiffies = unit.components
    .filter((component) => component.atom?.param === "hz")
    .reduce((sum, component) => sum + component.exponent, 0);
  return q.mul(unit.factor, q.pow(q.rational(1n, BigInt(hz)), jiffies));
};

const counted = (unit: Unit): string => {
  const names = Object.entries(unit.counts).map(([name, power]) =>
    power === 1 ? name : `${name}^${power}`,
  );
  return names.length === 0 ? "nothing in particular" : names.join(" and ");
};

/** This function gives the reason that `from` cannot become `to`, or undefined when it can. */
export const whyNotConvertible = (from: string, to: string): string | undefined => {
  const a = parseUnit(from);
  const b = parseUnit(to);
  if (!sameVector(a.vector, b.vector)) {
    return `${a.symbol} is a ${a.kind} and ${b.symbol} is a ${b.kind}`;
  }
  const aCounts = JSON.stringify(Object.entries(a.counts).sort());
  const bCounts = JSON.stringify(Object.entries(b.counts).sort());
  if (aCounts !== bCounts) return `${a.symbol} counts ${counted(a)} and ${b.symbol} ${counted(b)}`;
  if ((a.log || b.log) && a.symbol !== b.symbol) {
    return `${a.symbol} and ${b.symbol} are levels, and a level converts only to itself`;
  }
  return undefined;
};

export const convertible = (from: string, to: string): boolean =>
  whyNotConvertible(from, to) === undefined;

/** This function converts a value in one unit, exactly, into another unit. */
export const convertExact = (
  value: Rational,
  from: string,
  to: string,
  on?: MeasuredOn,
): Rational => {
  const why = whyNotConvertible(from, to);
  if (why !== undefined) throw new UnitError(`cannot convert ${from} to ${to}: ${why}`);
  const a = parseUnit(from);
  const b = parseUnit(to);
  const base = q.mul(q.add(value, a.offset ?? q.ZERO), factorOn(a, on));
  return q.sub(q.div(base, factorOn(b, on)), b.offset ?? q.ZERO);
};

export const convert = (amount: Quantity, to: string, on?: MeasuredOn): Quantity => {
  const unit = parseUnit(to).symbol;
  if (amount.unit === unit) return amount;
  return {
    value: q.toNumber(convertExact(q.fromNumber(amount.value), amount.unit, unit, on)),
    unit,
  };
};

/** This function gives the number that a quantity is in a unit. */
export const valueIn = (amount: Quantity, unit: string, on?: MeasuredOn): number =>
  convert(amount, unit, on).value;

const exact = (amount: Quantity, unit: string): Rational =>
  convertExact(q.fromNumber(amount.value), amount.unit, unit);

const refuseLevel = (unit: string, what: string): void => {
  if (parseUnit(unit).log) {
    throw new UnitError(`${what} of levels in ${unit} is not a level: use meanLevel`);
  }
};

/** This function gives a + b in the unit of a. It is exact for decimal inputs, thus money adds to the cent. */
export const add = (a: Quantity, b: Quantity): Quantity => {
  refuseLevel(a.unit, "a sum");
  return { value: q.toNumber(q.add(exact(a, a.unit), exact(b, a.unit))), unit: a.unit };
};

export const sub = (a: Quantity, b: Quantity): Quantity => {
  refuseLevel(a.unit, "a difference");
  return { value: q.toNumber(q.sub(exact(a, a.unit), exact(b, a.unit))), unit: a.unit };
};

/** This function gives the sum in `unit`, or in the unit of the first amount. An empty sum needs `unit`. */
export const sum = (amounts: readonly Quantity[], unit?: string): Quantity => {
  const target = unit === undefined ? amounts[0]?.unit : parseUnit(unit).symbol;
  if (target === undefined) throw new UnitError("an empty sum needs a unit");
  refuseLevel(target, "a sum");
  const total = amounts.reduce((acc, amount) => q.add(acc, exact(amount, target)), q.ZERO);
  return { value: q.toNumber(total), unit: target };
};

/** This function gives the arithmetic mean. For a logarithmic level, it gives the energy mean: 10·log10 of the mean power. */
export const mean = (amounts: readonly Quantity[], unit?: string): Quantity => {
  const target = unit === undefined ? amounts[0]?.unit : parseUnit(unit).symbol;
  if (target === undefined || amounts.length === 0) throw new UnitError("a mean of nothing");
  if (parseUnit(target).log) {
    for (const amount of amounts) {
      const why = whyNotConvertible(amount.unit, target);
      if (why !== undefined)
        throw new UnitError(`cannot average ${amount.unit} with ${target}: ${why}`);
    }
    const power =
      amounts.reduce((acc, amount) => acc + 10 ** (amount.value / 10), 0) / amounts.length;
    return { value: 10 * Math.log10(power), unit: target };
  }
  const total = amounts.reduce((acc, amount) => q.add(acc, exact(amount, target)), q.ZERO);
  return { value: q.toNumber(q.div(total, q.rational(BigInt(amounts.length)))), unit: target };
};

/** This function gives -1, 0 or 1. Infinity is larger than all amounts, and equal to itself. */
export const compare = (a: Extent, b: Extent): number => {
  const why = whyNotConvertible(a.unit, b.unit);
  if (why !== undefined) throw new UnitError(`cannot compare ${a.unit} with ${b.unit}: ${why}`);
  if (isUnbounded(a) || isUnbounded(b)) return isUnbounded(a) ? (isUnbounded(b) ? 0 : 1) : -1;
  return q.cmp(exact(a, a.unit), exact(b, a.unit));
};

export const min = <T extends Extent>(a: T, b: T): T => (compare(a, b) <= 0 ? a : b);
export const max = <T extends Extent>(a: T, b: T): T => (compare(a, b) >= 0 ? a : b);

/** This function multiplies an amount by a plain number: a count of probes, or a share. */
export const scale = (amount: Quantity, by: number): Quantity => ({
  value: q.toNumber(q.mul(q.fromNumber(amount.value), q.fromNumber(by))),
  unit: amount.unit,
});

/** This function rounds an amount to the decimals that its unit keeps (money to the cent), or to `decimals`. */
export const round = (amount: Quantity, decimals?: number): Quantity => {
  const places = decimals ?? parseUnit(amount.unit).components[0]?.atom?.decimals ?? undefined;
  if (places === undefined) return amount;
  const factor = 10 ** places;
  return { value: Math.round(amount.value * factor) / factor, unit: amount.unit };
};

/**
 * This function gives a time as a whole number of nanoseconds, or refuses it. A double holds each
 * whole nanosecond for approximately 104 days.
 */
export const toNanoseconds = (amount: Quantity, on?: MeasuredOn): number => {
  const ns = convertExact(q.fromNumber(amount.value), amount.unit, "ns", on);
  if (!q.isInteger(ns))
    throw new UnitError(`${amount.value} ${amount.unit} is not a whole number of ns`);
  const value = Number(ns.n);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `${amount.value} ${amount.unit} is past what a double holds exactly in ns`,
    );
  }
  return value;
};

/** This function gives the kind that a quantity measures. */
export const kindOfQuantity = (amount: Quantity | Unbounded): Kind | "derived" =>
  parseUnit(amount.unit).kind;
