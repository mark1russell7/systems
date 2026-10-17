// The agent of a kind node. It runs in a privileged container in the PID namespace of the node
// container, thus it sees the processes of each pod of the node, and PID 1 is the init of the node.
//
//   node agent.mjs serve       polls the rules of kube-proxy in the namespaces of the node, as
//                              /tmp/rules.json asks, and prints each change of the backends. It
//                              also reads the conntrack table of the node (procfs, or netlink
//                              with the conntrack tool of the node). It prints each entry
//                              that keeps its NAT to a pod that the rules dropped (`stale`), each
//                              handshake that stopped for a second (`stalled`). Each line
//                              `rules-alive` also counts the reads of the table (`ct`). Each
//                              second it reads the counters of dropped packets of the node and
//                              of each client pod, and prints each one that grew (`drops`)
//   node agent.mjs act JSON    does one act and prints its stamps on CLOCK_MONOTONIC
//
// The acts: signal (a signal to a PID), pause (SIGSTOP, then SIGCONT after ms), write (a file, for
// example cpu.max or a flag file in the root of a container), remove (a file), stall (the stall
// seam of the app: the ms in /tmp/lab-stall, then SIGUSR2), and now.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { backendsOf } from "./backends.ts";
import { entriesOf, flowsOf, staleOf, stalledOf } from "./conntrack.ts";
import { devOf, grownOf, snmpOf, softnetOf, unresolvedOf } from "./drops.ts";

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

/**
 * the TCP lines of the conntrack table of the node's network namespace: those of the ClusterIP and
 * those of a handshake. A kernel without CONFIG_NF_CONNTRACK_PROCFS has no /proc/net/nf_conntrack
 * (the kernel of GitHub's runner, 6.17), thus the agent then asks netlink with the conntrack tool of
 * the node. Both give the same form of line. The first read decides the source. `text` is null when
 * no source answers, and `why` tells why.
 *
 * A dump through netlink walks each bucket of the table of the whole kernel with the softirqs off,
 * whatever its filter. A segment that comes in that walk waits for its end. Thus each read is one
 * dump of TCP, and the agent filters it. The workflow makes the table small (kind.yml)
 */
const SOURCES = {
  procfs: (ip) => [["nsenter", "-t", "1", "-n", "--", "grep", "-F", "-e", ` dst=${ip} `, "-e", "[UNREPLIED]", "-e", " SYN_RECV ", "/proc/net/nf_conntrack"]],
  netlink: () => [["nsenter", "-t", "1", "-m", "-n", "--", "conntrack", "-L", "-p", "tcp"]],
};
let source = null;
const conntrackOf = (ip) => {
  const why = [];
  for (const name of source === null ? Object.keys(SOURCES) : [source]) {
    const lines = new Set();
    let ok = true;
    for (const [command, ...args] of SOURCES[name](ip)) {
      const run = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 << 20 });
      // grep exits 1 when no line matches; conntrack exits 0 with no entry
      if (run.status === 0 || (name === "procfs" && run.status === 1)) {
        for (const line of (run.stdout ?? "").split("\n")) if (line.trim() !== "") lines.add(line);
      } else {
        ok = false;
        why.push(`${name}: ${(run.stderr ?? "").trim().slice(0, 200) || `exit ${run.status ?? run.signal ?? run.error?.message}`}`);
        break;
      }
    }
    if (ok) {
      source = name;
      return { text: [...lines].join("\n"), why: null };
    }
  }
  return { text: null, why: why.join("; ") };
};
/** the PIDs of the clients of the node: the agent is in the PID namespace of the node, thus /proc holds each pod */
const clientsOf = () => {
  const out = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (readFileSync(`/proc/${name}/cmdline`, "utf8").includes("client.mjs")) out.push(name);
    } catch {
      // the process ended in the scan
    }
  }
  return out;
};

/**
 * the counters of dropped packets, by name. For the node: the drops of the backlogs and the squeezes
 * of the softirqs (the kernel, all CPUs), and the drops of each veth. For each client pod, through
 * /proc/<pid>/net: the IP discards and the sends with no route, the failed connects, the ICMP
 * errors of an unreachable destination, the drops of each interface, and the neighbors with no address yet
 */
