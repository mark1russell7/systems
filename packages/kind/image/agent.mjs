// The agent of a kind node. It runs in a privileged container in the PID namespace of the node
// container, thus it sees the processes of each pod of the node, and PID 1 is the init of the node.
//
//   node agent.mjs serve       polls the rules of kube-proxy in the namespaces of the node, as
//                              /tmp/rules.json asks, and prints each change of the backends. It
//                              also reads the conntrack table of the node, and prints each entry
//                              that keeps its NAT to a pod that the rules dropped (`stale`)
//   node agent.mjs act JSON    does one act and prints its stamps on CLOCK_MONOTONIC
//
// The acts: signal (a signal to a PID), pause (SIGSTOP, then SIGCONT after ms), write (a file, for
// example cpu.max or a flag file in the root of a container), remove (a file), stall (the stall
// seam of the app: the ms in /tmp/lab-stall, then SIGUSR2), and now.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { backendsOf } from "./backends.ts";
import { entriesOf, staleOf } from "./conntrack.ts";

const now = () => Number(process.hrtime.bigint()) / 1e6;
const node = process.env.NODE_NAME ?? "";
const say = (line) => process.stdout.write(`${JSON.stringify({ ...line, node })}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** the backends of a Service in each mode of kube-proxy, as "ip:port" (with the weight for IPVS) */
const DUMP = {
  iptables: ["nsenter", "-t", "1", "-m", "-n", "--", "iptables-save", "-t", "nat"],
  nftables: ["nsenter", "-t", "1", "-m", "-n", "--", "nft", "list", "table", "ip", "kube-proxy"],
  ipvs: ["nsenter", "-t", "1", "-n", "--", "cat", "/proc/net/ip_vs"],
};

/** the conntrack table of the node's network namespace, only the lines of the ClusterIP, or null when the kernel has none */
const conntrackOf = (ip) => {
  const run = spawnSync("nsenter", ["-t", "1", "-n", "--", "grep", "-F", ` dst=${ip} `, "/proc/net/nf_conntrack"], { encoding: "utf8", maxBuffer: 64 << 20 });
  // grep exits 1 when no line matches, and 2 when it cannot read the table
  if (run.status === 0 || run.status === 1) return run.stdout ?? "";
  return null;
};
/** how often the agent reads the conntrack table, in ms: the table is larger than the rules */
const CONNTRACK_EVERY = 250;

const serve = async () => {
  let last = null;
  let previous = null;
  let polls = 0;
  let spent = 0;
  let beat = now();
  let dumped = null;
  // the conntrack read: its last time, the stale entries that it saw, and whether the table exists
  let read = 0;
  let seen = new Map();
  let conntrack = true;
  for (;;) {
    if (!existsSync("/tmp/rules.json")) {
      last = null;
      await sleep(200);
      continue;
    }
    const rule = JSON.parse(readFileSync("/tmp/rules.json", "utf8"));
    const t = now();
    const run = spawnSync(DUMP[rule.mode][0], DUMP[rule.mode].slice(1), { encoding: "utf8", maxBuffer: 64 << 20 });
    const took = now() - t;
    polls += 1;
    spent += took;
    if (run.status !== 0) {
      say({ ev: "rules-fail", t, why: (run.stderr ?? "").trim().slice(0, 300) });
    } else {
      const backends = backendsOf(rule.mode, run.stdout, rule);
      const key = backends.join(",");
      // a dump that names the Service but gives no backend: once for each rule, its text, to read the format
      const config = JSON.stringify(rule);
      if (backends.length === 0 && run.stdout.includes(`${rule.ns}/${rule.svc}`) && dumped !== config) {
        say({ ev: "rules-dump", t, text: run.stdout.slice(0, 30000) });
        dumped = config;
      }
      if (key !== last) {
        say({ ev: "rules", t, prev: previous, took: Math.round(took * 1000) / 1000, b: backends });
        last = key;
      }
      // a new SYN on the port of a stale entry goes to the pod of the entry, not to a backend of the rules
      if (conntrack && t - read >= CONNTRACK_EVERY) {
        read = t;
        const text = conntrackOf(rule.ip);
        if (text === null) {
          say({ ev: "conntrack-fail", t, why: "the node has no readable /proc/net/nf_conntrack" });
          conntrack = false;
        } else {
          const next = new Map();
          for (const entry of staleOf(entriesOf(text, rule.ip, rule.port), backends)) {
            const id = `${entry.client}>${entry.backend}`;
            next.set(id, entry.state);
            // each entry once, and again when its state changes
            if (seen.get(id) !== entry.state) say({ ev: "stale", t, state: entry.state, ttl: entry.ttl, client: entry.client, backend: entry.backend, unreplied: entry.unreplied });
          }
          seen = next;
        }
      }
    }
    previous = t;
    if (t - beat >= 1000) {
      say({ ev: "rules-alive", t, polls, ms: Math.round((spent / polls) * 100) / 100 });
      beat = t;
      polls = 0;
      spent = 0;
    }
    const wait = rule.every - (now() - t);
    if (wait > 0) await sleep(wait);
  }
};

const act = async (spec) => {
  const t0 = now();
  if (spec.op === "now") return { t0, t1: t0 };
  if (spec.op === "signal") {
    process.kill(spec.pid, spec.signal);
    return { t0, t1: now() };
  }
  if (spec.op === "pause") {
    process.kill(spec.pid, "SIGSTOP");
    const stopped = now();
    await sleep(Math.max(0, spec.ms - (now() - t0)));
    // the end is timed on the monotonic clock, not on the timer: spin out the last milliseconds
    while (now() - stopped < spec.ms) {
      // nothing
    }
    process.kill(spec.pid, "SIGCONT");
    return { t0: stopped, t1: now() };
  }
  if (spec.op === "write") {
    writeFileSync(spec.path, spec.data);
    return { t0, t1: now() };
  }
  if (spec.op === "remove") {
    rmSync(spec.path, { force: true });
    return { t0, t1: now() };
  }
  if (spec.op === "stall") {
    writeFileSync(`/proc/${spec.pid}/root/tmp/lab-stall`, String(spec.ms));
    const t1 = now();
    process.kill(spec.pid, "SIGUSR2");
    return { t0: t1, t1: now() };
  }
  throw new Error(`no act ${spec.op}`);
};

const [mode, arg] = process.argv.slice(2);
if (mode === "serve") {
  say({ ev: "agent", what: "start", t: now() });
  await serve();
} else if (mode === "act") {
  const spec = JSON.parse(arg);
  try {
    const stamps = await act(spec);
    process.stdout.write(`${JSON.stringify({ ok: true, op: spec.op, ...stamps })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, op: spec.op, why: String(error?.message ?? error) })}\n`);
    process.exit(1);
  }
}
