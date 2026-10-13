import type { Component } from "./parse.ts";
import { parseUnit } from "./parse.ts";
import type { Extent, Quantity, Unknown } from "./quantity.ts";
import { convert } from "./quantity.ts";

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
    const whole = Math.round(magnitude * 10 ** cents) % 10 ** cents === 0;
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

const SPANS: ReadonlyArray<readonly [string, number]> = [
  ["d", 86400],
  ["h", 3600],
  ["min", 60],
  ["s", 1],
];

const spansFor = (seconds: number, parts: number): ReadonlyArray<readonly [string, number]> => {
  const start = Math.max(
    0,
    SPANS.findIndex(([, size]) => seconds >= size),
  );
  return SPANS.slice(start, start + parts);
};

/**
 * This function prints a time as people say it: "2 h 11 min 15 s", "45 min", "2 days 3 h". A
 * time of less than a second keeps its own unit ("250 ms"). The `parts` option sets the most
 * units that it names, and it rounds the smallest.
 */
export const formatDuration = (amount: Quantity, parts = 3): string => {
  const seconds = convert(amount, "s").value;
  if (Math.abs(seconds) < 1) return format(amount);
  const smallest = spansFor(Math.abs(seconds), parts).at(-1)?.[1] ?? 1;
  // round first, then name the parts: 59 min 59.6 s is 1 h, never 59 min 60 s
  let rest = Math.round(Math.abs(seconds) / smallest) * smallest;
  const named: string[] = [];
  for (const [unit, size] of spansFor(rest, parts)) {
    const whole = Math.floor(rest / size);
    rest -= whole * size;
    const word = SPOKEN[unit];
    if (whole > 0)
      named.push(`${whole} ${word === undefined ? unit : whole === 1 ? word : `${word}s`}`);
  }
  return `${seconds < 0 ? "-" : ""}${named.join(" ")}`;
};
