import type { Component } from "./parse.ts";
import { parseUnit } from "./parse.ts";
import type { Extent, Quantity, Unknown } from "./quantity.ts";
import { convert, convertExact, roundExact, whyNotConvertible } from "./quantity.ts";
import * as q from "@mark1russell7/rational";
import type { Rational } from "@mark1russell7/rational";
import { UnitError } from "./parse.ts";

export interface FormatOptions {
  /**
   * This number is the most decimal places to show (the default is 2). Money shows exactly this
   * many when it is given. Otherwise money shows its cents only when it has cents: $400, $42.49.
   */
  readonly digits?: number;
  /** This option shows a + on a positive amount, for changes. */
  readonly signed?: boolean;
}

/** The units of the calendar read as words: 6 days, a week, 3 months, 2 years. */
const SPOKEN: Readonly<Record<string, string>> = { d: "day", wk: "week", mo: "month", yr: "year" };

/** These words of a count read the same for many: five large (eggs), two each. */
const INVARIANT = new Set(["each", "whole", "large", "medium", "small", "extra large", "jumbo"]);

/** This function makes the name of a counted thing plural for an amount that is not one: 12 reps, 1 rep. */
const plural = (name: string, many: boolean): string =>
  !many || INVARIANT.has(name) || !/^[a-z][a-z ]*$/.test(name) || name.endsWith("s")
    ? name
    : `${name}s`;

const showComponent = (component: Component, many: boolean): string => {
  const power = Math.abs(component.exponent);
  const atom = component.atom;
  const name =
    atom === undefined
      ? plural(component.annotation ?? "", many)
      : `${atom.display ?? atom.symbol}${
          component.annotation === undefined
            ? ""
            : atom.percent === true
              ? ` of ${component.annotation}`
              : ` ${component.annotation}`
        }`;
  return power === 1 ? name : `${name}^${power}`;
};

/** People know these compounds by another name: a wind speed reads "mph", not "mi/h". */
const SAID: Readonly<Record<string, string>> = { "mi/h": "mph" };

/** This function gives how a unit reads next to an amount: "kcal/(h·kg)", "sets/wk", "% of 1RM", "mph". */
export const formatUnit = (unit: string, many = true): string => {
  const parsed = parseUnit(unit);
  const said = SAID[parsed.symbol];
  if (said !== undefined) return said;
  const top = parsed.components.filter((c) => c.exponent > 0);
  const bottom = parsed.components.filter((c) => c.exponent < 0);
  const numerator = top.map((c, i) => showComponent(c, many && i === 0)).join("·");
  if (bottom.length === 0) return numerator;
  const denominator = bottom.map((c) => showComponent(c, false)).join("·");
  return `${numerator}/${bottom.length > 1 ? `(${denominator})` : denominator}`;
};

const number = (value: number, digits: number, fixed: boolean): string =>
  value.toLocaleString("en-US", {
    minimumFractionDigits: fixed ? digits : 0,
    maximumFractionDigits: digits,
  });

/** This function prints an amount: "$1,234.56", "$500/mo", "7,875 s", "34.5%", "72°F", "12 reps", "∞ s". */
export const format = (amount: Extent | Unknown, options: FormatOptions = {}): string => {
  if ("unknown" in amount) return `unknown: ${amount.unknown}`;
  if (amount.value === "infinite") return `∞ ${formatUnit(amount.unit)}`;
  const parsed = parseUnit(amount.unit);
  const sign = amount.value < 0 ? "-" : options.signed === true && amount.value > 0 ? "+" : "";
  const magnitude = Math.abs(amount.value);
  const lead = parsed.components[0];
  // money leads with its symbol, whatever it is per: $500/mo, $42.49
  if (parsed.kind === "money" || parsed.kind === "money-rate") {
    const cents = lead?.atom?.decimals ?? 2;
    const whole = q.isInteger(roundExact(q.fromNumber(magnitude), cents));
    const digits = options.digits ?? (whole ? 0 : cents);
    const per = formatUnit(amount.unit).split("/")[1];
    return `${sign}${lead?.atom?.display ?? ""}${number(magnitude, digits, true)}${
      per === undefined ? "" : `/${per}`
    }`;
  }
  const shown = number(magnitude, options.digits ?? 2, false);
  // a bare count is just its number: 15 retries is "15", what it counts is the field's to say
  if (parsed.symbol === "count") return `${sign}${shown}`;
  const spoken = parsed.components.length === 1 ? SPOKEN[parsed.symbol] : undefined;
  if (spoken !== undefined) return `${sign}${shown} ${magnitude === 1 ? spoken : `${spoken}s`}`;
  // a percentage and a temperature scale sit against the number: 34.5%, 72°F
  const tight =
    parsed.components.length === 1 &&
    (lead?.atom?.percent === true || lead?.atom?.offset !== undefined);
  return `${sign}${shown}${tight ? "" : " "}${formatUnit(amount.unit, magnitude !== 1)}`;
};

