// client-mongo HOST PORT --mode idle|inflight|stream [--hosts H:P,H:P] [--set NAME] [--op write|read-long]
//              [--interval-ms N] [--max-s N] [--go PATH] [--w majority|1] [--before] [--options JSON]
//
// The client of a MongoDB cell: the driver mongodb 7.7.0 on Node 24.21.0, against a replica set.
// Each event is a JSON line with `ev` and `t`, the time on CLOCK_MONOTONIC in nanoseconds
// (process.hrtime, which libuv reads from it). The prober stamps the records of the kernel on the
// same clock, and the injector stamps each fault on it.
//
// The lines:
// - start: the version of the driver and of Node, the mode and the options.
// - clocks: the wall clock in ms beside the monotonic clock, each second. The log of mongod is on
//   the wall clock, and these lines put it on the monotonic clock.
// - socket, socket-end, socket-error: each socket of the driver by its role (monitor, rtt, pool),
//   with its local address. The role comes from the stack of the call that makes the socket.
// - connected: the first socket of the pool. The TCP client of the harness names its own socket so.
// - sdam: each heartbeat, each change of the description of a server, and each change of the topology.
// - cmap: each event of a connection pool, and each clear with its interruption of connections in use.
// - command: each try of an operation, with its server. A retry is a second try with the same number.
// - connecting: the start of the selection of the first server.
// - ready: the reply to the first write once the monitor streams (idle, inflight), or the
//   connection of the client (stream).
// - sent, ack, fail: each operation by its sequence number, with its server or its error and labels.
// - data, error: the end of the operation in flight, as the TCP client of the harness tells it.
//   In idle mode, an error of the socket of the first pool connection is an error line too.
// - done, deadline: the end of the client.
//
// The modes: idle sends one write, then holds the connections until --max-s. inflight sends one
// write, waits for the file --go, sends one more operation into the fault, and holds the
// connections after its end. stream sends a write each --interval-ms after the reply before, until
// --max-s or SIGTERM. --before starts the client into a fault that holds already: its first
// selection meets it.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";

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
  emit("fail", { why: "client-mongo HOST PORT --mode idle|inflight|stream" });
  process.exit(1);
}
const first = `${host}:${port}`;
const hosts = [first, ...(flag("--hosts") ?? "").split(",").filter((each) => each !== "" && each !== first)];
const set = flag("--set") ?? "rs0";
const op = flag("--op") ?? "write";
const interval = Number(flag("--interval-ms") ?? 50);
const max = Number(flag("--max-s") ?? 120) * 1000;
const go = flag("--go") ?? "/tmp/go";
const w = flag("--w") === "1" ? 1 : "majority";
const before = argv.includes("--before");
const options = JSON.parse(flag("--options") ?? "{}");

// ---- the two clocks: the wall clock of a log line of mongod goes onto the monotonic clock by them
const clocks = () => {
  const t = now();
  emit("clocks", { real: Date.now() }, t);
};
clocks();
setInterval(clocks, 1000).unref();

// ---- each socket of the driver, by its role: the stack of the call that makes it names the caller
const roleOf = (stack) => {
  if (/measureRoundTripTime/.test(stack)) return "rtt";
  if (/sdam[\\/]monitor\.js/.test(stack)) return "monitor";
  if (/cmap[\\/]connection_pool\.js/.test(stack)) return "pool";
  return "other";
};
let connected = null;
const createConnection = net.createConnection;
Error.stackTraceLimit = 50;
net.createConnection = function (...args) {
  const role = roleOf(new Error().stack ?? "");
  const socket = createConnection.apply(this, args);
  const server = `${args[0]?.host}:${args[0]?.port}`;
  socket.once("connect", () => {
    const local = `${socket.localAddress}:${socket.localPort}`;
    emit("socket", { role, server, local });
    if (role === "pool" && connected === null) {
      connected = local;
      emit("connected", { local });
    }
    socket.once("close", (hadError) => emit("socket-end", { role, server, local, error: hadError }));
  });
  socket.once("error", (error) => {
    const local = socket.localPort === undefined ? null : `${socket.localAddress}:${socket.localPort}`;
    const errno = error.code ?? error.errno ?? null;
    emit("socket-error", { role, server, local, errno, message: error.message });
    // the socket of the client in idle mode: its error is the detection, as for the TCP client
    if (mode === "idle" && local !== null && local === connected) emit("error", { errno });
  });
  return socket;
};

