// Packs each published package of this repository into one folder, for a release.
//
//   node scripts/pack.mjs <folder>
//
// A published package is a package whose name starts with @mark1russell7/ and that is not private.
// pnpm packs each one: it applies publishConfig, and it replaces each workspace: range with a real
// range. The script writes <folder>/packages.txt with one line for each tarball, "name version file",
// a package after the packages of this repository that it depends on. Build the packages first.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const out = process.argv[2];
if (out === undefined) {
  process.stderr.write("usage: node scripts/pack.mjs <folder>\n");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const root = join(import.meta.dirname, "..");
const packages = readdirSync(join(root, "packages"))
  .map((name) => join(root, "packages", name))
  .filter((dir) => existsSync(join(dir, "package.json")))
  .map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) }))
  .filter(({ manifest }) => !manifest.private && manifest.name?.startsWith("@mark1russell7/"));

// a package after the packages of this repository that it depends on
const names = new Set(packages.map(({ manifest }) => manifest.name));
const ordered = [];
const visit = (entry, path = []) => {
  if (ordered.includes(entry)) return;
  if (path.includes(entry)) throw new Error(`a dependency cycle at ${entry.manifest.name}`);
  for (const dependency of Object.keys(entry.manifest.dependencies ?? {})) {
    if (names.has(dependency))
      visit(packages.find(({ manifest }) => manifest.name === dependency), [...path, entry]);
  }
  ordered.push(entry);
};
packages.forEach((entry) => visit(entry));

const shell = process.platform === "win32";
const lines = [];
for (const { dir, manifest } of ordered) {
  const packed = execFileSync("pnpm", ["pack", "--json", "--pack-destination", resolve(out)], {
    cwd: dir,
    encoding: "utf8",
    shell,
  });
  const file = basename(JSON.parse(packed).filename);
  lines.push(`${manifest.name} ${manifest.version} ${file}`);
  process.stdout.write(`${manifest.name}@${manifest.version}: ${file}\n`);
}
writeFileSync(join(out, "packages.txt"), `${lines.join("\n")}\n`);
