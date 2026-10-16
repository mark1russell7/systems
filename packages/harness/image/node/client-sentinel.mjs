// client-sentinel --sentinels H:P,H:P,... --name NAME [--interval-ms N] [--max-s N] [--options JSON]
//
// A group cell's client: ioredis 6.0.0 in Sentinel mode, which asks the Sentinels for the primary
// of NAME and connects to it. Every event is a JSON line stamped on CLOCK_MONOTONIC
// (process.hrtime, which libuv reads from it), the clock the prober stamps the kernel's records
// with, and the injector stamps each fault with.
//
// The workload is a stream of writes with a sequence number: SET w:<n> <n>, each sent when the
// reply to the one before it came and --interval-ms passed. Each write is a sent line, then an
// ack line with the address of the server that accepted it, or a fail line with its error. A
// write whose line is neither had no answer when the client stopped. The group's keys after the
// run tell which writes it kept. --options are ioredis options over its defaults: none at the
// defaults of a cell. The client never stops on an error: ioredis reconnects, and the stream
// goes on until --max-s or SIGTERM.

import { readFileSync } from "node:fs";
import Redis from "ioredis";

const now = () => process.hrtime.bigint();
const emit = (ev, fields = {}, at = now()) =>
  process.stdout.write(`${JSON.stringify({ ev, t: Number(at), ...fields })}\n`);

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const sentinels = (flag("--sentinels") ?? "")
  .split(",")
  .filter((each) => each !== "")
  .map((each) => {
    const [host, port] = each.split(":");
    return { host, port: Number(port) };
  });
const name = flag("--name");
if (sentinels.length === 0 || name === undefined) {
  emit("fail", { why: "client-sentinel --sentinels H:P,... --name NAME" });
  process.exit(1);
}
const interval = Number(flag("--interval-ms") ?? 50);
const max = Number(flag("--max-s") ?? 120) * 1000;
const options = JSON.parse(flag("--options") ?? "{}");

emit("start", {
  boot_id: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
  client: "ioredis",
  mode: "sentinel",
  options,
});

const redis = new Redis({ ...options, sentinels, name, lazyConnect: true });
/** the server that the connection is on now, or null between connections */
const remote = () => {
  const stream = redis.stream;
  return stream?.remoteAddress === undefined ? null : `${stream.remoteAddress}:${stream.remotePort}`;
};
for (const status of ["connect", "ready", "close", "reconnecting", "end"]) {
  redis.on(status, (delay) => emit("status", { status, at: remote(), ...(status === "reconnecting" ? { delay } : {}) }));
}
redis.on("connect", () => {
  const { localAddress, localPort } = redis.stream;
  emit("connected", { local: `${localAddress}:${localPort}`, at: remote() });
});
// the errors on the way: a reset, a refused connect, a Sentinel that did not answer
redis.on("error", (error) =>
  emit("error", { name: error.name, errno: error.code ?? error.errno ?? null, message: error.message }),
);
redis.on("sentinelError", (error) => emit("sentinel-error", { message: error.message }));

let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  emit("done");
  redis.disconnect(false);
  setTimeout(() => process.exit(0), 50);
};
process.on("SIGTERM", stop);
setTimeout(() => {
  emit("deadline");
  stop();
}, max);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  await redis.connect();
  emit("ready", { at: remote() });
} catch (error) {
  emit("fail", { why: error.message });
  process.exit(1);
}

for (let n = 1; !stopped; n += 1) {
  const at = now();
  // stamped before the write: the kernel can answer before the call returns
  const reply = redis.set(`w:${n}`, String(n));
  emit("sent", { n }, at);
  try {
    const answer = await reply;
    emit("ack", { n, at: remote(), reply: answer });
  } catch (error) {
    emit("fail", { n, name: error.name, message: error.message });
  }
  await sleep(interval);
}
