// client-agent HOST PORT --mode idle|inflight|gap [--gap-ms N] [--method GET|POST] [--hold-ms N]
//              [--bytes N] [--go PATH] [--max-s N] [--linger-ms N]
//              [--timeout-ms N] [--keepalive-msecs N] [--buffer-ms N]
//
// The client of the HTTP cells that uses the http.Agent of Node 24.21.0. Without an agent flag it
// uses http.globalAgent: keep-alive on, a free socket timeout of 5 s, LIFO
// (lib/internal/http.js:263-265). With a flag, it uses a new Agent with the same options and the
// flag. Each event is a JSON line, as the TCP client of the harness writes them.
//
// The first request is GET /, and the end of its reply is the `ready` line. Then the client holds
// the connection idle (idle), sends the second request when the file --go appears (inflight), or
// sends it after the gap (gap). For each request it writes the connection that it went on (the
// local address and port), whether the agent reused the socket, and the outcome. For each socket it
// writes the connect, the end of file, the timeout of the agent, and the close.

import http from "node:http";
import { bootId, commandLine, emit, now, pathOf, sleep, waitFor } from "./lines.mjs";

const usage = "client-agent HOST PORT --mode idle|inflight|gap";
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

// the options of http.globalAgent, and each flag over them
const custom = cli.has("--timeout-ms") || cli.has("--keepalive-msecs") || cli.has("--buffer-ms");
const options = { keepAlive: true, scheduling: "lifo", timeout: 5000 };
if (cli.has("--timeout-ms")) options.timeout = cli.number("--timeout-ms");
if (cli.has("--keepalive-msecs")) options.keepAliveMsecs = cli.number("--keepalive-msecs");
if (cli.has("--buffer-ms")) options.agentKeepAliveTimeoutBuffer = cli.number("--buffer-ms");
const agent = custom ? new http.Agent(options) : http.globalAgent;

emit("start", {
  boot_id: bootId(),
  mode,
  client: "node-http-agent",
  node: process.version,
  agent: {
    global: !custom,
    keepAlive: agent.keepAlive,
    timeout: agent.options.timeout ?? 0,
    keepAliveMsecs: agent.keepAliveMsecs,
    agentKeepAliveTimeoutBuffer: agent.agentKeepAliveTimeoutBuffer,
    scheduling: agent.scheduling,
  },
});

setTimeout(() => {
  emit("deadline");
  process.exit(0);
}, max);

// the sockets of the agent, each with its number, its local address, and what happened to it
const sockets = new Map();
const isFree = (socket) => Object.values(agent.freeSockets).some((list) => list.includes(socket));

/** This function follows a socket of the agent, one time. */
const track = (socket) => {
  const known = sockets.get(socket);
  if (known !== undefined) return known;
  const entry = { n: sockets.size + 1, local: null, timedOut: false, pooled: false };
  sockets.set(socket, entry);
  const connected = () => {
    entry.local = `${socket.localAddress}:${socket.localPort}`;
    emit("conn", { n: entry.n, local: entry.local });
    if (entry.n === 1) emit("connected", { local: entry.local });
  };
  if (socket.connecting) socket.once("connect", connected);
  else connected();
  // the listeners of the agent come first: after its free handler, the socket is in the pool or destroyed
  socket.on("free", () => {
    entry.pooled = isFree(socket);
    emit(entry.pooled ? "pooled" : "not-pooled", { local: entry.local });
  });
  socket.on("timeout", () => {
    entry.timedOut = entry.pooled;
  });
  socket.on("end", () => emit("eof", { local: entry.local }));
  socket.on("error", (error) => emit("conn-error", { local: entry.local, errno: error.code ?? "ERROR", message: error.message }));
  socket.on("close", (hadError) => {
    // the agent destroys a free socket on its own timeout, or on any read: an end of file or a
    // reset from the peer (lib/_http_agent.js:101-112). The guard hides the end event
    const by = entry.timedOut ? "client-timer" : hadError ? "error" : entry.pooled ? "peer" : "client";
    if (by === "peer") emit("eof", { local: entry.local, free: true });
    emit("closed", { local: entry.local, by });
  });
  return entry;
};

/** This function sends request `i` and waits for its outcome. */
const request = (i, how, path) =>
  new Promise((resolve) => {
    const at = now();
    const req = http.request({
      host: cli.host,
      port: cli.port,
      method: how,
      path,
      agent,
      headers: how === "POST" ? { "content-length": "1" } : {},
    });
    emit("sent", { i }, at);
    let ended = false;
    const end = (ok) => {
      if (ended) return;
      ended = true;
      resolve(ok);
    };
    req.on("socket", (socket) => {
      const entry = track(socket);
      entry.pooled = false;
      entry.timedOut = false;
      const show = () => emit("request", { i, local: entry.local, reused: req.reusedSocket });
      if (socket.connecting) socket.once("connect", show);
      else show();
    });
    req.on("response", (res) => {
      emit("response", { i, status: res.statusCode, local: `${res.socket.localAddress}:${res.socket.localPort}` });
      let n = 0;
      res.on("data", (chunk) => {
        n += chunk.length;
        if (i > 1) emit("data", { i, n: chunk.length });
      });
      res.on("end", () => {
        if (i === 1) emit("ready", { reply: `HTTP ${res.statusCode}` });
        else emit("replied", { i, n: { value: n, unit: "B" } });
        end(true);
      });
      res.on("error", (error) => {
        emit("error", { i, errno: error.code ?? "ERROR", message: error.message });
        end(false);
      });
    });
    req.on("error", (error) => {
      emit("error", { i, errno: error.code ?? "ERROR", message: error.message });
      end(false);
    });
    req.end(how === "POST" ? "x" : undefined);
  });

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
// idle: the connection stays in the pool until it ends, or until the deadline
