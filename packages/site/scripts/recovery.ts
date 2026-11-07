// The export of the recovery drills for the site: src/data/recovery-<date>.json.
//
//   pnpm exec tsx packages/site/scripts/recovery.ts [--check [--fault] | --flip] --run <id> --commit <sha> <folder>...
//
// Each folder is the output of one shard of the workflow Cells (SYS-94). The script reads each record
// again with the code of the harness, and it stops when that verdict disagrees with summary.ndjson,
// or when a drill has no record. It gives the record of each rung from the measures of its drills
// (recoveryRecord). The verdict of each rung comes from those records and nothing else.
//
// With --check the script writes no file. It prints each rung, and it exits with 1 when a locked rung
// is not within its budgets. This is the lock of the rungs: the workflow Cells does not fail on a
// failing cell, thus this step fails for it.
//
// --fault puts each measure of each rung past its budget (breached), thus the check exits with 1.
//
// --flip is the flip test of the lock (SYS-99). It runs the check on the clean folders, with --fault,
// and on a copy with the record of one drill gone. For each rung and each budget, it also puts that
// one measure past its budget, and that rung must read beyond. It exits with 0 only if the clean
// check passes, each other check exits with 1 and names its cause, and each budget alone turns its
// rung red. A crash also exits with 1, thus a red read that does not name its cause does not pass.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Quantity } from "@mark1russell7/quantity";
import { measureGroup } from "../../harness/src/index.ts";
import { FAULT_FACTOR } from "../../cells/src/held.ts";
import { RECOVERY_CELLS, RECOVERY_LADDER, RECOVERY_RUNGS, breached, budgetFlip, recoveryRecord, recoveryVerdict } from "../../cells/src/recovery.ts";
import type { CellRecord, Summary } from "./judged.ts";
import { read, resultOf } from "./judged.ts";
import { dateOf, readFolders, runnerOf, stringify, withoutOne } from "./records.ts";

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
const check = flag("--check");
const fault = flag("--fault");
const flip = flag("--flip");
const runText = option("--run");
const run = Number(runText);
const commit = option("--commit");
// a fault in an export would write a false copy for the page
if (fault && !check) throw new Error("--fault needs --check");
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
const clean = RECOVERY_RUNGS.map((rung) => recoveryRecord(rung, { [rung.drill]: drillOf(rung.drill), [rung.kept]: drillOf(rung.kept) }, commit, at));
const budgetsOf = (name: string) => RECOVERY_LADDER.rungs.find((rung) => rung.name === name)?.budgets ?? [];
const records = fault ? clean.map((record) => budgetsOf(record.rung).reduce((each, budget) => breached(each, budget.measure), record)) : clean;
// the age of a record decides nothing at the time of its export
const verdict = recoveryVerdict(records, at);

/** This function starts the check of this script on the folders that it gets, and it gives its exit code and its output. */
const checkOf = (given: readonly string[], ...flags: readonly string[]) =>
  spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--check", ...flags, "--run", runText, "--commit", commit, ...given], { encoding: "utf8" });

if (flip) {
  // the Sunday runs the drills on one shard, thus one folder holds each record
  if (folders.length !== 1) throw new Error("--flip needs the folder of one shard");
  const scratch = mkdtempSync(join(tmpdir(), "recovery-"));
  const pass = checkOf(folders);
  const faulted = checkOf(folders, "--fault");
  const gone = checkOf([withoutOne(folders[0]!, scratch)]);
  rmSync(scratch, { recursive: true, force: true });
  // a crash also exits with 1: each red read names each rung or the lost record, thus a crash does not pass as red
  const results: ReadonlyArray<readonly [string, number | null, boolean]> = [
    ["the clean check", pass.status, pass.status === 0],
    [`each budget of each rung past its limit, ${FAULT_FACTOR} x or 1 for a limit of 0`, faulted.status, faulted.status === 1 && RECOVERY_RUNGS.every((rung) => faulted.stdout.includes(`rung ${rung.name}: beyond`))],
    ["a copy with the record of one drill gone", gone.status, gone.status === 1 && gone.stderr.includes("the folders have no record of")],
  ];
  const flips = budgetFlip(clean, at);
  const green = flips.filter((each) => !each.red);
  for (const [what, exit, right] of results) process.stdout.write(`${right ? "right" : "WRONG"}: ${what}: exit ${exit}\n`);
  process.stdout.write(`${flips.length - green.length} of ${flips.length} budgets turn their rung red alone\n`);
  for (const each of green) process.stdout.write(`this budget left rung ${each.rung} ${each.outcome}: ${each.measure}\n`);
  process.exit(results.every(([, , right]) => right) && green.length === 0 && flips.length > 0 ? 0 : 1);
}

if (check) {
  for (const rung of verdict.rungs) process.stdout.write(`rung ${rung.rung}: ${rung.outcome}${rung.reason === undefined ? "" : `, ${rung.reason}`}\n`);
  process.stdout.write(`held ${verdict.held ?? "none"}, failed ${verdict.failed}: ${verdict.reason}\n`);
  process.exit(verdict.failed ? 1 : 0);
}

// the facts of each run of a drill for the page, from the records and from what the backups wrote
const drills = entries.map((entry) => {
  const { cell } = entry.record;
  const runs = entry.record.runs.map((each, index) => {
    const measured = measureGroup(cell, each);
    const { recovery, writes } = measured.group;
    const dump = (each.group as { readonly drill?: { readonly backups: ReadonlyArray<{ readonly kind: string; readonly size: Quantity }> } }).drill?.backups.find((backup) => backup.kind === "dump");
    return {
      index: index + 1,
      void: measured.void,
      rto: measured.elapsed,
      lost: writes.lost?.length ?? null,
      afterBackup: recovery?.afterBackup ?? null,
      excess: recovery?.excess ?? null,
      holes: recovery?.holes.length ?? null,
      sameData: recovery?.sameData ?? null,
      dump: dump?.size ?? null,
    };
  });
  return { id: cell.name.split(" ")[0]!, name: cell.name, recovery: cell.drill!.recovery, tenants: cell.drill!.tenants, runs };
});

const copy = {
  source: "the raw records of the runners of GitHub, judged again by the harness, and the ladder verdict of rigor-bench",
  workflow: run,
  commit,
  date,
  runner: runnerOf(folders),
  ladder: RECOVERY_LADDER,
  verdict,
  records,
  cells,
  drills,
};
const out = fileURLToPath(new URL(`../src/data/recovery-${date}.json`, import.meta.url));
writeFileSync(out, stringify(copy));
process.stdout.write(`${cells.length} drills, held ${verdict.held ?? "none"}, next ${verdict.next ?? "none"}: ${out}\n`);
