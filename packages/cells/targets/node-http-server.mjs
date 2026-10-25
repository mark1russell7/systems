// server --port N [--keep-alive-timeout-ms N] [--keep-alive-timeout-buffer-ms N]
//        [--headers-timeout-ms N] [--request-timeout-ms N] [--checking-interval-ms N]
//        [--max-requests-per-socket N] [--timeout-ms N]
//
// The target of the HTTP cells: the http.Server of Node 24.21.0, on a stock Node image. Each flag
// sets one timer of the server, and each timer without a flag keeps the default of Node. The
// server answers at once on each path, on /hold?ms=N after N ms (a held reply, as BLPOP is for
// Redis), and on /big?bytes=N with a body of N bytes. It reads and drops the body of a request.
// A hold above 600 s or a body above 64 MiB gets 400. The cells ask for 60 s and 2 MB at most.
//
// Each event is a JSON line on the clock of the clients: a connection, a request, the end of a
// response (where the keep-alive timer arms, lib/_http_server.js:1096-1142), the timeout of an idle
// socket, and the close. The server adds no listener for the `timeout` event of the server: such a
// listener stops the destroy of an idle socket (lib/_http_server.js:900-909). A listener on the
// socket changes nothing.
//
// The script is one file with no imports but Node's own: the cell copies it into the stock image.

import http from "node:http";

/** This function writes one line, with `t` from process.hrtime: CLOCK_MONOTONIC, the clock of the prober. */
const emit = (ev, fields = {}) =>
  process.stdout.write(`${JSON.stringify({ ev, t: Number(process.hrtime.bigint()), ...fields })}\n`);

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : Number(argv[at + 1]);
};
const port = flag("--port") ?? 8080;

// the options of the constructor, only those that a flag gives (lib/_http_server.js:504-579)
const options = {};
const set = (option, name) => {
  const value = flag(name);
  if (value !== undefined) options[option] = value;
};
set("keepAliveTimeout", "--keep-alive-timeout-ms");
set("keepAliveTimeoutBuffer", "--keep-alive-timeout-buffer-ms");
set("headersTimeout", "--headers-timeout-ms");
set("requestTimeout", "--request-timeout-ms");
set("connectionsCheckingInterval", "--checking-interval-ms");

const peerOf = (socket) => `${socket.remoteAddress}:${socket.remotePort}`;

// the bounds of a held reply and of a long body: a request cannot hold a timer or a buffer without a limit
const MAX_HOLD_MS = 600_000;
const MAX_BYTES = 64 * 1024 * 1024;

const server = http.createServer(options, (req, res) => {
  const peer = peerOf(req.socket);
  emit("request", { peer, method: req.method, url: req.url });
  req.resume();
  const url = new URL(req.url ?? "/", "http://target");
  res.on("finish", () => emit("finished", { peer }));
  const hold = url.pathname === "/hold" ? Number(url.searchParams.get("ms") ?? 0) : 0;
  const bytes = url.pathname === "/big" ? Number(url.searchParams.get("bytes") ?? 0) : 0;
  if (hold > MAX_HOLD_MS || bytes > MAX_BYTES) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end(`a hold of at most ${MAX_HOLD_MS} ms, and a body of at most ${MAX_BYTES} bytes\n`);
    return;
  }
  const body = bytes > 0 ? Buffer.alloc(bytes, 120) : "ok\n";
  const answer = () => res.end(body);
  if (hold > 0) setTimeout(answer, hold);
  else answer();
});

// the properties that the constructor does not take (lib/_http_server.js:665-667)
const requests = flag("--max-requests-per-socket");
if (requests !== undefined) server.maxRequestsPerSocket = requests;
const timeout = flag("--timeout-ms");
if (timeout !== undefined) server.timeout = timeout;

server.on("connection", (socket) => {
  const peer = peerOf(socket);
  emit("accepted", { peer });
  socket.on("timeout", () => emit("idle-timeout", { peer }));
  socket.on("end", () => emit("peer-end", { peer }));
  socket.on("close", (error) => emit("closed", { peer, error }));
});

server.listen(port, "0.0.0.0", () =>
  emit("listening", {
    port,
    // the values that the server holds, as it reads them, for the manifest of the run
    keepAliveTimeout: server.keepAliveTimeout,
    keepAliveTimeoutBuffer: server.keepAliveTimeoutBuffer,
    headersTimeout: server.headersTimeout,
    requestTimeout: server.requestTimeout,
    connectionsCheckingInterval: server.connectionsCheckingInterval,
    maxRequestsPerSocket: server.maxRequestsPerSocket,
    timeout: server.timeout,
    node: process.version,
  }),
);
