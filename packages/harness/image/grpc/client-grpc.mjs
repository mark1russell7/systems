// client-grpc HOST PORT --mode idle|inflight|stream [--interval-ms N] [--max-s N] [--go PATH] [--before]
//             [--options JSON] [--hold-ms N] [--op check|watch]
//
// The client of a gRPC cell: grpc-js 1.14.6 on Node 24.21.0, with one channel to one server and no TLS.
// Each event is a JSON line with `ev` and `t`, the time on CLOCK_MONOTONIC in nanoseconds
// (process.hrtime, which libuv reads from it). The prober stamps the records of the kernel on the
// same clock, and the injector stamps each fault on it.
//
// Each operation is a unary call of grpc.health.v1.Health/Check, with no deadline and no
// waitForReady at the defaults: the health service of grpc-go and of etcd answers at once with
// SERVING. The messages are encoded here: a HealthCheckRequest has one string (field 1), and a
// HealthCheckResponse has one enum (field 1). Operation 1 makes the connection: the channel connects
// at its first call. With --hold-ms, the call in flight asks for the service `hold:<ms>`, and the
// server of the harness holds its reply for that time. Another server answers NOT_FOUND to it.
// With --op watch, the operation in flight is a stream of grpc.health.v1.Health/Watch. The server sends
// SERVING, and the stream stays open: a stream for the policy of a server for the PINGs of a client.
//
// The options (--options JSON): each name that starts with `grpc.` is a channel option of grpc-js,
// for example grpc.keepalive_time_ms. `deadline_ms` is the deadline of each call.
//
// The lines:
// - start: the versions of grpc-js and Node, the mode and the options.
// - connecting: the start of operation 1. Its stamp is the stamp of the first sent line.
// - socket, socket-eof, socket-end, socket-error: each TCP socket of the channel, with its local
//   address. connect-error: a connect that failed, with its error.
// - connected: the first of them. The TCP client of the harness names its own socket so.
// - state: each change of the connectivity state of the channel.
// - log: a line that grpc-js logs, for example the refusal of its PINGs by the server. That refusal
//   (a GOAWAY with too_many_pings) is the cause of the end of the connection: its errno is too_many_pings.
// - watch-data: each message of the stream of a Watch.
// - ready: the reply to operation 1: the channel is idle (idle, inflight), or the stream starts.
// - sent, ack, fail: each operation by its sequence number, with its status.
// - data, error: the end of the operation in flight, as the TCP client of the harness tells it. In
//   idle mode, the first end of the connected socket is an error line too. The errno of an error
//   line is the error of the socket when it has one (ECONNRESET), EOF for an end of the socket by
//   the server, or the status of the call (UNAVAILABLE).
// - done, deadline: the end of the client.
//
// The modes: idle does operation 1, then holds until --max-s. inflight does operation 1, waits for
// the file --go, does one more operation into the fault, and holds after its end. stream does an
// operation each --interval-ms after the end of the one before, until --max-s or SIGTERM: grpc-js
// connects again by itself, thus the stream goes on after a failed call. --before starts the client
// into a fault that holds already: its connect meets it.

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
  emit("fail", { why: "client-grpc HOST PORT --mode idle|inflight|stream" });
  process.exit(1);
}
const interval = Number(flag("--interval-ms") ?? 50);
const max = Number(flag("--max-s") ?? 120) * 1000;
const go = flag("--go") ?? "/tmp/go";
const before = argv.includes("--before");
const hold = flag("--hold-ms");
const op = flag("--op") ?? "check";
if (op !== "check" && op !== "watch") {
  emit("fail", { why: "--op check|watch" });
  process.exit(1);
}
// the options of the channel. A cell gives each option that it changes, and grpc-js gives the others
const options = JSON.parse(flag("--options") ?? "{}");
const { deadline_ms: deadlineMs, ...channelOptions } = options;
const unknown = Object.keys(channelOptions).filter((name) => !name.startsWith("grpc.") && !name.startsWith("grpc-node."));
if (unknown.length > 0) {
  emit("fail", { why: `options that are not channel options of grpc-js: ${unknown.join(", ")}` });
  process.exit(1);
}

// ---- each TCP socket of the channel: grpc-js connects with net.connect (transport.ts:830), on the
// module object that this patch changes. It loads after the patch
let connected = null;
// the first end of the connected socket: the cause of the end of the call in flight
let cause = null;
const connect = net.connect;
net.connect = function (...args) {
  const socket = connect.apply(this, args);
  let established = false;
  socket.once("connect", () => {
    established = true;
    const local = `${socket.localAddress}:${socket.localPort}`;
    emit("socket", { role: "connection", local });
    const first = connected === null;
    if (first) {
      connected = local;
      emit("connected", { local });
    }
    let failed = null;
    socket.once("error", (error) => {
      failed = error.code ?? error.errno ?? error.message;
      emit("socket-error", { role: "connection", local, errno: failed, message: error.message });
    });
    socket.once("end", () => emit("socket-eof", { role: "connection", local }));
    socket.once("close", (hadError) => {
      emit("socket-end", { role: "connection", local, error: hadError });
      if (!first || cause !== null || stopped) return;
      // the end of the connected socket: an error of its own, the end by the server, or the end by grpc-js
      cause = { errno: failed ?? (socket.readableEnded ? "EOF" : "CLOSED") };
      if (mode === "idle") emit("error", { errno: cause.errno });
    });
  });
  // a connect that fails: the reset of the SYN, or a give-up of the kernel. The socket has no
  // connection, thus its line is not a socket line
  socket.once("error", (error) => {
    if (!established) emit("connect-error", { errno: error.code ?? error.errno ?? null, message: error.message });
  });
  return socket;
};

