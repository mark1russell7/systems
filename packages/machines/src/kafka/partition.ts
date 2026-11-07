import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra/schema";

// The source of each fact below is the tag 4.3.2 of Apache Kafka. Each line number is a line of that
// file at that tag. An assumption of this document has a note that says so.
const CORE = "kafka 4.3.2 core/src/main/scala/kafka";
const SERVER = "kafka 4.3.2 server/src/main/java/org/apache/kafka/server";
const STORAGE = "kafka 4.3.2 storage/src/main/java/org/apache/kafka/storage/internals/log";
const CONTROLLER = "kafka 4.3.2 metadata/src/main/java/org/apache/kafka/controller";
const RAFT = "kafka 4.3.2 raft/src/main/java/org/apache/kafka/raft";
const CLIENTS = "kafka 4.3.2 clients/src/main/java/org/apache/kafka/clients";

/**
 * This document is Apache Kafka 4.3.2, for one broker that leads one partition, in KRaft mode. It
 * gives what the broker answers at each `acks`, and how the high watermark moves. It also gives how
 * the broker loses the leadership when a fault cuts it from the other brokers and the controller.
 *
 * With `acks=1` a broker answers after its own append. With `acks=all` the write waits in a purgatory
 * until the high watermark passes it. The high watermark is the smallest log end of the maximal
 * in-sync replicas. A leader that cannot reach the controller cannot shrink that set, thus its high
 * watermark stays.
 *
 * The controller fences a broker when no heartbeat came for `broker.session.timeout.ms`, and it
 * elects another leader. The cut broker is not told, and it has no timer that stops it. It stays a
 * leader in its own view until the metadata of the change reaches it, after the cut lifts. It then
 * becomes a follower, and it ends each write in the purgatory with NOT_LEADER_OR_FOLLOWER. It fetches
 * from the new leader, which answers with the end of its log at its election. The old leader
 * truncates to that offset, not to the high watermark.
 */
