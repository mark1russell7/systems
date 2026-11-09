// server --port N --ping-interval-ms N --ping-timeout-ms N
//
// The server program of the Socket.IO cells (SYS-87): the Server of socket.io 4.8.4 on engine.io
// 6.6.11 and the http.Server of Node, with the WebSocket transport only. It serves two events with an
// acknowledgement: `echo` answers at once, and `hold` answers after `ms` milliseconds.
//
// --ping-interval-ms and --ping-timeout-ms are pingInterval and pingTimeout of the Server. The
// server gives both to the client in its handshake. Each setting is a flag, and the server has no
// default.
//
// The readiness of the target is the line `listening`: the harness waits for it. Each event is a
// JSON line on the clock of the clients: a connection (`accepted`), each ping (`ping`), a request, a
// reply, and the close of a connection. The `ws` package does the WebSocket of engine.io. Its
// close() writes a line first (`drop`): the ping timeout of the server ends a connection with it.
// Each line names the connection by its peer.

import http from "node:http";
import { createRequire } from "node:module";
import type { Socket as NetSocket } from "node:net";
import { Server } from "socket.io";
import { WebSocket } from "ws";
import { bootId, commandLine, emit, versions } from "./lines.ts";

const line = commandLine("server --port N --ping-interval-ms N --ping-timeout-ms N");
const port = line.number("--port");
const pingInterval = line.number("--ping-interval-ms");
const pingTimeout = line.number("--ping-timeout-ms");

// engine.io must use the copy of ws that this program changes
const require = createRequire(import.meta.url);
const theirs = createRequire(require.resolve("engine.io")).resolve("ws");
const ours = require.resolve("ws");
if (theirs !== ours) line.fail(`engine.io resolves ws at ${theirs}, and this server at ${ours}`);

const peerOf = (socket: NetSocket | undefined): string => `${socket?.remoteAddress}:${socket?.remotePort}`;

/** A WebSocket of ws, with the socket that its types do not show. */
type WithSocket = WebSocket & { _socket?: NetSocket };

// close() of an open socket writes a close frame. close() of a socket that closes does nothing new
const close = WebSocket.prototype.close;
WebSocket.prototype.close = function (this: WithSocket, ...args: Parameters<typeof close>) {
  if (this.readyState === WebSocket.OPEN) emit("drop", { peer: peerOf(this._socket) });
  return close.apply(this, args);
};

const httpServer = http.createServer();
const io = new Server(httpServer, { transports: ["websocket"], pingInterval, pingTimeout, serveClient: false });

/** The parts of a socket of engine.io that the lines use. */
interface EngineSocket {
  request: { socket?: NetSocket };
  on(event: "packetCreate", listener: (packet: { type: string }) => void): void;
  on(event: "close", listener: (reason: string) => void): void;
}

io.engine.on("connection", (socket: EngineSocket) => {
  const peer = peerOf(socket.request.socket);
  emit("accepted", { peer });
  // sendPacket emits packetCreate before its write of the packet
  socket.on("packetCreate", (packet) => {
    if (packet.type === "ping") emit("ping", { peer });
  });
  socket.on("close", (reason) => emit("closed", { peer, reason }));
});

io.on("connection", (socket) => {
  socket.on("echo", (_input: unknown, ack: (reply: unknown) => void) => {
    emit("request", { method: "echo" });
    ack({ ok: true });
  });
  socket.on("hold", (input: { ms: number }, ack: (reply: unknown) => void) => {
    emit("request", { method: "hold", ms: input.ms });
    setTimeout(() => {
      emit("replied", { method: "hold", connected: socket.connected });
      ack({ ok: true, held: input.ms });
    }, input.ms);
  });
});

httpServer.listen(port, "0.0.0.0", () =>
  emit("listening", {
    port,
    boot_id: bootId(),
    node: process.version,
    packages: versions(["socket.io", "engine.io", "ws"]),
    server: "socket.io",
    pingInterval,
    pingTimeout,
  }),
);
