import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { npmDrift } from "@mark1russell7/harness";
import { describe, expect, it } from "vitest";

/** the folder `packages` of the workspace */
const PACKAGES = fileURLToPath(new URL("../..", import.meta.url));
/** These folders hold no context of an image: installed packages and built files. */
const SKIPPED = new Set(["node_modules", "build", "dist", "coverage", ".turbo"]);
/** These are the npm lockfiles of a folder, in the order of npm. */
const NPM_LOCKS = ["npm-shrinkwrap.json", "package-lock.json", "npm-lock.json"];

/** This function gives each folder under `root` with a package.json and an npm lockfile, with that lockfile. */
const lockedFolders = (root: string): Array<{ folder: string; lock: string }> => {
  const found: Array<{ folder: string; lock: string }> = [];
  const visit = (folder: string): void => {
    const entries = readdirSync(folder, { withFileTypes: true });
    const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    const lock = NPM_LOCKS.find((name) => names.has(name));
    if (names.has("package.json") && lock !== undefined) found.push({ folder, lock });
    for (const entry of entries) if (entry.isDirectory() && !SKIPPED.has(entry.name)) visit(join(folder, entry.name));
  };
  visit(root);
  return found;
};

describe("the npm lockfiles of the images and targets of the repository", () => {
  const folders = lockedFolders(PACKAGES);

  it("finds the lockfile of each image and target that the cells build", () => {
    const at = folders.map(({ folder, lock }) => relative(PACKAGES, join(folder, lock)).replaceAll("\\", "/"));
    expect(at).toEqual(expect.arrayContaining(["harness/image/node/npm-lock.json", "kind/image/npm-lock.json", "reference/image/npm-lock.json"]));
    expect(at.length).toBeGreaterThanOrEqual(12);
  });

  // Renovate updates a package.json, but not a lock with the name npm-lock.json. Thus a folder that renovate.json
  // does not ignore drifts, and npm ci refuses the build in the cells job (SYS-93, dispatch 44223098381).
  it("has a lock that satisfies each package.json beside it, thus npm ci accepts each build", () => {
    const drifts = folders.flatMap(({ folder, lock }) =>
      npmDrift(readFileSync(join(folder, "package.json"), "utf8"), readFileSync(join(folder, lock), "utf8")).map(
        (line) => `${relative(PACKAGES, folder).replaceAll("\\", "/")}: ${line}`,
      ),
    );
    expect(drifts).toEqual([]);
  });
});
