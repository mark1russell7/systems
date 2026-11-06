import type { Cell, GroupPrediction, Kafka, Target } from "@mark1russell7/harness";
import { KAFKA_PARTITION } from "@mark1russell7/machines";
import { given, ms, q, s } from "../catalog.ts";
import type { Span } from "../mongo/model.ts";
import { defaultsOf, linuxValues, secondsOf, spanOf } from "../mongo/model.ts";
import { rounded } from "../writes.ts";

/**
 * This module holds the cells of SYS-71: which writes does Kafka lose at each `acks`? The group is
 * three brokers and one controller of Apache Kafka 4.3.2. The client is the producer of kafka-clients
 * 4.3.2 on Java 21. A fault cuts the leader from the other brokers and from the controller, and the
 * client keeps its route to the leader. Each term comes from the source at the tag 4.3.2, and the
 * document `kafka-partition` holds each one with its citation.
 *
 * With `acks=1` a broker answers after its local append (ReplicaManager.scala:911-915). The controller
 * fences the leader 7 s to 10.125 s after the fault (`fence`) and elects a follower. The cut broker
 * has no timer of its own that stops it (BrokerLifecycleManager.java:601-604, :619-624). It answers
 * through the whole hold, and after the lift until the metadata reaches it (`step_down`). The old leader
 * then truncates to the end of the new leader's log at its election. That end comes in the fetch
 * answer of a diverging epoch (Partition.scala:1383-1413, AbstractFetcherThread.scala:603-641).
 *
 * The law of `acks=1`: the writes lost are the writes that the old leader answers from the cut to its
 * step-down. Thus the count reads the hold. The bound is not the high watermark. Each write that
 * reached the new leader survives, also above the high watermark. A hold that ends before the fence
 * has no election, thus it loses no write.
 *
 * The law of `acks=all`: no write is lost. A write waits until the high watermark passes it
 * (Partition.scala:969). The high watermark is the smallest log end of the maximal in-sync replicas
 * (Partition.scala:1028-1032). A cut leader cannot shrink that set, because a shrink needs the controller
 * (Partition.scala:1636-1659).
 *
 * Thus each write of the hold waits, and it gets no answer until NOT_LEADER_OR_FOLLOWER at the
 * step-down. The producer then sends it to the new leader. The cause is not `min.insync.replicas`.
 * That setting acts only when the set has shrunk (Partition.scala:1234). Thus a minimum of 1 gives the
 * same count.
 *
 * The law of the copies: a retry that repeats a batch in the new leader's log has the sequence numbers
 * of that batch. Thus the log does not grow (UnifiedLog.java:1411-1421). Each cell of `acks=all` has
 * idempotence on, which is the default (ProducerConfig.java:393, :527). `acks=1` turns it off with no
 * warning (ProducerConfig.java:610-618), and no cell here reads copies at `acks=1`.
 *
 * Idempotence off has no cell. A copy needs a batch that reached a follower and whose answer did not
 * reach the client. That window is one fetch round trip at the fault, thus the true band is 0 to W, with
 * a count near 0. A cell with that band cannot fail. A forced copy needs a cut in two parts, and the
 * harness has no such fault for this group.
 */

/** This image is Apache Kafka 4.3.2, pinned by the digest of its index. */
export const KAFKA_IMAGE = "apache/kafka:4.3.2@sha256:852a0d49fc4e656b022e7f23785411802c9a088c78a7c5e39f33969de9c227a7";

/** This line tells that a node serves, for each role (KafkaRaftServer.scala:97, KafkaBroker.scala:72). */
const READY = "Kafka Server started";

/** This time is the chosen setup timeout of a connection of a broker, in ms. It has no source. The default of 10 s makes the step-down long (`step_down`). */
const SETUP_TIMEOUT = 1000;

/**
 * This group is three brokers and one controller. The controller is not a target of a fault, and the
 * law has no election of the quorum. The settings fix the setup timeout at one value, because a failed
 * setup doubles it up to the maximum (ClusterConnectionStates.java:372-379). They also keep the
 * leadership on the new broker after the lift. The heap of 512 MB has no source: four nodes and a
 * client fit a runner of 4 CPUs and 16 GB.
 */
