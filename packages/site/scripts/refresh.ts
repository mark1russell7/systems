// The copies of one round of the refresh of the studies (SYS-101): a new src/data/<name>-<date>.json for each study.
//
//   pnpm exec tsx packages/site/scripts/refresh.ts refresh-<round> <out folder> <folder>...
//
// Each folder is the output of one shard of the round in the workflow Cells. The script starts the exporter of each
// study of the round on all the folders, and each exporter takes the records of its own catalog. Then it copies each
// new file of src/data to the out folder. A failing cell is a finding, thus the copy shows it. An exporter stops
// only when it cannot read a record again. Then the script starts the next exporter, and it exits with 1 at the end.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REFRESHES } from "../../cells/src/refresh.ts";

const [selection, out, ...folders] = process.argv.slice(2);
const round = /^refresh-(\d+)$/.exec(selection ?? "")?.[1];
if (round === undefined || out === undefined || folders.length === 0) {
  process.stderr.write("usage: pnpm exec tsx packages/site/scripts/refresh.ts refresh-<round> <out folder> <folder>...\n");
  process.exit(2);
}

const DATA = fileURLToPath(new URL("../src/data/", import.meta.url));
const studies = REFRESHES.filter((each) => each.round === Number(round));
if (studies.length === 0) throw new Error(`the round ${round} has no study`);

const before = new Set(readdirSync(DATA));
const failed: string[] = [];
for (const study of studies) {
  const script = fileURLToPath(new URL(`./${study.exporter}.ts`, import.meta.url));
  try {
    execFileSync(process.execPath, ["--import", "tsx", script, ...folders], { stdio: "inherit" });
  } catch {
    failed.push(study.page);
  }
}

mkdirSync(out, { recursive: true });
const copies = readdirSync(DATA).filter((name) => name.endsWith(".json") && !before.has(name));
for (const name of copies) copyFileSync(join(DATA, name), join(out, name));
process.stdout.write(`round ${round}: ${copies.length} new copies (${copies.join(", ")})\n`);
if (failed.length > 0) {
  process.stderr.write(`no new copy for ${failed.join(", ")}: its exporter stopped\n`);
  process.exit(1);
}
