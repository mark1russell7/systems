// client-pg HOST PORT --mode idle|inflight|stream [--interval-ms N] [--max-s N] [--go PATH]
//           [--query TEXT] [--before] [--options JSON]
//
// The client of a PostgreSQL cell: node-postgres (pg 8.23.1 with pg-pool 3.14.0) on Node 24.21.0.
// Each event is a JSON line with `ev` and `t`, the time on CLOCK_MONOTONIC in nanoseconds
// (process.hrtime, which libuv reads from it). The prober stamps the records of the kernel on the
// same clock, and the injector stamps each fault on it.
//
// The lines:
// - start: the versions of pg, pg-pool and Node, the mode and the options of the pool.
// - connecting: the first query, which makes the first connection of the pool. Its stamp is the
//   stamp of the first sent line. The pool arms its connect timer in that call.
// - socket, socket-end, socket-error: each socket of the pool, with its local address.
// - connected: the first socket. The TCP client of the harness names its own socket so.
// - pool: each event of the pool: connect, acquire, release, remove, and error with its errno.
// - ready: the reply to the first query: the connection is idle in the pool (idle, inflight), or
//   the stream starts (stream).
// - sent, ack, fail: each query by its sequence number, with its error.
// - data, error: the end of the query in flight, as the TCP client of the harness tells it. In idle
//   mode, an error of the pool for the first socket is an error line too: the pool removes it.
// - done, deadline: the end of the client.
//
// The modes: idle sends one query, gives the client back to the pool, then holds until --max-s.
// inflight sends one query, waits for the file --go, sends one more query into the fault, and holds
// after its end. stream sends a query each --interval-ms after the reply before, until --max-s or
// SIGTERM. --before starts the client into a fault that holds already: its first connect meets it.

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";

const now = () => process.hrtime.bigint();
const emit = (ev, fields = {}, at = now()) => process.stdout.write(`${JSON.stringify({ ev, t: Number(at), ...fields })}\n`);

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const [host, port] = argv;
const mode = flag("--mode");
if (host === undefined || port === undefined || !["idle", "inflight", "stream"].includes(mode)) {
  emit("fail", { why: "client-pg HOST PORT --mode idle|inflight|stream" });
  process.exit(1);
}
const interval = Number(flag("--interval-ms") ?? 50);
const max = Number(flag("--max-s") ?? 120) * 1000;
const go = flag("--go") ?? "/tmp/go";
const query = flag("--query") ?? "SELECT 1";
const before = argv.includes("--before");
// the options of the pool. A cell gives each option that it changes, and pg-pool gives the others
const options = JSON.parse(flag("--options") ?? "{}");

const { default: pg } = await import("pg");
const versionOf = (name) => JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), "utf8")).version;

const bootId = () => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
};
emit("start", { boot_id: bootId(), client: "pg", driver: versionOf("pg"), pool: versionOf("pg-pool"), node: process.versions.node, mode, query, options });

const pool = new pg.Pool({ host, port: Number(port), user: "postgres", database: "postgres", ...options });

/** This function gives the error of pg as data: its name, its code, its severity and its message. */
const failure = (error) =>
  error === undefined || error === null
    ? null
    : { name: error.name, code: error.code ?? null, errno: error.errno ?? null, severity: error.severity ?? null, message: error.message };
/** This function gives the errno of an error: the code of the socket (ECONNRESET), the SQLSTATE of the server, or the message of pg. */
const errnoOf = (error) => error?.code ?? error?.message ?? null;

// ---- each socket of the pool: pg-pool emits connect after the first ReadyForQuery of a new client
let connected = null;
const localOf = (client) => {
  const socket = client?.connection?.stream;
  return socket?.localPort === undefined ? null : `${socket.localAddress}:${socket.localPort}`;
};
pool.on("connect", (client) => {
  const socket = client.connection.stream;
  const local = localOf(client);
  emit("socket", { role: "pool", local });
  emit("pool", { event: "connect", local });
  if (connected === null && local !== null) {
    connected = local;
    emit("connected", { local });
  }
  socket.once("close", (hadError) => emit("socket-end", { role: "pool", local, error: hadError }));
  socket.once("error", (error) => emit("socket-error", { role: "pool", local, errno: errnoOf(error), message: error.message }));
});
pool.on("acquire", (client) => emit("pool", { event: "acquire", local: localOf(client) }));
pool.on("release", (error, client) => emit("pool", { event: "release", local: localOf(client), failure: failure(error) }));
// the pool removes a client: after its idle timer, its lifetime or an error. A driver band names the close CLOSED
pool.on("remove", (client) => emit("pool", { event: "remove", name: "CLOSED", local: localOf(client) }));
// an idle client that fails: the pool removes it and emits error. Without this listener, Node throws
pool.on("error", (error, client) => {
  const local = localOf(client);
  emit("pool", { event: "error", local, failure: failure(error) });
  // the socket of the client in idle mode: its error is the detection, as for the TCP client
  if (mode === "idle" && local !== null && local === connected) emit("error", { errno: errnoOf(error) });
});

// ---- the end of the client
let stopped = false;
const stop = (code = 0) => {
  if (stopped) return;
  stopped = true;
  emit("done");
  pool.end().finally(() => setTimeout(() => process.exit(code), 50));
};
process.on("SIGTERM", () => stop(0));
setTimeout(() => {
  emit("deadline");
  stop(0);
}, max);

/** This function sends query n through the pool. Its stamp is before the call. It gives null for a reply, or the error. */
const operate = async (n) => {
  const at = now();
  const reply = pool.query(query);
  // a band of a cell that starts into a fault counts from the start of the first connect
  if (n === 1) emit("connecting", { at: `${host}:${port}` }, at);
  emit("sent", { n }, at);
  try {
    const result = await reply;
    emit("ack", { n, rows: result.rowCount ?? null });
    return null;
  } catch (error) {
    emit("fail", { n, ...failure(error) });
    return error;
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (mode === "stream") {
  emit("ready", { at: `${host}:${port}` });
  for (let n = 1; !stopped; n += 1) {
    await operate(n);
    await sleep(interval);
  }
} else {
  // the first query makes the connection of the pool. Its reply is the last data before the fault
  const failed = await operate(1);
  if (failed !== null) {
    emit("error", { errno: errnoOf(failed), message: failed.message });
    stop(before ? 0 : 1);
  } else {
    // pool.query gives the client back to the pool at its reply: the connection is idle there
    emit("ready", { reply: "ack" });
    if (mode === "inflight") {
      await new Promise((resolve) => {
        const wait = setInterval(() => {
          if (!existsSync(go)) return;
          clearInterval(wait);
          resolve();
        }, 2);
      });
      const error = await operate(2);
      if (error === null) emit("data", { n: 2 });
      else emit("error", { errno: errnoOf(error), message: error.message });
    }
  }
}
