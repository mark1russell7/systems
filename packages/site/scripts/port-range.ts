// The export of the port range cells for the site: src/data/port-range-<date>.json.
//
//   pnpm exec tsx packages/site/scripts/port-range.ts <folder>...
//
// The cells of the port range (SYS-64, SYS-102) put one client in a small ip_local_port_range against one
// target. Each folder is the output of one shard of the workflow Cells on a runner of GitHub. It holds the
// raw record of each cell, summary.ndjson and runner.txt. The script reads each record again with the code of
// the harness (`judge`), and it stops when that verdict disagrees with summary.ndjson. It also stops when a
// prediction disagrees with the catalog at the HZ of the runner. A cell with no record keeps its place in
// the copy, with its prediction and no result. The copy keeps no address, container, namespace or path.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { Measured, PortsPrediction, PortsReading } from "../../harness/src/index.ts";
import type { CellRecord, Reading, Summary } from "./judged.ts";
import { read } from "./judged.ts";
import { commitOf, dateOf, ofCatalog, only, readFolders, runnerOf, secondsOf, stringify, voidsOf } from "./records.ts";

const folders = process.argv.slice(2);
if (folders.length === 0) {
  process.stderr.write("usage: pnpm exec tsx packages/site/scripts/port-range.ts <folder>...\n");
  process.exit(2);
}

// the catalog reads the HZ of the kernel when it loads, thus it loads after the HZ of the runner is known
const runner = runnerOf(folders);
process.env["CELLS_HZ"] = String(runner.hz);
const { PORT_RANGE_CELLS, PORT_RANGE_SPECS } = await import("../../cells/src/port-range.ts");
const { ALL } = await import("../../cells/src/all.ts");

// a full run of the catalogs holds the cells of each catalog: this export takes its own
const found = ofCatalog(
  readFolders<CellRecord, Summary>(folders),
  PORT_RANGE_CELLS.map((cell) => cell.name),
  ALL.map((cell) => cell.name),
);
if (found.size === 0) throw new Error("the folders have no record of a cell of the port range");

/** This function gives the prediction of a cell for the page. Each time is in seconds, and a term that the cell does not check is null. */
const predictionOf = (ports: PortsPrediction, why: string) => ({
  counts: ports.counts,
  seen: ports.seen,
  refusedWithin: secondsOf(ports.refusedWithin),
  share: ports.share ?? null,
  lowFirst: ports.lowFirst ?? false,
  freed: ports.freed === undefined ? null : { low: secondsOf(ports.freed.low), high: secondsOf(ports.freed.high) },
  retransmissions: ports.retransmissions ?? null,
  why,
});

/** This function gives what one counted run measured: the count of searches for each count of connects, the ports, and the times. */
const runOf = (run: Measured, prediction: PortsPrediction) => {
  const got: PortsReading | undefined = run.ports;
  if (got === undefined) throw new Error(`env ${run.environment} run ${run.index} has no reading of the ports`);
  const share = prediction.share;
  return {
    environment: run.environment,
    index: run.index,
    searches: got.rounds,
    counts: got.counts,
    seen: got.seen,
    errnos: got.errnos,
    refusal: secondsOf(got.refusal),
    share: share === undefined ? null : Number(((got.counts[String(share.count)] ?? 0) / Math.max(1, got.rounds)).toFixed(4)),
    freed: got.freed,
    firstFreed: secondsOf(got.firstFreed),
    lastFreed: secondsOf(got.lastFreed),
    tries: got.tries,
    retransmissions: run.retransmissions,
    finding: run.finding,
  };
};

/** This function gives the result of a cell with a record: its verdict, the findings of the runs outside the law, and each counted run. */
const resultOf = (reading: Reading, prediction: PortsPrediction, first: string | null) => {
  const { verdict, measured } = reading;
  const off = new Set(verdict.outside.map((each) => each.run)).size;
  return {
    decision: verdict.decision,
    counted: verdict.counted,
    voided: verdict.voided,
    why:
      verdict.counted === 0
        ? "No run counted."
        : off === 0
          ? `Each of the ${verdict.counted} counted runs holds each term of the law.`
          : `${off} of the ${verdict.counted} counted runs disagree with the law.`,
    findings: verdict.outside,
    runs: measured.filter((run) => run.void === null).map((run) => runOf(run, prediction)),
    voids: voidsOf(measured.flatMap((run) => (run.void === null ? [] : [run.void]))),
    first,
  };
};

const cells = PORT_RANGE_SPECS.map((spec, at) => {
  const catalog = PORT_RANGE_CELLS[at];
  if (catalog === undefined || catalog.name !== `${spec.plan} ${spec.name}`) throw new Error(`${spec.plan}: the specs and the cells disagree on the sequence`);
  const ports = catalog.prediction.ports;
  if (ports === undefined) throw new Error(`${catalog.name} has no prediction of the port range`);
  const entry = found.get(catalog.name);
  if (entry !== undefined && !isDeepStrictEqual(entry.record.cell.prediction, catalog.prediction))
    throw new Error(`${catalog.name}: the prediction of the record is not the prediction of the catalog at HZ ${runner.hz}`);
  return {
    plan: spec.plan,
    name: spec.name,
    settings: {
      size: spec.size,
      close: spec.close,
      rounds: spec.rounds,
      destinations: spec.destinations,
      reuse: spec.reuse,
      fault: spec.fault ?? null,
      window: spec.window,
    },
    prediction: predictionOf(ports, spec.why),
    result: entry === undefined ? null : resultOf(read(entry), ports, entry.first),
  };
});

const records = [...found.values()].map((entry) => entry.record);
const date = dateOf(records.map((record) => record.at.ended));
const copy = {
  source: "the raw records of the runners of GitHub, judged again by the harness. A re-run replaces the first run of its cell",
  ranAt: date,
  ...commitOf(records),
  units: "s",
  runs: Number(only("the count of runs", records.map((record) => String(record.cell.runs)))),
  kernel: runner.kernel,
  hz: runner.hz,
  low: Number(only("the low port", records.map((record) => String(record.cell.prediction.ports?.low)))),
  cells,
};
const out = fileURLToPath(new URL(`../src/data/port-range-${date}.json`, import.meta.url));
writeFileSync(out, stringify(copy));
const judged = cells.flatMap((cell) => (cell.result === null ? [] : [cell.result]));
process.stdout.write(`${judged.length} of ${cells.length} cells, ${judged.filter((result) => result.decision === "holds").length} hold: ${out}\n`);
