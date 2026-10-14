// The agent of the F6 cells against a real Redis. It runs in the network and the process namespaces
// of Redis, thus it signals redis-server and talks to it on 127.0.0.1, and its clock is the
// CLOCK_MONOTONIC of the probe. It prints one JSON line: the times just before and just after the act.
//
//   node agent.mjs stop | cont | kill | stall SECONDS
import { readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";

const now = () => process.hrtime.bigint().toString();
const server = () => {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/comm`, "utf8").trim() === "redis-server") return Number(entry);
    } catch {
      // the process ended while the agent read it
    }
  }
  throw new Error("no redis-server process");
};

const [act, arg] = process.argv.slice(2);
if (act === "stall") {
  const socket = connect({ host: "127.0.0.1", port: 6379 });
  await new Promise((resolve) => socket.once("connect", resolve));
  const t0 = now();
  socket.write(`DEBUG SLEEP ${arg}\r\n`);
  const t1 = now();
  process.stdout.write(`${JSON.stringify({ t0, t1 })}\n`);
  socket.unref();
  process.exit(0);
}
const pid = server();
const signal = { stop: "SIGSTOP", cont: "SIGCONT", kill: "SIGKILL" }[act];
if (signal === undefined) throw new Error(`unknown act ${act}`);
const t0 = now();
process.kill(pid, signal);
const t1 = now();
process.stdout.write(`${JSON.stringify({ t0, t1, pid })}\n`);
