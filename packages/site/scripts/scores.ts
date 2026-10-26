// The export of the scores of S6 for the site: src/data/s6-<date>.json, from the copy of a kind run
// of the S2 cells.
//
//   pnpm exec tsx packages/site/scripts/scores.ts <run id> <copy of S2>
//
// The run id is the CI run of the copy, for example 40358038728. The copy is the output of kind.ts,
// for example packages/site/src/data/s2-2026-10-26.json. The script gives the copy to `scoreCallers`
// of the cells, and it writes the scorecard beside the copy with the date of the copy. The scorecard
// has only the copy and the catalog in it, thus it names no machine.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CallerResult } from "../../cells/src/scores.ts";
import { scoreCallers } from "../../cells/src/scores.ts";
import { stringify } from "./records.ts";

const [id, from] = process.argv.slice(2);
if (id === undefined || from === undefined || !/^\d+$/.test(id)) {
  process.stderr.write("usage: pnpm exec tsx packages/site/scripts/scores.ts <run id> <copy of S2>\n");
  process.exit(2);
}

const copy = JSON.parse(readFileSync(from, "utf8")) as { readonly ranAt: string; readonly cells: readonly CallerResult[] };
const card = scoreCallers({ run: Number(id), cells: copy.cells });
const out = fileURLToPath(new URL(`../src/data/s6-${copy.ranAt}.json`, import.meta.url));
writeFileSync(out, stringify({ ranAt: copy.ranAt, ...card }));
process.stdout.write(`${card.incidents.length} incidents, run ${card.run}: ${out}\n`);
