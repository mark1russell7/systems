// The parts that the exports of the CI runs share: sentinel.ts, http.ts, mongodb.ts and kind.ts.
//
// A runner of GitHub writes one folder for each shard: one raw record for each cell, summary.ndjson
// with the verdict of each cell at the time of its run, and runner.txt with the kernel and its HZ.
// A cell in a later folder replaces the same cell of an earlier folder, thus the folder of a re-run
// goes last. These functions read the folders, and they round each time for the copy of the site.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { median } from "@mark1russell7/rigor-statistics";
import type { RecordCode } from "../../harness/src/index.ts";
import { commitProblems, DEBUG, DIRTY } from "../../harness/src/index.ts";
import { duration } from "../src/lib/format.ts";

/** A found cell is the raw record of a cell, its line of summary.ndjson, and the decision of a run that a re-run replaced. */
export interface Found<R, S> {
  readonly record: R;
  readonly summary: S;
  /** This decision is the decision of the cell in an earlier folder that a later folder replaced, or null. */
  readonly first: string | null;
}

/** This function reads the lines of summary.ndjson in a folder, by the name of each cell. */
const summariesOf = <S extends { readonly name: string }>(folder: string): Map<string, S> => {
  const out = new Map<string, S>();
  for (const line of readFileSync(join(folder, "summary.ndjson"), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const summary = JSON.parse(line) as S;
    out.set(summary.name, summary);
  }
  return out;
};

/**
 * This function reads the raw records of each folder with the line of each in summary.ndjson. A
 * cell in a later folder replaces the same cell of an earlier folder. It stops when a record has no
 * line, or when a line has no record.
 */
export const readFolders = <R extends { readonly cell: { readonly name: string } }, S extends { readonly name: string }>(
  folders: readonly string[],
): Map<string, Found<R, S>> => {
  const found = new Map<string, Found<R, S>>();
  for (const folder of folders) {
    const summaries = summariesOf<S>(folder);
    const seen = new Set<string>();
    for (const file of readdirSync(folder).filter((name) => name.endsWith(".json")).sort()) {
      const record = JSON.parse(readFileSync(join(folder, file), "utf8")) as R;
      const summary = summaries.get(record.cell.name);
      if (summary === undefined) throw new Error(`${file}: summary.ndjson has no line for ${record.cell.name}`);
      const before = found.get(record.cell.name);
      found.set(record.cell.name, {
        record,
        summary,
        first: before === undefined ? null : (before.first ?? (before.summary as { readonly decision?: string }).decision ?? null),
      });
      seen.add(record.cell.name);
    }
    const lost = [...summaries.keys()].filter((name) => !seen.has(name));
    if (lost.length > 0) throw new Error(`${folder}: summary.ndjson has lines with no record: ${lost.join(", ")}`);
  }
  return found;
};

/** This function gives the one value that each folder gives, or it stops. */
export const only = (what: string, values: readonly string[]): string => {
  const set = [...new Set(values)];
  if (set.length !== 1) throw new Error(`the records disagree on ${what}: ${set.join(", ")}`);
  return set[0]!;
};

/**
 * This function keeps the records of the cells of one catalog. A full run of the catalogs puts the
 * records of each catalog in the same folders, thus each export takes its own cells. A record of a
 * cell of no catalog stops it: then the folders hold the records of another run.
 */
export const ofCatalog = <F>(found: ReadonlyMap<string, F>, own: readonly string[], every: readonly string[]): Map<string, F> => {
  const mine = new Set(own);
  const all = new Set(every);
  const strange = [...found.keys()].filter((name) => !all.has(name));
  if (strange.length > 0) throw new Error(`no catalog has the cells ${strange.join(", ")}`);
  return new Map([...found].filter(([name]) => mine.has(name)));
};

/** A quantity of time, as a record gives it. */
interface Time {
  readonly value: number;
  readonly unit: string;
}

/**
 * This function gives the one δ_abs of the cells of a copy, in seconds: the noise of each cell, or
 * the default of the harness. It gives null when the cells disagree, as when a re-run had another
 * environment than the first run. Then each cell of the copy gives its own.
 */
export const noiseOf = (cells: readonly { readonly noise?: Time }[], fallback: Time): number | null => {
  const values = [...new Set(cells.map((cell) => secondsOf(cell.noise ?? fallback)))];
  return values.length === 1 ? values[0]! : null;
};

/**
 * This function gives the kernel and its HZ from runner.txt in each folder. The kernel keeps only
 * its version, and not the name of its build. GitHub rolls out a new image of its runners over some
 * days, thus the shards of one page can run on two kernels. Then the kernel names each version,
 * for example `6.17.0 and 7.0.0`. The HZ must be the same: a prediction of the catalog reads it.
 */
export const runnerOf = (folders: readonly string[]): { readonly kernel: string; readonly hz: number } => {
  const lines = folders.map((folder) => readFileSync(join(folder, "runner.txt"), "utf8"));
  const field = (text: string, form: RegExp): string => form.exec(text)?.[1] ?? "";
  const kernels = [...new Set(lines.map((text) => field(text, /^kernel: (\d+(?:\.\d+)+)/m)))];
  if (kernels.includes("")) throw new Error("a runner.txt gives no kernel");
  const version = (kernel: string): number[] => kernel.split(".").map(Number);
  kernels.sort((a, b) => {
    const [x, y] = [version(a), version(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  });
  return {
    kernel: kernels.join(" and "),
    hz: Number(only("HZ", lines.map((text) => field(text, /^CONFIG_HZ: CONFIG_HZ=(\d+)$/m)))),
  };
};

/** This function rounds a time in seconds to 0.1 µs, so that no binary fraction reaches the copy. */
export const round = (seconds: number): number => Number(seconds.toFixed(7));

/** This function gives a quantity of time in seconds, or null. */
export const secondsOf = (quantity: { readonly value: number; readonly unit: string } | null | undefined): number | null => {
  if (quantity === undefined || quantity === null) return null;
  const scale: Readonly<Record<string, number>> = { s: 1, ms: 1e-3 };
  const factor = scale[quantity.unit];
  if (factor === undefined) throw new Error(`no scale for the unit ${quantity.unit}`);
  return round(quantity.value * factor);
};

/** This function writes a time in seconds for the text of the page. */
export const time = (seconds: number): string => duration(seconds * 1000);

/** This function writes a time in seconds with `digits` decimals at 1 s or more, and as `time` below 1 s. */
export const timeAt =
  (digits: number) =>
  (seconds: number): string =>
    Math.abs(seconds) >= 1 ? `${Number(seconds.toFixed(digits))} s` : time(seconds);

/** This function writes an ordinal number as a word, up to the twelfth. */
export const ordinal = (n: number): string => {
  const words = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth"];
  const word = words[n - 1];
  if (word === undefined) throw new Error(`no word for the ordinal ${n}`);
  return word;
};

/** This form is one item of a list of numbers in a copy: the text of a number in JSON. */
const NUMBER = /^[\d.e+-]+$/;

/**
 * This function gives a list of numbers on one line, or the list as it is. A list of numbers has
 * a number or null as each item. White space can come before each item, and after the last one.
 */
const oneLine = (list: string, inside: string): string => {
  const items = inside.split(",");
  const last = items.length - 1;
  const trimmed = items.map((item, at) => (at === last ? item.trim() : item.trimStart()));
  return trimmed.every((item) => item === "null" || NUMBER.test(item)) ? `[${trimmed.join(", ")}]` : list;
};

/**
 * This function writes a copy as JSON with an indent of 2. Each list of numbers stays on one line, thus the copy stays small.
 * The pattern of a list has no nested quantifier, thus it cannot backtrack without a bound (SYS-34).
 */
export const stringify = (copy: unknown): string => `${JSON.stringify(copy, null, 2).replace(/\[([\s\d.e+,nul-]*)\]/g, oneLine)}\n`;

/** This function gives the date of a copy: the day that the last of its records ended. */
export const dateOf = (ended: readonly string[]): string => ended.map((each) => each.slice(0, 10)).sort().at(-1)!;

/** These are the parts of a record that give the commit of its code. A record of the old form has none of them. */
interface CodeOf {
  readonly code?: RecordCode | undefined;
  readonly debug?: boolean | undefined;
}

/**
 * This function gives the commit of the code that operated for the records of a copy, as its field `commit`. The stamp
 * of the page reads it (SYS-101). The records of the old form have no commit, thus their copy gets no field.
 * It stops at a local debug run, at a checkout with changes, at a mix of the two forms, and at two commits.
 */
export const commitOf = (records: readonly object[]): { readonly commit?: string } => {
  const codes = records as readonly CodeOf[];
  if (codes.every((record) => record.code === undefined && record.debug === undefined)) return {};
  const problems = [
    ...new Set(
      codes.flatMap((record) => [...commitProblems(record.code?.commit), ...(record.code?.dirty === true ? [DIRTY] : []), ...(record.debug === true ? [DEBUG] : [])]),
    ),
  ];
  if (problems.length > 0) throw new Error(`the copy cannot name the commit of its code: ${problems.join(", ")}`);
  return { commit: only("the commit of the code", codes.map((record) => record.code!.commit)) };
};

/** This function gives the median of a set of numbers, or null for none. */
export const middle = (values: readonly number[]): number | null => (values.length === 0 ? null : median(values));

/** This form is the reason of a void run whose timer the VM delayed. */
const DELAYED = /^its (retransmit|keepalive) timer ran (\d+) jiffies behind its wheel slot: the VM delayed it, not the kernel$/;

/** This form finds each number of a reason that stands alone: 13.3 and 2, but not the 6 of ip6tables. */
const STANDALONE = /(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g;

/** This function gives the range of some numbers as a text: "8.4", or "8.4 to 13.3". */
const rangeOf = (values: readonly string[]): string => {
  const sorted = [...values].sort((a, b) => Number(a) - Number(b));
  return sorted[0] === sorted.at(-1) ? sorted[0]! : `${sorted[0]} to ${sorted.at(-1)}`;
};

/** This function tells the void runs whose reason is a timer that the VM delayed: the timers and the range of their delays. */
const delayedOf = (matches: readonly RegExpExecArray[]): string => {
  const timers = [...new Set(matches.map((match) => match[1]!))].sort().join(" or the ");
  const jiffies = `${rangeOf(matches.map((match) => match[2]!))} jiffies`;
  return matches.length === 1
    ? `One run is void: its ${timers} timer was ${jiffies} behind its wheel slot. Thus the VM delayed it, not the kernel.`
    : `${matches.length} runs are void: in each, the ${timers} timer was ${jiffies} behind its wheel slot. Thus the VM delayed them, not the kernel.`;
};

/**
 * This function tells the void runs that have one shape of reason. The shape is the reason with no numbers.
 * The text gives the reason, with the range of each number over the runs.
 */
const shapedOf = (reasons: readonly string[]): string => {
  const numbers = reasons.map((reason) => reason.match(STANDALONE) ?? []);
  // the reasons of one shape have the same count of numbers: the range at each place is over all of them
  let place = 0;
  const text = reasons[0]!.replace(STANDALONE, () => {
    const at = place++;
    return rangeOf(numbers.map((each) => each[at]!));
  });
  return reasons.length === 1 ? `One run is void: ${text}.` : `${reasons.length} runs are void: in each, ${text}.`;
};

/**
 * This function tells each void run of a cell in one text, or gives null for none. It groups the runs by
 * the shape of their reason, in the order of the first run of each shape. A timer that the VM delayed has
 * its own text. Each other reason is a clause of the harness, and the text gives the range of its numbers.
 */
export const voidsOf = (reasons: readonly string[]): string | null => {
  if (reasons.length === 0) return null;
  const delayed = reasons.map((reason) => DELAYED.exec(reason)).filter((match) => match !== null);
  const shapes = new Map<string, string[]>();
  for (const reason of reasons.filter((each) => !DELAYED.test(each))) {
    const shape = reason.replace(STANDALONE, "#");
    shapes.set(shape, [...(shapes.get(shape) ?? []), reason]);
  }
  const first = (text: string): number => reasons.findIndex((reason) => reason === text);
  const parts = [
    ...(delayed.length === 0 ? [] : [{ at: first(delayed[0]![0]), text: delayedOf(delayed) }]),
    ...[...shapes.values()].map((group) => ({ at: first(group[0]!), text: shapedOf(group) })),
  ];
  return parts
    .sort((a, b) => a.at - b.at)
    .map((part) => part.text)
    .join(" ");
};
