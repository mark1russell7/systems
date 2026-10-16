import type { Cell, DriverBand, DriverStep, GroupPrediction, LineMatch, Prediction, Reference, ReplicaSet, ReplicaSetStage, Target } from "@mark1russell7/harness";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { RUNS, ms, predict, s, sysctlsOf } from "../catalog.ts";
import { router } from "../topologies.ts";
import type { MongoBand, MongoCell, MongoReference, MongoSpec } from "./cells.ts";
import { MONGO_IMAGE, SET_NAME } from "./cells.ts";
import { INTERVAL, linuxValues } from "./model.ts";
import { OP_ERROR, SOCKET_END, WRITE_OFF } from "./single.ts";
import { T01_MONGO } from "./t01.ts";
import { T03_MONGO } from "./t03.ts";
import { T11_MONGO } from "./t11.ts";

/**
 * This module gives each MongoDB cell of the catalogs as a cell of the harness. A cell of T01 or T03
 * has a replica set of one member as its target. Its bands are driver bands. Each one names the
 * socket of its reference and the line of the client that ends it. A cell of T11 has a replica set
 * of three members. Its stages come from the logs of the members and the lines of the client.
 */

/** These are the options of the server of each member: the cache of WiredTiger at 0.25 GB, so that three members fit on one runner. It sets no timer. */
export const SERVER_ARGS: readonly string[] = ["--wiredTigerCacheSizeGB", "0.25"];

/** This shell connects to the member in its own container, and to no other member. */
const SHELL = 'mongosh --quiet --norc "mongodb://127.0.0.1:27017/?directConnection=true"';

/**
 * This target is a replica set of one member: mongod as the child of a shell. Thus a `fin` fault
 * stops it, and the container stays up. A freeze stops mongod with SIGSTOP (`program`), with stamps.
 */
export const MONGO_ONE: Target = {
  image: MONGO_IMAGE,
  port: 27017,
  ready: "Waiting for connections",
  command: ["sh", "-c", `mongod --replSet ${SET_NAME} --bind_ip_all ${SERVER_ARGS.join(" ")} & echo $! > /tmp/server.pid; while :; do sleep 3600; done`],
  kill: ["sh", "-c", 'kill -KILL "$(cat /tmp/server.pid)"'],
  program: "mongod",
};

/** This command starts the set of one member with its own address, and waits until it accepts writes. */
export const INITIATE: readonly string[] = [
  "sh",
  "-c",
  `${SHELL} --eval 'rs.initiate({ _id: "${SET_NAME}", members: [{ _id: 0, host: "'"$(hostname -i)"':27017" }] })' && ` +
    `for i in $(seq 1 300); do ${SHELL} --eval 'db.hello().isWritablePrimary' | grep -q true && exit 0; sleep 0.2; done; exit 1`,
];

/** This command writes the long document of a read: 2 MB, which the MTU black hole drops. */
export const LONG_DOCUMENT: readonly string[] = [
  "sh",
  "-c",
  `${SHELL} --eval 'db.getSiblingDB("cells").w.insertOne({ _id: "long", pad: "x".repeat(2000000) }, { writeConcern: { w: 1 } })'`,
];

/** These are the settings of the replica set of T11 at the defaults of mongod 9.0.4. Each one is given, thus the manifest reads each one back. */
export const SET_DEFAULTS: Readonly<Record<string, number>> = {
  electionTimeoutMillis: 10000,
  heartbeatIntervalMillis: 2000,
  heartbeatTimeoutSecs: 10,
  catchUpTimeoutMillis: -1,
  catchUpTakeoverDelayMillis: 30000,
};

/** This function gives the replica set of three members of T11, with its settings over the defaults. */
export const replicaSetOf = (settings: Readonly<Record<string, number>> = {}): ReplicaSet => ({
  name: SET_NAME,
  image: MONGO_IMAGE,
  programs: { server: "mongod", shell: "mongosh" },
  args: SERVER_ARGS,
  port: 27017,
  members: ["m1", "m2", "m3"],
  settings: { ...SET_DEFAULTS, ...settings },
  ready: "Waiting for connections",
});

/** This time is the error of the stamps of a stage of a member. The wall clock of mongod and of the client is in whole ms. */
export const MEMBER_STAMPS: Quantity = { value: 2, unit: "ms" };

/** These errnos end a band at the report of the kernel on its socket. */
const KERNEL = new Set(["ETIMEDOUT", "ECONNRESET", "EOF", "EHOSTUNREACH", "ENETUNREACH", "ECONNREFUSED", "EPIPE"]);

/** This function gives the reference of a band of a MongoDB cell, as the harness names it. */
const referenceOf = (from: MongoReference): Reference => (from.event === "start" ? "client-start" : from.event);

/** This function gives the role of the socket of a reference. A reference with no socket reads the pool's. */
const socketOf = (from: MongoReference): string => ("socket" in from ? from.socket : "pool");

