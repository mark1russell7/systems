// The copies of a refresh: which JSON files of src/data an exporter wrote. A copy can overwrite a file
// with the same name, thus the script compares the hash of each file, not only its name.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
