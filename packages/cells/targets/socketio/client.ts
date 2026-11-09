// client HOST PORT --mode idle|inflight|stream --websocket ws --heartbeat off
//        --reconnect on|off [--reconnect-initial-ms N --reconnect-multiplier 2 --reconnect-max-ms N
//                            --reconnect-attempts N --reconnect-jitter X]
//        --request-timeout-ms N --connection-timeout-ms N [--hold-ms N] [--go PATH] [--max-s N]
//        [--count N --interval-ms N --sender client|target] [--retries N]
//
// The client program of the Socket.IO cells (SYS-87): the Manager and the Socket of
// socket.io-client 4.8.4, on the Node WebSocket transport of engine.io-client 6.6.7 (the `ws`
// package). The flags are the flags of each WebSocket client of the harness (probeArgs of run.ts):
//   --websocket   is ws only: the Node build of engine.io-client opens its sockets with ws.
//   --heartbeat   is off only: the client has no heartbeat of its own. The server gives pingInterval
//                 and pingTimeout in its handshake, and the client closes the connection when no ping
//                 comes in their sum.
//   --reconnect   maps to the options of the Manager: reconnectionDelay, reconnectionDelayMax,
//                 reconnectionAttempts and randomizationFactor. The Backoff of the Manager has the
//                 factor 2, thus --reconnect-multiplier is 2 only. The Manager reads 0 as its default
//                 for the delay and for the attempts (`||`), thus each is at least 1.
//   --connection-timeout-ms is the `timeout` of the Manager: the time limit of each try.
//   --request-timeout-ms is the time limit of each call: socket.timeout(N).emitWithAck(). With
//                 --retries, it is also the ackTimeout of the Socket: the time limit of each try.
//   --retries     is the `retries` of the Socket. Each event waits for its ack, and the client sends
//                 it again after a failed try. Without the flag, the Socket has no queue.
// Each setting is a flag, and the client has no default: a missing flag is a failure.
//
// Each mode calls `echo` first. Then the client waits for the next ping of the server, and writes
// `ready`. The client writes its pong in the same tick, and its ping timer starts there. This is
// the reference `pong-sent` of the harness. The modes then do this:
//   idle      hold the connection.
//   inflight  wait for the file --go, and call `echo` (or `hold` for --hold-ms) into the fault.
//   stream    send --count events, one each --interval-ms, from --sender.
// The two senders of a stream:
//   target  the client asks for the stream (`stream`) before `ready`. The fault comes before the
//           signal, thus the request cannot wait for it. The client writes `got` for each event. At
//           the signal, it writes `sent` and sends nothing. The server sends the stream to a room
//           that the client names in its auth. Each process has a new name.
//   client  at the signal, the client writes `sent`. Then it sends the events (`event`), and it
//           writes `emitted` before each one.
//
// The lines are those of the procedures subject of the client repository:
//   dial {conn}             before each new socket of the transport. conn counts from 1.
//   connected {conn, local} the socket opened: its local address.
//   write {conn, local, type} before each frame: the type of its engine.io packet.
//   drop {conn, local, how} before close() of an open socket: a close frame of ws.
//   reconnecting {attempt}  the Manager starts its reconnect timer.
//   status {status}         a connect (with `recovered`), a disconnect (with the reason), or an error of the Manager.
//   emitted {n} / got {n}   the send or the receipt of each event of a stream.
//   conn-end {conn, code}   the close event of each socket, with the errno of its socket error.
//   error {errno} / eof     the end of socket 1 (the socket of the run), when the client did not drop it.
//   sent / ready / data / call-error   each call, its reply, or its failure.

import { randomUUID } from "node:crypto";
import { NodeWebSocket } from "engine.io-client";
import { Manager } from "socket.io-client";
import { bootId, commandLine, emit, every, now, versions, waitFor } from "./lines.ts";

const USAGE =
  "client HOST PORT --mode idle|inflight|stream --websocket ws --heartbeat off --reconnect on|off --request-timeout-ms N --connection-timeout-ms N";
const line = commandLine(USAGE, 2);
const [host, port] = line.args;
const mode = line.required("--mode");
if (mode !== "idle" && mode !== "inflight" && mode !== "stream") line.fail("--mode is idle, inflight or stream");
if (line.required("--websocket") !== "ws") line.fail("--websocket is ws: the Node build of engine.io-client opens its sockets with the ws package");
if (line.toggle("--heartbeat")) line.fail("--heartbeat is off: the server gives the times of the ping in its handshake");
const reconnect = line.toggle("--reconnect")
  ? {
      initialDelay: line.number("--reconnect-initial-ms"),
      multiplier: line.number("--reconnect-multiplier"),
      maxDelay: line.number("--reconnect-max-ms"),
      attempts: line.number("--reconnect-attempts"),
      jitter: line.number("--reconnect-jitter"),
    }
  : null;
