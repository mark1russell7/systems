// The copies of a flip test (SYS-99). A check of the scheduled cells must fail on a bad folder, thus
// its flip runs the check again on copies of one folder, each with one defect.

import { spawnSync } from "node:child_process";
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CellRecord, Summary } from "./judged.ts";

/** This function starts a script with its arguments in this process of Node.js, and it gives its exit code. */
export const exitOf = (script: string, args: readonly string[]): number | null =>
  spawnSync(process.execPath, [...process.execArgv, script, ...args], { stdio: "ignore" }).status;

/** This function copies a folder into a new folder of a name, and it gives the copy and the file of its first record. */
const copyOf = (folder: string, into: string, name: string): { readonly copy: string; readonly file: string } => {
  const copy = join(into, name);
  cpSync(folder, copy, { recursive: true });
  const file = readdirSync(copy).filter((each) => each.endsWith(".json")).sort()[0];
  if (file === undefined) throw new Error(`${folder} has no record`);
  return { copy, file: join(copy, file) };
};

/** A raw record of any workflow: the name of its cell, and the pin of its checkout. */
export interface Named {
  readonly cell: { readonly name: string };
  readonly code?: { readonly commit: string; readonly dirty: boolean } | undefined;
}

/** This function copies a folder without its first record and the line of that record, and it gives the copy. */
export const withoutOne = (folder: string, into: string): string => {
  const { copy, file } = copyOf(folder, into, "gone");
  const { cell } = JSON.parse(readFileSync(file, "utf8")) as Named;
  rmSync(file);
  const kept = readFileSync(join(copy, "summary.ndjson"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && (JSON.parse(line) as Pick<Summary, "name">).name !== cell.name);
  writeFileSync(join(copy, "summary.ndjson"), `${kept.join("\n")}\n`);
  return copy;
};

/** This function copies a folder with a change to its first record, and it gives the copy. */
export const changed = <R extends Named = CellRecord>(folder: string, into: string, name: string, change: (record: R) => R): string => {
  const { copy, file } = copyOf(folder, into, name);
  writeFileSync(file, JSON.stringify(change(JSON.parse(readFileSync(file, "utf8")) as R)));
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
export const dirty = <R extends Named>(record: R): R => ({ ...record, code: { commit: record.code?.commit ?? "0".repeat(40), dirty: true } });
