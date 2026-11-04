// The export of the recovery drills for the site: src/data/recovery-<date>.json.
//
//   pnpm exec tsx packages/site/scripts/recovery.ts --run <id> --commit <sha> <folder>...
//
// Each folder is the output of one shard of the workflow Cells (SYS-94). The script reads each record
// again with the code of the harness, and it stops when that verdict disagrees with summary.ndjson,
// or when a drill has no record. It gives the record of each rung from the measures of its drills
// (recoveryRecord). The verdict of each rung comes from those records and nothing else.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { measureGroup } from "../../harness/src/index.ts";
import { RECOVERY_CELLS, RECOVERY_LADDER, RECOVERY_RUNGS, recoveryRecord, recoveryVerdict } from "../../cells/src/recovery.ts";
import type { CellRecord, Summary } from "./judged.ts";
import { read, resultOf } from "./judged.ts";
import { dateOf, readFolders, runnerOf, stringify } from "./records.ts";

const args = process.argv.slice(2);
const option = (name: string): string => {
  const at = args.indexOf(name);
  const value = at < 0 ? undefined : args[at + 1];
  if (value === undefined) throw new Error(`the script needs ${name} <value>`);
  args.splice(at, 2);
  return value;
};
const run = Number(option("--run"));
const commit = option("--commit");
const folders = args;
if (folders.length === 0) throw new Error("the script needs the folder of each shard");

const found = readFolders<CellRecord, Summary>(folders);
const lost = RECOVERY_CELLS.filter((cell) => !found.has(cell.name)).map((cell) => cell.name);
if (lost.length > 0) throw new Error(`the folders have no record of ${lost.join(", ")}`);

// the verdict of each cell, from the raw record judged again. A drill keeps its findings as the harness gives them
const entries = RECOVERY_CELLS.map((cell) => found.get(cell.name)!);
const readings = entries.map((entry) => read(entry));
const cells = readings.map((reading) => ({ name: reading.cell.name, ...resultOf(reading, { findings: [[/^.*$/, (match) => match[0]]] }) }));

/** This function gives the measures of the runs of a drill, by the prefix of its name. */
const drillOf = (prefix: string) => {
  const entry = entries.find((each) => each.record.cell.name.startsWith(`${prefix} `));
  if (entry === undefined) throw new Error(`no record of the drill ${prefix}`);
  return entry.record.runs.map((each) => measureGroup(entry.record.cell, each));
};

const date = dateOf(entries.map((entry) => entry.record.at.ended));
const at = entries.map((entry) => entry.record.at.ended).sort().at(-1)!;
const records = RECOVERY_RUNGS.map((rung) => recoveryRecord(rung, { [rung.drill]: drillOf(rung.drill), [rung.kept]: drillOf(rung.kept) }, commit, at));
// the age of a record decides nothing at the time of its export
const verdict = recoveryVerdict(records, at);

const copy = {
  source: "the raw records of the runners of GitHub, judged again by the harness, and the ladder verdict of rigor-bench",
  workflow: run,
  commit,
  date,
  runners: folders.map((folder) => runnerOf(folder)),
  ladder: RECOVERY_LADDER,
  verdict,
  records,
  cells,
};
const out = fileURLToPath(new URL(`../src/data/recovery-${date}.json`, import.meta.url));
writeFileSync(out, stringify(copy));
process.stdout.write(`${cells.length} drills, held ${verdict.held ?? "none"}, next ${verdict.next ?? "none"}: ${out}\n`);
