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

/** The text of each unit that was shown, keyed by its count (1 or many) and its spelling. */
const unitTexts = new Map<string, string>();

/** This function gives how a unit reads next to an amount: "kcal/(h·kg)", "sets/wk", "% of 1RM", "mph". */
export const formatUnit = (unit: string, many = true): string => {
  const key = `${many ? "n" : "1"}${unit}`;
  const hit = unitTexts.get(key);
  if (hit !== undefined) return hit;
  const text = unitText(unit, many);
  unitTexts.set(key, text);
  return text;
};

const unitText = (unit: string, many: boolean): string => {
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

/** These are the formats of numbers, one for each count of digits, fixed or not. */
const formats = new Map<string, Intl.NumberFormat>();

/**
 * This function prints a number in the format of en-US. A call of `toLocaleString` with options makes a new
 * format each time. That is most of the time of a call, thus this function makes each format one time.
 */
const number = (value: number, digits: number, fixed: boolean): string => {
  const key = `${digits}:${fixed}`;
  let format = formats.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat("en-US", { minimumFractionDigits: fixed ? digits : 0, maximumFractionDigits: digits });
    formats.set(key, format);
  }
  return format.format(value);
};

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
 *
 * The text is the text of the exact rational work. A fast path with doubles gives most texts, and the exact work runs
 * only when the doubles cannot decide a rounding or a comparison.
 */
export const formatOnScale = (amount: Quantity, scale: Scale): string =>
  formatOnScaleFast(amount, scale) ?? formatOnScaleExact(amount, scale);

/** The largest double below which each integer is exact. */
const SAFE = 2 ** 53;

/**
 * This number is the relative distance from a half, or from a size, below which the fast path does not decide. The
 * error of the doubles is at most 6 units in the last place (6 × 2^-53). 2^-48 is 32 units, thus each decision that
 * passes this filter is the decision of the exact value.
 */
const TIE = 2 ** -48;

/** An amount in one unit for the fast path: `n / d` with safe integers when it is exact, else only the double `x`. */
interface Near {
  readonly x: number;
  readonly n?: number;
  readonly d?: number;
}

/** The plan of a step for amounts in one unit. */
interface StepPlan {
  readonly step: ScaleStep;
  /** One unit of the amount is `p / q` of the step unit. */
  readonly p: number;
  readonly q: number;
  /** The size of one unit of the next step in the step unit, or undefined when no step is above. */
  readonly next: Rational | undefined;
}

/** The plan of a compound for amounts in one unit. */
interface CompoundPlan {
  readonly units: readonly string[];
  /** The size of each unit in the smallest unit: integers. */
  readonly sizes: readonly number[];
  readonly parts: number;
  /** One unit of the amount is `p / q` of the smallest unit. */
  readonly p: number;
  readonly q: number;
}

interface Plan {
  readonly steps: readonly StepPlan[];
  readonly compound: CompoundPlan | undefined;
}

/** The plans of each scale, keyed by the unit of the amount. A plan of null tells that only the exact path applies. */
const plans = new WeakMap<Scale, Map<string, Plan | null>>();

/** This function gives `p / q` with safe integers for the size of one `from` in `to`, or undefined. */
const ratioOf = (from: string, to: string): readonly [number, number] | undefined => {
  const unitFrom = parseUnit(from);
  const unitTo = parseUnit(to);
  if (unitFrom.log || unitTo.log || unitFrom.offset !== undefined || unitTo.offset !== undefined) return undefined;
  const size = convertExact(q.ONE, from, to);
  return size.n <= 0n || size.n > BigInt(SAFE) || size.d > BigInt(SAFE) ? undefined : [Number(size.n), Number(size.d)];
};

const planOf = (unit: string, scale: Scale): Plan | null => {
  const { steps, compound } = scale;
  const stepPlans: StepPlan[] = [];
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index] as ScaleStep;
    const ratio = ratioOf(unit, step.unit);
    if (ratio === undefined) return null;
    const next =
      steps[index + 1]?.unit ??
      [...(compound?.units ?? [])].reverse().find((u) => q.compare(sizeIn(u, step.unit), q.ONE) > 0);
    stepPlans.push({ step, p: ratio[0], q: ratio[1], next: next === undefined ? undefined : sizeIn(next, step.unit) });
  }
  if (compound === undefined) return { steps: stepPlans, compound: undefined };
  const smallestUnit = compound.units.at(-1);
  if (smallestUnit === undefined) return null;
  const sizes: number[] = [];
  for (const u of compound.units) {
    const size = sizeIn(u, smallestUnit);
    if (size.d !== 1n || size.n <= 0n || size.n > BigInt(SAFE)) return null;
    sizes.push(Number(size.n));
  }
  const ratio = ratioOf(unit, smallestUnit);
  if (ratio === undefined) return null;
  const parts = compound.parts ?? sizes.length;
  return { steps: stepPlans, compound: { units: compound.units, sizes, parts, p: ratio[0], q: ratio[1] } };
};

const planFor = (amount: Quantity, scale: Scale): Plan | null => {
  let byUnit = plans.get(scale);
  if (byUnit === undefined) {
    byUnit = new Map();
    plans.set(scale, byUnit);
  }
  let plan = byUnit.get(amount.unit);
  if (plan === undefined) {
    checkUnits(amount, [...scale.steps.map((step) => step.unit), ...(scale.compound?.units ?? [])]);
    plan = planOf(amount.unit, scale);
    byUnit.set(amount.unit, plan);
  }
  return plan;
};

