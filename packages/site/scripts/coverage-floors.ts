// The floors of the coverage (SYS-109), from 5 CI runs on main or more.
//
//   pnpm exec tsx packages/site/scripts/coverage-floors.ts <run id>...
//
// For each run, the script reads its commit (gh run view --json), and it downloads the artifact `coverage` of the run
// to a temporary folder (gh run download). It reads packages/<name>/coverage/coverage-summary.json of each package.
// Then it writes coverage-floors.json at the root of the repository (src/lib/coverage.ts). A run on a branch that is
// not main, a run that did not succeed, or a run with no artifact `coverage` stops the script.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoverageRun, Shares } from "../src/lib/coverage.ts";
import { floorsOf, sharesOf } from "../src/lib/coverage.ts";

const REPO = "mark1russell7/systems";

const gh = (args: readonly string[]): string => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });

/** This function reads one run: its commit, and the coverage of each package from its artifact. */
const runOf = (id: string): CoverageRun => {
  const view = JSON.parse(gh(["run", "view", id, "-R", REPO, "--json", "headSha,headBranch,conclusion,event"])) as {
    headSha: string;
    headBranch: string;
    conclusion: string;
    event: string;
  };
  if (view.headBranch !== "main") throw new Error(`The run ${id} is on ${view.headBranch}, not main.`);
  if (view.conclusion !== "success") throw new Error(`The run ${id} gave ${view.conclusion}, not success.`);
  const folder = mkdtempSync(join(tmpdir(), `coverage-${id}-`));
  try {
    gh(["run", "download", id, "-R", REPO, "-n", "coverage", "-D", folder]);
    const root = join(folder, "packages");
    if (!existsSync(root)) throw new Error(`The artifact coverage of the run ${id} has no folder packages.`);
    const packages: Record<string, Shares> = {};
    for (const name of readdirSync(root).sort()) {
      const file = join(root, name, "coverage", "coverage-summary.json");
      if (existsSync(file)) packages[name] = sharesOf(JSON.parse(readFileSync(file, "utf8")));
    }
    return { id, commit: view.headSha, packages };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};

const ids = process.argv.slice(2);
const file = floorsOf(ids.map(runOf));
const out = fileURLToPath(new URL("../../../coverage-floors.json", import.meta.url));
writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
console.log(`${out}: the floors of ${Object.keys(file.floors).length} packages, from ${file.runs.length} runs.`);
