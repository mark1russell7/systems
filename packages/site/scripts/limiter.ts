// The export of the paired run of the limiter cells for the site: src/data/limiter-bench-<date>.json.
//
//   pnpm exec tsx packages/site/scripts/limiter.ts --run <id> --pair <control>,<candidate> --only <regex> <folder>...
//
// Each folder is the output of one shard of the workflow Cells with the input `pair` (SYS-52). It
// has the raw record of each pair cell, summary.ndjson, paired.ndjson and runner.txt. The script
// reads each record again with the code of the harness, and it stops when that verdict disagrees
// with summary.ndjson. It makes the plan of the pair again (limiterBench), and it stops when a
// record has another slot, or when a cell of the plan has no record. It gives the times of each
// pair again from the raw records (benchTimes, pairedLines). It stops when they disagree with
// paired.ndjson. Then it gives the time verdict of rigor-bench of each measure against the A/A pair.

import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { timeVerdict } from "@mark1russell7/rigor-bench";
import type { PairedLine, PairMeasure, PairSlot } from "../../cells/src/limiter.ts";
import { benchTimes, LIMITER_SPECS, limiterBench, pairedLines, pairedTimeOf, pairOf } from "../../cells/src/limiter.ts";
import type { CellRecord, Summary } from "./judged.ts";
import { read } from "./judged.ts";
import { dateOf, readFolders, round, stringify } from "./records.ts";

/** These options of timeVerdict are the defaults of rigor-bench, written out so that the copy names them. */
export const OPTIONS = { rule: "difference", margin: 0.05 } as const;

const args = process.argv.slice(2);
const option = (name: string): string => {
  const at = args.indexOf(name);
  const value = at < 0 ? undefined : args[at + 1];
  if (value === undefined) throw new Error(`the script needs ${name} <value>`);
  args.splice(at, 2);
  return value;
};
const run = Number(option("--run"));
const pair = option("--pair");
const selection = option("--only");
const folders = args;
if (folders.length === 0) throw new Error("the script needs the folder of each shard");

/** A pair record is the raw record of a pair cell: a cell record with its slot. */
interface PairRecord extends CellRecord {
  readonly pair: PairSlot;
}

const found = readFolders<PairRecord, Summary & { readonly again?: readonly (string | null)[] }>(folders);
const plan = limiterBench(pairOf(pair, "/pair"), folders.length, new RegExp(selection));
const slots = new Map(plan.map((each) => [each.cell.name, each.slot]));
const strange = [...found.keys()].filter((name) => !slots.has(name));
if (strange.length > 0) throw new Error(`the plan of the pair has no cells ${strange.join(", ")}`);
const lost = plan.filter((each) => !found.has(each.cell.name)).map((each) => each.cell.name);
if (lost.length > 0) throw new Error(`the folders have no record of ${lost.join(", ")}`);

/** This function gives an amount in seconds, rounded to 0.1 µs, so that no binary fraction reaches the copy. */
const seconds = (amount: Quantity): Quantity => ({ value: round(valueIn(amount, "s")), unit: "s" });

// the times of each arm, from the raw records judged again
const arms = plan.map(({ cell, slot }) => {
  const entry = found.get(cell.name)!;
  if (JSON.stringify(entry.record.pair) !== JSON.stringify(slot)) throw new Error(`${cell.name}: the record has the slot ${JSON.stringify(entry.record.pair)}, and the plan gives ${JSON.stringify(slot)}`);
  const reading = read(entry);
  const spec = LIMITER_SPECS.find((each) => each.plan === slot.plan)!;
  const times = reading.measured.flatMap((each) => benchTimes(spec, each));
  return { slot, times, summary: entry.summary };
});

