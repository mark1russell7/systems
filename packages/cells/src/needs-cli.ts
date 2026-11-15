// The step "The needs of the shard" of the workflow Cells: it writes containerlab=true or false, and
// disk=<bytes>, to GITHUB_OUTPUT (needs.ts).
//
//   pnpm exec tsx packages/cells/src/needs-cli.ts

import { appendFileSync, readFileSync } from "node:fs";
import { valueIn } from "@mark1russell7/quantity";
import { needsOf } from "./needs.ts";

const needs = needsOf(process.env, (path) => readFileSync(path, "utf8"));
const disk = valueIn(needs.disk, "B");
const output = process.env["GITHUB_OUTPUT"];
if (output !== undefined) appendFileSync(output, `containerlab=${needs.containerlab}\ndisk=${disk}\n`);
process.stdout.write(`containerlab: ${needs.containerlab} (${needs.cells.length} cells on a fabric)\n`);
process.stdout.write(`disk of the drills: ${disk} B at most\n`);
