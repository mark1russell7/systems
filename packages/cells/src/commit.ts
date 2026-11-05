import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * This module gives the commit of the code that operates the cells. It is the commit of the
 * checkout of this repository, which holds the harness, the catalogs and the runner. It is not the
 * commit of a repository that calls the runner, thus it does not come from GITHUB_SHA. A checkout
 * with a change to a tracked file is not a commit, and the record says so (`dirty`).
 */

/** The code of a record is the commit of the checkout that operated, and if its tracked files had changes. */
export interface Code {
  readonly commit: string;
  readonly dirty: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));
const git = (args: readonly string[]): string => execFileSync("git", [...args], { cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** This function gives the code of the checkout of this file, or undefined outside a checkout of git. */
export const codeHere = (): Code | undefined => {
  try {
    const commit = git(["rev-parse", "HEAD"]);
    const changes = git(["status", "--porcelain", "--untracked-files=no"]);
    return { commit, dirty: changes !== "" };
  } catch {
    return undefined;
  }
};
