// A gRPC client of a kind cell: grpc-js 1.14.6 with one channel to the ClusterIP of the server, at
// the defaults of grpc-js. An open loop sends a unary call of grpc.health.v1.Health/Check each
// EVERY_MS on that channel. The channel holds one connection, thus kube-proxy picks a backend only
// when grpc-js connects again: after a GOAWAY of the server or the end of the socket.
//
// Each call is one JSON line, as the lines of client.mjs: its start on CLOCK_MONOTONIC (`t`, ms), its
// duration (`d`, ms), its outcome, the pod that answered (`b`, from the header x-pod of grpc-go), and
// the local port of the last socket of the channel (`lp`). The outcomes:
// - ok: the reply.
// - refused, reset, unreachable: a status whose details name ECONNREFUSED, ECONNRESET or EPIPE, or
//   EHOSTUNREACH or ENETUNREACH. A call that finds the channel in TRANSIENT_FAILURE fails at once
//   with the error of the last connect (load-balancing-call.ts:338-345), thus it names that errno.
// - timeout: no answer in TIMEOUT_MS. A call of grpc-js has no deadline at the defaults, thus the client
//   cancels it at that time.
// - error: each other status, with its name and its details in `e`.
import net from "node:net";

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

// the local port of a socket, or null once its handle is closed (as in client.mjs)
const portOf = (socket) => {
  const out = {};
  socket?._handle?.getsockname?.(out);
  return typeof out.port === "number" ? out.port : null;
};

// grpc-js connects with net.connect (transport.ts:830), on the module object that this patch changes.
// It loads after the patch. With an address and no host name, connect() comes before net.connect
// returns, thus the handle has the port at once, a refused connection's too
let lp = null;
const connect = net.connect;
net.connect = function (...args) {
  const socket = connect.apply(this, args);
  lp = portOf(socket) ?? lp;
  socket.once("connect", () => {
    lp = portOf(socket) ?? lp;
  });
  return socket;
};

const grpc = await import("@grpc/grpc-js");

// ---- the messages of grpc.health.v1, encoded by hand: the request of the service "", and the status of the reply
const encodeRequest = () => Buffer.alloc(0);
const decodeResponse = (buffer) => (buffer.length >= 2 && buffer[0] === 0x08 ? buffer[1] : 0);

const outcomeOf = (error) => {
  const text = `${error.details ?? ""} ${error.message ?? ""}`;
  if (/ECONNREFUSED/.test(text)) return "refused";
  if (/ECONNRESET|EPIPE/.test(text)) return "reset";
  if (/EHOSTUNREACH|ENETUNREACH/.test(text)) return "unreachable";
  if (error.code === grpc.status.DEADLINE_EXCEEDED) return "timeout";
  return "error";
};

const client = new grpc.Client(`${host}:${port}`, grpc.credentials.createInsecure(), {});

const fire = () => {
  const t = now();
  let done = false;
  let backend = null;
  const finish = (o, extra = {}) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    say({ ev: "req", t, d: Math.round((now() - t) * 1000) / 1000, o, ...(backend === null ? {} : { b: backend }), ...extra, lp });
  };
  const call = client.makeUnaryRequest("/grpc.health.v1.Health/Check", encodeRequest, decodeResponse, null, new grpc.Metadata(), {}, (error, status) => {
    if (error === null || error === undefined) finish(status === 1 ? "ok" : `status-${status}`);
    else finish(outcomeOf(error), { e: `${grpc.status[error.code] ?? error.code}: ${error.details ?? error.message}`.slice(0, 200) });
  });
  call.on("metadata", (metadata) => {
    const named = metadata.get("x-pod")[0];
    if (named !== undefined) backend = String(named);
  });
  const timer = setTimeout(() => {
    finish("timeout", { e: "LAB_TIMEOUT" });
    call.cancel();
  }, timeout);
};

say({ ev: "client", what: "start", t: now(), target: `${host}:${port}`, every, timeout, client: "grpc-js" });
setInterval(fire, every);
