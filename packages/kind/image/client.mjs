// A client of a kind cell: an open loop of requests to the ClusterIP of the service, each on a new
// connection, thus kube-proxy picks a backend for each one. With CONNECTIONS, the client keeps that
// count of keep-alive connections, and each request goes on the next one in turn. kube-proxy picks a
// backend only for a new connection. SIGHUP opens new connections. Each request is one JSON line with
// its start on CLOCK_MONOTONIC, its duration, its outcome (ok, 503, refused, reset, timeout,
// unreachable, or another error) and its local port (`lp`). With PROTOCOL h2c, each connection is a
// session of HTTP/2, and each request is a stream on the next session in turn. With SESSION_CHECK,
// each session has the session check of the service: a stream timeout or a PING with no ACK closes it.
// Each second, one line counts the PINGs of the checks and their ACKs (`pings`).
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { sessionCheck } from "@mark1russell7/service/http-client";

const [host, port] = (process.env.TARGET ?? "").split(":");
const every = Number(process.env.EVERY_MS ?? 20);
const timeout = Number(process.env.TIMEOUT_MS ?? 1000);
const pod = process.env.POD_NAME ?? "client";
const node = process.env.NODE_NAME ?? "";
const now = () => Number(process.hrtime.bigint()) / 1e6;
const h2 = process.env.PROTOCOL === "h2c";
// a client of HTTP/2 needs at least one session
const connections = process.env.CONNECTIONS === undefined ? (h2 ? 1 : 0) : Number(process.env.CONNECTIONS);
// the knobs of the session check, or null for a session with no check
const checkKnobs = h2 && process.env.SESSION_CHECK !== undefined ? JSON.parse(process.env.SESSION_CHECK) : null;

// each agent holds one keep-alive connection. A `Connection: close` of the server ends it after its
// answer, and the next request on the agent opens a new connection
const agentsOf = () => Array.from({ length: connections }, () => new http.Agent({ keepAlive: true, maxSockets: 1 }));
let agents = h2 ? [] : agentsOf();
let turn = 0;

// each slot of HTTP/2 holds one session on its own socket, thus the client knows its local port. A
// GOAWAY, a close or an error of the session makes the slot open a new session at its next stream.
// kube-proxy picks a backend for that new connection. The old session ends the streams that it has.
// The check of a session hears each frame of the peer: its SETTINGS, its PINGs, and each response.
// It sends each PING through `counted`, thus the client counts each PING and each ACK
const sessionOf = () => {
  const socket = net.connect({ host, port: Number(port) });
  const session = http2.connect(`http://${host}:${port}`, { createConnection: () => socket });
  const held = { session, socket, usable: true, check: null };
  const drop = () => {
    held.usable = false;
    held.check?.stop();
  };
  if (checkKnobs !== null) {
    const counted = {
      get connecting() {
        return session.connecting;
      },
      ping(callback) {
        const sent = session.ping((error) => {
          if (error === null) pings.acked += 1;
          callback(error);
        });
        if (sent) pings.sent += 1;
        return sent;
      },
      destroy(error) {
        session.destroy(error);
      },
    };
    held.check = sessionCheck(counted, {
      knobs: checkKnobs,
      onClose: (cause) => {
        held.usable = false;
        say({ ev: "client", what: "session-check", t: now(), why: cause, lp: portOf(socket) });
      },
    });
    session.on("remoteSettings", () => held.check.heard());
    session.on("ping", () => held.check.heard());
  }
  session.on("goaway", drop);
  session.on("close", drop);
  session.on("error", drop);
  return held;
};
let slots = h2 ? Array.from({ length: connections }, sessionOf) : [];
const slotAt = (at) => {
  if (!slots[at].usable) slots[at] = sessionOf();
  return slots[at];
};

// SIGHUP: new agents or sessions for the next requests. The old ones go after the timeout, thus each
// request on them ends first
process.on("SIGHUP", () => {
  const old = agents;
  const oldSlots = slots;
  if (h2) slots = Array.from({ length: connections }, sessionOf);
  else agents = agentsOf();
  say({ ev: "client", what: "reconnect", t: now() });
  setTimeout(() => {
    for (const agent of old) agent.destroy();
    for (const held of oldSlots) held.session.destroy();
  }, timeout + 100);
});

// the PINGs of the session checks of this client. Each second, one line gives the PINGs that the client
// sent and the ACKs that it got in that second. A client with no check writes zeros, thus each record
// shows that the client counted
let pings = { sent: 0, acked: 0 };
setInterval(() => {
  say({ ev: "pings", t: now(), sent: pings.sent, acked: pings.acked });
  pings = { sent: 0, acked: 0 };
}, 1000);

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