/** One step of a scale: a unit of quantity, and the decimal places of an amount in it. */
export interface ScaleStep {
  /** The unit of the step. The text shows its symbol, so the text reads back as the same amount. */
  readonly unit: string;
  /** This number is the most decimal places (the default is 2). */
  readonly digits?: number;
  /**
   * This number is the significant digits. The decimal places then shrink as the number grows, but stay at most
   * `digits`: with 2, the text is "0.42", "3.5" and "120".
   */
  readonly significant?: number;
  /** This option always shows `digits` decimal places: "1.0", not "1". */
  readonly fixed?: boolean;
}

/** The whole units of a compound, for example "2 h 5 min". */
export interface ScaleCompound {
  /** The units of the compound, from the largest to the smallest. */
  readonly units: readonly string[];
  /** This number is the most units that the text names (the default is all). The smallest of them is rounded. */
  readonly parts?: number;
}

/**
 * A scale is the units that an amount can show in, as data. The steps go from the smallest unit to the largest. An
 * amount shows in the largest step that it fills after the rounding of the step below. Above the last step, the
 * compound names whole units.
 */
export interface Scale {
  readonly steps: readonly ScaleStep[];
  readonly compound?: ScaleCompound;
}

/** The decimal places of a value of a step. */
const placesOf = (step: ScaleStep, value: number): number => {
  const digits = step.digits ?? 2;
  if (step.significant === undefined || value === 0) return digits;
  return Math.min(digits, Math.max(0, step.significant - 1 - Math.floor(Math.log10(value))));
};

/** This function gives an amount in a unit, exactly: 9995 ms is 1999/200 s, not the double 9.995. */
const exactIn = (amount: Quantity, unit: string): Rational => convertExact(q.fromNumber(amount.value), amount.unit, unit);

/** This function gives the size of one `unit` in `of`, exactly. */
const sizeIn = (unit: string, of: string): Rational => convertExact(q.ONE, unit, of);

const checkUnits = (amount: Quantity, units: readonly string[]): void => {
  for (const unit of units) {
    const why = whyNotConvertible(amount.unit, unit);
    if (why !== undefined) throw new UnitError(`cannot show ${amount.unit} on a scale with ${unit}: ${why}`);
  }
};

/** The text of a whole number of a unit of a compound: "2 h", "1 day", "3 days". */
const wholeText = (whole: number, unit: string): string => {
  const word = SPOKEN[unit];
  return `${whole} ${word === undefined ? formatUnit(unit, whole !== 1) : whole === 1 ? word : `${word}s`}`;
};

/** The text of a compound for a magnitude of 0 or more, with no sign. */
const compoundText = (magnitude: Quantity, compound: ScaleCompound): string => {
  const smallestUnit = compound.units.at(-1);
  if (smallestUnit === undefined) throw new RangeError("a compound of a scale needs one unit or more");
  const spans = compound.units.map((unit) => [unit, sizeIn(unit, smallestUnit)] as const);
  const parts = compound.parts ?? spans.length;
  const spansFor = (value: Rational) => {
    const start = Math.max(0, spans.findIndex(([, size]) => q.compare(value, size) >= 0));
    return spans.slice(start, start + parts);
  };
  const value = exactIn(magnitude, smallestUnit);
  const smallest = spansFor(value).at(-1)?.[1] ?? q.ONE;
  // round first, then name the parts: 59 min 59.6 s is 1 h, never 59 min 60 s. The rounding is exact, thus
  // 1 min 2.5 s with whole seconds gives 1 min 3 s
  let rest = q.mul(roundExact(q.div(value, smallest), 0), smallest);
  const named: string[] = [];
  for (const [unit, size] of spansFor(rest)) {
    const whole = q.floor(q.div(rest, size));
    rest = q.sub(rest, q.mul(whole, size));
    if (q.sign(whole) > 0) named.push(wholeText(q.toNumber(whole), unit));
  }
  return named.length === 0 ? wholeText(0, smallestUnit) : named.join(" ");
};

