// The export of the HTTP cells for the site: src/data/http-<date>.json.
//
//   pnpm exec tsx packages/site/scripts/http.ts <folder>...
//
// The HTTP catalog puts the http.Server of Node against three clients: the agent of Node, undici
// and the transport of Go. Each folder is the output of one shard of the workflow Cells on a runner
// of GitHub: the raw record of each cell, summary.ndjson and runner.txt. The folders of a re-run go
// last, and each of their cells replaces the cell of the first run. The script reads each record
// again with the code of the harness (`judge`), and it stops when that verdict disagrees with
// summary.ndjson. It also stops when a prediction disagrees with the catalog at the HZ of the
// runner. The copy keeps only what the page shows.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Cell, RequestPrediction } from "../../harness/src/index.ts";
import { NOISE } from "../../harness/src/index.ts";
import type { CellRecord, Reading, Summary } from "./judged.ts";
import { FROM, nameOf, read, resultOf } from "./judged.ts";
import { dateOf, only, readFolders, runnerOf, secondsOf, stringify, timeAt } from "./records.ts";

const folders = process.argv.slice(2);
if (folders.length === 0) {
  process.stderr.write("usage: pnpm exec tsx packages/site/scripts/http.ts <folder>...\n");
  process.exit(2);
}

// the catalog reads the HZ of the kernel when it loads, thus it loads after the HZ of the runner is known
const runner = runnerOf(folders);
process.env["CELLS_HZ"] = String(runner.hz);
const { HTTP_CELLS } = await import("../../cells/src/http/catalog.ts");
const { HTTP_HARNESS_CELLS } = await import("../../cells/src/http/cells.ts");

const found = readFolders<CellRecord, Summary>(folders);

/** These phrases tell what ends the connection in a prediction, by its timer and its errno. */
const CLOSERS: Readonly<Record<string, string>> = {
  "keep_alive CLOSED": "the pool of undici closes the idle connection",
  "free_socket CLOSED": "the agent closes its free socket",
  "idle_conn CLOSED": "the IdleConnTimeout of Go closes the idle connection",
  "keep_alive EOF": "the client reads the end of file from the keep-alive timer of the server",
  "rx.fin EOF": "the FIN of the server reaches the client as an end of file",
  "rx.rst ECONNRESET": "a reset reaches the client as ECONNRESET",
  "retrans_giveup EHOSTUNREACH": "the give-up of the retransmissions gives EHOSTUNREACH",
  "retrans_giveup ETIMEDOUT": "the give-up of the retransmissions gives ETIMEDOUT",
  "headers UND_ERR_HEADERS_TIMEOUT": "the headersTimeout of undici gives UND_ERR_HEADERS_TIMEOUT",
};

/** These phrases name the reference of a time of an HTTP cell, in a sentence. */
const HTTP_FROM: Readonly<Record<string, string>> = { ...FROM, "last-received": "the last segment of the reply", "peer-closed": "the close of the socket of the server" };

/**
 * This function tells what the request meets in a prediction, or null for a workload with one
 * request. A race has a second request after its gap, and a fault cell has a request in flight.
 */
const requestOf = (request: RequestPrediction | undefined, race: boolean): string | null => {
  if (request === undefined) return null;
  const which = race ? "the second request" : "the request in flight";
  const Which = `${which[0]!.toUpperCase()}${which.slice(1)}`;
  if (request.pending === true) return `${Which} waits for its reply until the end of the window.`;
  const on = request.connection === "new" ? "a new connection" : "the same connection";
  if (request.retried)
    return request.error === null
      ? `${Which} fails on the same connection. The client sends it again on a new connection, and it gets a reply.`
      : `${Which} fails on the same connection. The client sends it again, and the new try gets ${request.error}.`;
  if (request.error !== null) return `${Which} fails with ${request.error} on ${on}.`;
  return `${Which} goes on ${on}, and it gets a reply.`;
};

/** This text is the start of the reason of a race whose ordering is a distribution, as the catalog writes it. */
const DISTRIBUTION =
  /^its ordering is a distribution: the gap \[([\d.]+), ([\d.]+)\] s with a round trip of \[([\d.]+), ([\d.]+)\] s meets the close of the server \[([\d.]+), ([\d.]+)\] s$/;