if (reconnect !== null) {
  if (reconnect.multiplier !== 2) line.fail("--reconnect-multiplier is 2: the factor of the Backoff of the Manager");
  if (reconnect.initialDelay < 1 || reconnect.attempts < 1) line.fail("--reconnect-initial-ms and --reconnect-attempts are at least 1: the Manager reads 0 as its default");
  if (reconnect.jitter < 0 || reconnect.jitter > 1) line.fail("--reconnect-jitter is from 0 to 1");
}
const requestTimeout = line.number("--request-timeout-ms");
const connectionTimeout = line.number("--connection-timeout-ms");
const hold = line.flag("--hold-ms") === undefined ? undefined : line.number("--hold-ms");
const go = line.flag("--go") ?? "/tmp/go";
const max = Number(line.flag("--max-s") ?? 60) * 1000;
const stream =
  mode === "stream" ? { count: line.number("--count"), interval: line.number("--interval-ms"), sender: line.required("--sender") } : null;
if (stream !== null) {
  if (stream.sender !== "client" && stream.sender !== "target") line.fail("--sender is client or target");
  if (stream.count < 1 || stream.interval < 1) line.fail("--count and --interval-ms are at least 1");
}
const retries = line.flag("--retries") === undefined ? undefined : line.number("--retries");
// `emit` of the Socket reads `retries` as a boolean: 0 turns the queue off, and is not one try
if (retries !== undefined && retries < 1) line.fail("--retries is at least 1: the Socket reads 0 as no queue");

emit("start", {
  boot_id: bootId(),
  mode,
  client: "socketio",
  packages: versions(["socket.io-client", "engine.io-client", "ws"]),
  node: process.version,
  settings: { reconnect, requestTimeout, connectionTimeout, hold: hold ?? null, stream, retries: retries ?? null },
});

/** One socket of the transport: its number, its local address, and if the client dropped it. */
interface SocketRecord {
  conn: number;
  local: string | undefined;
  dropped: boolean;
}

/** An error of a socket: a Node error, or a value with the same fields. */
type SocketError = { code?: unknown; name?: unknown; message?: string } | null | undefined;

/** The acts of a WebSocket of ws that the client uses. */
interface WsSocket {
  readyState: number;
  _socket?: { localAddress?: string; localPort?: number; on(event: string, listener: (error: SocketError) => void): void };
  addEventListener(type: string, listener: (event: never) => void): void;
  send(data: unknown, ...rest: unknown[]): unknown;
  close(...args: unknown[]): unknown;
}

/** These are the names of the packet types of engine.io 4, by the first character of a frame. */
const PACKETS: Record<string, string> = { "0": "open", "1": "close", "2": "ping", "3": "pong", "4": "message", "5": "upgrade", "6": "noop" };

/** This function gives the type of a frame of the transport: the type of its engine.io packet. */
const typeOf = (data: unknown): string => (typeof data === "string" ? (PACKETS[data.charAt(0)] ?? "unknown") : "binary");

let tries = 0;
/** This is the last socket error that the client read. The close event of its socket follows it. */
let pending: { errno: unknown; at: bigint } | undefined;

/**
 * This transport is the Node WebSocket transport of engine.io-client with lines. Its createSocket
 * writes a line, then calls the transport: engine.io-client and ws do what they do without it. The
 * listeners of `open` and `close` are its own, and they come before the listeners of the transport.
 * A WebSocket of ws emits no `error` for an error of its socket, thus the transport reads that error
 * on the socket itself.
 */
class StampedWebSocket extends NodeWebSocket {
  override createSocket(uri: string, protocols: string | string[] | undefined, opts: Record<string, unknown>): WsSocket {
    const conn = ++tries;
    emit("dial", { conn });
    const ws = super.createSocket(uri, protocols, opts) as WsSocket;
    const socket: SocketRecord = { conn, local: undefined, dropped: false };
    const send = ws.send.bind(ws);
    ws.send = (data: unknown, ...rest: unknown[]) => {
      emit("write", { conn, local: socket.local ?? null, type: typeOf(data) });
      return send(data, ...rest);
    };
    // close() of an open socket writes a close frame, and close() of a socket in its handshake aborts
    // it. close() of a socket that closes or closed does nothing: the transport calls it after each end
    const close = ws.close.bind(ws);
    ws.close = (...args: unknown[]) => {
      if (ws.readyState <= 1) {
        socket.dropped = true;
        emit("drop", { conn, local: socket.local ?? null, how: "close" });
      }
      return close(...args);
    };
    ws.addEventListener("open", () => {
      const raw = ws._socket;
      if (raw?.localAddress !== undefined) {
        socket.local = `${raw.localAddress}:${raw.localPort}`;
        emit("connected", { conn, local: socket.local });
      }
      raw?.on("error", (error) => {
        pending = { errno: error?.code ?? error?.name ?? "unknown", at: now() };
      });
    });
    ws.addEventListener("error", (event: { error?: SocketError } | undefined) => {
      const code = event?.error?.code;
      if (typeof code === "string") pending = { errno: code, at: now() };
    });
    ws.addEventListener("close", (event: { code: number; wasClean: boolean }) => {
      const error = pending;
      pending = undefined;
      emit("conn-end", { conn, local: socket.local ?? null, code: event.code, clean: event.wasClean, errno: error?.errno ?? null });
      // the end of the socket of the run, as the client saw it: an error, or the end of the file
      if (conn !== 1 || socket.dropped) return;
      if (error !== undefined) emit("error", { errno: error.errno, local: socket.local ?? null }, error.at);
      else emit("eof", { local: socket.local ?? null });
    });
    return ws;
  }
}

