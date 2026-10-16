import { count, HZ } from "../catalog.ts";
import type { Alias, MongoCell, MongoSpec, Waiting } from "./cells.ts";
import { assumingSingle } from "./single.ts";

/**
 * The MongoDB catalog of T01: the driver of MongoDB 7.7.0 and a replica set of one member of
 * mongod 9.0.4, on the direct pair. The driver monitors the member as it monitors a set. Each
 * cell is named by the cell of the plan that it stands for.
 */

/** This function gives the first boundary of a level of the timer wheel above the driver's keepalive delay. It is in seconds, at the HZ of the kernel. */
export const wheelBoundary = (above = 120): number => {
  for (let level = 1; level < 9; level += 1) {
    const at = (63 << (3 * level)) / HZ;
    if (at > above) return at;
  }
  throw new Error("no level of the wheel above the delay");
};
const BOUNDARY = wheelBoundary();
/** These are the keepalive delays of the driver on each side of that boundary, in whole seconds. */
const BELOW = Math.ceil(BOUNDARY) - 1;
const ABOVE = Math.ceil(BOUNDARY) + 1;

/** These options of the driver are the tuned ones: a heartbeat of 2 s and a connect timeout of 5 s, thus a write-off at 7 s. */
const TUNED = { heartbeatFrequencyMS: 2000, connectTimeoutMS: 5000 };

/** These are the cells of T01 over mongodb-node-7.7 and mongodb-replset. */
export const T01_MONGO_SPECS: readonly MongoSpec[] = [
  // ---- the defaults stage: each trigger of the plan at defaults
  { plan: "T01.defaults.1", name: "blackhole, a write in flight", fault: "blackhole", mode: "inflight" },
  { plan: "T01.defaults.40", name: "rst, a write in flight", fault: "rst", mode: "inflight" },
  { plan: "T01.defaults.41", name: "fin, idle", fault: "fin", mode: "idle" },
  { plan: "T01.defaults.42", name: "unreachable-host, idle", fault: "unreachable", mode: "idle", icmp: "host" },
  { plan: "T01.defaults.43", name: "freeze-process, a write in flight", fault: "freeze-process", mode: "inflight" },
  { plan: "T01.defaults.44", name: "a 1 s stall, a write in flight", fault: "stall", mode: "inflight", stall: 1 },
  { plan: "T01.defaults.45", name: "event:idle, no fault for 200 s", fault: "none", mode: "idle", hold: 200 },
  { plan: "T01.defaults.47", name: "rst at connect: the member refuses before the client starts", fault: "rst", mode: "inflight", before: true },
  // ---- the border stage: the breakpoints that the documents place
  {
    plan: "T01.border-off.19",
    name: `blackhole, idle, keepAliveInitialDelay ${BELOW} s, below a level of the timer wheel`,
    fault: "blackhole",
    mode: "idle",
    options: { keepAliveInitialDelay: BELOW * 1000 },
  },
  {
    plan: "T01.border-off.20",
    name: `blackhole, idle, keepAliveInitialDelay ${ABOVE} s, above a level of the timer wheel`,
    fault: "blackhole",
    mode: "idle",
    options: { keepAliveInitialDelay: ABOVE * 1000 },
  },
  {
    plan: "T01.border-off.21",
    name: "blackhole, a write in flight, keepAliveInitialDelay 27 s: the keepalive ends the monitor's stream before its write-off",
    fault: "blackhole",
    mode: "inflight",
    options: { keepAliveInitialDelay: 27000 },
  },
  {
    plan: "T01.border-off.22",
    name: "blackhole, a write in flight, keepAliveInitialDelay 31 s: the write-off comes before the keepalive",
    fault: "blackhole",
    mode: "inflight",
    options: { keepAliveInitialDelay: 31000 },
  },
  {
    plan: "T01.border-off.51",
    name: "blackhole, a write in flight, tcp_retries2 = 5: the kernel gives up before the monitor's write-off",
    fault: "blackhole",
    mode: "inflight",
    linux: { tcp_retries2: count(5) },
  },
  {
    plan: "T01.border-off.52",
    name: "blackhole, a write in flight, tcp_retries2 = 7: the monitor's write-off comes first",
    fault: "blackhole",
    mode: "inflight",
    linux: { tcp_retries2: count(7) },
  },
  { plan: "T01.border-off.59", name: "freeze-process 29 s, a write in flight: inside the write-off", fault: "freeze-process", mode: "inflight", hold: 29 },
  { plan: "T01.border-off.60", name: "freeze-process 41 s, a write in flight: outside the write-off", fault: "freeze-process", mode: "inflight", hold: 41 },
  {
    plan: "T01.border-off.67",
    name: "freeze-process 59 s, a write in flight: the retry lands inside serverSelectionTimeoutMS",
    fault: "freeze-process",
    mode: "inflight",
    hold: 59,
  },
  {
    plan: "T01.border-off.68",
    name: "freeze-process 71 s, a write in flight: the retry's selection times out first",
    fault: "freeze-process",
    mode: "inflight",
    hold: 71,
  },
  {
    plan: "T01.border-off.75",
    name: "freeze-process 4.5 s, a write in flight, heartbeatFrequencyMS 2000 and connectTimeoutMS 5000: inside the write-off",
    fault: "freeze-process",
    mode: "inflight",
    hold: 4.5,
    options: TUNED,
  },
  {
    plan: "T01.border-off.76",
    name: "freeze-process 7.5 s, a write in flight, heartbeatFrequencyMS 2000 and connectTimeoutMS 5000: outside the write-off",
    fault: "freeze-process",
    mode: "inflight",
    hold: 7.5,
    options: TUNED,
  },
  {
    plan: "T01.border-off.215",
    name: "freeze-process 60 s, a write in flight, connectTimeoutMS 1000: the monitor's hello has a timeout",
    fault: "freeze-process",
    mode: "inflight",
    hold: 60,
    options: { connectTimeoutMS: 1000 },
  },
  {
    plan: "T01.border-off.216",
    name: "freeze-process 60 s, a write in flight, connectTimeoutMS 0: the monitor's hello has no timeout",
    fault: "freeze-process",
    mode: "inflight",
    hold: 60,
    options: { connectTimeoutMS: 0 },
  },
  {
    plan: "T01.border-off.221",
    name: "blackhole before the client starts, serverSelectionTimeoutMS 25000: the selection ends before the connect timeout",
    fault: "blackhole",
    mode: "inflight",
    before: true,
    options: { serverSelectionTimeoutMS: 25000 },
  },
  {
    plan: "T01.border-off.222",
    name: "blackhole before the client starts, serverSelectionTimeoutMS 35000: the connect times out first",
    fault: "blackhole",
    mode: "inflight",
    before: true,
    options: { serverSelectionTimeoutMS: 35000 },
  },
];

