import { createHash } from "node:crypto";

/**
 * This module reads the lockfiles of a build context for the manifest of a run. A lockfile pins each
 * package that a build installs, thus its sha256 pins the packages that the image holds. The
 * versions of the packages that each manifest names directly are the part that a person reads.
 */

/** A context file is a file of a build context: its path in the context, and its content. */
export interface ContextFile {
  readonly at: string;
  readonly content: Buffer | string;
}

/**
 * These are the names of the lockfiles that the harness records. A `go.mod` is the lockfile of a Go
 * module, because its `require` lines give exact versions. For them, Go selects the same packages
 * each time, and its checksum database examines each package.
 */
export const LOCK_NAMES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "jars.sha256",
]);

const nameOf = (at: string): string => at.split("/").at(-1)!;
const folderOf = (at: string): string => at.split("/").slice(0, -1).join("/");
const textOf = (content: Buffer | string): string => (typeof content === "string" ? content : content.toString("utf8"));

/** This function gives each lockfile of a context by its path, with the sha256 of its content in hex. */
export const locksOf = (files: readonly ContextFile[]): Record<string, string> =>
  Object.fromEntries(
    files
      .filter((file) => LOCK_NAMES.has(nameOf(file.at)))
      .map((file) => [file.at, createHash("sha256").update(file.content).digest("hex")] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

/** This function gives the version of each direct dependency of an npm lockfile (lockfileVersion 2 or 3). */
export const npmVersions = (lock: string): Record<string, string> => {
  const parsed = JSON.parse(lock) as { packages?: Record<string, { version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }> };
  const packages = parsed.packages ?? {};
  const root = packages[""] ?? {};
  const names = [...Object.keys(root.dependencies ?? {}), ...Object.keys(root.optionalDependencies ?? {})];
  const found: Record<string, string> = {};
  for (const name of names) {
    const version = packages[`node_modules/${name}`]?.version;
    if (version !== undefined) found[name] = version;
  }
  return found;
};

/** This function gives the packages of a Cargo.lock: the name, the version and the dependencies of each. */
const cargoPackages = (lock: string): Array<{ name: string; version: string; dependencies: string[] }> =>
  lock
    .split(/^\[\[package\]\]\s*$/m)
    .slice(1)
    .flatMap((block) => {
      const name = /^name = "([^"]+)"$/m.exec(block)?.[1];
      const version = /^version = "([^"]+)"$/m.exec(block)?.[1];
      if (name === undefined || version === undefined) return [];
      const list = /^dependencies = \[([^\]]*)\]/m.exec(block)?.[1] ?? "";
      const dependencies = [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
      return [{ name, version, dependencies }];
    });

/**
 * This function gives the version of each direct dependency of the root package of a Cargo.lock: the
 * package that the Cargo.toml beside it names. An entry of a dependency list is a name, or a name
 * and a version when the lock holds two versions of that name.
 */
export const cargoVersions = (lock: string, manifest: string): Record<string, string> => {
  const rootName = /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms.exec(manifest)?.[1];
  const packages = cargoPackages(lock);
  const root = packages.find((each) => each.name === rootName);
  if (root === undefined) return {};
  const found: Record<string, string> = {};
  for (const entry of root.dependencies) {
    const [name, version] = entry.split(" ");
    const pinned = version ?? packages.find((each) => each.name === name)?.version;
    if (name !== undefined && pinned !== undefined) found[name] = pinned;
  }
  return found;
};

/** This function gives the version of each direct requirement of a go.mod. A requirement that is `// indirect` is not direct. */
export const goVersions = (mod: string): Record<string, string> => {
  const found: Record<string, string> = {};
  const lines = mod.replace(/^require\s*\(([^)]*)\)/gm, (_all, block: string) =>
    block
      .split(/\r?\n/)
      .map((line) => `require ${line.trim()}`)
      .join("\n"),
  );
  for (const line of lines.split(/\r?\n/)) {
    const match = /^require\s+(\S+)\s+(v\S+)(.*)$/.exec(line.trim());
    if (match === null || /\/\/\s*indirect/.test(match[3]!)) continue;
    found[match[1]!] = match[2]!;
  }
  return found;
};

/** This function gives the version of each jar of a list of jars by their SHA-256: `<hex>  HikariCP-7.1.0.jar` gives HikariCP 7.1.0. */
export const jarVersions = (list: string): Record<string, string> => {
  const found: Record<string, string> = {};
  for (const line of list.split(/\r?\n/)) {
    const match = /^[0-9a-f]{64}\s+\*?(.+?)-(\d[^-]*(?:-[A-Za-z0-9.]+)?)\.jar$/.exec(line.trim());
    if (match !== null) found[match[1]!] = match[2]!;
  }
  return found;
};

/**
 * This function gives the version of each package that the manifests of a context name directly,
 * by its name. It reads each npm lockfile, Cargo.lock, go.mod and list of jars. A package of a
 * workspace in the context is a package of the image too, with the version of its package.json.
 * Such a package has a name and a version, and it is not private. The record has the sha256 of
 * the lockfile of a pnpm, yarn or bun workspace (`locksOf`). This function does not read versions
 * from such a lockfile.
 */
export const versionsOf = (files: readonly ContextFile[]): Record<string, string> => {
  const byPath = new Map(files.map((file) => [file.at, textOf(file.content)] as const));
  const found: Record<string, string> = {};
  for (const [at, text] of [...byPath].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const name = nameOf(at);
    const folder = folderOf(at);
    const beside = (other: string): string | undefined => byPath.get(folder === "" ? other : `${folder}/${other}`);
    if (name === "package-lock.json" || name === "npm-lock.json" || name === "npm-shrinkwrap.json") Object.assign(found, npmVersions(text));
    else if (name === "Cargo.lock") Object.assign(found, cargoVersions(text, beside("Cargo.toml") ?? ""));
    else if (name === "go.mod") Object.assign(found, goVersions(text));
    else if (name === "jars.sha256") Object.assign(found, jarVersions(text));
    else if (name === "package.json") {
      const manifest = JSON.parse(text) as { name?: string; version?: string; private?: boolean };
      if (manifest.private !== true && manifest.name !== undefined && manifest.version !== undefined) found[manifest.name] = manifest.version;
    }
  }
  return found;
};
