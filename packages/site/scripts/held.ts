// The read of the decisions of the scheduled cells (SYS-99).
//
//   pnpm exec tsx packages/site/scripts/held.ts --cells <night | drills> --shard <i/n> [--fault | --flip] <folder>...
//   pnpm exec tsx packages/site/scripts/held.ts --kind <regular expression> --shard <i/n> [--fault | --flip] <folder>...
//
// The name of --cells is a selection of SCHEDULED_CELLS in the cells package. Each folder is the output of one shard of the workflow Cells. The script judges each raw record
// again with the code of the harness, and it stops when that verdict disagrees with summary.ndjson.
// It prints each cell, and it exits with 1 unless each cell of the selection has a record and holds.
//
// --kind reads the output of one shard of the workflow Kind. Its value is the input `only` of that
// workflow. The script judges each raw record again with the cell of the same name in the kind catalog.
// A cell that waits has no record, thus it does not pass.
//
// --fault reads the same records with the injected fault of the cells package or the kind package.
//
// A record that does not pin the programs of its runs is not a record (SYS-101), thus its cell is red.
//
// --flip is the flip test of this check. It runs this script on the clean folders and with --fault.
// It also runs it on three copies: one with a record gone, one with an image by the tag redis:7.4 and
// no digest, and one with a checkout with changes. It exits with 0 only if the clean read passes, each
// cell turns red under the fault, and each other read exits with 1.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Manifest } from "../../harness/src/index.ts";
import { recordProblems } from "../../harness/src/index.ts";
import type { EnvironmentManifest, KindCellRecord, KindCellRecordV1 } from "../../kind/src/record.ts";
import { FORMAT, FORMAT_V1, upgrade } from "../../kind/src/record.ts";
import { shardOf } from "../../kind/src/run.ts";
import { judgeKind } from "../../kind/src/verdict.ts";
import { faultedKind, kindRecordProblems } from "../../kind/src/held.ts";
import { catalogs, SCHEDULED_CELLS, selectedOf } from "../../cells/src/all.ts";
import type { Decided } from "../../cells/src/held.ts";
import { FAULT_FACTOR, faultedVerdict, heldRead, slowdownSeen } from "../../cells/src/held.ts";
import { KIND_CATALOG } from "../../cells/src/kinds.ts";
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
const kindOnly = args.includes("--kind") ? option("--kind") : undefined;
const selection = kindOnly === undefined ? option("--cells") : undefined;
const shardText = option("--shard");
const [shard, of] = shardText.split("/").map(Number) as [number, number];
const folders = args;
if (folders.length === 0) throw new Error("the script needs the folder of each shard");

/** A raw record that the copies of the flip change: a record of the cells or of kind. */
interface Changeable {
  readonly cell: { readonly name: string };
  readonly code?: { readonly commit: string; readonly dirty: boolean } | undefined;
}

/**
 * A source is what the read needs from the records of one workflow:
 * - the expected cells,
 * - the verdict of each record, as judged or under the fault,
 * - the problems of the pins of each record,
 * - the change that gives a record an image by a tag with no digest.
 */
interface Source {
  /** These arguments select the source, for a start of this script on a copy. */
  readonly select: readonly string[];
  readonly expected: readonly string[];
  readonly verdicts: (underFault: boolean) => Map<string, Decided>;
  readonly problems: ReadonlyMap<string, readonly string[]>;
  /** These lines tell of the cells that waited, with the reason of each. */
  readonly notes: readonly string[];
  /** These factors are the slowdowns that turn each timed cell red. */
  readonly seen: readonly number[];
  readonly fault: string;
  readonly byTag: (record: Changeable) => Changeable;
}

