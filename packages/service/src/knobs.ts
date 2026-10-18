import type { Extent } from "@mark1russell7/quantity";
import { convertible, valueIn } from "@mark1russell7/quantity";

/** A knob record is the knobs of a part, by name. A knob that is absent is undefined. */
export type KnobRecord = Readonly<Record<string, Extent | undefined>>;

/**
 * This function gives a time knob in milliseconds, or infinity for a time without a bound. The
 * runtime has no defaults, thus a knob that is absent throws. A knob that is not a time, or that is
 * less than zero, also throws.
 */
export const millisecondsOf = (knobs: KnobRecord, name: string, owner: string): number => {
  const amount = knobs[name];
  if (amount === undefined) throw new Error(`${owner} needs the knob ${name}: it has no defaults`);
  if (!convertible(amount.unit, "s")) throw new Error(`the knob ${name} is not a time`);
  if (amount.value === "infinite") return Number.POSITIVE_INFINITY;
  const value = valueIn(amount, "ms");
  if (!(value >= 0)) throw new Error(`the knob ${name} is less than zero`);
  return value;
};

/** This function gives a time knob in milliseconds, and it throws for a time without a bound. */
export const boundedMillisecondsOf = (knobs: KnobRecord, name: string, owner: string): number => {
  const value = millisecondsOf(knobs, name, owner);
  if (!Number.isFinite(value)) throw new Error(`the knob ${name} of ${owner} has no bound: it needs a time`);
  return value;
};

/**
 * This function gives a count knob (the unit `count`) as a whole number above zero, or infinity
 * for a count without a bound. A knob that is absent, not a count, or not a whole number above zero throws.
 */
export const countOf = (knobs: KnobRecord, name: string, owner: string): number => {
  const amount = knobs[name];
  if (amount === undefined) throw new Error(`${owner} needs the knob ${name}: it has no defaults`);
  if (!convertible(amount.unit, "count")) throw new Error(`the knob ${name} is not a count`);
  if (amount.value === "infinite") return Number.POSITIVE_INFINITY;
  const value = valueIn(amount, "count");
  if (!(Number.isInteger(value) && value >= 1)) throw new Error(`the knob ${name} is ${value}, not a whole number above zero`);
  return value;
};