/**
 * This function prints an amount on a scale: "512 B", "1.5 KiB", "3.5 ms", "1.25 s", "2 min 5 s". It rounds the
 * amount in a step before it compares the amount with the next step. Thus 1,048,575 B gives "1 MiB", not "1,024 KiB".
 */
export const formatOnScale = (amount: Quantity, scale: Scale): string => {
  if (!Number.isFinite(amount.value)) throw new RangeError(`not a finite amount: ${String(amount.value)} ${amount.unit}`);
  const { steps, compound } = scale;
  if (steps.length === 0 && compound === undefined) throw new RangeError("a scale needs a step or a compound");
  checkUnits(amount, [...steps.map((step) => step.unit), ...(compound?.units ?? [])]);
  const sign = amount.value < 0 ? "-" : "";
  const magnitude = { value: Math.abs(amount.value), unit: amount.unit };
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index] as ScaleStep;
    const value = exactIn(magnitude, step.unit);
    const places = placesOf(step, q.toNumber(value));
    // the rounding is of the exact value: 9995 ms is 9.995 s and shows "10 s", where the double 9.995 * 100 rounds down
    const rounded = roundExact(value, places);
    const shown = q.toNumber(rounded);
    // the next step: the next unit of the scale, or the smallest unit of the compound above this step
    const next =
      steps[index + 1]?.unit ??
      [...(compound?.units ?? [])].reverse().find((unit) => q.compare(sizeIn(unit, step.unit), q.ONE) > 0);
    if (next === undefined || q.compare(rounded, sizeIn(next, step.unit)) < 0) {
      // an amount that rounds to 0 has no sign: "0 ms", not "-0 ms"
      return `${shown === 0 ? "" : sign}${number(shown, places, step.fixed === true)} ${formatUnit(step.unit, shown !== 1)}`;
    }
  }
  return `${sign}${compoundText(magnitude, compound as ScaleCompound)}`;
};

/** The scale of bytes with steps of 1024: B, KiB, MiB, GiB and TiB, with at most 1 decimal place. */
export const BYTES_1024: Scale = { steps: ["B", "KiB", "MiB", "GiB", "TiB"].map((unit) => ({ unit, digits: 1 })) };

/** The scale of bytes with steps of 1000: B, kB, MB, GB and TB, with at most 1 decimal place. */
export const BYTES_1000: Scale = { steps: ["B", "kB", "MB", "GB", "TB"].map((unit) => ({ unit, digits: 1 })) };

/**
 * The scale of a short time: "0.42 ms", "3.5 ms", "120 ms", "1.25 s", then 2 whole units from 1 min: "2 min 5 s",
 * "2 h 5 min".
 */
export const DURATION_MS: Scale = {
  steps: [
    { unit: "ms", digits: 2, significant: 2 },
    { unit: "s", digits: 2 },
  ],
  compound: { units: ["d", "h", "min", "s"], parts: 2 },
};

/**
 * This function prints a time as people say it: "2 h 11 min 15 s", "45 min", "2 days 3 h". A
 * time of less than a second keeps its own unit ("250 ms"). The `parts` option sets the most
 * units that it names, and it rounds the smallest. It is `formatOnScale` with a compound of days,
 * hours, minutes and seconds.
 */
export const formatDuration = (amount: Quantity, parts = 3): string => {
  if (Math.abs(convert(amount, "s").value) < 1) return format(amount);
  return formatOnScale(amount, { steps: [], compound: { units: ["d", "h", "min", "s"], parts } });
};
