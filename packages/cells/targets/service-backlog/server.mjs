// server --port N
//
// The target of the cells of a declared backlog (SYS-103): the http.Server of Node 24.21.0 under
// httpTransport of @mark1russell7/service, from npm, with the knob server_listen_backlog. The
// protocol is that of the target of the native program `queue` of the harness. Thus its client
// operates this target with no change.
//
// - The main thread holds the listener. It blocks in Atomics.wait between two commands, thus its
//   event loop does not run, and Node accepts no connection. The kernel queue fills, as it does for
//   a service whose event loop is busy.
// - A worker (control.mjs) serves the control port, PORT + 1. It reads the queue each 5 ms and writes
//   a `queue` line for each change.
// - `open BACKLOG` starts a new transport with the knob, on 0.0.0.0. The transport gives the knob to
//   server.listen, and Node gives it to listen(2). Thus the limit of the record is the limit that the
//   kernel got, after Node and after somaxconn.
// - `accept COUNT` runs the event loop until no new connection comes in 50 ms. Node accepts each
//   connection of the queue in one turn of its loop, thus the reply names each one, not COUNT.
//
// Node calls listen(2) with `backlog || 511` (lib/net.js of Node 24.21.0, line 2325). Thus a
// backlog of 0 gives the kernel 511 in service 0.7.3. A later service refuses the knob 0, and the
// reply of `open` then has the error.

import http from "node:http";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { httpTransport } from "@mark1russell7/service/http";
import { detachedLifecycle } from "@mark1russell7/service/testing";
import manifest from "@mark1russell7/service/package.json" with { type: "json" };
import { emit } from "./emit.mjs";

const argv = process.argv.slice(2);
const at = argv.indexOf("--port");
const port = Number(at === -1 ? 6390 : argv[at + 1]);

const s = (value) => ({ value, unit: "s" });
const count = (value) => ({ value, unit: "count" });
/** These are the other knobs of the transport. No request comes, thus their values do not change a record. */
const KNOBS = { server_idle_close: s(65), server_idle_sweep_interval: s(1), server_retry_after: s(1) };
/** A turn of the event loop with no new connection for this time ends an accept. */
const QUIET_MS = 50;

/** The worker sets the word to 1 for each command, and the main thread waits on it. */
const flag = new Int32Array(new SharedArrayBuffer(4));
const { port1: commands, port2: theirs } = new MessageChannel();

/** This is the listener of the run, its connections, and the peers that it accepted since the last accept. */
let current;

const close = async () => {
  if (current === undefined) return;
  const { server, sockets } = current;
  current = undefined;
  for (const socket of sockets) socket.destroy();
  // the close of the listener resets each connection that the queue still holds
  await new Promise((resolve) => server.close(() => resolve()));
};

const open = async (backlog) => {
  await close();
  const server = http.createServer();
  const sockets = new Set();
  const fresh = [];
  server.on("connection", (socket) => {
    sockets.add(socket);
    fresh.push(socket.remotePort);
    socket.on("close", () => sockets.delete(socket));
  });
  const transport = httpTransport(server, { ...KNOBS, server_listen_backlog: count(backlog) }, { listen: { port, host: "0.0.0.0" } });
  await transport.start(new AbortController().signal, detachedLifecycle());
  current = { server, sockets, fresh };
  return { opened: true };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const accept = async () => {
  if (current === undefined) return { error: "no listener" };
  let seen = -1;
  while (current.fresh.length !== seen) {
    seen = current.fresh.length;
    await sleep(QUIET_MS);
  }
  return { peers: current.fresh.splice(0) };
};

const HANDLERS = { open, accept };

const worker = new Worker(new URL("./control.mjs", import.meta.url), { workerData: { port, flag, channel: theirs }, transferList: [theirs] });
worker.on("error", (error) => {
  emit("fail", { why: `the control worker failed: ${error.message}` });
  process.exit(1);
});
await new Promise((resolve) => worker.once("message", resolve));
emit("listening", { control: port + 1, service: manifest.version, node: process.version });

for (;;) {
  // the event loop stops here, thus Node accepts nothing until the next command
  Atomics.wait(flag, 0, 0);
  Atomics.store(flag, 0, 0);
  const got = receiveMessageOnPort(commands);
  if (got === undefined) continue;
  const { command, number } = got.message;
  let reply;
  try {
    reply = await HANDLERS[command](number);
  } catch (error) {
    reply = { error: error instanceof Error ? error.message : String(error) };
  }
  commands.postMessage(reply);
}
