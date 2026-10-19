// client-amqp HOST PORT --mode idle|inflight|stream [--interval-ms N] [--max-s N] [--go PATH] [--before]
//             [--options JSON]
//
// The client of a RabbitMQ cell: amqplib 2.2.0 on Node 24.21.0, with one connection and one channel.
// Each event is a JSON line with `ev` and `t`, the time on CLOCK_MONOTONIC in nanoseconds
// (process.hrtime, which libuv reads from it). The prober stamps the records of the kernel on the
// same clock, and the injector stamps each fault on it.
//
// The operations: operation 1 connects, opens the channel and declares a queue that the broker names
// (assertQueue). Each later operation declares that queue again, passively (checkQueue). Each is an
// RPC of the channel: the broker answers at once with declare-ok, and amqplib has no timer on it. The
// queue is exclusive, and it goes with the connection. RabbitMQ 4.3.6 refuses a transient queue that
// is not exclusive: transient_nonexcl_queues is denied by default (rabbit_amqqueue.erl:113-119, :228-241).
// The broker names it, because the exclusive queue of the client before can still exist: 405
// RESOURCE_LOCKED.
//
// The options (--options JSON): `heartbeat` in seconds goes in the URL. Without it, amqplib takes
// the heartbeat that the broker proposes. The others are the socket options of amqplib: noDelay,
// keepAlive, keepAliveDelay (ms) and timeout (ms). `user` and `password` are the user of the broker:
// guest, as amqplib gives it, when the options name none.
//
// The lines:
// - start: the versions of amqplib and Node, the mode and the options.
// - connecting: the start of operation 1. Its stamp is the stamp of the first sent line.
// - socket, socket-end, socket-error: the socket of the connection, with its local address.
// - connected: that socket. The TCP client of the harness names its own socket so.
// - connection, channel: each event of the connection (error, close, blocked, unblocked) and of
//   the channel (error, close), with the error as data.
// - ready: the reply to operation 1: the connection is idle (idle, inflight), or the stream starts.
// - sent, ack, fail: each operation by its sequence number, with its error.
// - data, error: the end of the operation in flight, as the TCP client of the harness tells it. In
//   idle mode, the first error of the connection is an error line too. The errno of an error line
//   is the error of the connection when it has one: the RPC itself fails only with 'Channel ended'.
// - done, deadline: the end of the client.
//
// The modes: idle does operation 1, then holds until --max-s. inflight does operation 1, waits for
// the file --go, does one more operation into the fault, and holds after its end. stream does an
// operation each --interval-ms after the reply before, until --max-s or SIGTERM. --before starts the
// client into a fault that holds already: its connect meets it.

import { existsSync, readFileSync } from "node:fs";

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
  emit("fail", { why: "client-amqp HOST PORT --mode idle|inflight|stream" });
  process.exit(1);
}
const interval = Number(flag("--interval-ms") ?? 50);
const max = Number(flag("--max-s") ?? 120) * 1000;
const go = flag("--go") ?? "/tmp/go";
const before = argv.includes("--before");
// the options of the connection. A cell gives each option that it changes, and amqplib gives the others
const options = JSON.parse(flag("--options") ?? "{}");
const { heartbeat, user = "guest", password = "guest", ...socketOptions } = options;

const { default: amqp } = await import("amqplib");
const versionOf = (name) => JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), "utf8")).version;

const bootId = () => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
};
emit("start", { boot_id: bootId(), client: "amqp", driver: versionOf("amqplib"), node: process.versions.node, mode, options });

const url = `amqp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${heartbeat === undefined ? "" : `?heartbeat=${heartbeat}`}`;

/** This function gives the error of amqplib as data: its name, its code and its message. */
const failure = (error) => (error === undefined || error === null ? null : { name: error.name, code: error.code ?? null, message: error.message });
/** This function gives the errno of an error: the code of the socket (ECONNRESET), the reply code of the broker, or the message of amqplib. */
const errnoOf = (error) => error?.code ?? error?.message ?? null;

// ---- the connection and its channel
let connection = null;
let channel = null;
// the queue of the client: the broker names it at operation 1
let queue = null;
// the first error of the connection: the cause of the failure of an RPC in flight
let cause = null;
const open = async () => {
  connection = await amqp.connect(url, socketOptions);
  const socket = connection.connection.stream;
  const local = `${socket.localAddress}:${socket.localPort}`;
  emit("socket", { role: "connection", local });
  emit("connected", { local });
  socket.once("close", (hadError) => emit("socket-end", { role: "connection", local, error: hadError }));
  socket.once("error", (error) => emit("socket-error", { role: "connection", local, errno: errnoOf(error), message: error.message }));
  // the first end of the connection: its error, or its close. The connection in idle mode: that
  // end is the detection, as for the TCP client
  const ended = (error) => {
    if (cause !== null) return;
    cause = error;
    if (mode === "idle") emit("error", { errno: errnoOf(error), message: error.message });
  };
  // amqplib emits each error once, then its close. Without a listener, Node throws the error
  connection.on("error", (error) => {
    emit("connection", { event: "error", failure: failure(error) });
    ended(error);
  });
  // a close of the broker with 320 (CONNECTION_FORCED) is not an error for amqplib: only its close tells
  connection.on("close", (error) => {
    emit("connection", { event: "close", failure: failure(error) });
    if (!stopped) ended(error ?? new Error("Connection closed"));
  });
  connection.on("blocked", (reason) => emit("connection", { event: "blocked", reason }));
  connection.on("unblocked", () => emit("connection", { event: "unblocked" }));
  channel = await connection.createChannel();
  channel.on("error", (error) => emit("channel", { event: "error", failure: failure(error) }));
  channel.on("close", () => emit("channel", { event: "close" }));
};

// ---- the end of the client
let stopped = false;
const stop = (code = 0) => {
  if (stopped) return;
  stopped = true;
  emit("done");
  const closing = connection === null ? Promise.resolve() : connection.close().catch(() => undefined);
  // a dead connection does not answer its close: the client does not wait for it
  Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 1000))]).finally(() => setTimeout(() => process.exit(code), 50));
};
process.on("SIGTERM", () => stop(0));
setTimeout(() => {
  emit("deadline");
  stop(0);
}, max);

/** This function does operation n. Its stamp is before the call. It gives null for a reply, or the error. */
const operate = async (n) => {
  const at = now();
  // a band of a cell that starts into a fault counts from the start of the connect
  if (n === 1) emit("connecting", { at: `${host}:${port}` }, at);
  emit("sent", { n }, at);
  try {
    if (n === 1) {
      await open();
      ({ queue } = await channel.assertQueue("", { durable: false, exclusive: true }));
    } else {
      await channel.checkQueue(queue);
    }
    emit("ack", { n });
    return null;
  } catch (error) {
    emit("fail", { n, ...failure(error) });
    return error;
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (mode === "stream") {
  const failed = await operate(1);
  if (failed === null) {
    emit("ready", { at: `${host}:${port}` });
    for (let n = 2; !stopped; n += 1) {
      if ((await operate(n)) !== null) break;
      await sleep(interval);
    }
  } else {
    emit("error", { errno: errnoOf(cause ?? failed), message: (cause ?? failed).message });
    stop(1);
  }
} else {
  // operation 1 makes the connection. Its reply is the last data before the fault
  const failed = await operate(1);
  if (failed !== null) {
    emit("error", { errno: errnoOf(cause ?? failed), message: (cause ?? failed).message });
    stop(before ? 0 : 1);
  } else {
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
      else emit("error", { errno: errnoOf(cause ?? error), message: (cause ?? error).message });
    }
  }
}
