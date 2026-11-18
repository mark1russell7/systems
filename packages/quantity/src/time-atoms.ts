import type { Rational } from "@mark1russell7/rational";
import { ONE, div } from "@mark1russell7/rational";
import type { Atom, Vector } from "./dimensions.ts";
import { atom, decimal as r } from "./dimensions.ts";

const T: Vector = { time: 1 };
const PER_T: Vector = { time: -1 };
const NONE: Vector = {};

/** This is the mean Gregorian year. A month is exactly a twelfth of it, thus USD/mo × 12 is USD/yr. */
const YEAR: Rational = r("31556952");

/** These are the units of time. A jiffy is 1/HZ seconds, thus its conversion needs the HZ of the kernel. */
export const TIME_ATOMS: readonly Atom[] = [
  atom("ns", "nanosecond", T, r("1e-9"), { aliases: ["nsec", "nanoseconds"] }),
  atom("us", "microsecond", T, r("1e-6"), {
    display: "µs",
    aliases: ["µs", "μs", "usec", "microseconds"],
  }),
  atom("ms", "millisecond", T, r("0.001"), { aliases: ["msec", "milliseconds"] }),
  atom("s", "second", T, ONE, { aliases: ["sec", "secs", "second", "seconds"] }),
  atom("min", "minute", T, r("60"), { aliases: ["mins", "minute", "minutes"] }),
  atom("h", "hour", T, r("3600"), { aliases: ["hr", "hrs", "hour", "hours"] }),
  atom("d", "day", T, r("86400"), { aliases: ["day", "days"] }),
  atom("wk", "week", T, r("604800"), { aliases: ["week", "weeks"] }),
  atom("mo", "month", T, div(YEAR, r("12")), { aliases: ["month", "months"] }),
  atom("yr", "year", T, YEAR, { aliases: ["year", "years"] }),
  atom("jiffy", "jiffy", T, ONE, { param: "hz", aliases: ["jiffies"] }),
];

/** These are the units of frequency, and the counts per time that say what they count. */
export const FREQUENCY_ATOMS: readonly Atom[] = [
  // the deviation of the frequency of a grid from 50 or 60 Hz is a few mHz
  atom("mHz", "millihertz", PER_T, r("1e-3")),
  atom("Hz", "hertz", PER_T, ONE, { aliases: ["hertz"] }),
  atom("kHz", "kilohertz", PER_T, r("1e3")),
  atom("MHz", "megahertz", PER_T, r("1e6")),
  atom("GHz", "gigahertz", PER_T, r("1e9")),
  atom("bpm", "beats per minute", PER_T, div(ONE, r("60")), { counts: "beat" }),
];

/** These are the units with no dimension: a count, a ratio and a level. */
export const DIMENSIONLESS_ATOMS: readonly Atom[] = [
  atom("count", "count", NONE, ONE),
  atom("%", "percent", NONE, r("0.01"), { percent: true, aliases: ["percent", "pct"] }),
  atom("ppm", "part per million", NONE, r("1e-6"), { percent: true }),
  atom("ppb", "part per billion", NONE, r("1e-9"), { percent: true }),
  atom("dBA", "A-weighted decibel", NONE, ONE, { log: true, aliases: ["dBASPL"] }),
  // a level with no weighting: it converts only to itself, as dBA does
  atom("dB", "decibel", NONE, ONE, { log: true }),
];

/** These are the whole spellings of other systems that name units of the three tables above. */
export const TIME_SPELLINGS: Readonly<Record<string, string>> = {
  "beats/min": "bpm",
  "dB(A)": "dBA",
};