const groupOf = (minInsync: number, writers: number): Kafka => ({
  image: KAFKA_IMAGE,
  brokers: ["k1", "k2", "k3"],
  controller: "c1",
  port: 9092,
  controllerPort: 9093,
  clusterId: "Y2VsbHMtb2Yta2Fma2EtMQ",
  heap: "-Xmx512m -Xms512m",
  settings: {
    "socket.connection.setup.timeout.ms": String(SETUP_TIMEOUT),
    "socket.connection.setup.timeout.max.ms": String(SETUP_TIMEOUT),
    "auto.leader.rebalance.enable": "false",
  },
  ready: READY,
  minInsync,
  writers,
});

/** This target is one broker, for the record of the cell: the lab starts each node by the command of its image. */
export const KAFKA_TARGET: Target = { image: KAFKA_IMAGE, port: 9092, ready: READY, program: "java" };

/** This time is the wait of a writer between two writes, in seconds. It has no source. */
export const INTERVAL = 0.05;
/** This time is the round trip of the group, in seconds. It has no source. */
export const RTT = 0.002;
/** This time is the most that one write adds in the client and the broker, in seconds. It has no source. */
export const CYCLE_SLACK = 0.01;
/** This time is the chosen window of a measured cell, in seconds: it is above each hold and its step-down. It has no source. */
const WINDOW = 60;
/** This count is the runs of a cell of SYS-71: the decision rule of the prediction reads 4. */
export const ACKS_RUNS = 4;
/** This count is the chosen count of writers at `acks=all`, each with one write at a time. It has no source. */
export const WRITERS = 4;
/** This time is `request.timeout.ms` of the producer, in seconds (ProducerConfig.java:441-446). A delayed write ends there (Sender.java:890, :930-933). */
export const REQUEST_TIMEOUT = 30;

/** These are the knobs of the document for a cell. */
const VALUES = { ...defaultsOf(KAFKA_PARTITION), socket_connection_setup_timeout: ms(SETUP_TIMEOUT) };

/** This function gives the fence of the controller, in seconds from the fault. */
export const fenceOf = (): Span => spanOf(KAFKA_PARTITION, "fence", given(VALUES));

/** This function gives the step-down of the old leader, in seconds from the lift. */
export const stepDownOf = (): Span => spanOf(KAFKA_PARTITION, "step_down", given(VALUES));

/** This function gives the time of one write of one writer, in seconds: the wait of the writer, and its reply. */
export const cycleOf = (): Span => ({ lo: INTERVAL, hi: rounded(INTERVAL + RTT + CYCLE_SLACK) });

/**
 * This function gives the band of the writes that `acks=1` loses, for a hold above the fence. The low
 * edge is the writes in the hold at the longest cycle, less one for the write that the cut meets. The
 * high edge is the writes to the latest step-down at the shortest cycle. It adds two: a follower can
 * lag one write at the cut, and a write that the step-down meets can have its reply.
 */
export const lostOf = (hold: number): { readonly low: number; readonly high: number } => {
  const cycle = cycleOf();
  return { low: Math.floor(rounded(hold / cycle.hi)) - 1, high: Math.ceil(rounded((hold + stepDownOf().hi) / cycle.lo)) + 2 };
};

/**
 * This function gives the latest gap between two heartbeats at the controller for a hold, in seconds.
 * The last heartbeat came up to one interval before the fault. A heartbeat in flight retransmits on
 * the doubled timer of TCP. Its first timer is `tcp_rto_min`, and the next retransmission after the lift
 * comes at most `2 × hold + tcp_rto_min` after the fault.
 */
export const heartbeatBackOf = (hold: number): number =>
  rounded(secondsOf(VALUES, "broker_heartbeat_interval") + 2 * hold + secondsOf(linuxValues(), "tcp_rto_min"));