/** This function gives the line of the client that ends a band, or undefined for a band that the kernel ends. */
export const endsOf = (band: MongoBand, spec: MongoSpec): LineMatch | undefined => {
  if (KERNEL.has(band.name)) return undefined;
  if (band.name === "MongoNetworkTimeoutError") return { ev: "sdam", where: { event: "heartbeat-failed" }, name: "failure.name" };
  if (band.name === "PoolClearedOnNetworkError") return { ev: "command", where: { event: "failed", n: 2 }, name: "failure.name" };
  if (band.name === "MongoServerSelectionError") return spec.before === true ? { ev: "fail", where: { why: "connect" } } : { ev: "fail", where: { n: 2 } };
  if (band.name === "OK") return { ev: "ack", where: { n: 2 } };
  throw new Error(`${spec.plan}: no line of the client ends ${band.name}`);
};

/** This function gives the lines of the client that a quiet event of a MongoDB prediction names. The router's forget is a test of its own. */
const quietOf = (quiet: readonly string[]): LineMatch[] =>
  quiet.flatMap((what): LineMatch[] => {
    if (what === WRITE_OFF) return [{ ev: "sdam", where: { event: "heartbeat-failed" } }];
    if (what === SOCKET_END) return [{ ev: "socket-error" }];
    if (what === OP_ERROR) return [{ ev: "fail" }];
    if (what === "the router forgets a flow") return [];
    throw new Error(`no line of the client marks "${what}"`);
  });

/** This function gives a later band of a MongoDB cell as a step of its driver band. */
const stepOf = (band: MongoBand, spec: MongoSpec): DriverStep => {
  const ends = endsOf(band, spec);
  if (ends === undefined) throw new Error(`${spec.plan}: a later band ends at a line, not at the kernel: ${band.what}`);
  return { what: band.what, name: band.name, socket: socketOf(band.from), from: referenceOf(band.from), ends, low: band.low, high: band.high };
};

/** This function gives the prediction of a stall from the catalog of Linux TCP, as the MongoDB catalogs take it. */
const stallOf = (spec: MongoSpec): Prediction =>
  predict({ name: spec.name, fault: "stall", manifestation: "blackhole", observer: "client", mode: "inflight", stall: spec.stall!, linux: spec.linux ?? {} });

/** This function gives the prediction of a cell of one member for the harness. */
export const singlePrediction = (cell: MongoCell): Prediction => {
  const { prediction, spec } = cell;
  // a stall is the stall of Linux TCP: the classic measurement of the pool's socket times it
  if (spec.fault === "stall") return stallOf(spec);
  if (prediction.detects === null) return { detects: null, window: prediction.window, why: prediction.why ?? "a measurement" };
  const rtt = prediction.rtt === undefined ? {} : { rtt: prediction.rtt };
  const quiet = quietOf(prediction.quiet);
  if (!prediction.detects) {
    const [reply] = prediction.bands;
    const driver: DriverBand = {
      socket: "pool",
      ...(quiet.length === 0 ? {} : { quiet }),
      ...(reply === undefined ? {} : { reply: { from: referenceOf(reply.from), ends: endsOf(reply, spec)! } }),
    };
    return { detects: false, window: prediction.window, ...rtt, ...(reply === undefined ? {} : { replies: { low: reply.low, high: reply.high } }), driver };
  }
  const [band, ...rest] = prediction.bands;
  if (band === undefined) throw new Error(`${spec.plan}: a detection has no band`);
  const ends = endsOf(band, spec);
  const driver: DriverBand = {
    socket: socketOf(band.from),
    ...(ends === undefined ? {} : { ends }),
    ...(quiet.length === 0 ? {} : { quiet }),
    ...(rest.length === 0 ? {} : { then: rest.map((each) => stepOf(each, spec)) }),
  };
  return { detects: true, timer: band.what, errno: band.name, from: referenceOf(band.from), low: band.low, high: band.high, ...rtt, driver };
};

/** These are the stages that a quiet event of a T11 prediction names. */
const QUIET_STAGES: Readonly<Record<string, ReplicaSetStage>> = {
  "a member other than the old primary becomes primary": "elected",
  [WRITE_OFF]: "written-off",
};

/** This function gives the prediction of a cell of T11 for the harness. */
export const setPrediction = (cell: MongoCell): Prediction => {
  const { prediction, spec } = cell;
  const group = prediction.group;
  if (group === undefined) throw new Error(`${spec.plan}: a cell of T11 has no group prediction`);
  const quiet = prediction.quiet.map((what) => {
    const stage = QUIET_STAGES[what];
    if (stage === undefined) throw new Error(`${spec.plan}: no stage marks "${what}"`);
    return stage;
  });
  const expected: GroupPrediction = {
    lands: group.lands,
    failover: group.failover,
    stages: group.stages.map((stage) => ({ stage: stage.stage, low: stage.low, high: stage.high })),
    stamps: MEMBER_STAMPS,
    ...(group.errors === undefined ? {} : { errors: group.errors }),
    ...(quiet.length === 0 ? {} : { quiet }),
  };
  const rtt = prediction.rtt === undefined ? {} : { rtt: prediction.rtt };
  // a stall: the write into the cut gets its reply at the first retransmission after the cut ends
  if (spec.stall !== undefined) {
    const stall = stallOf(spec);
    if (stall.detects !== false || stall.recovers === undefined) throw new Error(`${spec.plan}: Linux TCP gives no recovery`);
    return { ...stall, window: prediction.window, group: expected };
  }
  const [band] = prediction.bands;
  if (band === undefined || prediction.detects !== true) throw new Error(`${spec.plan}: a cell of T11 has a band of its first write`);
  return { detects: true, timer: band.what, errno: "OK", from: "fault", low: band.low, high: band.high, ...rtt, group: expected };
};

