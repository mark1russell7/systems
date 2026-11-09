// The copies of a flip test (SYS-99). A check of the scheduled cells must fail on a bad folder, thus
// its flip runs the check again on copies of one folder, each with one defect.

import { spawnSync } from "node:child_process";
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CellRecord, Summary } from "./judged.ts";

/** The read of a start of a script: its exit code and its output. */
export interface Read {
  readonly status: number | null;
  readonly output: string;
}

/** This function starts a script with its arguments in this process of Node.js, and it gives its exit code and its output. */
export const readOf = (script: string, args: readonly string[]): Read => {
  const done = spawnSync(process.execPath, [...process.execArgv, script, ...args], { encoding: "utf8" });
  return { status: done.status, output: `${done.stdout ?? ""}${done.stderr ?? ""}` };
};

/**
 * This function tells if a read of a flip is right. With no cause, the read must exit with 0. With a
 * cause, it must exit with 1 and name the cause in its output. A crash also exits with 1, and it names
 * no cause, thus a crash does not pass as red.
 */
export const rightFor = (read: Read, cause: string | null): boolean =>
  cause === null ? read.status === 0 : read.status === 1 && read.output.includes(cause);

/** This function copies a folder into a new folder of a name, and it gives the copy and the file of its first record. */
const copyOf = (folder: string, into: string, name: string): { readonly copy: string; readonly file: string } => {
  const copy = join(into, name);
  cpSync(folder, copy, { recursive: true });
  const file = readdirSync(copy).filter((each) => each.endsWith(".json")).sort()[0];
  if (file === undefined) throw new Error(`${folder} has no record`);
  return { copy, file: join(copy, file) };
};

/** This function copies a folder without its first record and the line of that record, and it gives the copy. */
export const withoutOne = (folder: string, into: string): string => {
  const { copy, file } = copyOf(folder, into, "gone");
  const { cell } = JSON.parse(readFileSync(file, "utf8")) as CellRecord;
  rmSync(file);
  const kept = readFileSync(join(copy, "summary.ndjson"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && (JSON.parse(line) as Summary).name !== cell.name);
  writeFileSync(join(copy, "summary.ndjson"), `${kept.join("\n")}\n`);
  return copy;
};

/** This function copies a folder with a change to its first record, and it gives the copy. */
export const changed = (folder: string, into: string, name: string, change: (record: CellRecord) => CellRecord): string => {
  const { copy, file } = copyOf(folder, into, name);
  writeFileSync(file, JSON.stringify(change(JSON.parse(readFileSync(file, "utf8")) as CellRecord)));
  return copy;
};

/** This change gives the target of each manifest the tag redis:7.4, with no digest and no build record. */
export const byTag = (record: CellRecord): CellRecord => ({
  ...record,
  manifests: record.manifests.map((manifest) => {
    const { build: _build, ...target } = manifest.target;
    return { ...manifest, target: { ...target, image: "redis:7.4" } };
  }),
});

/** This change marks the checkout of the record as one with changes to tracked files. */
export const dirty = (record: CellRecord): CellRecord => ({ ...record, code: { commit: record.code?.commit ?? "0".repeat(40), dirty: true } });
