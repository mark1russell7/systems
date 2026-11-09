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
// A record that does not pin the programs of its runs is not a record (SYS-101), thus its cell is red.
//
// --flip is the flip test of this check. It runs this script on the clean folders and with --fault.
// It also runs it on three copies: one with a record gone, one with a target by the tag redis:7.4 and
// no digest, and one with a checkout with changes. It exits with 0 only if the clean read passes, each
// cell turns red under the fault, and each other read exits with 1 and names its cause. A crash also
// exits with 1, thus a red read that names no cause fails the flip.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Verdict } from "../../harness/src/index.ts";
import { recordProblems } from "../../harness/src/index.ts";
import { catalogs, SCHEDULED_CELLS, selectedOf } from "../../cells/src/all.ts";
import { FAULT_FACTOR, faultedVerdict, heldRead, slowdownSeen } from "../../cells/src/held.ts";
import type { Read } from "./flip.ts";
import { byTag, changed, dirty, readOf, rightFor, withoutOne } from "./flip.ts";
import type { CellRecord, Reading, Summary } from "./judged.ts";
import { read } from "./judged.ts";
import { readFolders } from "./records.ts";

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
/** These are the problems of the pins of each record, from the raw record and not from summary.ndjson. */
const problems = new Map([...found].map(([name, entry]) => [name, recordProblems(entry.record)]));

/** This function gives the verdicts of the records: as judged, or under the fault. */
const verdictsOf = (underFault: boolean): Map<string, Verdict> =>
  new Map([...readings].map(([name, reading]) => [name, underFault ? faultedVerdict(reading.cell, reading.measured) : reading.verdict]));

/** This function starts this script on the folders that it gets, and it gives its exit code and its output. */
const again = (given: readonly string[], ...flags: readonly string[]): Read =>
  readOf(fileURLToPath(import.meta.url), ["--cells", selection, "--shard", shardText, ...flags, ...given]);

if (flip) {
  // the flip needs one folder for its copy: each shard of the schedule gives one folder
  if (folders.length !== 1) throw new Error("--flip needs the folder of one shard");
  const scratch = mkdtempSync(join(tmpdir(), "held-"));
  const stayed = heldRead(expected, verdictsOf(true)).cells.filter((cell) => cell.held);
  const seen = [...readings.values()].flatMap((reading) => {
    const power = slowdownSeen(reading.cell, reading.measured);
    return power === null ? [] : [power];
  });
  // each red read names its cause in the line "not held", thus a crash does not pass as red
  const reads: ReadonlyArray<readonly [string, Read, string | null]> = [
    ["the clean copy", again(folders), null],
    [`a fault of ${FAULT_FACTOR} x the top of each band`, again(folders, "--fault"), "did not hold"],
    ["a copy with one record gone", again([withoutOne(folders[0]!, scratch)]), "had no record"],
    ["a copy with a target by the tag redis:7.4 and no digest", again([changed(folders[0]!, scratch, "tag", byTag)]), "with no pin of the programs"],
    ["a copy from a checkout with changes", again([changed(folders[0]!, scratch, "dirty", dirty)]), "with no pin of the programs"],
  ];
  rmSync(scratch, { recursive: true, force: true });
  const results = reads.map(([what, done, cause]) => ({ what, exit: done.status, cause, right: rightFor(done, cause) }));
  for (const each of results) process.stdout.write(`${each.right ? "right" : "WRONG"}: ${each.what}: exit ${each.exit}${each.cause === null ? "" : `, cause "${each.cause}"`}\n`);
  for (const cell of stayed) process.stdout.write(`the fault left this cell green: ${cell.name}\n`);
  if (seen.length > 0) process.stdout.write(`a slowdown turns a cell red from ${Math.min(...seen).toFixed(3)} x to ${Math.max(...seen).toFixed(3)} x\n`);
  process.exit(results.every((each) => each.right) && stayed.length === 0 ? 0 : 1);
}

const result = heldRead(expected, verdictsOf(fault), problems);
for (const cell of result.cells) process.stdout.write(`${cell.held || cell.decision !== "holds" ? cell.decision : cell.why}: ${cell.name}\n`);
for (const name of result.missing) process.stdout.write(`no record: ${name}\n`);
for (const name of result.extra) process.stdout.write(`outside the selection: ${name}\n`);
process.stdout.write(`${result.held ? "held" : "not held"}: ${result.reason}\n`);
process.exit(result.held ? 0 : 1);
