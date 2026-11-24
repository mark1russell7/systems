// The copy of one study from the records of the workflow Cells: a new src/data/<name>-<date>.json.
//
//   pnpm exec tsx packages/site/scripts/copy.ts <exporter> <out folder> <run id>...
//
// The workflow Copy starts this script, thus the shared machine does not download the records or hold them
// in memory. The script downloads the artifacts cells-* of each run with the GitHub CLI, in the sequence of
// the run ids. A later run replaces the record of the same cell, as a re-run does. Then it starts the
// exporter on all the folders, and it copies each file of src/data that is new or changed to the out folder.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportCopies } from "./copies.ts";

const [exporter, out, ...runs] = process.argv.slice(2);
if (exporter === undefined || out === undefined || runs.length === 0) {
  process.stderr.write("usage: pnpm exec tsx packages/site/scripts/copy.ts <exporter> <out folder> <run id>...\n");
  process.exit(2);
}
const strange = runs.filter((run) => !/^\d+$/.test(run));
if (strange.length > 0) throw new Error(`${strange.join(", ")}: a run id is a number`);

const repository = process.env["GITHUB_REPOSITORY"] ?? "metrograph-labs/systems";
const records = mkdtempSync(join(tmpdir(), "copy-"));
const folders = runs.flatMap((run, at) => {
  // the number before the id keeps the sequence of the runs in the names of the folders
  const into = join(records, `${String(at).padStart(3, "0")}-${run}`);
  execFileSync("gh", ["run", "download", run, "--repo", repository, "--pattern", "cells-*", "--dir", into], { stdio: "inherit" });
  const shards = readdirSync(into).filter((name) => name.startsWith("cells-")).sort();
  if (shards.length === 0) throw new Error(`the run ${run} has no artifact cells-*`);
  return shards.map((shard) => join(into, shard));
});

const { copies, failed } = exportCopies([exporter], out, folders);
process.stdout.write(`${exporter}: ${copies.length} new or changed copies (${copies.join(", ")})\n`);
if (failed.length > 0 || copies.length === 0) {
  process.stderr.write(`no new copy: the exporter ${exporter} ${failed.length > 0 ? "stopped" : "wrote no new file"}\n`);
  process.exit(1);
}
