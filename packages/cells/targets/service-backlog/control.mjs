// The worker of the target: the control port, PORT + 1, and the read of the queue each 5 ms. The
// main thread holds the listener and blocks. Thus this worker gives it `open` and `accept`, and it
// reads the queue from the kernel with no help of the main thread.
//
// - The count. /proc/net/tcp gives the count of the queue of a listener as its rx_queue: the
//   field sk_ack_backlog (net/ipv4/tcp_ipv4.c of Linux v7.0, lines 2880-2881).
// - The limit. inet_diag gives the limit as idiag_wqueue: the field sk_max_ack_backlog
//   (net/ipv4/tcp_diag.c, lines 27-28). `ss` of iproute2 shows it as the Send-Q of the listener.
//   The limit changes only at `open`, thus the worker reads it once for each `open`.
// - The counters. /proc/net/netstat gives the counters of the namespace, as the native target reads them.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import readline from "node:readline";
import { parentPort, workerData } from "node:worker_threads";
import { emit } from "./emit.mjs";

const { port, flag, channel } = workerData;
/** The local address of the listener in /proc/net/tcp: 0.0.0.0 and the port, in hexadecimal. */
const LOCAL = `00000000:${port.toString(16).toUpperCase().padStart(4, "0")}`;
/** The state LISTEN in /proc/net/tcp. */
const LISTEN = "0A";

/** This function gives the count of the queue of the listener, or undefined when no listener is open. */
const countOf = () => {
  for (const line of readFileSync("/proc/net/tcp", "utf8").split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[1] === LOCAL && fields[3] === LISTEN) return Number.parseInt(fields[4].split(":")[1], 16);
  }
  return undefined;
};

/** This function gives the limit of the queue of the listener from `ss`, or undefined when no listener is open. */
const limitOf = () => {
  const text = execFileSync("ss", ["-Hltn", `sport = :${port}`], { encoding: "utf8" });
  const fields = text.trim().split(/\s+/);
  return fields[0] === "LISTEN" ? Number(fields[2]) : undefined;
};

/** This function reads the counters from the text of /proc/net/netstat: a line of names, then a line of values. */
const counters = () => {
  const found = { overflows: 0, drops: 0, cookies: 0, timeouts: 0, resets: 0 };
  const names = { ListenOverflows: "overflows", ListenDrops: "drops", TCPReqQFullDoCookies: "cookies", TCPTimeouts: "timeouts", EmbryonicRsts: "resets" };
  const lines = readFileSync("/proc/net/netstat", "utf8").split("\n");
  for (let at = 0; at + 1 < lines.length; at += 2) {
    if (!lines[at].startsWith("TcpExt:")) continue;
    const keys = lines[at].trim().split(/\s+/);
    const values = lines[at + 1].trim().split(/\s+/);
    keys.forEach((key, index) => {
      if (key in names) found[names[key]] = Number(values[index]);
    });
  }
  return found;
};

/** The limit of the open listener, or undefined before the first `open`. */
let limit;

const fields = () => {
  const count = limit === undefined ? undefined : countOf();
  return { count: count ?? 0, max: count === undefined ? 0 : limit, ...counters() };
};

/** This function gives one command to the main thread, and waits for its reply. */
const ask = (message) =>
  new Promise((resolve) => {
    channel.once("message", resolve);
    channel.postMessage(message);
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  });

const reply = async (line) => {
  const [command, word] = line.trim().split(/\s+/);
  const number = Number.parseInt(word ?? "", 10);
  if (command === "open" && Number.isInteger(number)) {
    limit = undefined;
    const done = await ask({ command: "open", number });
    if (done.error !== undefined) return { error: done.error, backlog: number };
    limit = limitOf();
    return fields();
  }
  if (command === "accept" && Number.isInteger(number)) return ask({ command: "accept", number });
  if (command === "stats") return fields();
  return { refused: line };
};

const serve = async (socket) => {
  socket.setNoDelay(true);
  for await (const line of readline.createInterface({ input: socket, crlfDelay: Infinity })) {
    const answer = await reply(line);
    if (answer.error !== undefined) emit("control-error", answer);
    socket.write(`${JSON.stringify(answer)}\n`);
  }
};

/** This function writes a `queue` line for each change of the queue or of its counters. */
const sample = () => {
  let last;
  setInterval(() => {
    if (limit === undefined) return;
    const now = fields();
    const text = JSON.stringify(now);
    if (text !== last) emit("queue", now);
    last = text;
  }, 5);
};

const control = net.createServer((socket) => {
  serve(socket).catch((error) => emit("control-error", { error: error.message }));
});
control.listen({ port: port + 1, host: "0.0.0.0" }, () => {
  sample();
  parentPort.postMessage("ready");
});