export const KAFKA_PARTITION: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "kafka-partition",
  title: "Apache Kafka 4.3.2: one broker that leads one partition, its answers at each acks, its high watermark and the loss of its leadership",
  layer: "server",
  version: "4.3.2",
  conditions: {
    kafka: "4.3.2",
    mode: "KRaft, with one controller that is not a broker",
    partition: "one partition with a replica on each of three brokers, unclean leader election off",
    fault: "the leader is cut from the other brokers and the controller, and the client keeps its route to the leader",
  },
  sources: [
    { ref: `${CORE}/server/ReplicaManager.scala:1360-1366 a delayed produce only when requiredAcks is -1, and :911-915 each other write is answered at once`, rung: "implemented" },
    { ref: `${CORE}/server/ReplicaManager.scala:885-910 the delayed produce goes in the purgatory`, rung: "implemented" },
    { ref: `${SERVER}/purgatory/DelayedProduce.java:139-152 it completes on an error, or when each partition has enough replicas`, rung: "implemented" },
    {
      ref: `${CORE}/cluster/Partition.scala:947-983 acks=all completes when the high watermark passes the write, with NOT_ENOUGH_REPLICAS_AFTER_APPEND below the minimum, and NOT_LEADER_OR_FOLLOWER off the leader`,
      rung: "implemented",
    },
    { ref: `${CORE}/cluster/Partition.scala:1230-1238 an append with acks=all under min.insync.replicas fails, and each other append goes on`, rung: "implemented" },
    { ref: `${CORE}/cluster/Partition.scala:1010-1053 the high watermark is the smallest log end of the maximal in-sync replicas, and it does not move under the minimum`, rung: "implemented" },
    { ref: `${CORE}/cluster/Partition.scala:1089-1127 and :1155-1165 the shrink of the in-sync replicas`, rung: "implemented" },
    {
      ref: `${CORE}/cluster/Partition.scala:1636-1659 a shrink is pending until the controller commits it, and ${SERVER}/partition/PendingShrinkIsr.java:36-42 the maximal in-sync replicas stay the committed ones`,
      rung: "implemented",
    },
    { ref: `${SERVER}/config/ReplicationConfigs.java:55 replica.lag.time.max.ms is 30000`, rung: "implemented" },
    { ref: `${RAFT}/KRaftConfigs.java:40 broker.heartbeat.interval.ms is 2000, and :44 broker.session.timeout.ms is 9000`, rung: "implemented" },
    { ref: `${CONTROLLER}/BrokerHeartbeatTracker.java:99-121 and :131-133 a broker expires when no heartbeat came in the session timeout`, rung: "implemented" },
    { ref: `${CONTROLLER}/QuorumController.java:1659-1660 the controller looks for one stale broker each max(1 ms, session / 8), and :1672-1675 repeats`, rung: "implemented" },
    {
      ref: `${CONTROLLER}/ReplicationControlManager.java:1769-1797 and :2110-2112 it fences the broker and moves each of its leaderships, and PartitionChangeBuilder.java:256-267 takes the first valid replica in replica order`,
      rung: "implemented",
    },
    { ref: `${SERVER}/BrokerLifecycleManager.java:601-604 and :619-624 a broker that gets no heartbeat reply schedules the next heartbeat, and it stops nothing`, rung: "implemented" },
    { ref: `${RAFT}/QuorumConfig.java:83 the fetch timeout is 2000, and :104 the retry backoff is 20`, rung: "implemented" },
    { ref: `${CORE}/raft/KafkaRaftManager.scala:236-237 the reconnect backoff of the raft client is 50 to 500 ms, and :249-251 its setup timeouts are the settings of the broker`, rung: "implemented" },
    { ref: `${CLIENTS}/ClusterConnectionStates.java:41 and :43 a backoff and a setup timeout take a jitter of 0.2, and :372-379 a setup that fails doubles the timeout`, rung: "implemented" },
    { ref: `kafka 4.3.2 server-common/src/main/java/org/apache/kafka/server/config/ServerConfigs.java:71-77 socket.connection.setup.timeout.ms on a broker`, rung: "implemented" },
    { ref: `${CLIENTS}/CommonClientConfigs.java:139 and :144 socket.connection.setup.timeout.ms is 10000, and its maximum is 30000`, rung: "implemented" },
    {
      ref: `${CORE}/server/ReplicaManager.scala:2448-2544 the delta of a follower: makeFollower at :2472, a new fetcher at :2535, and each delayed write ends at :2539`,
      rung: "implemented",
    },
    {
      ref: `${CORE}/cluster/Partition.scala:1383-1413 a leader answers a fetch of an older epoch with the diverging epoch, and ${CORE}/server/AbstractFetcherThread.scala:603-641 the follower truncates to the end of that epoch`,
      rung: "implemented",
    },
    { ref: `${CORE}/cluster/Partition.scala:635-649 makeLeader, and :694-743 makeFollower`, rung: "implemented" },
    { ref: `${STORAGE}/UnifiedLog.java:1411-1421 and :1261-1268 an idempotent batch that repeats is not appended, and the answer gives its first offset`, rung: "implemented" },
    { ref: `${STORAGE}/ProducerStateEntry.java:35 and :128-135 the broker keeps the last 5 batches of each producer, and a repeat has their exact range of sequence numbers`, rung: "implemented" },
  ],
  states: {
    leader: { initial: true, note: "the controller and the broker agree that the broker leads" },
    deposed: {
      note: "the controller moved the leadership, and the broker does not know. It appends each write. It answers acks=1, and acks=all waits, because no fetch reaches it and its high watermark stays",
    },
    follower: { note: "the broker fetches from the new leader" },
  },
  events: {
    "rx.produce-1": { kind: "rx", note: "a write with acks=1" },
    "rx.produce-all": { kind: "rx", note: "a write with acks=all, with enough in-sync replicas" },
    "rx.produce-all-short": { kind: "rx", note: "a write with acks=all, under min.insync.replicas" },
    "rx.produce-repeat": { kind: "rx", note: "an idempotent batch with the sequence numbers of one of the last 5 batches of its producer" },
    "rx.fetch": { kind: "rx", note: "a fetch of a follower" },
    "rx.heartbeat": { kind: "rx", note: "a heartbeat of this broker reaches the controller" },
    "local.lift": { kind: "local", note: "the cut lifts" },
    "timer.lag": { kind: "timer", note: "a follower did not catch up in replica.lag.time.max.ms" },
    "timer.fence": { kind: "timer", note: "the controller finds the session of the broker expired" },
    "timer.metadata": { kind: "timer", note: "the metadata of the change reaches the broker" },
    "rx.diverging-epoch": { kind: "rx", note: "the new leader answers a fetch with the end of the old epoch" },
    "rx.elected": { kind: "rx", note: "the metadata names this broker as the leader again" },
  },
  knobs: {
    broker_heartbeat_interval: { key: "broker.heartbeat.interval.ms", scope: "broker", unit: "ms", default: 2000, note: "KRaftConfigs.java:40" },
    broker_session_timeout: { key: "broker.session.timeout.ms", scope: "broker", unit: "ms", default: 9000, note: "KRaftConfigs.java:44" },
    replica_lag_time_max: { key: "replica.lag.time.max.ms", scope: "broker", unit: "ms", default: 30000, note: "ReplicationConfigs.java:55" },
    socket_connection_setup_timeout: { key: "socket.connection.setup.timeout.ms", scope: "broker", unit: "ms", default: 10000, note: "CommonClientConfigs.java:139" },
    raft_reconnect_backoff_max: { key: "the largest reconnect backoff of the raft client", scope: "build", unit: "ms", default: 500, note: "KafkaRaftManager.scala:237" },
    connection_jitter: { key: "the jitter of a setup timeout and of a backoff", scope: "build", unit: "count", default: 0.2, note: "ClusterConnectionStates.java:41, :43" },
    slack: {
      key: "the round trips and the steps from the first connect to the publish of the metadata",
      scope: "broker",
      unit: "ms",
      default: 100,
      note: "an assumption of this document, not a value of Kafka: the version request, a fetch, and the publish of the batch",
    },
  },
  timers: {
    replica_lag: {
      duration: { expr: "replica_lag_time_max", unit: "ms" },
      arms: ["enter:leader"],
      cancels: ["rx.fetch"],
      fires: "timer.lag",
      note: "the first follower that lags. The broker asks the controller to shrink, and a cut broker gets no answer",
    },
    fence: {
      // the last heartbeat came up to one interval before the fault, and the check of the controller comes each session / 8
      duration: { expr: "broker_session_timeout", unit: "ms" },
      early: { expr: "broker_heartbeat_interval", unit: "ms" },
      lateness: { expr: "max(1, broker_session_timeout / 8)", unit: "ms" },
      arms: ["enter:leader"],
      cancels: ["rx.heartbeat"],
      fires: "timer.fence",
      note: "from the fault. It runs in the controller",
    },
    step_down: {
      // a setup that the lift meets ends at its timeout, then one backoff, then the connect that the lift lets through
      duration: { const: 0, unit: "ms" },
      lateness: { expr: "socket_connection_setup_timeout * (1 + connection_jitter) + raft_reconnect_backoff_max * (1 + connection_jitter) + slack", unit: "ms" },
      arms: ["local.lift"],
      fires: "timer.metadata",
      note: "from the lift. No timer of Kafka: the longest wait of the raft client for its next fetch from the controller. A hold above the fetch timeout has no fetch in flight at the lift",
    },
  },
  transitions: [
    { id: "kafka.append-1", from: "leader", to: "leader", on: "rx.produce-1", emits: ["reply"], note: "the reply follows the local append", source: "ReplicaManager.scala:911-915, :1360-1366" },
    { id: "kafka.append-all", from: "leader", to: "leader", on: "rx.produce-all", note: "the write waits in the purgatory", source: "ReplicaManager.scala:885-910, DelayedProduce.java:139-152" },
    { id: "kafka.refuse", from: "leader", to: "leader", on: "rx.produce-all-short", emits: ["NOT_ENOUGH_REPLICAS"], source: "Partition.scala:1230-1238" },
    { id: "kafka.repeat", from: "leader", to: "leader", on: "rx.produce-repeat", emits: ["reply"], note: "the log does not change, and the reply gives the first offset", source: "UnifiedLog.java:1411-1421, ProducerStateEntry.java:128-135" },
    { id: "kafka.fetch", from: "leader", to: "leader", on: "rx.fetch", emits: ["reply"], note: "the high watermark moves, and each write that it passes completes", source: "Partition.scala:947-983, :1010-1053" },
    { id: "kafka.heartbeat", from: "leader", to: "leader", on: "rx.heartbeat", source: "BrokerHeartbeatTracker.java:99-121" },
    { id: "kafka.lift-early", from: "leader", to: "leader", on: "local.lift", note: "a hold that ends before the fence: the heartbeats go on, and the leadership stays", source: "BrokerLifecycleManager.java:601-604" },
    { id: "kafka.shrink-pending", from: "leader", to: "leader", on: "timer.lag", note: "the shrink stays pending: the maximal in-sync replicas keep each follower", source: "Partition.scala:1636-1659, PendingShrinkIsr.java:36-42" },
    { id: "kafka.fenced", from: "leader", to: "deposed", on: "timer.fence", note: "the first valid replica in replica order leads, with the log end that it has", source: "BrokerHeartbeatTracker.java:131-133, QuorumController.java:1659-1660, ReplicationControlManager.java:1769-1797, PartitionChangeBuilder.java:256-267" },
    { id: "kafka.deposed-append-1", from: "deposed", to: "deposed", on: "rx.produce-1", emits: ["reply"], note: "the broker has no check of its own fence", source: "ReplicaManager.scala:911-915, BrokerLifecycleManager.java:619-624" },
    { id: "kafka.deposed-append-all", from: "deposed", to: "deposed", on: "rx.produce-all", note: "the write waits: the high watermark stays", source: "Partition.scala:969, :1028-1032" },
    { id: "kafka.deposed-shrink", from: "deposed", to: "deposed", on: "timer.lag", note: "the shrink stays pending", source: "Partition.scala:1636-1659" },
    { id: "kafka.deposed-lift", from: "deposed", to: "deposed", on: "local.lift", note: "the wait for the metadata starts", source: "KafkaRaftManager.scala:236-237, :249-251" },
    { id: "kafka.step-down", from: "deposed", to: "follower", on: "timer.metadata", emits: ["NOT_LEADER_OR_FOLLOWER"], note: "each write in the purgatory ends, and the producer sends it to the new leader", source: "ReplicaManager.scala:2448-2544, Partition.scala:694-743" },
    { id: "kafka.truncate", from: "follower", to: "follower", on: "rx.diverging-epoch", note: "the log ends at the end of the new leader's log at its election", source: "Partition.scala:1383-1413, AbstractFetcherThread.scala:603-641" },
    { id: "kafka.elected", from: "follower", to: "leader", on: "rx.elected", source: "Partition.scala:635-649" },
  ],
});
