// The export of the gRPC cells for the site: src/data/grpc-<date>.json.
//
//   pnpm exec tsx packages/site/scripts/grpc.ts <folder>...
//
// The gRPC cells put grpc-js 1.14.6 on Node against two servers: a server of grpc-go v1.84.0 (the
// server of the harness) and etcd v3.6.15. T01 is the direct pair, at the defaults, in the array
// stage and at the borders of O03, O17, O25 and O26. T03 puts a router of a cloud preset between
// the client and grpc-go, and T02 puts one proxy there. Each folder is the output of one shard of the
// workflow Cells on a runner of GitHub: the raw record of each cell, summary.ndjson and runner.txt.
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
  process.stderr.write("usage: pnpm exec tsx packages/site/scripts/grpc.ts <folder>...\n");
  process.exit(2);
}

// the catalog reads the HZ of the kernel when it loads, thus it loads after the HZ of the runner is known
const runner = runnerOf(folders);
process.env["CELLS_HZ"] = String(runner.hz);
const { T01_GRPC, GRPC_DRIVER } = await import("../../cells/src/grpc/t01.ts");
const { T03_GRPC } = await import("../../cells/src/grpc/t03.ts");
const { T02_GRPC } = await import("../../cells/src/grpc/t02.ts");
const CATALOG = [...T01_GRPC, ...T03_GRPC, ...T02_GRPC];
const { ALL } = await import("../../cells/src/all.ts");

// a full run of the catalogs holds the cells of each catalog: this export takes its own
const found = ofCatalog(
  readFolders<CellRecord, Summary>(folders),
  CATALOG.map((cell) => cell.name),
  ALL.map((cell) => cell.name),
);

/** These phrases tell what detects the fault in a prediction, by the timer that the catalog names and its error. */
const TIMERS: Readonly<Record<string, string>> = {
  "the reset of the call": "the reset answers the call",
  "the reset of the connect": "the reset of the SYN fails the connect, and the first call fails at once",
  "the server ends the connection: rx.fin": "the FIN of the killed server ends the idle connection",
  retrans_giveup: "the retransmissions of the kernel give up",
  "keepalive CLOSED": "the keepalive of grpc-js gets no ACK for its PING in 20 s, and grpc-js closes the transport",
  "keepalive ETIMEDOUT": "the TCP keepalive of the listener of the server gets no answer, and the kernel of the server aborts its socket",
  deadline: "the deadline of the call ends it",
  ping_timeout: "the keepalive of gRPC at the server gets no ACK for its PING, and the server closes the connection",
  too_many_pings: "the server counts three PINGs as strikes, and it sends GOAWAY too_many_pings and closes the connection",
  "the reset of the router at a retransmission": "the router resets the first retransmission of the client after the end of the CLOSE timeout of conntrack",
  "the local reply of Envoy to the reset of its upstream": "Envoy answers the reset of its upstream with its own reply, on the open connection of the client",
  "the stop of toxiproxy, whose exit closes the connection of the client": "the exit of the stopped Toxiproxy closes the idle connection",
  "the stop of docker-proxy, whose exit closes the connection of the client": "the exit of the stopped docker-proxy closes the idle connection",
  "the FIN of the killed server, which Toxiproxy passes as a close of the client": "Toxiproxy passes the FIN of the killed server as a close of the client",
  "the idle timeout of Caddy, and its GOAWAY": "Caddy sends GOAWAY at its idle timeout",
  "grpc_read_timeout of nginx: due in the stop of its worker, it fires at the resume, before nginx reads the reply in the socket":
    "the read timer of nginx comes due in the stop of its worker, and at the resume it fires before nginx reads the reply in the socket",
};
const timerText = (p: { readonly timer: string; readonly errno: string }): string | undefined => TIMERS[`${p.timer} ${p.errno}`] ?? TIMERS[p.timer];
/** These phrases name the reference of a band, in a sentence. */
const FROMS: Readonly<Record<string, string>> = {
  "last-data": "the last segment with data from the server",
  "last-received": "the last segment that the socket of the server got",
  "request-sent": "the send of the call",
  "first-retransmission": "the first retransmission of the RTO timer",
  "peer-closed": "the close of the socket of the server",
  "client-start": "the start of the client",
  fault: "the start of the fault",
};
const from = (reference: Reference): string => {
  const text = FROMS[reference];
  if (text === undefined) throw new Error(`no text for the reference ${reference}`);
  return text;
};
/** This function gives the phrase of the error of a band: the close of the observer, which the kernel stamps by its FIN, an end of file, or an error. */
const withError = (name: string): string =>
  name === "CLOSED"
    ? ", and the kernel stamps its FIN"
    : name === "EOF"
      ? " with an end of file"
      : name === "too_many_pings"
        ? ""
        : name === "IDLE"
          ? ", and grpc-js drops the transport (READY to IDLE)"
          : ` with ${name}`;

