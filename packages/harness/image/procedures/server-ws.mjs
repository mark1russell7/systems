// server-ws --port N --tcp-keepalive off|N --heartbeat off|on [--heartbeat-interval-ms N --heartbeat-misses N]
//
// A cell's target: the procedures server of @procedures/client 0.7.0 (Server and
// WebSocketServerTransport) on the http.Server of Node 24.21.0, at the path /ws. It has two
// procedures: `harness.echo` answers at once, and `harness.hold` answers after `ms` milliseconds
// (a held reply, as BLPOP is for Redis).
//
// --tcp-keepalive is the keepalive of each accepted socket: off, or its idle time in ms. Node's
// default is off (keepAlive of http.Server), and the cell says it.
//
// --heartbeat is the heartbeat of the server (roadmap R3): a WebSocket ping to each connection at
// each interval, and terminate() for a connection that missed `misses` pongs. Each setting is a
// flag, and the server has no default. 0.7.0 takes each time as a duration, not a number. One
// setInterval of the transport, from its start, beats for all connections: the first ping of a
// connection comes at the next beat after its accept (transport.js:94-112, :147-151).
//
// Each event is a JSON line on the clock of the clients: a connection (`accepted`), a request,
// a reply, and the close of a connection. The `ws` package does the WebSocket of the server. Its
// `ping` and `terminate` write a line first (`ping`, `drop`): the heartbeat of the server pings its
// clients and drops a silent one. Each line names the connection by its peer.

import http from "node:http";
import { WebSocket } from "ws";
import { Server, WebSocketServerTransport } from "@procedures/client";
import { bootId, commandLine, emit } from "./lines.mjs";

const line = commandLine("server-ws --port N --tcp-keepalive off|N --heartbeat off|on [--heartbeat-interval-ms N --heartbeat-misses N]");
const port = line.number("--port");
const keepalive = line.required("--tcp-keepalive");
const keepAliveMs = keepalive === "off" ? null : Number(keepalive);
if (keepAliveMs !== null && !Number.isFinite(keepAliveMs)) line.fail("--tcp-keepalive is off or a number of ms");
const heartbeat = line.toggle("--heartbeat")
  ? { interval: line.number("--heartbeat-interval-ms"), misses: line.number("--heartbeat-misses") }
  : null;

const peerOf = (socket) => `${socket?.remoteAddress}:${socket?.remotePort}`;

// the acts of a heartbeat of the server, in the package that the transport imports
const ping = WebSocket.prototype.ping;
WebSocket.prototype.ping = function (...args) {
  emit("ping", { peer: peerOf(this._socket) });
  return ping.apply(this, args);
};
const terminate = WebSocket.prototype.terminate;
WebSocket.prototype.terminate = function (...args) {
  emit("drop", { peer: peerOf(this._socket) });
  return terminate.apply(this, args);
};

const ok = (request, payload) => ({ id: request.id, status: { type: "success", code: 200 }, payload, metadata: {} });
const server = new Server();
server.register({ service: "harness", operation: "echo" }, async (request) => {
  emit("request", { method: "harness.echo" });
  return ok(request, { ok: true });
});
server.register({ service: "harness", operation: "hold" }, async (request) => {
  const ms = Number(request.payload?.ms ?? 0);
  emit("request", { method: "harness.hold", ms });
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    request.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  emit("replied", { method: "harness.hold", aborted: request.signal?.aborted === true });
  return ok(request, { ok: true, held: ms });
});

const httpServer = http.createServer({
  keepAlive: keepAliveMs !== null,
  ...(keepAliveMs === null ? {} : { keepAliveInitialDelay: keepAliveMs }),
});
const transport = new WebSocketServerTransport(server, {
  server: httpServer,
  path: "/ws",
  heartbeat: heartbeat === null ? false : { interval: { value: heartbeat.interval, unit: "ms" }, misses: heartbeat.misses },
  onConnection: (ws, request) => {
    const peer = peerOf(request.socket);
    emit("accepted", { peer });
    ws.on("close", (code) => emit("closed", { peer, code }));
  },
});
server.addTransport(transport);
await server.start();

httpServer.listen(port, "0.0.0.0", () =>
  emit("listening", {
    port,
    boot_id: bootId(),
    node: process.version,
    package: "@procedures/client 0.7.0",
    tcpKeepalive: keepAliveMs,
    heartbeat,
  }),
);
