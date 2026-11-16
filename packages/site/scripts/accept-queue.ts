// The export of the accept queue cells for the site: src/data/accept-queue-<date>.json.
//
//   pnpm exec tsx packages/site/scripts/accept-queue.ts <folder>...
//
// The cells of the accept queue (SYS-63, SYS-103) fill the queue of a listener that does not accept. Each
// folder is the output of one shard of the workflow Cells on a runner of GitHub. It holds the raw record of
// each cell, summary.ndjson and runner.txt. The script reads each record again with the code of the harness
// (`judge`), and it stops when that verdict disagrees with summary.ndjson. It also stops when a prediction
// disagrees with the catalog at the HZ of the runner. A cell with no record keeps its place in the copy,
// with its prediction and no result.
//
// The copy gives each term of the law of each cell: its band and the value of each counted run, with their
// median. Thus the page shows the median next to its band, and it computes nothing. The copy keeps no
// address, container, namespace or path.

import { writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { Measured, Prediction, QueueBand, QueuePrediction, QueueReading } from "../../harness/src/index.ts";
import type { CellRecord, Reading, Summary } from "./judged.ts";
import { read, resultOf } from "./judged.ts";
import { commitOf, dateOf, middle, ofCatalog, readFolders, runnerOf, secondsOf, stringify } from "./records.ts";

const folders = process.argv.slice(2);
if (folders.length === 0) {
  process.stderr.write("usage: pnpm exec tsx packages/site/scripts/accept-queue.ts <folder>...\n");
  process.exit(2);
}

// the catalog reads the HZ of the kernel when it loads, thus it loads after the HZ of the runner is known
const runner = runnerOf(folders);
process.env["CELLS_HZ"] = String(runner.hz);
const { ACCEPT_QUEUE_CELLS, SERVICE_QUEUE_CELLS } = await import("../../cells/src/accept-queue.ts");
const { ALL } = await import("../../cells/src/all.ts");
const CATALOG = [...ACCEPT_QUEUE_CELLS, ...SERVICE_QUEUE_CELLS];

// a full run of the catalogs holds the cells of each catalog: this export takes its own
const found = ofCatalog(
  readFolders<CellRecord, Summary>(folders),
  CATALOG.map((cell) => cell.name),
  ALL.map((cell) => cell.name),
);
if (found.size === 0) throw new Error("the folders have no record of a cell of the accept queue");

/** A term of the law: its band, the value of each counted run, and their median. A count has a band of one value. */
interface Term {
  readonly term: string;
  readonly unit: "count" | "s";
  readonly low: number;
  readonly high: number;
  readonly values: readonly (number | null)[];
  readonly median: number | null;
  /** This choice says if the median is inside the band. It is null with no median. */
  readonly inside: boolean | null;
}

/** This function gives one term from its band and the value of each counted run. */
const termOf = (term: string, unit: Term["unit"], low: number, high: number, values: readonly (number | null)[]): Term => {
  const median = middle(values.filter((value): value is number => value !== null));
  return { term, unit, low, high, values, median, inside: median === null ? null : median >= low && median <= high };
};

/** This function gives a band in seconds. */
const secondsIn = (band: QueueBand): { readonly low: number; readonly high: number } => ({ low: secondsOf(band.low)!, high: secondsOf(band.high)! });

/** This function gives each term of the law of one cell, from the readings of its counted runs. Each reading is in the sequence of the runs. */
const termsOf = (queue: QueuePrediction, readings: readonly QueueReading[]): Term[] => {
  const count = (term: string, low: number, high: number, value: (reading: QueueReading) => number): Term =>
    termOf(term, "count", low, high, readings.map(value));
  const time = (term: string, band: QueueBand, value: (reading: QueueReading) => number | null): Term => {
    const { low, high } = secondsIn(band);
    return termOf(term, "s", low, high, readings.map(value));
  };
  return [
    count("the limit of the queue", queue.max, queue.max, (got) => got.max),
    count("the most in the queue", queue.held, queue.held, (got) => got.held),
    count("the connects that succeed", queue.connected, queue.connected, (got) => got.connected),
    count("the overflows", queue.overflows.low, queue.overflows.high, (got) => got.overflows),
    count("the resets of the target", queue.resets, queue.resets, (got) => got.resets),
    ...(queue.drained === undefined ? [] : [count("the accepts", queue.drained, queue.drained, (got) => got.drained)]),
    ...(queue.expiry === undefined ? [] : [time("the expiry of the requests", queue.expiry.within, (got) => secondsOf(got.expiry))]),
    ...(queue.rise === undefined ? [] : [time(`the queue back to ${queue.rise.count}`, queue.rise.within, (got) => secondsOf(got.rise))]),
    ...queue.connections.flatMap((connection) =>
      connection.ends === null
        ? []
        : [
            time(`${connection.ends.errno} at the ${connection.name} connection`, connection.ends.within, (got) =>
              secondsOf(got.connections.find((each) => each.name === connection.name)?.ended),
            ),
          ],
    ),
  ];
};

/** This function gives the law of the accept queue in a prediction. Only a prediction with no detection has one. */
const queueOf = (prediction: Prediction): QueuePrediction | undefined => (prediction.detects === null ? prediction.queue : undefined);

/** This function gives the result of a cell with a record: its verdict, each term of its law and the first verdict of a re-run. */
const cellResultOf = (reading: Reading, queue: QueuePrediction, first: string | null) => {
  const result = resultOf(reading);
  const counted = reading.measured.filter((run: Measured) => run.void === null);
  const readings = counted.map((run) => {
    if (run.queue === undefined) throw new Error(`env ${run.environment} run ${run.index} has no reading of the queue`);
    return run.queue;
  });
  return {
    decision: result.decision,
    counted: result.counted,
    voided: result.voided,
    why: result.why,
    voids: result.voids,
    terms: termsOf(queue, readings),
    first,
  };
};

const cells = CATALOG.map((catalog) => {
  const queue = queueOf(catalog.prediction);
  if (queue === undefined) throw new Error(`${catalog.name} has no prediction of the queue`);
  const entry = found.get(catalog.name);
  if (entry !== undefined && !isDeepStrictEqual(entry.record.cell.prediction, catalog.prediction))
    throw new Error(`${catalog.name}: the prediction of the record is not the prediction of the catalog at HZ ${runner.hz}`);
  const id = catalog.name.split(" ")[0]!;
  return {
    id,
    name: catalog.name.slice(id.length + 1),
    why: catalog.prediction.detects === null ? catalog.prediction.why : null,
    result: entry === undefined ? null : cellResultOf(read(entry), queue, entry.first),
  };
});

/**
 * The workflow Copy puts the records of the run with the id N in a folder `<sequence>-N`. This function gives
 * the id of each run, in the sequence of the folders. A folder of another form gives no id.
 */
const runsOf = (shards: readonly string[]): number[] => [
  ...new Set(shards.flatMap((shard) => /^\d{3}-(\d+)$/.exec(basename(dirname(shard)))?.slice(1).map(Number) ?? [])),
];

const records = [...found.values()].map((entry) => entry.record);
const date = dateOf(records.map((record) => record.at.ended));
const copy = {
  source: "the raw records of the runners of GitHub, judged again by the harness. A re-run replaces the first run of its cell",
  ranAt: date,
  ...commitOf(records),
  workflows: runsOf(folders),
  kernel: runner.kernel,
  hz: runner.hz,
  cells,
};
const out = fileURLToPath(new URL(`../src/data/accept-queue-${date}.json`, import.meta.url));
writeFileSync(out, stringify(copy));
const judged = cells.flatMap((cell) => (cell.result === null ? [] : [cell.result]));
process.stdout.write(`${judged.length} of ${cells.length} cells, ${judged.filter((result) => result.decision === "holds").length} hold: ${out}\n`);
