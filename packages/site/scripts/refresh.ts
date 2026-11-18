// The copies of one round of the refresh of the studies (SYS-101): a new src/data/<name>-<date>.json for each study.
//
//   pnpm exec tsx packages/site/scripts/refresh.ts refresh-<round> <out folder> <folder>...
//
// Each folder is the output of one shard of the round in the workflow Cells. The script starts the exporter of each
// study of the round on all the folders, and each exporter takes the records of its own catalog. Then it copies each
// file of src/data that is new or changed to the out folder. A failing cell is a finding, thus the copy shows it. An exporter stops
// only when it cannot read a record again. Then the script starts the next exporter, and it exits with 1 at the end.

import { REFRESHES } from "../../cells/src/refresh.ts";
import { exportCopies } from "./copies.ts";

const [selection, out, ...folders] = process.argv.slice(2);
const round = /^refresh-(\d+)$/.exec(selection ?? "")?.[1];
if (round === undefined || out === undefined || folders.length === 0) {
  process.stderr.write("usage: pnpm exec tsx packages/site/scripts/refresh.ts refresh-<round> <out folder> <folder>...\n");
  process.exit(2);
}

const studies = REFRESHES.filter((each) => each.round === Number(round));
if (studies.length === 0) throw new Error(`the round ${round} has no study`);

const { copies, failed } = exportCopies(
  studies.map((study) => study.exporter),
  out,
  folders,
);
process.stdout.write(`round ${round}: ${copies.length} new or changed copies (${copies.join(", ")})\n`);
if (failed.length > 0) {
  const pages = studies.filter((study) => failed.includes(study.exporter)).map((study) => study.page);
  process.stderr.write(`no new copy for ${pages.join(", ")}: its exporter stopped\n`);
  process.exit(1);
}
