// The export of the PostgreSQL cells for the site: src/data/pg-<date>.json.
//
//   pnpm exec tsx packages/site/scripts/pg.ts <folder>...
//
// The PostgreSQL cells put two clients against one server of PostgreSQL 17.11: node-postgres
// (pg 8.23.1 with pg-pool 3.14.0) and HikariCP 7.1.0 over pgjdbc 42.7.13. T01 is the direct pair,
// T03 has a router of a cloud preset between them, and T10 has PgBouncer 1.26.1. Each folder is
// the output of one shard of the workflow Cells on a runner of GitHub: the raw record of each
// cell, summary.ndjson and runner.txt.
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
  process.stderr.write("usage: pnpm exec tsx packages/site/scripts/pg.ts <folder>...\n");
  process.exit(2);
}

// the catalog reads the HZ of the kernel when it loads, thus it loads after the HZ of the runner is known
const runner = runnerOf(folders);
process.env["CELLS_HZ"] = String(runner.hz);
const { T01_PG, PG_DRIVER } = await import("../../cells/src/pg/t01.ts");
const { T01_HIKARI, HIKARI_DRIVER } = await import("../../cells/src/pg/hikari.ts");
const { T03_HIKARI } = await import("../../cells/src/pg/t03.ts");
const { T10_HIKARI } = await import("../../cells/src/pg/t10.ts");
const { ALL } = await import("../../cells/src/all.ts");

/** These are the PostgreSQL cells of the catalogs, each with its client. */
const CATALOG = [
  ...T01_PG.map((cell) => ({ cell, client: "node-postgres" })),
  ...[...T01_HIKARI, ...T03_HIKARI, ...T10_HIKARI].map((cell) => ({ cell, client: "HikariCP" })),
];

// a full run of the catalogs holds the cells of each catalog: this export takes its own
const found = ofCatalog(
  readFolders<CellRecord, Summary>(folders),
  CATALOG.map((each) => each.cell.name),
  ALL.map((cell) => cell.name),
);

/** These phrases tell what detects the fault in a prediction, by the timer that the catalog names. */
const TIMERS: Readonly<Record<string, string>> = {
  idle_timeout: "the pool closes its idle client at its idle timer",
  "the reset of the query": "the reset answers the query",
  "the reset of the connect": "the reset of the SYN refuses the first connect",
  "the server ends the connection: rx.fin": "the FIN of the stopped server ends the idle client",
  retrans_giveup: "the retransmissions of the kernel give up",
  query_timeout: "the query timer of the pool fails the query",
  connect_timeout: "the connect timer of the pool fails the first connect",
  validation_timeout: "the check of the pool gets no reply, and its read timeout closes the socket",
  socket_timeout: "the read timeout of pgjdbc closes the socket",
  start_check: "the start of the pool fails after the sleep of its check",
  statement_timeout: "the statement timer of the server ends the query",
};
/** These phrases name the reference of a band, in a sentence. */
const FROMS: Readonly<Record<string, string>> = {
  "last-received": "the last segment on the socket",
  "request-sent": "the send of the query",
  "first-retransmission": "the first retransmission of the RTO timer",
  "peer-closed": "the close of the socket of the server",
  "client-start": "the start of the first connect",
  "first-sent": "the empty query of the check, the first segment after the fault",
};
const from = (reference: Reference): string => {
  const text = FROMS[reference];
  if (text === undefined) throw new Error(`no text for the reference ${reference}`);
  return text;
};
/** This function gives the phrase of the error of a band: the close of the pool, an end of file, or an error. */
const withError = (name: string): string =>
  name === "CLOSED" ? ", and the kernel stamps its FIN" : name === "EOF" ? " with an end of file" : ` with ${name.includes(" ") ? `'${name}'` : name}`;

/** This function names a line that a prediction does not let come after the fault. */
const quietOf = (match: LineMatch): string => {
  if (match.ev === "fail" && match.where === undefined) return "failed query";
  if (match.ev === "socket-error" && match.where === undefined) return "socket error";
  throw new Error(`no text for the line ${JSON.stringify(match)}`);
};
const listed = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);

/** This function gives the prediction of a cell: its kind, its band and its text. */
const predictionOf = (cell: Cell) => {
  const p = cell.prediction;
  const at = timeAt(3);
  const none = { low: null, high: null, window: null };
  if (p.detects === null) throw new Error(`${cell.name}: a measurement only, which the PostgreSQL cells do not have`);
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
      text: text(`The algebra predicts that the reply comes back at the ${ordinal(p.recovers.firing)} firing of the RTO timer. The band is ${at(low)} to ${at(high)} after the send of the query.`),
    };
  }
  if (p.replies !== undefined) {
    const [low, high] = [secondsOf(p.replies.low)!, secondsOf(p.replies.high)!];
    return {
      kind: "replies",
      ...none,
      low,
      high,
      window: secondsOf(p.window),
      text: text(`The algebra predicts that no timer ends the query, and that the reply comes back after the hold of the server. The band of the reply is ${at(low)} to ${at(high)} after the send of the query.`),
    };
  }
  const window = secondsOf(p.window)!;
  return { kind: "silent", ...none, window, text: text(`The algebra predicts that nothing detects the fault in a window of ${at(window)}.`) };
};

/** This function gives the name of a cell without the client and the target, which each PostgreSQL cell has. */
const shortOf = (name: string): string => {
  const short = name.replace(/^(pg-8\.23|hikaricp-pgjdbc) to postgresql, /, "");
  if (short === name) throw new Error(`${name}: not the client and the target of the PostgreSQL cells`);
  return short;
};

const cells = CATALOG.flatMap(({ cell: catalog, client }) => {
  const entry = found.get(catalog.name);
  if (entry === undefined) return [];
  if (JSON.stringify(entry.record.cell.prediction) !== JSON.stringify(catalog.prediction))
    throw new Error(`${catalog.name}: the prediction of the record is not the prediction of the catalog at HZ ${runner.hz}`);
  const reading = read(entry);
  const named = nameOf(catalog.name);
  return [
    {
      ...named,
      name: shortOf(named.name),
      group: named.catalog,
      client,
      stage: named.plan?.includes(".border-off.") ? "border" : "defaults",
      prediction: predictionOf(entry.record.cell),
      ...resultOf(reading),
    },
  ];
});
const unknown = [...found.keys()].filter((name) => !CATALOG.some((each) => each.cell.name === name));
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
  clients: { "node-postgres": PG_DRIVER, HikariCP: HIKARI_DRIVER },
  cells,
};
const out = fileURLToPath(new URL(`../src/data/pg-${date}.json`, import.meta.url));
writeFileSync(out, stringify(copy));
process.stdout.write(`${cells.length} cells, ${cells.reduce((sum, cell) => sum + cell.counted + cell.voided, 0)} runs: ${out}\n`);