const grpc = await import("@grpc/grpc-js");
const version = JSON.parse(readFileSync(new URL("./node_modules/@grpc/grpc-js/package.json", import.meta.url), "utf8")).version;
// each line that grpc-js logs, with no trace: an error of a subchannel, or the doubled keepalive after
// too_many_pings. grpc-js logs that refusal when the GOAWAY comes, before the end of the socket (subchannel.ts:280-289)
grpc.setLogger({
  error: (...parts) => {
    const text = parts.map(String).join(" ");
    emit("log", { text });
    if (/excess pings/.test(text) && cause === null && !stopped) {
      cause = { errno: "too_many_pings" };
      if (mode === "idle") emit("error", { errno: cause.errno });
    }
  },
});
grpc.setLogVerbosity(grpc.logVerbosity.ERROR);

const bootId = () => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
};
emit("start", { boot_id: bootId(), client: "grpc", driver: version, node: process.versions.node, mode, op, options, hold: hold === undefined ? null : Number(hold) });

// ---- the messages of grpc.health.v1, encoded by hand
const encodeRequest = (service) => {
  const bytes = Buffer.from(service, "utf8");
  if (bytes.length > 127) throw new Error("a service name of more than 127 bytes");
  return bytes.length === 0 ? Buffer.alloc(0) : Buffer.concat([Buffer.from([0x0a, bytes.length]), bytes]);
};
const SERVING = ["UNKNOWN", "SERVING", "NOT_SERVING", "SERVICE_UNKNOWN"];
const decodeResponse = (buffer) => ({ status: buffer.length >= 2 && buffer[0] === 0x08 ? (SERVING[buffer[1]] ?? buffer[1]) : "UNKNOWN" });

const client = new grpc.Client(`${host}:${port}`, grpc.credentials.createInsecure(), channelOptions);
const channel = client.getChannel();
const STATES = ["IDLE", "CONNECTING", "READY", "TRANSIENT_FAILURE", "SHUTDOWN"];
const watch = (state) =>
  channel.watchConnectivityState(state, Infinity, () => {
    const next = channel.getConnectivityState(false);
    emit("state", { from: STATES[state], to: STATES[next] });
    if (next !== grpc.connectivityState.SHUTDOWN) watch(next);
  });
watch(channel.getConnectivityState(false));

/** This function gives the status of a failed call as data: its code, its name and its details. */
const failure = (error) => ({ code: error.code ?? null, name: grpc.status[error.code] ?? null, details: error.details ?? error.message });

// ---- the end of the client
let stopped = false;
const stop = (code = 0) => {
  if (stopped) return;
  stopped = true;
  emit("done");
  client.close();
  setTimeout(() => process.exit(code), 50);
};
process.on("SIGTERM", () => stop(0));
setTimeout(() => {
  emit("deadline");
  stop(0);
}, max);

/** This function does operation n. Its stamp is before the call. It gives null for a reply, or the error. */
const operate = (n, service = "") =>
  new Promise((resolve) => {
    const at = now();
    // a band of a cell that starts into a fault counts from the start of the connect
    if (n === 1) emit("connecting", { at: `${host}:${port}` }, at);
    emit("sent", { n, service }, at);
    const callOptions = deadlineMs === undefined ? {} : { deadline: Date.now() + deadlineMs };
    client.makeUnaryRequest("/grpc.health.v1.Health/Check", encodeRequest, decodeResponse, service, new grpc.Metadata(), callOptions, (error, reply) => {
      if (error === null || error === undefined) {
        emit("ack", { n, status: reply.status });
        resolve(null);
      } else {
        emit("fail", { n, ...failure(error) });
        resolve(error);
      }
    });
  });

/** This function opens the stream of a Watch as operation n. It gives null when the server ends the stream, or the error. */
const watchOf = (n) =>
  new Promise((resolve) => {
    emit("sent", { n, op: "watch" });
    const stream = client.makeServerStreamRequest("/grpc.health.v1.Health/Watch", encodeRequest, decodeResponse, "", new grpc.Metadata(), {});
    stream.on("data", (reply) => emit("watch-data", { n, status: reply.status }));
    stream.on("error", (error) => {
      emit("fail", { n, ...failure(error) });
      resolve(error);
    });
    stream.on("end", () => {
      emit("ack", { n });
      resolve(null);
    });
  });

/** This function gives the errno of the end of a call: the end of its socket when it has one, else its status. */
const errnoOf = (error) => cause?.errno ?? grpc.status[error.code] ?? error.message;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (mode === "stream") {
  const failed = await operate(1);
  if (failed === null) {
    emit("ready", { at: `${host}:${port}` });
    for (let n = 2; !stopped; n += 1) {
      await operate(n);
      await sleep(interval);
    }
  } else {
    emit("error", { errno: errnoOf(failed), message: failed.details ?? failed.message });
    stop(1);
  }
} else {
  // operation 1 makes the connection. Its reply is the last data before the fault
  const failed = await operate(1);
  if (failed !== null) {
    emit("error", { errno: errnoOf(failed), message: failed.details ?? failed.message });
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
      const error = op === "watch" ? await watchOf(2) : await operate(2, hold === undefined ? "" : `hold:${hold}`);
      if (error === null) emit("data", { n: 2 });
      else emit("error", { errno: errnoOf(error), message: error.details ?? error.message });
    }
  }
}