const countersOf = () => {
  const values = {};
  const read = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };
  const softnet = read("/proc/1/net/softnet_stat");
  if (softnet !== null) {
    const { dropped, squeezed } = softnetOf(softnet);
    values["kernel.backlog-drops"] = dropped;
    values["kernel.squeezes"] = squeezed;
  }
  const dev = read("/proc/1/net/dev");
  if (dev !== null) {
    for (const [name, drops] of Object.entries(devOf(dev))) {
      if (!name.startsWith("veth")) continue;
      values[`node.${name}.rx-drops`] = drops.rx;
      values[`node.${name}.tx-drops`] = drops.tx;
    }
  }
  for (const pid of clientsOf()) {
    const snmp = read(`/proc/${pid}/net/snmp`);
    const own = read(`/proc/${pid}/net/dev`);
    const arp = read(`/proc/${pid}/net/arp`);
    if (snmp === null || own === null || arp === null) continue;
    const ip = snmpOf(snmp, "Ip");
    const tcp = snmpOf(snmp, "Tcp");
    values[`client.${pid}.ip-out-discards`] = ip["OutDiscards"] ?? 0;
    values[`client.${pid}.ip-out-no-routes`] = ip["OutNoRoutes"] ?? 0;
    values[`client.${pid}.tcp-attempt-fails`] = tcp["AttemptFails"] ?? 0;
    // a refused connect is a reset, or an ICMP error such as the port unreachable of a reject rule
    values[`client.${pid}.icmp-in-unreachable`] = snmpOf(snmp, "Icmp")["InDestUnreachs"] ?? 0;
    for (const [name, drops] of Object.entries(devOf(own))) {
      if (name === "lo") continue;
      values[`client.${pid}.${name}.rx-drops`] = drops.rx;
      values[`client.${pid}.${name}.tx-drops`] = drops.tx;
    }
    values[`client.${pid}.unresolved-neighbors`] = unresolvedOf(arp);
  }
  return values;
};

/**
 * how often the agent reads the conntrack table, in ms. Three dumps each 250 ms on each node took
 * three quarters of the CPUs of a runner (run 39066066532), and the lab waited for an idle VM until
 * the end. An entry of a SYN with no reply lives 120 s, thus a read each second sees it
 */
const CONNTRACK_EVERY = 1000;

const serve = async () => {
  let last = null;
  let previous = null;
  let polls = 0;
  let spent = 0;
  let beat = now();
  let dumped = null;
  // the conntrack read: its last time, the stale entries and the stalled handshakes that it saw,
  // whether the table exists, and the count of the reads since the last beat
  let read = 0;
  let seen = new Map();
  let stuck = new Map();
  let conntrack = true;
  let count = { reads: 0, ms: 0, lines: 0, vip: 0, states: {}, syn: [], error: null };
  // the counters of dropped packets at the last read, and the count of that last read's values
  let counters = null;
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
        try {
          const { text, why } = conntrackOf(rule.ip);
          count.reads += 1;
          count.ms += now() - t;
          if (text === null) {
            // the lab drops the lines before a run, thus each beat tells it again in ct.error
            say({ ev: "conntrack-fail", t, why });
            count.error = why;
            conntrack = false;
          } else {
            const flows = flowsOf(text);
            const entries = entriesOf(text, rule.ip, rule.port);
            count.lines = flows.length;
            count.vip = entries.length;
            count.states = {};
            for (const entry of entries) count.states[entry.state] = (count.states[entry.state] ?? 0) + 1;
            // a sample of the entries in SYN_SENT: a fresh SYN has the life 120, and an old one less
            count.syn = entries.filter((entry) => entry.state === "SYN_SENT").slice(0, 3).map((entry) => ({ client: entry.client, backend: entry.backend, ttl: entry.ttl, unreplied: entry.unreplied }));
            const next = new Map();
            for (const entry of staleOf(entries, backends)) {
              const id = `${entry.client}>${entry.backend}`;
              next.set(id, entry.state);
              // each entry once, and again when its state changes
              if (seen.get(id) !== entry.state) say({ ev: "stale", t, state: entry.state, ttl: entry.ttl, client: entry.client, backend: entry.backend, unreplied: entry.unreplied });
            }
            seen = next;
            // a connection that times out: where its SYN went, and whether an answer came on this node
            const held = new Map();
            for (const flow of stalledOf(flows, 1)) {
              const id = `${flow.from}>${flow.to}`;
              held.set(id, flow.state);
              if (stuck.get(id) !== flow.state) say({ ev: "stalled", t, state: flow.state, ttl: flow.ttl, from: flow.from, to: flow.to, reply: flow.reply, unreplied: flow.unreplied });
            }
            stuck = held;
          }
        } catch (error) {
          // a read that fails stops the reads, and the next beat tells why
          count.error = String(error?.stack ?? error).slice(0, 600);
          conntrack = false;
        }
      }
    }
    previous = t;
    if (t - beat >= 1000) {
      // a packet lost between a client and the conntrack of the node leaves a trace in one of these
      const next = countersOf();
      if (counters !== null) {
        const grown = grownOf(counters, next);
        if (Object.keys(grown).length > 0) say({ ev: "drops", t, grown });
      }
      counters = next;
      // the reads of the conntrack table since the last beat: a beat without them did not read it
      const ct = { source, reads: count.reads, ms: count.reads === 0 ? 0 : Math.round((count.ms / count.reads) * 100) / 100, lines: count.lines, vip: count.vip, states: count.states, syn: count.syn, on: conntrack, ...(count.error === null ? {} : { error: count.error }) };
      say({ ev: "rules-alive", t, polls, ms: Math.round((spent / polls) * 100) / 100, ct });
      count = { ...count, reads: 0, ms: 0 };
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
