// server --port N --policy sliding-window --limit N --window-ms N --max-keys N
// server --port N --policy token-bucket --rate-per-s N --burst N --max-keys N
//
// The target of the cells of the keyed limiter: the http.Server of Node 24.21.0 over the keyed
// limiter of @mark1russell7/service, from npm. Each request takes one unit of its key, the header
// x-limiter-key of the client. A permitted take gets 200. A refused take gets the response of
// limitedResponse: 429 with Retry-After in whole seconds, rounded up (RFC 6585 §4, RFC 9110 §10.2.3).
// The store is memoryStore, on the monotonic clock of the process. A request without a key gets 400.
//
// Each event is a JSON line on the clock of the clients: the listen, each take with its decision
// and its Retry-After, and the end of each response. The server keeps the defaults of Node for its
// own timers. Thus its keep-alive timer closes an idle connection after 5 s, as a server at its
// defaults does.
//
// Before it listens, the server checks its declaration with lint() (declaration.mjs). A problem
// stops the server before its line "listening", thus the cell fails. The line "listening" gives
// the version of the service and the findings of lint(), thus each record of a cell has them.
// With --lint off, the server does not load declaration.mjs, and the line gives "lint": "off".
// The control of a pair of versions uses it, because an older version can lack that lint().

import http from "node:http";
import { limitedResponse } from "@mark1russell7/service/http";
import { keyedLimiter, memoryStore } from "@mark1russell7/service/limiter";
import { realClock } from "@mark1russell7/service/clock";
import manifest from "@mark1russell7/service/package.json" with { type: "json" };
import { LIMITER, specOf } from "./spec.mjs";

/** This function writes one line, with `t` from process.hrtime: CLOCK_MONOTONIC, the clock of the prober. */
const emit = (ev, fields = {}) =>
  process.stdout.write(`${JSON.stringify({ ev, t: Number(process.hrtime.bigint()), ...fields })}\n`);

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const number = (name) => {
  const value = flag(name);
  if (value === undefined) {
    emit("fail", { why: `the limiter has no defaults: give ${name}` });
    process.exit(1);
  }
  return Number(value);
};
const port = Number(flag("--port") ?? 8080);
const spec =
  flag("--policy") === "token-bucket"
    ? specOf({ policy: "token-bucket", ratePerS: number("--rate-per-s"), burst: number("--burst"), maxKeys: number("--max-keys") })
    : specOf({ policy: "sliding-window", limit: number("--limit"), windowMs: number("--window-ms"), maxKeys: number("--max-keys") });
const checked = flag("--lint") === "off" ? { findings: "off", problems: [] } : (await import("./declaration.mjs")).lintTarget(spec);
if (checked.problems.length > 0) {
  emit("fail", { why: checked.problems.join("; "), service: manifest.version, lint: checked.findings });
  process.exit(1);
}
const limiter = keyedLimiter(LIMITER, spec, memoryStore(realClock));

const peerOf = (socket) => `${socket.remoteAddress}:${socket.remotePort}`;

const server = http.createServer(async (req, res) => {
  const peer = peerOf(req.socket);
  req.resume();
  const key = req.headers["x-limiter-key"];
  res.on("finish", () => emit("finished", { peer, status: res.statusCode }));
  if (typeof key !== "string" || key.length === 0) {
    res.writeHead(400, { "content-type": "text/plain" }).end("no x-limiter-key");
    return;
  }
  const decision = await limiter.take(key);
  if (decision.allowed) {
    emit("take", { peer, key, allowed: true, remaining: decision.remaining });
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  const response = limitedResponse(decision);
  emit("take", { peer, key, allowed: false, cause: decision.cause, retry_after: decision.retryAfter, header: response.headers["retry-after"] });
  res.writeHead(response.status, response.headers).end(response.body);
});
server.on("connection", (socket) => {
  const peer = peerOf(socket);
  emit("connection", { peer });
  socket.on("close", () => emit("closed", { peer }));
});
server.listen(port, () => emit("listening", { port, policy: spec.policy, max_keys: spec.evict.maxKeys, service: manifest.version, lint: checked.findings }));