// the lines of each pair: the second arm of a pair comes after its first arm in the plan
const lines: PairedLine[] = [];
const waiting = new Map<string, (typeof arms)[number]>();
for (const arm of arms) {
  const key = `${arm.slot.plan} ${arm.slot.block} ${arm.slot.round}`;
  const first = waiting.get(key);
  if (first === undefined) waiting.set(key, arm);
  else lines.push(...pairedLines(first, arm));
}
const written = folders.flatMap((folder) =>
  readFileSync(join(folder, "paired.ndjson"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as PairedLine),
);
const text = (list: readonly PairedLine[]) => list.map((line) => JSON.stringify(line)).sort();
if (JSON.stringify(text(lines)) !== JSON.stringify(text(written)))
  throw new Error(`the raw records give ${lines.length} paired lines, and paired.ndjson gives ${written.length} lines that are not the same`);

/** This function keeps 7 significant digits of each number of an object, so that the copy stays small. */
const digits = <T extends object>(object: T): T =>
  Object.fromEntries(Object.entries(object).map(([key, value]) => [key, typeof value === "number" ? Number(value.toPrecision(7)) : value])) as T;

const copied = lines.map((line) => ({ ...line, a: seconds(line.a), b: seconds(line.b) }));
const measures: readonly PairMeasure[] = ["retry", "answer"];
const verdicts = measures.map((measure) => {
  const of = (block: "ab" | "aa") => copied.filter((line) => line.measure === measure && line.pair === block).map(pairedTimeOf);
  const verdict = timeVerdict(of("ab"), of("aa"), OPTIONS);
  return {
    measure,
    outcome: verdict.outcome,
    reason: verdict.reason,
    interval: verdict.interval === undefined ? null : digits(verdict.interval),
    band: verdict.band === undefined ? null : digits(verdict.band),
    cases: { ab: new Set(of("ab").map((each) => each.case)).size, aa: new Set(of("aa").map((each) => each.case)).size },
    ratios: verdict.cases.map((each) => ({ case: each.case, ratio: Number(each.ratio.toFixed(7)), rounds: each.rounds })),
  };
});

/** This function gives the image, the CPU, the count of CPUs and the HZ of the runner of a folder, from runner.txt. */
const runnerOf = (folder: string) => {
  const lines = readFileSync(join(folder, "runner.txt"), "utf8");
  const field = (name: string): string => {
    const value = new RegExp(`^${name}: (.+)$`, "m").exec(lines)?.[1]?.trim();
    if (value === undefined) throw new Error(`${folder}: runner.txt gives no ${name}`);
    return value;
  };
  return { image: field("image"), cpu: field("cpu"), cpus: Number(field("cpus")), hz: Number(field("CONFIG_HZ").replace("CONFIG_HZ=", "")) };
};

const bench = JSON.parse(readFileSync(fileURLToPath(new URL("../node_modules/@mark1russell7/rigor-bench/package.json", import.meta.url)), "utf8")) as { readonly version: string };
const [control, candidate] = pairOf(pair, "/pair").map((build) => build.service) as [string, string];
const records = [...found.values()].map((entry) => entry.record);
const date = dateOf(records.map((record) => record.at.ended));
const summaries = arms.map((arm) => arm.summary);
const copy = {
  source: "the raw records of the runners of GitHub, judged again by the harness, and the time verdict of rigor-bench of each measure",
  workflow: run,
  date,
  pair: { control, candidate },
  only: selection,
  shards: folders.length,
  rounds: Math.max(...plan.map((each) => each.slot.round)) + 1,
  bench: { package: "@mark1russell7/rigor-bench", version: bench.version, options: OPTIONS },
  unit: "s",
  runners: Object.fromEntries(folders.map((folder) => [basename(folder), runnerOf([folder])])),
  cells: {
    count: summaries.length,
    holds: summaries.filter((summary) => summary.decision === "holds").length,
    again: summaries.filter((summary) => summary.again !== undefined).length,
    decisions: [...new Set(summaries.map((summary) => summary.decision))].sort(),
  },
  verdicts,
  slots: plan.map(({ cell, slot }) => ({ name: cell.name, ...slot, decision: found.get(cell.name)!.summary.decision })),
  records: copied,
};
const out = fileURLToPath(new URL(`../src/data/limiter-bench-${date}.json`, import.meta.url));
writeFileSync(out, stringify(copy));
process.stdout.write(`${summaries.length} cells, ${copied.length} paired lines, ${verdicts.map((each) => `${each.measure} ${each.outcome}`).join(", ")}: ${out}\n`);
