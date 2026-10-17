// A client of a kind cell: an open loop of requests to the ClusterIP of the service, each on a new
// connection, thus kube-proxy picks a backend for each one. Each request is one JSON line with its
// start on CLOCK_MONOTONIC, its duration, its outcome (ok, 503, refused, reset, timeout,
// unreachable, or another error) and its local port (`lp`).
import http from "node:http";

const [host, port] = (process.env.TARGET ?? "").split(":");
const every = Number(process.env.EVERY_MS ?? 20);
const timeout = Number(process.env.TIMEOUT_MS ?? 1000);
const pod = process.env.POD_NAME ?? "client";
const node = process.env.NODE_NAME ?? "";
const now = () => Number(process.hrtime.bigint()) / 1e6;

let pending = [];
const flush = () => {
  if (pending.length === 0) return;
  process.stdout.write(pending.join(""));
  pending = [];
};
setInterval(flush, 100);
const say = (line) => pending.push(`${JSON.stringify({ ...line, p: pod, n: node })}\n`);

const outcomeOf = (error) => {
  const code = error?.code ?? "";
  if (code === "ECONNREFUSED") return "refused";
  if (code === "ECONNRESET" || code === "EPIPE") return "reset";
  if (code === "ETIMEDOUT" || code === "LAB_TIMEOUT") return "timeout";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "unreachable";
  return "error";
};

// the local port of a socket, or null once its handle is closed. The kernel gives the port at
// connect(), and a refusal closes the handle in the poll phase of the loop: before setImmediate
const portOf = (socket) => {
  const out = {};
  socket?._handle?.getsockname?.(out);
  return typeof out.port === "number" ? out.port : null;
};

const fire = () => {
  const t = now();
  let done = false;
  // the local port of the connection, on each request: a conntrack entry is per port, thus a failure
  // on a port shows the connection before it on the same port, and the backend that it went to
  let lp = null;
  let socket = null;
  const finish = (o, extra = {}) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    lp ??= portOf(socket);
    say({ ev: "req", t, d: Math.round((now() - t) * 1000) / 1000, o, ...extra, lp });
  };
  const req = http.request({ host, port: Number(port), path: "/work", agent: false, headers: { connection: "close" } }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      body += chunk;
    });
    res.on("end", () => finish(res.statusCode === 200 ? "ok" : res.statusCode === 503 ? "503" : `status-${res.statusCode}`, { b: body.slice(0, 64) }));
    res.on("error", (error) => finish(outcomeOf(error), { e: error.code ?? String(error) }));
  });
  const timer = setTimeout(() => {
    // before the destroy closes the handle
    lp ??= portOf(socket);
    const error = Object.assign(new Error("no answer in time"), { code: "LAB_TIMEOUT" });
    req.destroy(error);
    finish("timeout", { e: "LAB_TIMEOUT" });
  }, timeout);
  req.on("error", (error) => finish(outcomeOf(error), { e: error.code ?? String(error) }));
  req.on("socket", (opened) => {
    socket = opened;
    // connect() comes in the tick before this event, thus the handle has the port here, a refused
    // connection's too: in 200 refusals, each port was here and none at setImmediate
    lp = portOf(opened);
    opened.once("connect", () => {
      lp ??= portOf(opened);
    });
  });
  req.end();
};

say({ ev: "client", what: "start", t: now(), target: `${host}:${port}`, every, timeout });
setInterval(fire, every);