/** These are the cells of the plan that are another cell of this catalog. */
export const T01_MONGO_ALIASES: readonly Alias[] = [
  { plan: "T01.defaults.210", is: "T01.defaults.1", why: "the earlier epoch changes the keep-alive of Node's server, which this chain does not have" },
  { plan: "T01.defaults.211", is: "T01.defaults.1", why: "the earlier epoch changes HikariCP's keepalive, which this chain does not have" },
  { plan: "T01.border-off.53", is: "T01.border-off.59", why: "a frozen server with its kernel up: the monitor's write-off bounds it, and 29 s is inside it" },
  { plan: "T01.border-off.54", is: "T01.border-off.60", why: "a frozen server with its kernel up: 41 s is outside the monitor's write-off" },
  { plan: "T01.border-off.149", is: "T03.border-off.11", why: "O03 for the driver through a router that drops a forgotten flow: the cell needs the router of T03" },
  { plan: "T01.border-off.150", is: "T03.border-off.12", why: "O03 for the driver through a router that drops a forgotten flow: the cell needs the router of T03" },
];

/** These reasons are the reasons of the waiting cells, by kind. */
const NOT_THIS = "the breakpoint names another system's setting: this chain has no such knob";
const KERNEL_ONLY = "a breakpoint of Linux TCP alone: the monitor's write-off at 40 s ends the request before each time that it moves, and the TCP client's cells of T01 place it";