// the driver loads after the patch, thus each of its sockets goes through it
const { MongoClient } = await import("mongodb");
const version = JSON.parse(readFileSync(new URL("./node_modules/mongodb/package.json", import.meta.url), "utf8")).version;

const bootId = () => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
};
emit("start", { boot_id: bootId(), client: "mongodb", driver: version, node: process.versions.node, mode, op, w, hosts, options });

const uri = `mongodb://${hosts.join(",")}/?replicaSet=${set}`;
const client = new MongoClient(uri, { ...options, writeConcern: { w }, monitorCommands: true });

// ---- the driver's own events, each stamped as the driver emits it
const failure = (error) =>
  error === undefined || error === null
    ? null
    : { name: error.name, code: error.code ?? null, labels: [...(error.errorLabelSet ?? [])], message: error.message };
const describe = (d) =>
  d === undefined ? null : { type: d.type, setName: d.setName ?? null, electionId: d.electionId?.toHexString?.() ?? null, error: failure(d.error) };
/** This promise resolves at the first awaited hello of a monitor: the stream of the monitor has begun. */
let streamed = () => undefined;
const streaming = new Promise((resolve) => {
  streamed = resolve;
});
client.on("serverHeartbeatStarted", (e) => {
  emit("sdam", { event: "heartbeat-started", address: e.connectionId, awaited: e.awaited });
  if (e.awaited) streamed();
});
client.on("serverHeartbeatSucceeded", (e) =>
  emit("sdam", { event: "heartbeat-succeeded", address: e.connectionId, awaited: e.awaited, duration: e.duration, primary: e.reply?.isWritablePrimary ?? null }),
);
client.on("serverHeartbeatFailed", (e) =>
  emit("sdam", { event: "heartbeat-failed", address: e.connectionId, awaited: e.awaited, duration: e.duration, failure: failure(e.failure) }),
);
client.on("serverDescriptionChanged", (e) =>
  emit("sdam", { event: "server-changed", address: e.address, previous: describe(e.previousDescription), next: describe(e.newDescription) }),
);
client.on("topologyDescriptionChanged", (e) => {
  const primary = [...e.newDescription.servers.values()].find((d) => d.type === "RSPrimary")?.address ?? null;
  emit("sdam", { event: "topology-changed", type: e.newDescription.type, primary });
});
client.on("serverOpening", (e) => emit("sdam", { event: "server-opening", address: e.address }));
client.on("serverClosed", (e) => emit("sdam", { event: "server-closed", address: e.address }));
for (const [event, name] of [
  ["connectionPoolCreated", "pool-created"],
  ["connectionPoolReady", "pool-ready"],
  ["connectionPoolClosed", "pool-closed"],
  ["connectionCreated", "created"],
  ["connectionReady", "connection-ready"],
  ["connectionCheckOutStarted", "checkout-started"],
  ["connectionCheckedOut", "checked-out"],
  ["connectionCheckedIn", "checked-in"],
]) {
  client.on(event, (e) => emit("cmap", { event: name, address: e.address, connectionId: e.connectionId ?? null }));
}
client.on("connectionPoolCleared", (e) => emit("cmap", { event: "pool-cleared", address: e.address, interruptInUseConnections: e.interruptInUseConnections ?? false }));
client.on("connectionClosed", (e) => emit("cmap", { event: "closed", address: e.address, connectionId: e.connectionId, reason: e.reason, failure: failure(e.error) }));
client.on("connectionCheckOutFailed", (e) => emit("cmap", { event: "checkout-failed", address: e.address, reason: e.reason, failure: failure(e.error) }));