/** This function gives the source of the folders of the workflow Cells. */
const cellsSource = (name: string): Source => {
  const only = Object.hasOwn(SCHEDULED_CELLS, name) ? SCHEDULED_CELLS[name] : undefined;
  if (only === undefined) throw new Error(`the script knows no selection ${name}: ${Object.keys(SCHEDULED_CELLS).join(", ")}`);
  const found = readFolders<CellRecord, Summary>(folders);
  const readings = new Map<string, Reading>([...found].map(([cell, entry]) => [cell, read(entry)]));
  return {
    select: ["--cells", name],
    expected: selectedOf(catalogs(), only, shard, of).map((cell) => cell.name),
    verdicts: (underFault) =>
      new Map([...readings].map(([cell, reading]) => [cell, underFault ? faultedVerdict(reading.cell, reading.measured) : reading.verdict])),
    // the problems come from the raw record, not from summary.ndjson
    problems: new Map([...found].map(([cell, entry]) => [cell, recordProblems(entry.record)])),
    notes: [],
    seen: [...readings.values()].flatMap((reading) => {
      const power = slowdownSeen(reading.cell, reading.measured);
      return power === null ? [] : [power];
    }),
    fault: `a fault of ${FAULT_FACTOR} x the top of each band`,
    // the target of each manifest gets the tag, with no digest and no build record
    byTag: (record) => {
      const cells = record as CellRecord;
      return {
        ...cells,
        manifests: cells.manifests.map((manifest: Manifest) => {
          const { build: _build, ...target } = manifest.target;
          return { ...manifest, target: { ...target, image: "redis:7.4" } };
        }),
      } as Changeable;
    },
  };
};

/** A line of summary.ndjson of the workflow Kind: a verdict, or a cell that waited and why. */
interface KindSummary {
  readonly name: string;
  readonly decision: string;
  readonly why?: string;
}

/**
 * This function gives the source of the folders of the workflow Kind. A cell in a later folder
 * replaces the same cell of an earlier folder. It stops when a record has no line in summary.ndjson,
 * or when a line of a verdict has no record. A line of a cell that waited has no record.
 */