/** These are the cells of the plan over these systems that this catalog does not start, each with its reason. */
export const T01_MONGO_WAITING: readonly Waiting[] = [
  { plan: "T01.defaults.46", trigger: "event:server-restart-same-ip", why: "the harness has no restart of a target with its address" },
  { plan: "T01.defaults.48", trigger: "app-stall", why: "no machine document gives the time of a stall in the server, and the harness has no such fault" },
  { plan: "T01.defaults.49", trigger: "timed:mid-commit", why: "the harness has no injector that times a fault to a reply" },
  { plan: "T01.defaults.50", trigger: "in-process:event-loop", why: "no document gives the sequence of the timers of Node that are late after a block of its event loop" },
  { plan: "T01.defaults.51", trigger: "workload:write-write-read", why: "the driver writes each command in one write, and it sets TCP_NODELAY (connect.ts:338): the pattern does not occur" },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 69, 70, 71, 72, 73, 74, 77, 78, 79, 80, 81, 82, 83, 84, 87, 88, 89, 90, 93, 94, 97, 98, 103, 104, 105, 106, 107, 108, 113, 114, 115, 116, 117, 118, 119, 120, 141, 142, 241, 242].map(
    (n): Waiting => ({ plan: `T01.border-off.${n}`, trigger: "border", why: NOT_THIS }),
  ),
  ...[85, 86].map(
    (n): Waiting => ({
      plan: `T01.border-off.${n}`,
      trigger: "border",
      why: "a stalled handshake meets the monitor's handshake timeout and the first selection at the same 30 s: T01.border-off.221 and .222 move the selection across the connect timeout",
    }),
  ),
  ...[95, 96].map(
    (n): Waiting => ({ plan: `T01.border-off.${n}`, trigger: "border", why: "the driver's pool gives the connection that came back last (connection_pool.ts:394, :758), and no timer reads the order" }),
  ),
  ...[99, 100].map((n): Waiting => ({ plan: `T01.border-off.${n}`, trigger: "border", why: "the client sends one operation at a time, against a pool of 100" })),
  ...Array.from({ length: 28 }, (_, at) => 23 + at).map(
    (n): Waiting => ({ plan: `T01.border-off.${n}`, trigger: "border", why: KERNEL_ONLY }),
  ),
  { plan: "T01.border-off.17", trigger: "border", why: "the driver's maxIdleTimeMS has no timer: the pool checks it only at a check-out (connection_pool.ts:584)" },
  { plan: "T01.border-off.18", trigger: "border", why: "the driver's maxIdleTimeMS has no timer: the pool checks it only at a check-out (connection_pool.ts:584)" },
  { plan: "T01.border-off.55", trigger: "border", why: NOT_THIS },
  { plan: "T01.border-off.56", trigger: "border", why: NOT_THIS },
  { plan: "T01.border-off.57", trigger: "border", why: "no document gives the sequence of the timers of Node that are late after a block of its event loop" },
  { plan: "T01.border-off.58", trigger: "border", why: "no document gives the sequence of the timers of Node that are late after a block of its event loop" },
  { plan: "T01.border-off.61", trigger: "border", why: NOT_THIS },
  { plan: "T01.border-off.62", trigger: "border", why: NOT_THIS },
  { plan: "T01.border-off.63", trigger: "border", why: "the driver has no reconnect schedule of its own: the monitor's next check is heartbeatFrequencyMS or minHeartbeatFrequencyMS, which T01.border-off.67 and .68 place" },
  { plan: "T01.border-off.64", trigger: "border", why: "the driver has no reconnect schedule of its own: the monitor's next check is heartbeatFrequencyMS or minHeartbeatFrequencyMS, which T01.border-off.67 and .68 place" },
  { plan: "T01.border-off.65", trigger: "border", why: "the attempts are two at the defaults: T01.border-off.67 and .68 place the second one" },
  { plan: "T01.border-off.66", trigger: "border", why: "the attempts are two at the defaults: T01.border-off.67 and .68 place the second one" },
  { plan: "T01.border-off.91", trigger: "border", why: "a transaction is out of the documents: the client sends no transaction" },
  { plan: "T01.border-off.92", trigger: "border", why: "a transaction is out of the documents: the client sends no transaction" },
  { plan: "T01.border-off.101", trigger: "border", why: "the harness has no CPU limit of a member, and no document gives the service time under load" },
  { plan: "T01.border-off.102", trigger: "border", why: "the harness has no CPU limit of a member, and no document gives the service time under load" },
  { plan: "T01.border-off.109", trigger: "border", why: "a set of one member: w 1 and majority are the same member" },
  { plan: "T01.border-off.110", trigger: "border", why: "a set of one member: w 1 and majority are the same member" },
  { plan: "T01.border-off.111", trigger: "border", why: "a set of one member has no catch-up (replication_coordinator_impl_catchup.cpp:41-46)" },
  { plan: "T01.border-off.112", trigger: "border", why: "a set of one member has no catch-up (replication_coordinator_impl_catchup.cpp:41-46)" },
  { plan: "T01.border-off.175", trigger: "border", why: "the driver's document does not model timeoutMS, and the client sets none" },
  { plan: "T01.border-off.176", trigger: "border", why: "the driver's document does not model timeoutMS, and the client sets none" },
  { plan: "T01.border-off.183", trigger: "border", why: "the rule compares a health check of a service with the driver: no service is on this chain" },
  { plan: "T01.border-off.184", trigger: "border", why: "the rule compares a health check of a service with the driver: no service is on this chain" },
  { plan: "T01.border-off.193", trigger: "border", why: "the rule compares the start-up budget of a pod: no pod is on this chain" },
  { plan: "T01.border-off.194", trigger: "border", why: "the rule compares the start-up budget of a pod: no pod is on this chain" },
  { plan: "T01.border-off.217", trigger: "border", why: "the driver's document does not model timeoutMS: no request has a deadline at the defaults" },
  { plan: "T01.border-off.218", trigger: "border", why: "the driver's document does not model timeoutMS: no request has a deadline at the defaults" },
  { plan: "T01.border-off.235", trigger: "border", why: "a set of one member has no failover: T11.border-off.47 and .48 place the rule" },
  { plan: "T01.border-off.236", trigger: "border", why: "a set of one member has no failover: T11.border-off.47 and .48 place the rule" },
];

/** This function gives the name of a MongoDB cell: the cell of the plan, then the rest. */
export const nameOf = (spec: MongoSpec): string => `${spec.plan} mongodb-node-7.7 to mongodb-replset, ${spec.name}`;

/** These are the cells of the MongoDB catalog of T01, with their predictions. */
export const T01_MONGO: readonly MongoCell[] = T01_MONGO_SPECS.map((spec) => ({ spec, name: nameOf(spec), prediction: assumingSingle(spec) }));
