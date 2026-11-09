// The move of the pages to the copies of one round of the refresh (SYS-101).
//
//   gh run download <run> -R mark1russell7/systems -n refresh -D <copies folder>
//   pnpm exec tsx packages/site/scripts/adopt.ts <copies folder> [<report file>]
//
// The job export of the workflow Cells uploads the copies of a round as the artifact refresh. A token of a workflow
// cannot open a pull request that starts the checks, thus a session downloads the artifact and starts this script. It
// moves each page of a study to its new copy and gives the report for the body of the pull request. The report lists
// each line of a page that still names the day of the old file, because its text can be false for the new copy.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REFRESHES } from "../../cells/src/refresh.ts";
import { moveCopies, pagesOf, reportOf } from "./moves.ts";

const [copies, report] = process.argv.slice(2);
if (copies === undefined) {
  process.stderr.write("usage: pnpm exec tsx packages/site/scripts/adopt.ts <copies folder> [<report file>]\n");
  process.exit(2);
}

const SITE = fileURLToPath(new URL("..", import.meta.url));
const moves = moveCopies(SITE, copies, pagesOf(REFRESHES));
const text = reportOf(moves);
if (report === undefined) process.stdout.write(text);
else writeFileSync(report, text);
process.stdout.write(`${moves.length} copies, ${moves.filter((move) => move.from !== undefined).length} pages moved\n`);
