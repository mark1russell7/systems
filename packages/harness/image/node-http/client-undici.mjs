// client-undici HOST PORT --mode idle|inflight|gap [--gap-ms N] [--method GET|POST] [--hold-ms N]
//               [--bytes N] [--go PATH] [--max-s N] [--linger-ms N]
//               [--keepalive-timeout-ms N] [--keepalive-max-timeout-ms N] [--keepalive-threshold-ms N]
//               [--headers-timeout-ms N] [--body-timeout-ms N] [--connect-timeout-ms N]
//               [--keepalive-initial-delay-ms N]
//
// The client of the HTTP cells that uses an HTTP/1.1 Client of undici 8.12.2, at its defaults
// with each flag over them. Each event is a JSON line, as the TCP client of the harness writes them.
//
// The workload is the workload of client-agent.mjs. A connector around the connector of undici
// follows each socket. The channel undici:client:sendHeaders tells which socket each request goes
// on. The disconnect event of the client tells why a socket ended: an end of file (other side
// closed), a reset, or the keep-alive timer of the client (socket idle timeout).

import diagnostics from "node:diagnostics_channel";
import { Client, buildConnector } from "undici";
import { bootId, commandLine, emit, now, pathOf, sleep, waitFor } from "./lines.mjs";

const usage = "client-undici HOST PORT --mode idle|inflight|gap";
const cli = commandLine(usage);
const mode = cli.flag("--mode");
if (mode !== "idle" && mode !== "inflight" && mode !== "gap") {
  emit("fail", { why: usage });
  process.exit(1);
}
const method = cli.flag("--method") ?? "GET";
const second = pathOf({ hold: cli.number("--hold-ms"), bytes: cli.number("--bytes") });
const max = cli.number("--max-s", 60) * 1000;
const linger = cli.number("--linger-ms", 500);

// the options of the client: undici's defaults, and each flag over them
const options = {};
const set = (option, name) => {
  if (cli.has(name)) options[option] = cli.number(name);
};
set("keepAliveTimeout", "--keepalive-timeout-ms");
set("keepAliveMaxTimeout", "--keepalive-max-timeout-ms");
set("keepAliveTimeoutThreshold", "--keepalive-threshold-ms");
set("headersTimeout", "--headers-timeout-ms");
set("bodyTimeout", "--body-timeout-ms");
const connect = {};
if (cli.has("--connect-timeout-ms")) connect.timeout = cli.number("--connect-timeout-ms");
if (cli.has("--keepalive-initial-delay-ms")) connect.keepAliveInitialDelay = cli.number("--keepalive-initial-delay-ms");

emit("start", { boot_id: bootId(), mode, client: "undici", node: process.version, options, connect });

setTimeout(() => {
  emit("deadline");
  process.exit(0);
}, max);

// the sockets of the client, each with its number, its local address, and its use
const sockets = new Map();
let current = null;

/** This function follows a socket of the client, one time. */
const track = (socket) => {
  const known = sockets.get(socket);
  if (known !== undefined) return known;
  const entry = { n: sockets.size + 1, local: `${socket.localAddress}:${socket.localPort}`, used: false };
  sockets.set(socket, entry);
  current = entry;
  emit("conn", { n: entry.n, local: entry.local });
  if (entry.n === 1) emit("connected", { local: entry.local });
  socket.on("end", () => emit("eof", { local: entry.local }));
  socket.on("error", (error) =>
    // undici destroys a socket with an error of its own when it closes the socket itself
    OWN.has(error.code)
      ? emit("client-close", { local: entry.local, errno: error.code, message: error.message })
      : emit("conn-error", { local: entry.local, errno: error.code ?? "ERROR", message: error.message }),
  );
  socket.on("close", () => emit("closed", { local: entry.local }));
  return entry;
};

// the errors of undici for a close by the client itself: no reuse, its keep-alive timer, its deadlines
const OWN = new Set(["UND_ERR_INFO", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"]);

// the default connector of undici with the connect options, around a function that follows each socket
const connector = buildConnector(connect);
let requestIndex = 0;
const client = new Client(`http://${cli.host}:${cli.port}`, {
  ...options,
  connect: (opts, callback) =>
    connector(opts, (error, socket) => {
      if (error === null && socket !== undefined && socket !== null) track(socket);
      callback(error, socket);
    }),
});

diagnostics.subscribe("undici:client:sendHeaders", ({ socket }) => {
  const entry = track(socket);
  emit("request", { i: requestIndex, local: entry.local, reused: entry.used });
  entry.used = true;
});
client.on("disconnect", (_origin, _targets, error) => {
  // UND_ERR_INFO is a close by the client: no reuse (reset), or its keep-alive timer (socket idle timeout)
  const by = OWN.has(error?.code) ? "client" : "peer";
  emit("disconnect", { local: current?.local ?? null, by, errno: error?.code ?? null, message: error?.message ?? null });
});

/** This function sends request `i` and waits for its outcome. */
const request = async (i, how, path) => {
  requestIndex = i;
  const at = now();
  const pending = client.request({ path, method: how, body: how === "POST" ? "x" : undefined });
  emit("sent", { i }, at);
  try {
    const { statusCode, body } = await pending;
    emit("response", { i, status: statusCode });
    let n = 0;
    for await (const chunk of body) {
      n += chunk.length;
      if (i > 1) emit("data", { i, n: chunk.length });
    }
    if (i === 1) emit("ready", { reply: `HTTP ${statusCode}` });
    else emit("replied", { i, n: { value: n, unit: "B" } });
    return true;
  } catch (error) {
    emit("error", { i, errno: error.code ?? "ERROR", cause: error.cause?.code ?? null, message: error.message });
    return false;
  }
};

const finish = async () => {
  emit("done", { i: 2 });
  await sleep(linger);
  process.exit(0);
};

if (!(await request(1, "GET", "/"))) process.exit(1);
if (mode === "inflight") {
  await waitFor(cli.flag("--go") ?? "/tmp/go");
  await request(2, method, second);
  await finish();
} else if (mode === "gap") {
  await sleep(cli.number("--gap-ms", 0));
  await request(2, method, second);
  await finish();
}
// idle: the connection stays open until it ends, or until the deadline