/** This function gives the sequence number of an operation from its comment. */
const numberOf = (command) => {
  const match = /^[wr]:(\d+)$/.exec(String(command?.comment ?? ""));
  return match === null ? null : Number(match[1]);
};
const started = new Map();
/** This map holds the server of the last try of each operation that succeeded, by its sequence number. */
const lastServer = new Map();
client.on("commandStarted", (e) => {
  const n = numberOf(e.command);
  if (n === null) return;
  started.set(e.requestId, n);
  emit("command", { event: "started", name: e.commandName, n, address: e.address, connectionId: e.connectionId, requestId: e.requestId });
});
client.on("commandSucceeded", (e) => {
  if (!started.has(e.requestId)) return;
  const n = started.get(e.requestId);
  started.delete(e.requestId);
  lastServer.set(n, e.address);
  emit("command", { event: "succeeded", name: e.commandName, n, address: e.address, requestId: e.requestId, duration: e.duration });
});
client.on("commandFailed", (e) => {
  if (!started.has(e.requestId)) return;
  const n = started.get(e.requestId);
  started.delete(e.requestId);
  emit("command", { event: "failed", name: e.commandName, n, address: e.address, requestId: e.requestId, duration: e.duration, failure: failure(e.failure) });
});

// ---- the end of the client
let stopped = false;
const stop = (code = 0) => {
  if (stopped) return;
  stopped = true;
  emit("done");
  client.close().finally(() => setTimeout(() => process.exit(code), 50));
};
process.on("SIGTERM", () => stop(0));
setTimeout(() => {
  emit("deadline");
  stop(0);
}, max);

const collection = client.db("cells").collection("w");
// the writes of one client: each run starts its numbers at 1, and the field `run` keeps them apart
const run = randomUUID();

/**
 * This function sends operation n: a write of its sequence number, or the read of the long
 * document. Its stamp is before the call. It gives null for a reply, or the error.
 */
const operate = async (n) => {
  const at = now();
  const kind = op === "read-long" && mode === "inflight" && n > 1 ? "read" : "write";
  const reply = kind === "read" ? collection.findOne({ _id: "long" }, { comment: `r:${n}` }) : collection.insertOne({ n, run }, { comment: `w:${n}` });
  emit("sent", { n, kind }, at);
  try {
    const answer = await reply;
    emit("ack", { n, kind, at: lastServer.get(n) ?? null, bytes: kind === "read" ? JSON.stringify(answer ?? {}).length : 0 });
    return null;
  } catch (error) {
    emit("fail", { n, kind, ...failure(error) });
    return error;
  }
};

emit("connecting", { hosts });
try {
  await client.connect();
} catch (error) {
  emit("fail", { why: "connect", ...failure(error) });
  emit("error", { errno: error.name, message: error.message });
  stop(before ? 0 : 1);
}
if (stopped) await new Promise(() => undefined);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (mode === "stream") {
  emit("ready", { at: first });
  for (let n = 1; !stopped; n += 1) {
    await operate(n);
    await sleep(interval);
  }
} else {
  // the first write makes the connection of the pool. Its reply is the last data before the fault
  const failed = await operate(1);
  if (failed !== null) {
    emit("error", { errno: failed.name, message: failed.message });
    stop(1);
  } else {
    // the monitor sends its first awaited hello minHeartbeatFrequencyMS after its first check. A
    // fault before that hello meets the start of the stream, not the stream that a cell measures
    const awaited = await Promise.race([streaming.then(() => true), sleep(5000).then(() => false)]);
    emit("ready", { reply: "ack", streaming: awaited });
    if (mode === "inflight") {
      await new Promise((resolve) => {
        const wait = setInterval(() => {
          if (!existsSync(go)) return;
          clearInterval(wait);
          resolve();
        }, 2);
      });
      const error = await operate(2);
      if (error === null) emit("data", { n: 1 });
      else emit("error", { errno: error.name, message: error.message });
    }
  }
}