const kindSource = (pattern: string): Source => {
  const only = new RegExp(pattern);
  const records = new Map<string, KindCellRecord>();
  const waited = new Map<string, string>();
  for (const folder of folders) {
    const lines = readFileSync(join(folder, "summary.ndjson"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as KindSummary);
    const named = new Set<string>();
    for (const file of readdirSync(folder).filter((each) => each.endsWith(".json")).sort()) {
      const data = JSON.parse(readFileSync(join(folder, file), "utf8")) as KindCellRecord | KindCellRecordV1;
      if (data.format !== FORMAT && data.format !== FORMAT_V1) throw new Error(`${file}: the format ${String((data as { readonly format?: unknown }).format)} is not the format of a kind record`);
      const record = upgrade(data);
      if (!lines.some((line) => line.name === record.cell.name && line.decision !== "waiting")) throw new Error(`${file}: summary.ndjson has no line for ${record.cell.name}`);
      records.set(record.cell.name, record);
      waited.delete(record.cell.name);
      named.add(record.cell.name);
    }
    for (const line of lines) {
      if (line.decision === "waiting") waited.set(line.name, line.why ?? "no reason");
      else if (!named.has(line.name)) throw new Error(`${folder}: summary.ndjson has a line with no record: ${line.name}`);
    }
  }
  const cellOf = (record: KindCellRecord) => KIND_CATALOG.find((each) => each.name === record.cell.name) ?? record.cell;
  return {
    select: ["--kind", pattern],
    expected: shardOf(KIND_CATALOG.filter((cell) => only.test(cell.name)), shard, of).map((cell) => cell.name),
    // each record is judged with the cell of today's catalog, or with its own cell when the catalog has none
    verdicts: (underFault) =>
      new Map(
        [...records].map(([name, record]) => {
          const cell = cellOf(record);
          return [name, judgeKind(cell, underFault ? faultedKind(cell, record.runs) : record.runs)];
        }),
      ),
    problems: new Map([...records].map(([name, record]) => [name, kindRecordProblems(record)])),
    notes: [...waited].map(([name, why]) => `waiting, ${why}: ${name}`),
    seen: [],
    fault: "a fault that fails each request from the fault of each counted run",
    // the image redis of each cluster gets the tag, with no digest and no build record
    byTag: (record) => {
      const kind = record as KindCellRecord;
      return {
        ...kind,
        manifests: kind.manifests.map((manifest: EnvironmentManifest) => {
          const { redis: _redis, ...builds } = manifest.builds ?? {};
          return { ...manifest, images: { ...manifest.images, redis: "redis:7.4" }, ...(manifest.builds === undefined ? {} : { builds }) };
        }),
      } as Changeable;
    },
  };
};

const source = kindOnly === undefined ? cellsSource(selection!) : kindSource(kindOnly);

/** This function starts this script on the folders that it gets, and it gives its exit code. */
const exitOf = (given: readonly string[], ...flags: readonly string[]): number | null => {
  const script = fileURLToPath(import.meta.url);
  const done = spawnSync(process.execPath, [...process.execArgv, script, ...source.select, "--shard", shardText, ...flags, ...given], { stdio: "ignore" });
  return done.status;
};

/** This function copies a folder into a new folder of a name, and it gives the copy and the file of its first record. */
const copyOf = (folder: string, into: string, name: string): { readonly copy: string; readonly file: string } => {
  const copy = join(into, name);
  cpSync(folder, copy, { recursive: true });
  const file = readdirSync(copy).filter((each) => each.endsWith(".json")).sort()[0];
  if (file === undefined) throw new Error(`${folder} has no record`);
  return { copy, file: join(copy, file) };
};

/** This function copies a folder without its first record and the line of that record, and it gives the copy. */
const withoutOne = (folder: string, into: string): string => {
  const { copy, file } = copyOf(folder, into, "gone");
  const { cell } = JSON.parse(readFileSync(file, "utf8")) as Changeable;
  rmSync(file);
  const kept = readFileSync(join(copy, "summary.ndjson"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && (JSON.parse(line) as { readonly name: string }).name !== cell.name);
  writeFileSync(join(copy, "summary.ndjson"), `${kept.join("\n")}\n`);
  return copy;
};

/** This function copies a folder with a change to its first record, and it gives the copy. */
const changed = (folder: string, into: string, name: string, change: (record: Changeable) => Changeable): string => {
  const { copy, file } = copyOf(folder, into, name);
  writeFileSync(file, JSON.stringify(change(JSON.parse(readFileSync(file, "utf8")) as Changeable)));
  return copy;
};

/** This change marks the checkout of the record as one with changes to tracked files. */
const dirty = (record: Changeable): Changeable => ({ ...record, code: { commit: record.code?.commit ?? "0".repeat(40), dirty: true } });

if (flip) {
  // the flip needs one folder for its copy: each shard of the schedule gives one folder
  if (folders.length !== 1) throw new Error("--flip needs the folder of one shard");
  const scratch = mkdtempSync(join(tmpdir(), "held-"));
  const stayed = heldRead(source.expected, source.verdicts(true)).cells.filter((cell) => cell.held);
  const results: ReadonlyArray<readonly [string, number | null, number]> = [
    ["the clean copy", exitOf(folders), 0],
    [source.fault, exitOf(folders, "--fault"), 1],
    ["a copy with one record gone", exitOf([withoutOne(folders[0]!, scratch)]), 1],
    ["a copy with an image by the tag redis:7.4 and no digest", exitOf([changed(folders[0]!, scratch, "tag", source.byTag)]), 1],
    ["a copy from a checkout with changes", exitOf([changed(folders[0]!, scratch, "dirty", dirty)]), 1],
  ];
  rmSync(scratch, { recursive: true, force: true });
  for (const [what, exit, wanted] of results) process.stdout.write(`${what}: exit ${exit}, wanted ${wanted}\n`);
  for (const cell of stayed) process.stdout.write(`the fault left this cell green: ${cell.name}\n`);
  const { seen } = source;
  if (seen.length > 0) process.stdout.write(`a slowdown turns a cell red from ${Math.min(...seen).toFixed(3)} x to ${Math.max(...seen).toFixed(3)} x\n`);
  process.exit(results.every(([, exit, wanted]) => exit === wanted) && stayed.length === 0 ? 0 : 1);
}

const result = heldRead(source.expected, source.verdicts(fault), source.problems);
for (const cell of result.cells) process.stdout.write(`${cell.held || cell.decision !== "holds" ? cell.decision : cell.why}: ${cell.name}\n`);
for (const note of source.notes) process.stdout.write(`${note}\n`);
for (const name of result.missing) process.stdout.write(`no record: ${name}\n`);
for (const name of result.extra) process.stdout.write(`outside the selection: ${name}\n`);
process.stdout.write(`${result.held ? "held" : "not held"}: ${result.reason}\n`);
process.exit(result.held ? 0 : 1);