const outcomeOfStatus = (status) => (status === 200 ? "ok" : status === 503 ? "503" : `status-${status}`);

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
  const options =
    connections === 0
      ? { agent: false, headers: { connection: "close" } }
      : { agent: agents[turn++ % connections] };
  const req = http.request({ host, port: Number(port), path: "/work", ...options }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      body += chunk;
    });
    res.on("end", () => finish(outcomeOfStatus(res.statusCode), { b: body.slice(0, 64) }));
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
    // a kept connection is already connected: a listener on it does not fire, and stays
    if (opened.connecting)
      opened.once("connect", () => {
        lp ??= portOf(opened);
      });
  });
  req.end();
};

// a stream that the server did not take: REFUSED_STREAM, a stream above the last one of a GOAWAY, or
// a stream on a session that closed before it went. RFC 9113 (section 8.7) lets the client send it
// again, and the client does that once, on a new session
const REFUSED = http2.constants.NGHTTP2_REFUSED_STREAM;
const untaken = (error, stream) =>
  stream?.rstCode === REFUSED ||
  /REFUSED_STREAM/.test(String(error?.message ?? "")) ||
  error?.code === "ERR_HTTP2_GOAWAY_SESSION" ||
  error?.code === "ERR_HTTP2_INVALID_SESSION";

// one request of HTTP/2: a stream on the next session in turn. Each stream writes the same line as a
// request of HTTP/1.1, and `r` tells that the client sent it again
const fireH2 = () => {
  const t = now();
  const at = turn++ % connections;
  let done = false;
  let lp = null;
  let held = null;
  let stream = null;
  let again = false;
  // the end of the current stream for the check of its session: one time, at its timeout or otherwise
  let endStream = null;
  const finish = (o, extra = {}) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    endStream?.(false);
    lp ??= portOf(held?.socket);
    say({ ev: "req", t, d: Math.round((now() - t) * 1000) / 1000, o, ...extra, lp, ...(again ? { r: 1 } : {}) });
  };
  const failed = (error) => {
    if (done) return;
    if (!again && untaken(error, stream)) {
      again = true;
      held.usable = false;
      endStream?.(false);
      send();
      return;
    }
    finish(outcomeOf(error), { e: error?.code ?? String(error) });
  };
  const send = () => {
    held = slotAt(at);
    lp = portOf(held.socket);
    if (held.socket.connecting)
      held.socket.once("connect", () => {
        lp ??= portOf(held.socket);
      });
    try {
      stream = held.session.request({ ":path": "/work" });
    } catch (error) {
      failed(error);
      return;
    }
    const mine = stream;
    const check = held.check;
    let counted = false;
    check?.opened();
    endStream = (timedOut) => {
      if (counted) return;
      counted = true;
      if (timedOut) check?.timedOut();
      else check?.ended();
    };
    let status = 0;
    let body = "";
    mine.setEncoding("utf8");
    mine.on("response", (headers) => {
      check?.heard();
      status = Number(headers[":status"]);
    });
    mine.on("data", (chunk) => {
      check?.heard();
      body += chunk;
    });
    mine.on("end", () => {
      if (mine === stream && status !== 0) finish(outcomeOfStatus(status), { b: body.slice(0, 64) });
    });
    mine.on("error", (error) => {
      if (mine === stream) failed(error);
    });
    mine.on("close", () => {
      if (mine !== stream || done) return;
      if (status !== 0) finish(outcomeOfStatus(status), { b: body.slice(0, 64) });
      else failed(Object.assign(new Error(`the stream closed with code ${mine.rstCode}`), { code: mine.rstCode === REFUSED ? "REFUSED_STREAM" : "ECONNRESET" }));
    });
    mine.end();
  };
  const timer = setTimeout(() => {
    lp ??= portOf(held?.socket);
    stream?.close(http2.constants.NGHTTP2_CANCEL);
    // a stream that times out closes its session, when the session has a check
    endStream?.(true);
    finish("timeout", { e: "LAB_TIMEOUT" });
  }, timeout);
  send();
};

say({ ev: "client", what: "start", t: now(), target: `${host}:${port}`, every, timeout, connections, protocol: h2 ? "h2c" : "http/1.1", ...(checkKnobs !== null ? { sessionCheck: checkKnobs } : {}) });
setInterval(h2 ? fireH2 : fire, every);