/** This function gives a magnitude `v` of 0 or more times `p / q`. */
const nearOf = (v: number, p: number, q: number): Near => {
  const x = (v * p) / q;
  return Number.isInteger(v) && v * p <= SAFE ? { x, n: v * p, d: q } : { x };
};

/** This function gives an integer `a / b` rounded down, for safe integers of 0 or more. */
const quotient = (a: number, b: number): number => (a - (a % b)) / b;

/** This function gives the amount times 10^places, rounded with a half going up, or undefined when it cannot decide. */
const roundNear = (near: Near, places: number): number | undefined => {
  if (places > 15) return undefined;
  const ten = 10 ** places;
  if (near.n !== undefined && near.d !== undefined) {
    const twice = 2 * near.n * ten + near.d;
    return twice <= SAFE ? quotient(twice, 2 * near.d) : undefined;
  }
  const scaled = near.x * ten;
  if (!(scaled < 2 ** 50)) return undefined;
  const t = scaled + 0.5;
  const whole = Math.floor(t);
  const tolerance = (scaled + 1) * TIE;
  return t - whole <= tolerance || whole + 1 - t <= tolerance ? undefined : whole;
};

/** This function tells if the amount is `size` or more, or gives undefined when it cannot decide. */
const atLeast = (near: Near, size: number): boolean | undefined => {
  if (near.n !== undefined && near.d !== undefined) {
    const right = size * near.d;
    return right <= SAFE ? near.n >= right : undefined;
  }
  return Math.abs(near.x - size) <= (near.x + size) * TIE ? undefined : near.x >= size;
};

/** The decimal places of a step, or undefined when a double near a power of 10 cannot decide them. */
const placesNear = (step: ScaleStep, near: Near): number | undefined => {
  const exact = near.n !== undefined;
  if (step.significant === undefined || near.x === 0 || exact) return placesOf(step, near.x);
  const low = 10 ** Math.floor(Math.log10(near.x));
  const margin = near.x * 2 ** -40;
  return Math.abs(near.x - low) <= margin || Math.abs(10 * low - near.x) <= margin ? undefined : placesOf(step, near.x);
};

/** The powers of 10 as bigints, for the comparison of a rounded amount with the next step. */
const TENS = Array.from({ length: 16 }, (_, k) => 10n ** BigInt(k));

/** The text of a compound by the fast path, or undefined. It is `compoundText` with integers of the smallest unit. */
const compoundNear = (magnitude: number, plan: CompoundPlan): string | undefined => {
  const value = nearOf(magnitude, plan.p, plan.q);
  const startOf = (near: Near): number | undefined => {
    for (let index = 0; index < plan.sizes.length; index++) {
      const hit = atLeast(near, plan.sizes[index] as number);
      if (hit === undefined) return undefined;
      if (hit) return index;
    }
    return 0;
  };
  const start = startOf(value);
  if (start === undefined) return undefined;
  const smallest = plan.sizes[Math.min(start + plan.parts, plan.sizes.length) - 1] ?? 1;
  const count = roundNear(
    value.n !== undefined && value.d !== undefined ? { x: value.x / smallest, n: value.n, d: value.d * smallest } : { x: value.x / smallest },
    0,
  );
  if (count === undefined || count * smallest > SAFE) return undefined;
  let rest = count * smallest;
  const from = startOf({ x: rest, n: rest, d: 1 }) as number;
  const named: string[] = [];
  for (let index = from; index < Math.min(from + plan.parts, plan.sizes.length); index++) {
    const size = plan.sizes[index] as number;
    const whole = quotient(rest, size);
    rest -= whole * size;
    if (whole > 0) named.push(wholeText(whole, plan.units[index] as string));
  }
  return named.length === 0 ? wholeText(0, plan.units.at(-1) as string) : named.join(" ");
};

/**
 * This function is the fast path of `formatOnScale`. It gives undefined when the doubles cannot decide a rounding or a
 * comparison. It also gives undefined for a scale with a unit with an offset, a level or a large factor. The entry
 * does not export it.
 */
export const formatOnScaleFast = (amount: Quantity, scale: Scale): string | undefined => {
  if (!Number.isFinite(amount.value)) return undefined;
  if (scale.steps.length === 0 && scale.compound === undefined) return undefined;
  const plan = planFor(amount, scale);
  if (plan === null) return undefined;
  const sign = amount.value < 0 ? "-" : "";
  const magnitude = Math.abs(amount.value);
  for (const stepPlan of plan.steps) {
    const near = nearOf(magnitude, stepPlan.p, stepPlan.q);
    const places = placesNear(stepPlan.step, near);
    if (places === undefined) return undefined;
    const rounded = roundNear(near, places);
    if (rounded === undefined) return undefined;
    const next = stepPlan.next;
    if (next === undefined || BigInt(rounded) * next.d < next.n * (TENS[places] as bigint)) {
      const shown = rounded / 10 ** places;
      const text = `${number(shown, places, stepPlan.step.fixed === true)} ${formatUnit(stepPlan.step.unit, shown !== 1)}`;
      return `${shown === 0 ? "" : sign}${text}`;
    }
  }
  if (plan.compound === undefined) return undefined;
  const text = compoundNear(magnitude, plan.compound);
  return text === undefined ? undefined : `${sign}${text}`;
};

/** This function is `formatOnScale` with exact rational work only. The entry does not export it. */
export const formatOnScaleExact = (amount: Quantity, scale: Scale): string => {
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