/** This function names a line that a prediction does not let come after the fault. */
const quietOf = (match: LineMatch): string => {
  if (match.ev === "fail" && match.where === undefined) return "failed call";
  if (match.ev === "socket-error" && match.where === undefined) return "socket error";
  throw new Error(`no text for the line ${JSON.stringify(match)}`);
};
const listed = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);

/** This function gives the prediction of a cell: its kind, its band and its text. */
const predictionOf = (cell: Cell) => {
  const p = cell.prediction;
  const at = timeAt(3);
  const none = { low: null, high: null, window: null };
  if (p.detects === null) return { kind: "measured", ...none, window: secondsOf(p.window), text: `The cell measures only: ${p.why}.` };
  const quiet = (p.driver?.quiet ?? []).map(quietOf);
  const extra = quiet.length > 0 ? [`The prediction has no ${listed(quiet)} after the fault.`] : [];
  const text = (first: string): string => [first, ...extra].join(" ");
  if (p.detects) {
    const timer = timerText(p);
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
      text: text(`The algebra predicts that the reply comes back at the ${ordinal(p.recovers.firing)} firing of the RTO timer. The band is ${at(low)} to ${at(high)} after the send of the call.`),
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
      text: text(`The algebra predicts that no timer ends the call, and that the reply comes back after the hold of the server. The band of the reply is ${at(low)} to ${at(high)} after the send of the call.`),
    };
  }
  const window = secondsOf(p.window)!;
  const forgets = p.middlebox?.forgets;
  const router =
    forgets === undefined
      ? []
      : [`The router forgets the flow ${at(secondsOf(forgets.low)!)} to ${at(secondsOf(forgets.high)!)} after the last segment that the client got.`];
  return { kind: "silent", ...none, window, text: [`The algebra predicts that nothing detects the fault in a window of ${at(window)}.`, ...router, ...extra].join(" ") };
};

/** This function gives the name of a cell with its server, and without the client, which each gRPC cell has. */
const shortOf = (name: string): string => {
  const match = /^grpc-js-1\.14 to (grpc-go-server|etcd-3\.6), (.*)$/.exec(name);
  if (match === null) throw new Error(`${name}: not the client and a server of the gRPC cells`);
  return `${match[1] === "grpc-go-server" ? "grpc-go" : "etcd"}: ${match[2]}`;
};

/** This function gives the stage of a cell by its cell of the plan: the defaults, the array stage or a border. */
const stageOf = (plan: string | null): string => (plan?.includes(".border-off.") ? "border" : plan?.includes(".array.") ? "array" : "defaults");

const cells = CATALOG.flatMap((catalog) => {
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
      client: "grpc-js",
      stage: stageOf(named.plan),
      prediction: predictionOf(entry.record.cell),
      ...resultOf(reading),
    },
  ];
});
const unknown = [...found.keys()].filter((name) => !CATALOG.some((cell) => cell.name === name));
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
  target: "a server of grpc-go v1.84.0 and etcd v3.6.15, direct, through the router of a cloud, or through one proxy",
  clients: { "grpc-js": GRPC_DRIVER },
  cells,
};
const out = fileURLToPath(new URL(`../src/data/grpc-${date}.json`, import.meta.url));
writeFileSync(out, stringify(copy));
process.stdout.write(`${cells.length} cells, ${cells.reduce((sum, cell) => sum + cell.counted + cell.voided, 0)} runs: ${out}\n`);
