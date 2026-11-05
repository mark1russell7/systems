// The read of the decisions of the scheduled cells (SYS-99).
//
//   pnpm exec tsx packages/site/scripts/held.ts --cells <night | drills> --shard <i/n> [--fault | --flip] <folder>...
//
// The name of --cells is a selection of SCHEDULED_CELLS in the cells package. Each folder is the output of one shard of the workflow Cells. The script judges each raw record
// again with the code of the harness, and it stops when that verdict disagrees with summary.ndjson.
// It prints each cell, and it exits with 1 unless each cell of the selection has a record and holds.
//
// --fault reads the same records with the injected fault of the cells package.
//
// --flip is the flip test of this check. It runs this script on the clean folders, with --fault, and
// on a copy with one record gone. It exits with 0 only if the clean read passes, each cell turns red
// under the fault, and the two other reads exit with 1.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Verdict } from "../../harness/src/index.ts";
import { catalogs, SCHEDULED_CELLS, selectedOf } from "../../cells/src/all.ts";
import { FAULT_FACTOR, faultedVerdict, heldRead, slowdownSeen } from "../../cells/src/held.ts";
import type { CellRecord, Reading, Summary } from "./judged.ts";
import { read } from "./judged.ts";
import { readFolders, withoutOne } from "./records.ts";

const args = process.argv.slice(2);
const option = (name: string): string => {
  const at = args.indexOf(name);
  const value = at < 0 ? undefined : args[at + 1];
  if (value === undefined) throw new Error(`the script needs ${name} <value>`);
  args.splice(at, 2);
  return value;
};
/** This function removes a flag from the arguments, and it tells if the flag was there. */
const flag = (name: string): boolean => {
  const at = args.indexOf(name);
  if (at >= 0) args.splice(at, 1);
  return at >= 0;
};
const flip = flag("--flip");
const fault = flag("--fault");
const selection = option("--cells");
const only = Object.hasOwn(SCHEDULED_CELLS, selection) ? SCHEDULED_CELLS[selection] : undefined;
if (only === undefined) throw new Error(`the script knows no selection ${selection}: ${Object.keys(SCHEDULED_CELLS).join(", ")}`);
const shardText = option("--shard");
const [shard, of] = shardText.split("/").map(Number) as [number, number];
const folders = args;
if (folders.length === 0) throw new Error("the script needs the folder of each shard");

const expected = selectedOf(catalogs(), only, shard, of).map((cell) => cell.name);
const found = readFolders<CellRecord, Summary>(folders);
const readings = new Map<string, Reading>([...found].map(([name, entry]) => [name, read(entry)]));

/** This function gives the verdicts of the records: as judged, or under the fault. */
const verdictsOf = (underFault: boolean): Map<string, Verdict> =>
  new Map([...readings].map(([name, reading]) => [name, underFault ? faultedVerdict(reading.cell, reading.measured) : reading.verdict]));

/** This function starts this script on the folders that it gets, and it gives its exit code. */
const exitOf = (given: readonly string[], ...flags: readonly string[]): number | null => {
  const script = fileURLToPath(import.meta.url);
  const done = spawnSync(process.execPath, [...process.execArgv, script, "--cells", selection, "--shard", shardText, ...flags, ...given], { stdio: "ignore" });
  return done.status;
};

if (flip) {
  // the flip needs one folder for its copy: each shard of the schedule gives one folder
  if (folders.length !== 1) throw new Error("--flip needs the folder of one shard");
  const scratch = mkdtempSync(join(tmpdir(), "held-"));
  const stayed = heldRead(expected, verdictsOf(true)).cells.filter((cell) => cell.held);
  const seen = [...readings.values()].flatMap((reading) => {
    const power = slowdownSeen(reading.cell, reading.measured);
    return power === null ? [] : [power];
  });
  const results: ReadonlyArray<readonly [string, number | null, number]> = [
    ["the clean copy", exitOf(folders), 0],
    [`a fault of ${FAULT_FACTOR} x the top of each band`, exitOf(folders, "--fault"), 1],
    ["a copy with one record gone", exitOf([withoutOne(folders[0]!, scratch)]), 1],
  ];
  rmSync(scratch, { recursive: true, force: true });
  for (const [what, exit, wanted] of results) process.stdout.write(`${what}: exit ${exit}, wanted ${wanted}\n`);
  for (const cell of stayed) process.stdout.write(`the fault left this cell green: ${cell.name}\n`);
  if (seen.length > 0) process.stdout.write(`a slowdown turns a cell red from ${Math.min(...seen).toFixed(3)} x to ${Math.max(...seen).toFixed(3)} x\n`);
  process.exit(results.every(([, exit, wanted]) => exit === wanted) && stayed.length === 0 ? 0 : 1);
}

const result = heldRead(expected, verdictsOf(fault));
for (const cell of result.cells) process.stdout.write(`${cell.decision}: ${cell.name}\n`);
for (const name of result.missing) process.stdout.write(`no record: ${name}\n`);
for (const name of result.extra) process.stdout.write(`outside the selection: ${name}\n`);
process.stdout.write(`${result.held ? "held" : "not held"}: ${result.reason}\n`);
process.exit(result.held ? 0 : 1);
