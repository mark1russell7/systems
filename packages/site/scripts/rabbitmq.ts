// The export of the RabbitMQ cells for the site: src/data/rabbitmq-<date>.json.
//
//   pnpm exec tsx packages/site/scripts/rabbitmq.ts <folder>...
//
// The RabbitMQ cells put amqplib 2.2.0 on Node against one broker of RabbitMQ 4.3.6: T01, the direct
// pair, at the defaults and at the borders of O03 and O17. Each folder is the output of one shard of
// the workflow Cells on a runner of GitHub: the raw record of each cell, summary.ndjson and
// runner.txt.
// The script reads each record again with the code of the harness (`judge`), and it stops when that
// verdict disagrees with summary.ndjson. It also stops when a prediction disagrees with the catalog
// at the HZ of the runner. The copy keeps only what the page shows.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Cell, LineMatch, Reference } from "../../harness/src/index.ts";
import { NOISE } from "../../harness/src/index.ts";
import type { CellRecord, Summary } from "./judged.ts";
import { nameOf, read, resultOf } from "./judged.ts";
import { dateOf, noiseOf, ofCatalog, only, ordinal, readFolders, runnerOf, secondsOf, stringify, timeAt } from "./records.ts";

const folders = process.argv.slice(2);
if (folders.length === 0) {
  process.stderr.write("usage: pnpm exec tsx packages/site/scripts/rabbitmq.ts <folder>...\n");
  process.exit(2);
}

// the catalog reads the HZ of the kernel when it loads, thus it loads after the HZ of the runner is known
const runner = runnerOf(folders);
process.env["CELLS_HZ"] = String(runner.hz);
const { T01_AMQP, AMQP_DRIVER } = await import("../../cells/src/rabbit/t01.ts");
const { ALL } = await import("../../cells/src/all.ts");

// a full run of the catalogs holds the cells of each catalog: this export takes its own
const found = ofCatalog(
  readFolders<CellRecord, Summary>(folders),
  T01_AMQP.map((cell) => cell.name),
  ALL.map((cell) => cell.name),
);

/** These phrases tell what detects the fault in a prediction, by the timer that the catalog names. */
const TIMERS: Readonly<Record<string, string>> = {
  heartbeat: "the heartbeat of amqplib ends the connection after two receive checks with no bytes of the broker",
  "the reset of the operation": "the reset answers the operation",
  "the broker ends the connection: rx.rst": "the stopped broker resets the idle connection",
  retrans_giveup: "the retransmissions of the kernel give up",
  "the reset of the connect": "the reset of the SYN refuses the first connect",
};
/** These phrases name the reference of a band, in a sentence. */
const FROMS: Readonly<Record<string, string>> = {
  "last-data": "the last segment with data from the broker",
  "request-sent": "the send of the operation",
  "first-retransmission": "the first retransmission of the RTO timer",
  "peer-closed": "the close of the socket of the broker",
  "client-start": "the start of the client",
};
const from = (reference: Reference): string => {
  const text = FROMS[reference];
  if (text === undefined) throw new Error(`no text for the reference ${reference}`);
  return text;
};
/** This function gives the phrase of the error of a band: the close of amqplib, which the kernel stamps by its FIN, or an error. */
const withError = (name: string): string => (name === "CLOSED" ? ", and the kernel stamps its FIN" : ` with ${name}`);

/** This function names a line that a prediction does not let come after the fault. */
const quietOf = (match: LineMatch): string => {
  if (match.ev === "fail" && match.where === undefined) return "failed operation";
  if (match.ev === "socket-error" && match.where === undefined) return "socket error";
  throw new Error(`no text for the line ${JSON.stringify(match)}`);
};
const listed = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);

/** This function gives the prediction of a cell: its kind, its band and its text. */
const predictionOf = (cell: Cell) => {
  const p = cell.prediction;
  const at = timeAt(3);
  const none = { low: null, high: null, window: null };
  if (p.detects === null) throw new Error(`${cell.name}: a measurement only, which the RabbitMQ cells do not have`);
  const quiet = (p.driver?.quiet ?? []).map(quietOf);
  const extra = quiet.length > 0 ? [`The prediction has no ${listed(quiet)} after the fault.`] : [];
  const text = (first: string): string => [first, ...extra].join(" ");
  if (p.detects) {
    const timer = TIMERS[p.timer];
    if (timer === undefined) throw new Error(`${cell.name}: the timer "${p.timer}" has no text for the page`);
    const [low, high] = [secondsOf(p.low)!, secondsOf(p.high)!];
    return {
      kind: "detects",
      ...none,
      low,
      high,
      text: text(`The algebra predicts that ${timer}${withError(p.errno)}. The band is ${at(low)} to ${at(high)} after ${from(p.from)}.`),
    };
  }
  if (p.recovers !== undefined) {
    const [low, high] = [secondsOf(p.recovers.low)!, secondsOf(p.recovers.high)!];
    return {
      kind: "recovers",
      ...none,
      low,
      high,
      window: secondsOf(p.window),
      text: text(`The algebra predicts that the reply comes back at the ${ordinal(p.recovers.firing)} firing of the RTO timer. The band is ${at(low)} to ${at(high)} after the send of the operation.`),
    };
  }
  const window = secondsOf(p.window)!;
  return { kind: "silent", ...none, window, text: text(`The algebra predicts that nothing detects the fault in a window of ${at(window)}.`) };
};

/** This function gives the name of a cell without the client and the target, which each RabbitMQ cell has. */
const shortOf = (name: string): string => {
  const short = name.replace(/^amqplib-2\.2 to rabbitmq-4\.3, /, "");
  if (short === name) throw new Error(`${name}: not the client and the target of the RabbitMQ cells`);
  return short;
};

const cells = T01_AMQP.flatMap((catalog) => {
  const entry = found.get(catalog.name);
  if (entry === undefined) return [];
  if (JSON.stringify(entry.record.cell.prediction) !== JSON.stringify(catalog.prediction))
    throw new Error(`${catalog.name}: the prediction of the record is not the prediction of the catalog at HZ ${runner.hz}`);
  const named = nameOf(catalog.name);
  return [
    {
      ...named,
      name: shortOf(named.name),
      group: named.catalog,
      client: "amqplib",
      stage: named.plan?.includes(".border-off.") ? "border" : "defaults",
      prediction: predictionOf(entry.record.cell),
      ...resultOf(read(entry)),
    },
  ];
});
const unknown = [...found.keys()].filter((name) => !T01_AMQP.some((cell) => cell.name === name));
if (unknown.length > 0) throw new Error(`no catalog has the cells ${unknown.join(", ")}`);

const records = [...found.values()].map((entry) => entry.record);
const date = dateOf(records.map((record) => record.at.ended));
const copy = {
  source: "the raw records of the runners of GitHub, judged again by the harness",
  ranAt: date,
  units: "s",
  noise: noiseOf(records.map((record) => record.cell), NOISE),
  runs: Number(only("the count of runs", records.map((record) => String(record.cell.runs)))),
  kernel: runner.kernel,
  hz: runner.hz,
  target: only("the target", records.map((record) => record.cell.target.image.replace(/@.*$/, ""))),
  clients: { amqplib: AMQP_DRIVER },
  cells,
};
const out = fileURLToPath(new URL(`../src/data/rabbitmq-${date}.json`, import.meta.url));
writeFileSync(out, stringify(copy));
process.stdout.write(`${cells.length} cells, ${cells.reduce((sum, cell) => sum + cell.counted + cell.voided, 0)} runs: ${out}\n`);
