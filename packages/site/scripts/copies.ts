// The copies of a refresh: which JSON files of src/data an exporter wrote. A copy can overwrite a file
// with the same name, thus the script compares the hash of each file, not only its name.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** This function gives the sha256 of each JSON file of a folder, by its name. */
export const snapshot = (folder: string): ReadonlyMap<string, string> =>
  new Map(
    readdirSync(folder)
      .filter((name) => name.endsWith(".json"))
      .map((name) => [name, createHash("sha256").update(readFileSync(join(folder, name))).digest("hex")] as const),
  );

/** This function gives the names of the files that are new, or whose bytes changed, after the exporters. */
export const changedFiles = (before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] =>
  [...after].filter(([name, hash]) => before.get(name) !== hash).map(([name]) => name);

/** The folder of the copies of the site. */
const DATA = fileURLToPath(new URL("../src/data/", import.meta.url));

/** This form is the name of an exporter: a script of this folder. */
const EXPORTER = /^[a-z][a-z0-9-]*$/;

/**
 * This function starts each exporter on all the folders, and it copies each file of src/data that is new or
 * changed to the out folder. An exporter that stops does not stop the next one. The function gives the
 * names of the copies and the exporters that stopped.
 */
export const exportCopies = (
  exporters: readonly string[],
  out: string,
  folders: readonly string[],
): { readonly copies: readonly string[]; readonly failed: readonly string[] } => {
  const before = snapshot(DATA);
  const failed: string[] = [];
  for (const exporter of exporters) {
    if (!EXPORTER.test(exporter)) throw new Error(`${JSON.stringify(exporter)} is not the name of an exporter`);
    const script = fileURLToPath(new URL(`./${exporter}.ts`, import.meta.url));
    try {
      execFileSync(process.execPath, ["--import", "tsx", script, ...folders], { stdio: "inherit" });
    } catch {
      failed.push(exporter);
    }
  }
  mkdirSync(out, { recursive: true });
  // a copy of a second round on one day overwrites the file of the first, thus a changed hash counts too
  const copies = changedFiles(before, snapshot(DATA));
  for (const name of copies) copyFileSync(join(DATA, name), join(out, name));
  return { copies, failed };
};