/** This function gives the sysctls of the namespace of the client of a cell: Linux 6.6, with the overrides of the cell. */
const clientSysctls = (spec: MongoSpec): Record<string, string> => sysctlsOf(linuxValues(spec.linux));

/** This function gives the harness cell of a MongoDB cell of T01 or T03. */
export const singleCell = (cell: MongoCell): Cell => {
  const { spec } = cell;
  const hop = spec.router === undefined ? undefined : router(spec.router.form, spec.router.idle);
  const icmp = spec.fault === "unreachable" ? { "net.ipv4.icmp_ratelimit": "0" } : {};
  const atRouter = hop !== undefined && spec.toward !== undefined;
  // a killed server cannot serve the next run: each run of a fin has its own environment
  const killsServer = spec.fault === "fin";
  return {
    name: cell.name,
    target: MONGO_ONE,
    targetSetup: [INITIATE, ...(spec.op === "read-long" ? [LONG_DOCUMENT] : [])],
    sysctls: clientSysctls(spec),
    probe: { mode: spec.mode, keepalive: false, driver: { name: "mongodb", set: SET_NAME, ...(spec.op === undefined ? {} : { op: spec.op }) } },
    fault: spec.fault as Cell["fault"],
    prediction: singlePrediction(cell),
    ...(spec.observer === "server" ? { observer: "server" as const } : {}),
    ...(hop === undefined
      ? {}
      : { topology: { name: "T03", hops: [atRouter && spec.fault === "unreachable" ? { ...hop, sysctls: icmp } : hop] } }),
    ...(atRouter ? { faultAt: { hop: hop.name, toward: spec.toward! } } : {}),
    ...(!atRouter && spec.fault === "unreachable" ? { targetSysctls: icmp } : {}),
    ...(spec.fault === "freeze-process" && spec.hold !== undefined ? { hold: s(spec.hold) } : {}),
    ...(spec.stall === undefined ? {} : { stall: s(spec.stall) }),
    ...(spec.icmp === undefined ? {} : { icmp: spec.icmp }),
    ...(spec.drops === undefined ? {} : { drops: spec.drops }),
    ...(spec.mtu === undefined ? {} : { mtu: spec.mtu }),
    ...(spec.options === undefined ? {} : { driverOptions: spec.options }),
    ...(spec.before === true ? { before: true } : {}),
    runs: RUNS,
    environments: killsServer ? RUNS : 2,
  };
};

/** This function gives the harness cell of a MongoDB cell of T11. */
export const setCell = (cell: MongoCell): Cell => {
  const { spec } = cell;
  return {
    name: cell.name,
    target: { image: MONGO_IMAGE, port: 27017, ready: "Waiting for connections" },
    sysctls: clientSysctls(spec),
    probe: { mode: "stream", keepalive: false, interval: ms(INTERVAL * 1000) },
    fault: spec.fault as Cell["fault"],
    ...(spec.at === undefined ? {} : { faultAt: spec.at }),
    replicaSet: replicaSetOf(spec.settings),
    ...(spec.hold === undefined ? {} : { hold: s(spec.hold) }),
    ...(spec.stall === undefined ? {} : { stall: s(spec.stall) }),
    ...(spec.options === undefined ? {} : { driverOptions: spec.options }),
    ...(spec.w === undefined ? {} : { writeConcern: spec.w }),
    prediction: setPrediction(cell),
    runs: RUNS,
    environments: 2,
    // a set has 12 containers and its timeline reads three schedulers: one cell at a time
    concurrency: 1,
  };
};

/** These are the MongoDB cells of the catalogs for the harness: T01, T03, then T11. */
export const MONGO_CELLS: readonly Cell[] = [...T01_MONGO.map(singleCell), ...T03_MONGO.map(singleCell), ...T11_MONGO.map(setCell)];

/** This function gives the longest wait of a cell for its outcome, in seconds: for the plan of the runs in CI. */
export const longestWait = (cell: Cell): number => {
  const { prediction } = cell;
  const own = prediction.detects === true ? valueIn(prediction.high, "s") : valueIn(prediction.window, "s");
  const steps = prediction.detects !== null ? (prediction.driver?.then ?? []).map((step) => valueIn(step.high, "s")) : [];
  return Math.max(own, ...steps, cell.hold === undefined ? 0 : valueIn(cell.hold, "s"));
};
