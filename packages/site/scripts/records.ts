// The parts that the exports of the CI runs share: sentinel.ts, http.ts, mongodb.ts and kind.ts.
//
// A runner of GitHub writes one folder for each shard: one raw record for each cell, summary.ndjson
// with the verdict of each cell at the time of its run, and runner.txt with the kernel and its HZ.
// A cell in a later folder replaces the same cell of an earlier folder, thus the folder of a re-run
// goes last. These functions read the folders, and they round each time for the copy of the site.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

/** This function writes a copy as JSON with an indent of 2. Each list of numbers stays on one line, thus the copy stays small. */
export const stringify = (copy: unknown): string =>
  `${JSON.stringify(copy, null, 2).replace(/\[\s*((?:-?[\d.e+-]+|null)(?:,\s*(?:-?[\d.e+-]+|null))*)\s*\]/g, (_, items: string) => `[${items.split(/,\s*/).join(", ")}]`)}\n`;

/** This function gives the date of a copy: the day that the last of its records ended. */
export const dateOf = (ended: readonly string[]): string => ended.map((each) => each.slice(0, 10)).sort().at(-1)!;

/** This function gives the median of a set of numbers, or null for none. */
export const middle = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
};

/** This form is the reason of a void run whose timer the VM delayed. */
const DELAYED = /^its (retransmit|keepalive) timer ran (\d+) jiffies behind its wheel slot: the VM delayed it, not the kernel$/;

/**
 * This function tells each void run of a cell in one text, or gives null for none. In these copies,
 * the reason of each void run is a timer that the VM delayed. Thus the text gives the timers and the
 * range of their delays. It stops at another reason.
 */
export const voidsOf = (reasons: readonly string[]): string | null => {
  if (reasons.length === 0) return null;
  const delays = reasons.map((reason) => DELAYED.exec(reason));
  const other = reasons.find((_, n) => delays[n] === null);
  if (other !== undefined) throw new Error(`the void reason "${other}" has no text for the page`);
  const timers = [...new Set(delays.map((match) => match![1]!))].sort().join(" or the ");
  const behind = delays.map((match) => Number(match![2]));
  const [low, high] = [Math.min(...behind), Math.max(...behind)];
  const jiffies = low === high ? `${low} jiffies` : `${low} to ${high} jiffies`;
  return reasons.length === 1
    ? `One run is void: its ${timers} timer was ${jiffies} behind its wheel slot. Thus the VM delayed it, not the kernel.`
    : `${reasons.length} runs are void: in each, the ${timers} timer was ${jiffies} behind its wheel slot. Thus the VM delayed them, not the kernel.`;
};