/** This function gives the prediction of a cell: its kind, its band and its text. The kind is a detection, a recovery, silence, or a measurement only. */
const predictionOf = (cell: Cell, race: boolean) => {
  const p = cell.prediction;
  const at = timeAt(4);
  const request = requestOf(p.request, race);
  const and = (text: string): string => (request === null ? text : `${text} ${request}`);
  const none = { low: null, high: null, window: null };
  if (p.detects === null) {
    const match = DISTRIBUTION.exec(p.why);
    if (match === null) throw new Error(`${cell.name}: the reason "${p.why}" has no text for the page`);
    if (p.from !== "last-received") throw new Error(`${cell.name}: a measurement from ${p.from}`);
    const [gapLow, gapHigh, rttLow, rttHigh, closeLow, closeHigh] = match.slice(1).map(Number) as [number, number, number, number, number, number];
    const text = [
      "This cell has no band.",
      `The gap of ${at(gapLow)} to ${at(gapHigh)} and a round trip of ${at(rttLow)} to ${at(rttHigh)} meet the close of the server at ${at(closeLow)} to ${at(closeHigh)}.`,
      "Thus the order of the two is a distribution.",
      "The harness measures the time from the last segment of the reply to the close of the connection.",
    ].join(" ");
    return { kind: "measured", ...none, window: secondsOf(p.window), text };
  }
  if (p.detects) {
    const closes = CLOSERS[`${p.timer} ${p.errno}`];
    if (closes === undefined) throw new Error(`${cell.name}: the timer ${p.timer} with ${p.errno} has no text for the page`);
    const [low, high] = [secondsOf(p.low)!, secondsOf(p.high)!];
    const band = `The band is ${at(low)} to ${at(high)} after ${HTTP_FROM[p.from] ?? p.from}.`;
    return { kind: "detects", ...none, low, high, text: and(`The algebra predicts that ${closes}. ${band}`) };
  }
  if (p.recovers !== undefined) {
    const [low, high] = [secondsOf(p.recovers.low)!, secondsOf(p.recovers.high)!];
    return {
      kind: "recovers",
      ...none,
      low,
      high,
      window: secondsOf(p.window),
      text: and(`The algebra predicts that the reply comes back ${at(low)} to ${at(high)} after the send of the request.`),
    };
  }
  const window = secondsOf(p.window)!;
  return { kind: "silent", ...none, window, text: and(`The algebra predicts that nothing closes the connection in a window of ${at(window)}.`) };
};

/** This text tells why CI did a cell again. Each re-run of this copy has the same reason. */
const REPEATED =
  "In the first CI run, the harness read a failed dial of a new try as a request with no new try. After a fix, the harness counts that dial as a new try, and CI did the cell again.";

/** This function gives the outcomes of the second requests of the counted runs, each with its count. */
const requestsOf = (reading: Reading) => Object.entries(reading.verdict.requests ?? {}).map(([outcome, count]) => ({ outcome, count }));

const cells = HTTP_HARNESS_CELLS.flatMap((catalog, at) => {
  const entry = found.get(catalog.name);
  if (entry === undefined) return [];
  const http = HTTP_CELLS[at];
  if (http === undefined || http.name !== catalog.name) throw new Error(`${catalog.name}: the catalogs disagree on the sequence`);
  if (JSON.stringify(entry.record.cell.prediction) !== JSON.stringify(catalog.prediction))
    throw new Error(`${catalog.name}: the prediction of the record is not the prediction of the catalog at HZ ${runner.hz}`);
  const reading = read(entry);
  const { spec } = http;
  const race = spec.workload.mode === "gap";
  return [
    {
      ...nameOf(catalog.name),
      group: spec.template === "T03" ? "router" : race ? "race" : "faults",
      client: spec.client,
      ordering: http.ordering,
      prediction: predictionOf(entry.record.cell, race),
      ...resultOf(reading, { digits: 4, silent: "Nothing closed the connection" }),
      requests: requestsOf(reading),
      first: entry.first,
      repeated: entry.first === null ? null : REPEATED,
    },
  ];
});
const unknown = [...found.keys()].filter((name) => !HTTP_HARNESS_CELLS.some((catalog) => catalog.name === name));
if (unknown.length > 0) throw new Error(`no catalog has the cells ${unknown.join(", ")}`);

const records = [...found.values()].map((entry) => entry.record);
const date = dateOf(records.map((record) => record.at.ended));
const copy = {
  source: "the raw records of the runners of GitHub, judged again by the harness. A re-run replaces the first run of its cell",
  ranAt: date,
  units: "s",
  noise: secondsOf(NOISE),
  runs: Number(only("the count of runs", records.map((record) => String(record.cell.runs)))),
  kernel: runner.kernel,
  hz: runner.hz,
  target: only("the target", records.map((record) => record.cell.target.image.replace(/@.*$/, ""))),
  cells,
};
const out = fileURLToPath(new URL(`../src/data/http-${date}.json`, import.meta.url));
writeFileSync(out, stringify(copy));
process.stdout.write(`${cells.length} cells, ${cells.reduce((sum, cell) => sum + cell.counted + cell.voided, 0)} runs: ${out}\n`);
