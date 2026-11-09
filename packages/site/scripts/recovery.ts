// The export of the recovery drills for the site: src/data/recovery-<date>.json.
//
//   pnpm exec tsx packages/site/scripts/recovery.ts [--check | --flip] --run <id> --commit <sha> <folder>...
//
// Each folder is the output of one shard of the workflow Cells (SYS-94). The script reads each record
// again with the code of the harness, and it stops when that verdict disagrees with summary.ndjson,
// or when a drill has no record. It gives the record of each rung from the measures of its drills
// (recoveryRecord). The verdict of each rung comes from those records and nothing else.
//
// With --check the script writes no file. It prints each rung, and it exits with 1 when a locked rung
// is not within its budgets. This is the lock of the rungs: the workflow Cells does not fail on a
// failing cell, thus this step fails for it. A record that does not pin the programs of its runs is
// not a record (SYS-101), thus it fails the check too.
//
// --flip is the flip test of the check (SYS-99), on the folder of one shard. A fault of 1.5 x the
// limit of a budget (or 1 above a limit of 0) goes into each measure in turn, and that budget of each
// locked rung must be beyond. The check runs again on the clean folder and on three copies: one with
// a record gone, one with a target by the tag redis:7.4 and no digest, and one with a checkout with
// changes. It exits with 0 only if the clean check passes, each fault turns each rung red, and each
// copy exits with 1.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Quantity } from "@mark1russell7/quantity";
import { measureGroup, recordProblems } from "../../harness/src/index.ts";
import { FAULT_FACTOR } from "../../cells/src/held.ts";
import { RECOVERY_CELLS, RECOVERY_LADDER, RECOVERY_RUNGS, recoveryFlip, recoveryRecord, recoveryVerdict } from "../../cells/src/recovery.ts";
import { byTag, changed, dirty, exitOf, withoutOne } from "./flip.ts";
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
/** This function removes a flag from the arguments, and it tells if the flag was there. */
const flag = (name: string): boolean => {
  const at = args.indexOf(name);
  if (at >= 0) args.splice(at, 1);
  return at >= 0;
};
const check = flag("--check");
const flip = flag("--flip");
const runText = option("--run");
const run = Number(runText);
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

// the problems of the pins of each record, from the raw record and not from summary.ndjson
const unpinned = entries.flatMap((entry) => {
  const problems = recordProblems(entry.record);
  return problems.length === 0 ? [] : [`not a record: ${entry.record.cell.name}: ${problems.join("; ")}`];
});

if (check || flip) {
  for (const rung of verdict.rungs) process.stdout.write(`rung ${rung.rung}: ${rung.outcome}${rung.reason === undefined ? "" : `, ${rung.reason}`}\n`);
  for (const line of unpinned) process.stdout.write(`${line}\n`);
  process.stdout.write(`held ${verdict.held ?? "none"}, failed ${verdict.failed}: ${verdict.reason}\n`);
}
if (check) process.exit(verdict.failed || unpinned.length > 0 ? 1 : 0);

if (flip) {
  // the flip needs one folder for its copies: the Sunday run has one shard
  if (folders.length !== 1) throw new Error("--flip needs the folder of one shard");
  const scratch = mkdtempSync(join(tmpdir(), "recovery-"));
  const again = (given: string): number | null => exitOf(fileURLToPath(import.meta.url), ["--check", "--run", runText, "--commit", commit, given]);
  const results: ReadonlyArray<readonly [string, number | null, number]> = [
    ["the clean copy", again(folders[0]!), 0],
    ["a copy with one record gone", again(withoutOne(folders[0]!, scratch)), 1],
    ["a copy with a target by the tag redis:7.4 and no digest", again(changed(folders[0]!, scratch, "tag", byTag)), 1],
    ["a copy from a checkout with changes", again(changed(folders[0]!, scratch, "dirty", dirty)), 1],
  ];
  rmSync(scratch, { recursive: true, force: true });
  const flips = recoveryFlip(records, at);
  for (const [what, exit, wanted] of results) process.stdout.write(`${what}: exit ${exit}, wanted ${wanted}\n`);
  for (const each of flips)
    process.stdout.write(`a fault of ${FAULT_FACTOR} x the limit of "${each.measure}": ${each.stayed.length === 0 ? "each rung is beyond" : `the fault left these rungs green: ${each.stayed.join(", ")}`}\n`);
  process.exit(results.every(([, exit, wanted]) => exit === wanted) && flips.every((each) => each.stayed.length === 0) ? 0 : 1);
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