/** A spec is one cell of SYS-71, before its prediction. */
export interface AcksSpec {
  /** This identifier is the name of the cell, for example `K1.acks.1`. */
  readonly plan: string;
  /** This text is the value of `acks`. */
  readonly acks: "1" | "all";
  /** This count is the setting `min.insync.replicas` of the topic. */
  readonly minInsync: number;
  /** This count is the writers of the client. */
  readonly writers: number;
  /** This time is how long the cut holds, in seconds. */
  readonly hold: number;
  /** This flag tells that the hold is above the fence, thus another broker leads at the end. */
  readonly failover: boolean;
}

/** These are the specs of SYS-71: the law of `acks=1` at two holds, its short hold, and `acks=all` at two minimums. */
export const ACKS_SPECS: readonly AcksSpec[] = [
  { plan: "K1.acks.1", acks: "1", minInsync: 2, writers: 1, hold: 20, failover: true },
  { plan: "K1.acks.2", acks: "1", minInsync: 2, writers: 1, hold: 40, failover: true },
  { plan: "K1.acks.3", acks: "1", minInsync: 2, writers: 1, hold: 3, failover: false },
  { plan: "K1.acks.4", acks: "all", minInsync: 2, writers: WRITERS, hold: 20, failover: true },
  { plan: "K1.acks.5", acks: "all", minInsync: 1, writers: WRITERS, hold: 20, failover: true },
];

/** This function gives the band of lost writes of a spec. */
const lostBand = (spec: AcksSpec): { readonly low: number; readonly high: number } =>
  spec.acks === "1" && spec.failover ? lostOf(spec.hold) : { low: 0, high: 0 };

const WHY_LOST = "the first write after the lift has no band: the band of lost writes judges the cell";
const WHY_ALL = "each write of the hold waits, and the first answer has no band: the bands of lost writes and of copies judge the cell";

/** This function gives the cell of a spec. It throws if a term of the law does not hold for the spec. */
export const acksCell = (spec: AcksSpec): Cell => {
  if (spec.failover && spec.hold <= fenceOf().hi) throw new Error(`${spec.plan}: the hold can end before the fence`);
  if (!spec.failover && heartbeatBackOf(spec.hold) >= secondsOf(VALUES, "broker_session_timeout")) throw new Error(`${spec.plan}: the session can expire in the hold`);
  // a delayed write must end at the step-down: a timeout of the request is a second cause of a retry
  if (spec.acks === "all" && spec.hold + stepDownOf().hi >= REQUEST_TIMEOUT) throw new Error(`${spec.plan}: the request timer can end a write in the hold`);
  const group: GroupPrediction = {
    lands: "same",
    failover: spec.failover,
    stages: [],
    lost: lostBand(spec),
    ...(spec.acks === "all" ? { duplicates: { low: 0, high: 0 } } : {}),
  };
  return {
    name: `${spec.plan} kafka-clients-4.3 to kafka-4.3 group, the leader cut from the group, ${spec.hold} s, acks=${spec.acks}, min.insync.replicas ${spec.minInsync}, ${spec.writers === 1 ? "one writer" : `${spec.writers} writers`}`,
    target: KAFKA_TARGET,
    sysctls: {},
    probe: { mode: "stream", keepalive: false, interval: ms(INTERVAL * 1000) },
    // linger.ms has no source: a batch of one write at a time needs no wait
    driverOptions: { acks: spec.acks, "linger.ms": 0 },
    fault: "partition",
    faultAt: { role: "primary", cuts: "group" },
    kafka: groupOf(spec.minInsync, spec.writers),
    hold: s(spec.hold),
    prediction: { detects: null, window: q(WINDOW), why: spec.acks === "1" ? WHY_LOST : WHY_ALL, from: "fault", group },
    runs: ACKS_RUNS,
    environments: 2,
    // four nodes, their sidecars, a client and a prober fill a runner: one cell at a time
    concurrency: 1,
  };
};

/** These are the cells of SYS-71. */
export const ACKS_CELLS: readonly Cell[] = ACKS_SPECS.map(acksCell);
