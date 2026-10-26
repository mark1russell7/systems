// The export of the scores of S6 for the site: src/data/s6-<date>.json, from the copies of the kind
// runs of the S2 cells, one copy for each incident.
//
//   pnpm exec tsx packages/site/scripts/scores.ts <run id> <copy of S2> [<run id> <copy of S2>]...
//
// Each run id is the CI run of the copy after it, for example 40358038728. A copy is the output of
// kind.ts, for example packages/site/src/data/s2-2026-10-26.json. The script gives the copies to
// `scoreCallers` of the cells. It writes the scorecard beside them with the latest date of a copy.
// The scorecard has only the copies and the catalog in it, thus it names no machine.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CallerResult, CallerRun } from "../../cells/src/scores.ts";
import { scoreCallers } from "../../cells/src/scores.ts";
import { stringify } from "./records.ts";

const args = process.argv.slice(2);
if (args.length === 0 || args.length % 2 !== 0 || args.some((arg, at) => at % 2 === 0 && !/^\d+$/.test(arg))) {
  process.stderr.write("usage: pnpm exec tsx packages/site/scripts/scores.ts <run id> <copy of S2> [<run id> <copy of S2>]...\n");
  process.exit(2);
}

const copies = Array.from({ length: args.length / 2 }, (_, at) => {
  const copy = JSON.parse(readFileSync(args[2 * at + 1]!, "utf8")) as { readonly ranAt: string; readonly cells: readonly CallerResult[] };
  return { ranAt: copy.ranAt, run: { run: Number(args[2 * at]), cells: copy.cells } satisfies CallerRun };
});
const card = scoreCallers(...copies.map((copy) => copy.run));
const ranAt = copies.map((copy) => copy.ranAt).sort().at(-1)!;
const out = fileURLToPath(new URL(`../src/data/s6-${ranAt}.json`, import.meta.url));
writeFileSync(out, stringify({ ranAt, ...card }));
process.stdout.write(`${card.incidents.length} incidents, runs ${card.runs.join(", ")}: ${out}\n`);