/** The fields of the Manager that its reconnect changes. The types of socket.io-client keep them private. */
interface Reconnecting {
  _reconnecting: boolean;
  backoff: { attempts: number };
}

// the Manager starts the timer of a try in reconnect(): its line takes the time before the call
const prototype = Manager.prototype as unknown as { reconnect: (this: Reconnecting) => unknown };
const managerReconnect = prototype.reconnect;
prototype.reconnect = function (this: Reconnecting) {
  const at = now();
  const before = this._reconnecting;
  const result = managerReconnect.call(this);
  if (!before && this._reconnecting) emit("reconnecting", { attempt: this.backoff.attempts }, at);
  return result;
};

setTimeout(() => {
  emit("deadline");
  process.exit(0);
}, max);

const manager = new Manager(`http://${host}:${port}`, {
  transports: [StampedWebSocket],
  reconnection: reconnect !== null,
  ...(reconnect === null
    ? {}
    : {
        reconnectionDelay: reconnect.initialDelay,
        reconnectionDelayMax: reconnect.maxDelay,
        reconnectionAttempts: reconnect.attempts,
        randomizationFactor: reconnect.jitter,
      }),
  timeout: connectionTimeout,
} as ConstructorParameters<typeof Manager>[1]);
manager.on("error", (error: SocketError) => emit("status", { status: "error", message: error?.message ?? null }));
// the room of a stream of the server: one for each client process, thus no stream of an earlier run reaches it
const room = randomUUID();
const socket = manager.socket("/", { auth: { stream: room }, ...(retries === undefined ? {} : { retries, ackTimeout: requestTimeout }) });
socket.on("disconnect", (reason: string) => emit("status", { status: "disconnected", reason }));
socket.on("connect_error", (error: SocketError) => emit("status", { status: "error", message: error?.message ?? null }));
// each event of a stream of the target. With recovery, the server adds the offset as the last argument
socket.on("event", (input: { n: number }) => emit("got", { n: input.n }));
await new Promise<void>((resolve) => {
  // each connection: `recovered` is undefined where the server has no recovery, thus the line gives a boolean
  socket.on("connect", () => {
    emit("status", { status: "connected", recovered: socket.recovered === true });
    resolve();
  });
});

try {
  emit("sent");
  const reply: unknown = await socket.timeout(requestTimeout).emitWithAck("echo", {});
  // a stream of the target starts before the fault, because the black hole comes before the signal
  if (stream?.sender === "target") await socket.timeout(requestTimeout).emitWithAck("stream", { count: stream.count, interval: stream.interval });
  // the client writes its pong to the next ping of the server, and starts its ping timer there
  await new Promise<void>((resolve) => manager.once("ping", () => resolve()));
  emit("ready", { reply: JSON.stringify(reply ?? null) });
} catch (error) {
  emit("fail", { why: (error as SocketError)?.message ?? String(error) });
  process.exit(1);
}

if (stream !== null) {
  await waitFor(go);
  emit("sent");
  if (stream.sender === "client")
    every(stream.count, stream.interval, (n) => {
      emit("emitted", { n });
      socket.emit("event", { n });
    });
}

if (mode === "inflight") {
  await waitFor(go);
  // into the fault: its reply never comes, or comes after the fault
  emit("sent");
  socket
    .timeout(requestTimeout)
    .emitWithAck(hold === undefined ? "echo" : "hold", hold === undefined ? {} : { ms: hold })
    .then(
      (reply: unknown) => emit("data", { n: JSON.stringify(reply ?? null).length }),
      (error: SocketError) => emit("call-error", { code: error?.code ?? error?.name ?? null, message: error?.message ?? String(error) }),
    );
}
