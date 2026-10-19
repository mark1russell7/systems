// client-cluster HOSTS --queue NAME [--interval-ms N] [--max-s N] [--reconnect-ms N] [--options JSON]
//
// The client of a cluster cell of RabbitMQ: amqplib 2.2.0 on Node 24.21.0, as an application publishes
// with it. It publishes a stream of sequence numbers to one quorum queue on a confirm channel, one at
// a time, --interval-ms after the confirm of the one before. Each event is a JSON line with `ev` and
// `t`, the time on CLOCK_MONOTONIC in nanoseconds (process.hrtime, which libuv reads from it). The
// prober stamps the records of the kernel on the same clock, and the injector stamps each fault on it.
//
// HOSTS is host:port,host:port,... in the sequence of the connects: the first is the node of the
// client. amqplib connects to one node and does not connect again by itself. When the connection ends,
// this client connects to the next node of the list after --reconnect-ms (1000 ms), as an application
// does. Then it publishes again the sequence number that has no confirm.
//
// The options (--options JSON): `heartbeat` in seconds goes in the URL. Without it, amqplib takes the
// heartbeat that the broker proposes. `user` and `password` are the user of the broker: guest, as
// amqplib gives it, when the options name none.
//
// The lines:
// - start: the versions of amqplib and Node, the hosts and the options. clocks: the wall clock.
// - connecting: each connect, with its node. socket, socket-end, socket-error: the socket of each
//   connection, with its local address and its node. connected: that socket.
// - connection, channel: each event of the connection (error, close, blocked, unblocked) and of the
//   channel (error, close), with the error as data.
// - ready: the first channel is open, and the stream starts.
// - sent, ack, fail: each publish by its sequence number and the node that it went through. An ack is
//   the confirm (basic.ack). A fail is a nack, or a channel that closed before the confirm.
// - done, deadline: the end of the client.

import { readFileSync } from "node:fs";

const now = () => process.hrtime.bigint();
const emit = (ev, fields = {}, at = now()) => process.stdout.write(`${JSON.stringify({ ev, t: Number(at), ...fields })}\n`);

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const hosts = (argv[0] ?? "").split(",").filter((each) => each !== "");
const queue = flag("--queue");
if (hosts.length === 0 || queue === undefined) {
  emit("fail", { why: "client-cluster HOST:PORT,... --queue NAME" });
  process.exit(1);
}
const interval = Number(flag("--interval-ms") ?? 50);
const max = Number(flag("--max-s") ?? 120) * 1000;
const reconnect = Number(flag("--reconnect-ms") ?? 1000);
const options = JSON.parse(flag("--options") ?? "{}");
const { heartbeat, user = "guest", password = "guest" } = options;

const { default: amqp } = await import("amqplib");
const versionOf = (name) => JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), "utf8")).version;
const bootId = () => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
};
emit("start", { boot_id: bootId(), client: "amqp-cluster", driver: versionOf("amqplib"), node: process.versions.node, hosts, queue, options });
// the wall clock beside the monotonic one: the run puts the log lines of the nodes on the monotonic clock
const clocks = () => emit("clocks", { real: Date.now() });
clocks();
setInterval(clocks, 1000).unref();

const urlOf = (at) => `amqp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${at}/${heartbeat === undefined ? "" : `?heartbeat=${heartbeat}`}`;
const failure = (error) => (error === undefined || error === null ? null : { name: error.name, code: error.code ?? null, message: error.message });
const errnoOf = (error) => error?.code ?? error?.message ?? null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let stopped = false;
let connection = null;
let channel = null;
// the node of the connection that is open now, and the place of the next connect in the list
let at = null;
let next = 0;
// this promise ends when the connection that is open now ends
let ended = null;

/** This function connects to the next node of the list and opens a confirm channel. It gives false when the connect fails. */
const open = async () => {
  const node = hosts[next % hosts.length];
  next += 1;
  emit("connecting", { at: node });
  try {
    connection = await amqp.connect(urlOf(node));
  } catch (error) {
    emit("connection", { event: "connect-failed", at: node, errno: errnoOf(error), failure: failure(error) });
    return false;
  }
  const socket = connection.connection.stream;
  const local = `${socket.localAddress}:${socket.localPort}`;
  emit("socket", { role: "connection", local, server: node });
  emit("connected", { local, at: node });
  socket.once("close", (hadError) => emit("socket-end", { role: "connection", local, server: node, error: hadError }));
  socket.once("error", (error) => emit("socket-error", { role: "connection", local, server: node, errno: errnoOf(error), message: error.message }));
  let finish;
  ended = new Promise((resolve) => (finish = resolve));
  // amqplib emits each error once, then its close. Without a listener, Node throws the error
  connection.on("error", (error) => emit("connection", { event: "error", at: node, failure: failure(error) }));
  // a close of the broker with 320 (CONNECTION_FORCED) is not an error for amqplib: only its close tells
  connection.on("close", (error) => {
    emit("connection", { event: "close", at: node, failure: failure(error) });
    finish();
  });
  connection.on("blocked", (reason) => emit("connection", { event: "blocked", at: node, reason }));
  connection.on("unblocked", () => emit("connection", { event: "unblocked", at: node }));
  try {
    channel = await connection.createConfirmChannel();
  } catch (error) {
    emit("channel", { event: "open-failed", at: node, failure: failure(error) });
    return false;
  }
  channel.on("error", (error) => emit("channel", { event: "error", at: node, failure: failure(error) }));
  channel.on("close", () => emit("channel", { event: "close", at: node }));
  at = node;
  return true;
};

/** This function publishes n and waits for its confirm. It gives null for a confirm, or the error. */
const publish = (n) =>
  new Promise((resolve) => {
    const through = at;
    emit("sent", { n, at: through });
    try {
      channel.sendToQueue(queue, Buffer.from(String(n)), { persistent: true }, (error) => {
        if (error === null || error === undefined) {
          emit("ack", { n, at: through });
          resolve(null);
        } else {
          emit("fail", { n, at: through, ...failure(error) });
          resolve(error);
        }
      });
    } catch (error) {
      emit("fail", { n, at: through, ...failure(error) });
      resolve(error);
    }
  });

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

let ready = false;
let n = 1;
while (!stopped) {
  if (channel === null) {
    if (!(await open())) {
      channel = null;
      await sleep(reconnect);
      continue;
    }
    if (!ready) {
      ready = true;
      emit("ready", { at });
    }
  }
  // a publish ends at its confirm, at a nack, or at the close of its channel
  const failed = await publish(n);
  if (failed === null) {
    n += 1;
    await sleep(interval);
    continue;
  }
  // the same sequence number goes again: on the same channel after a nack, or on the next node after an end
  if (failed.message === "message nacked") {
    await sleep(interval);
    continue;
  }
  // the channel closed: its connection ends with it, or after one more wait the client ends the connection
  const closing = connection;
  await Promise.race([ended, sleep(reconnect)]);
  closing?.close().catch(() => undefined);
  channel = null;
  connection = null;
  if (!stopped) await sleep(reconnect);
}
