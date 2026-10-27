// client-ioredis HOST PORT --mode idle|inflight [--keepalive-ms N] [--go PATH] [--max-s N]
//
// A cell's client one layer up: an ioredis 6.0.0 connection, every event a JSON line stamped on
// CLOCK_MONOTONIC (process.hrtime, which libuv reads from it), the clock the prober stamps the
// kernel's records with. Its lines are the harness's TCP client's, so the harness reads both the
// same way (image/native/src/bin/client.rs), with ioredis's own status changes
// beside them as `status` lines.
//
// ioredis sets the socket's keepalive itself, once it connects: setKeepAlive(true, keepAlive), and
// Node fixes the probe interval and count. It sets no other timer that the kernel sees. Each mode
// sends a PING and reads its reply first. That reply is the last segment received. idle: then hold
// the connection until it fails. inflight: then wait for the file --go to appear, send a PING into
// the fault, and wait.

import { existsSync, readFileSync } from "node:fs";
import Redis from "ioredis";

const now = () => process.hrtime.bigint();
const emit = (ev, fields = {}, at = now()) =>
  process.stdout.write(`${JSON.stringify({ ev, t: Number(at), ...fields })}\n`);

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const [host, port] = argv;
const mode = flag("--mode");
if (host === undefined || port === undefined || (mode !== "idle" && mode !== "inflight")) {
  emit("fail", { why: "client-ioredis HOST PORT --mode idle|inflight" });
  process.exit(1);
}
const keepAlive = Number(flag("--keepalive-ms") ?? 30000);
const go = flag("--go") ?? "/tmp/go";
const max = Number(flag("--max-s") ?? 60) * 1000;

emit("start", {
  boot_id: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
  mode,
  client: "ioredis",
});

// one connection, whose end is what is measured: ioredis reconnects by itself, thus the client ends first
const redis = new Redis({ host, port: Number(port), keepAlive, lazyConnect: true });
for (const status of ["connect", "ready", "close", "reconnecting", "end"]) {
  redis.on(status, () => emit("status", { status }));
}

let ended = false;
const end = (code = 0) => {
  if (ended) return;
  ended = true;
  // a moment for ioredis's own close to be written after the error that caused it
  setTimeout(() => {
    redis.disconnect(false);
    process.exit(code);
  }, 50);
};
redis.on("error", (error) => {
  emit("error", { errno: error.code ?? error.errno ?? "unknown", message: error.message });
  end();
});
redis.on("close", () => {
  if (!ended) emit("eof");
  end();
});
setTimeout(() => {
  emit("deadline");
  end();
}, max);

/** This function sends a PING. It stamps the PING before the write, because the kernel can answer before the call ends. */
const ping = () => {
  const at = now();
  const reply = redis.ping();
  emit("sent", {}, at);
  return reply;
};

redis.once("connect", () => {
  const { localAddress, localPort } = redis.stream;
  emit("connected", { local: `${localAddress}:${localPort}` });
});

try {
  await redis.connect();
  const reply = await ping();
  emit("ready", { reply: `+${reply}\r\n` });
} catch (error) {
  // a connection that never became ready: what ended it was written as it happened
  if (!ended) emit("fail", { why: error.message });
  end(1);
}

if (mode === "inflight") {
  const wait = setInterval(() => {
    if (!existsSync(go)) return;
    clearInterval(wait);
    // into the fault: its reply never comes, or comes once the target thaws
    ping().then(
      (late) => emit("data", { n: late.length, text: late }),
      () => undefined,
    );
  }, 2);
}
