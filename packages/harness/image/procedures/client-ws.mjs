// client-ws HOST PORT --mode idle|inflight --heartbeat on|off [--heartbeat-interval-ms N --heartbeat-timeout-ms N]
//           --reconnect on|off [--reconnect-initial-ms N --reconnect-multiplier X --reconnect-max-ms N --reconnect-attempts N]
//           --request-timeout-ms N --connection-timeout-ms N [--hold-ms N] [--go PATH] [--max-s N]
//
// A cell's client: the WebSocket client of @procedures/client 0.2.3 (WebSocketTransport), over the
// WebSocket of Node 24.21.0, which is undici 7.29.1. Each setting of the transport is a flag, and
// the client has no default: a missing flag is a failure. Both modes call `harness.echo` first; its
// reply is `ready`. idle: then hold the connection. inflight: then wait for the file --go, and call
// `harness.echo` (or `harness.hold` for --hold-ms) into the fault.
//
// The lines are those of the harness's TCP client, on CLOCK_MONOTONIC, and the program's own acts:
//   dial {conn}            before each new socket of the transport (conn counts from 1)
//   connected {conn, local} the socket opened: its local address (undici:websocket:open)
//   ping {conn, local}     before each ping of the heartbeat
//   write {conn, type}     before each other frame: a request, a cancel or a credit
//   drop {conn, local}     before the transport closes a socket by itself: its close frame
//   reconnecting {attempt} the transport starts its reconnect timer (onReconnecting)
//   status {status}        connected, disconnected (with the reason) or error, from the callbacks
//   conn-end {conn, code}  the close event of each socket, with the errno of its socket error
//   error {errno} / eof    the end of socket 1, the socket of the run, when the transport did not drop it
//   sent / ready / data / call-error   each call, its reply, or its failure
//
// The transport makes each socket with `new WebSocket(url)`, the global class of Node. Thus the
// client puts a subclass of that class in its place before the transport starts. The subclass
// writes a line, then calls the class of Node: the transport and undici do what they do without it.
// The close event goes to a listener of the subclass, which the transport cannot remove.

import { subscribe } from "node:diagnostics_channel";
import { bootId, commandLine, emit, now, waitFor } from "./lines.mjs";

const USAGE =
  "client-ws HOST PORT --mode idle|inflight --heartbeat on|off --reconnect on|off --request-timeout-ms N --connection-timeout-ms N";
const line = commandLine(USAGE, 2);
const [host, port] = line.args;
const mode = line.required("--mode");
if (mode !== "idle" && mode !== "inflight") line.fail("--mode is idle or inflight");
const heartbeat = line.toggle("--heartbeat")
  ? { enabled: true, interval: line.number("--heartbeat-interval-ms"), timeout: line.number("--heartbeat-timeout-ms") }
  : { enabled: false };
const reconnect = line.toggle("--reconnect")
  ? {
      enabled: true,
      initialDelay: line.number("--reconnect-initial-ms"),
      backoffMultiplier: line.number("--reconnect-multiplier"),
      maxDelay: line.number("--reconnect-max-ms"),
      maxAttempts: line.number("--reconnect-attempts"),
    }
  : { enabled: false };
const requestTimeout = line.number("--request-timeout-ms");
const connectionTimeout = line.number("--connection-timeout-ms");
const hold = line.flag("--hold-ms") === undefined ? undefined : line.number("--hold-ms");
const go = line.flag("--go") ?? "/tmp/go";
const max = Number(line.flag("--max-s") ?? 60) * 1000;

emit("start", {
  boot_id: bootId(),
  mode,
  client: "procedures-ws",
  node: process.version,
  undici: process.versions.undici ?? null,
  settings: { heartbeat, reconnect, requestTimeout, connectionTimeout, hold: hold ?? null },
});

/** These are the sockets of the transport, by their WebSocket: the number of each, its local address, and whether the transport dropped it. */
const sockets = new WeakMap();
let tries = 0;
/** This is the last socket error that undici published. The close event of its socket follows it. */
let pending;

/** This function gives the type of a frame of the transport: its JSON `type`. */
const typeOf = (data) => {
  if (typeof data !== "string") return "binary";
  try {
    return JSON.parse(data).type ?? "unknown";
  } catch {
    return "text";
  }
};

const Native = globalThis.WebSocket;
class Stamped extends Native {
  constructor(...args) {
    const conn = ++tries;
    emit("dial", { conn });
    super(...args);
    const socket = { conn, local: undefined, dropped: false };
    sockets.set(this, socket);
    this.addEventListener("close", (event) => {
      const error = pending;
      pending = undefined;
      emit("conn-end", { conn, local: socket.local ?? null, code: event.code, clean: event.wasClean, errno: error?.errno ?? null });
      // the end of the socket of the run, as the client saw it: an error, or the end of the file
      if (conn !== 1 || socket.dropped) return;
      if (error !== undefined) emit("error", { errno: error.errno, local: socket.local ?? null }, error.at);
      else emit("eof", { local: socket.local ?? null });
    });
  }

  send(...args) {
    const socket = sockets.get(this);
    const type = typeOf(args[0]);
    emit(type === "ping" ? "ping" : "write", { conn: socket?.conn ?? null, local: socket?.local ?? null, ...(type === "ping" ? {} : { type }) });
    return super.send(...args);
  }

  close(...args) {
    const socket = sockets.get(this);
    if (socket !== undefined) socket.dropped = true;
    emit("drop", { conn: socket?.conn ?? null, local: socket?.local ?? null });
    return super.close(...args);
  }
}
globalThis.WebSocket = Stamped;

subscribe("undici:websocket:open", (message) => {
  const socket = sockets.get(message.websocket);
  const address = message.address;
  const local = address === null || address === undefined ? null : `${address.address}:${address.port}`;
  if (socket !== undefined) socket.local = local ?? undefined;
  emit("connected", { conn: socket?.conn ?? null, local });
});
subscribe("undici:websocket:socket_error", (error) => {
  pending = { errno: error?.code ?? error?.name ?? "unknown", at: now() };
});

setTimeout(() => {
  emit("deadline");
  process.exit(0);
}, max);

const { Client, WebSocketTransport } = await import("@procedures/client");

let opened;
const first = new Promise((resolve) => {
  opened = resolve;
});
const transport = new WebSocketTransport({
  url: `ws://${host}:${port}/ws`,
  heartbeat,
  reconnect,
  requestTimeout,
  connectionTimeout,
  onConnect: () => {
    emit("status", { status: "connected" });
    opened?.();
    opened = undefined;
  },
  onDisconnect: (reason) => emit("status", { status: "disconnected", reason: reason ?? null }),
  onReconnecting: (attempt) => emit("reconnecting", { attempt }),
  onError: (error) => emit("status", { status: "error", message: error?.message ?? null }),
});
const client = new Client({ transport });

const ECHO = { service: "harness", operation: "echo" };
const HOLD = { service: "harness", operation: "hold" };

await first;
try {
  emit("sent");
  const reply = await client.call(ECHO, {});
  emit("ready", { reply: JSON.stringify(reply ?? null) });
} catch (error) {
  emit("fail", { why: error?.message ?? String(error) });
  process.exit(1);
}

if (mode === "inflight") {
  await waitFor(go);
  // into the fault: its reply never comes, or comes after the fault
  emit("sent");
  client.call(hold === undefined ? ECHO : HOLD, hold === undefined ? {} : { ms: hold }).then(
    (reply) => emit("data", { n: JSON.stringify(reply ?? null).length }),
    (error) => emit("call-error", { code: error?.code ?? error?.name ?? null, message: error?.message ?? String(error) }),
  );
}
