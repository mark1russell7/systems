// The step "The needs of the shard" of the workflow Cells: it writes containerlab=true or false to
// GITHUB_OUTPUT (needs.ts).
//
//   pnpm exec tsx packages/cells/src/needs-cli.ts

import { appendFileSync, readFileSync } from "node:fs";
import { needsOf } from "./needs.ts";

const needs = needsOf(process.env, (path) => readFileSync(path, "utf8"));
const output = process.env["GITHUB_OUTPUT"];
if (output !== undefined) appendFileSync(output, `containerlab=${needs.containerlab}\n`);
process.stdout.write(`containerlab: ${needs.containerlab} (${needs.cells.length} cells on a fabric)\n`);
