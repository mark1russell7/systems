import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra/schema";

// The source of each fact below is the tag 4.3.2 of Apache Kafka. Each line number is a line of that
// file at that tag. An assumption of this document has a note that says so.
const GROUP = "kafka 4.3.2 group-coordinator/src/main/java/org/apache/kafka/coordinator/group";
const INTERNALS = "kafka 4.3.2 clients/src/main/java/org/apache/kafka/clients/consumer/internals";

/**
 * This document is Apache Kafka 4.3.2, for one member of a consumer group that a process stop holds.
 * It gives when the coordinator removes the member, and when another member gets its partition. It
 * also gives the answer to a commit of the old offsets after the stop.
 *
 * In the consumer protocol the session is a setting of the broker. Each heartbeat starts the session
 * timer again. The last heartbeat came up to one interval before the stop, thus the fence comes one
 * session after the stop, less up to one interval. The other member takes the partition at one of its
 * own heartbeats after the fence.
 *
 * A commit of the member after the fence gets UNKNOWN_MEMBER_ID, and the client throws
 * CommitFailedException. The rejoin changes this. A member that polls after the fence joins again at
 * epoch 0 and gets a new epoch. The commit check at the same epoch asks no question about who owns the
 * partition. Thus the broker accepts a commit of the old offsets at the new epoch. That commit moves
 * the committed offset back while another member owns the partition.
 */
export const KAFKA_CONSUMER_GROUP: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "kafka-consumer-group",
  title: "Apache Kafka 4.3.2: one member of a consumer group under a process stop, its fence, the takeover of its partition and its commit after the stop",
  layer: "server",
  version: "4.3.2",
  conditions: {
    kafka: "4.3.2",
    mode: "KRaft, with one controller that is not a broker",
    group: "two members and two partitions, with one partition for each member before the stop",
    fault: "a stop of the process of one member, for a time, in the processing of one batch",
  },
  sources: [
    { ref: `${GROUP}/GroupCoordinatorConfig.java:184-204 the session of the consumer protocol is 45000, its minimum 45000, its maximum 60000, and the heartbeat interval is 5000`, rung: "implemented" },
    { ref: `${GROUP}/GroupCoordinatorConfig.java:592-598 the session is at or above its minimum and at or below its maximum, and the interval is below the session`, rung: "implemented" },
    { ref: `${GROUP}/GroupCoordinatorConfig.java:163-168 the classic session is between 6000 and 1800000, a value that the client sets`, rung: "implemented" },
    { ref: `${GROUP}/GroupMetadataManager.java:2475 each heartbeat schedules the session again, and :4775-4787 the timer fences the member`, rung: "implemented" },
    { ref: `${GROUP}/GroupMetadataManager.java:4687 the log line of a fence of the consumer protocol, and :7026 the line of a classic member`, rung: "implemented" },
    { ref: `${GROUP}/GroupMetadataManager.java:4358 the fence removes the member, raises the group epoch and cancels the timers of the member`, rung: "implemented" },
    { ref: `${GROUP}/GroupMetadataManager.java:3867 and :3900-3947 the next heartbeat of another member computes the target and reconciles`, rung: "implemented" },
    {
      ref: `${GROUP}/modern/consumer/ConsumerGroup.java:649-690 a commit of a member that is gone gets UNKNOWN_MEMBER_ID, and a commit at the epoch of the member passes with no check of who owns the partition`,
      rung: "implemented",
    },
    { ref: `${INTERNALS}/CommitRequestManager.java:826-832 a commit sends the member and the epoch, and :901-905 UNKNOWN_MEMBER_ID becomes CommitFailedException`, rung: "implemented" },
    { ref: `${INTERNALS}/AbstractHeartbeatRequestManager.java:427-442 a fenced epoch and an unknown member both fence the client`, rung: "implemented" },
    { ref: `${INTERNALS}/AbstractMembershipManager.java:388 a fenced client resets its epoch, signals the lost partitions, clears its assignment and joins again`, rung: "implemented" },
    { ref: `${INTERNALS}/ConsumerMembershipManager.java:367-374 with a listener, the lost callback waits for the poll of the application`, rung: "implemented" },
    { ref: `${INTERNALS}/AsyncKafkaConsumer.java:1006 a poll runs the callbacks, thus the rejoin follows the poll`, rung: "implemented" },
    { ref: `${INTERNALS}/ConsumerCoordinator.java:1312-1325 and :1433-1448 a classic commit with no generation, or with UNKNOWN_MEMBER_ID, gets CommitFailedException`, rung: "implemented" },
  ],
  states: {
    stable: { initial: true, note: "the coordinator holds the member, and the member holds its partition" },
    fenced: { note: "the coordinator removed the member, and the stopped client does not know" },
    rejoined: { note: "the client joined again and has a new epoch, and another member can own its old partition" },
  },
  events: {
    "rx.heartbeat": { kind: "rx", note: "a heartbeat of this member reaches the coordinator" },
    "rx.commit": { kind: "rx", note: "a commit of the old offsets, at the epoch of the member" },
    "rx.commit-after-fence": { kind: "rx", note: "a commit of the old offsets from a member that the coordinator removed" },
    "local.poll": { kind: "local", note: "the application polls after the thaw" },
    "timer.session": { kind: "timer", note: "the session of the member ends in the coordinator" },
    "timer.takeover": { kind: "timer", note: "a heartbeat of the other member after the fence gives it the partition" },
  },
  knobs: {
    consumer_session_timeout: { key: "group.consumer.session.timeout.ms", scope: "broker", unit: "ms", default: 45000, note: "GroupCoordinatorConfig.java:184" },
    consumer_heartbeat_interval: { key: "group.consumer.heartbeat.interval.ms", scope: "broker", unit: "ms", default: 5000, note: "GroupCoordinatorConfig.java:196" },
    classic_session_timeout: { key: "session.timeout.ms", scope: "client", unit: "ms", default: 45000, note: "a value of the client, between the limits at GroupCoordinatorConfig.java:163-168" },
    classic_heartbeat_interval: { key: "heartbeat.interval.ms", scope: "client", unit: "ms", default: 3000, note: "a value of the client" },
    early_slack: {
      key: "the time from a heartbeat of the client to its arrival at the coordinator",
      scope: "broker",
      unit: "ms",
      default: 100,
      note: "an assumption of this document, not a value of Kafka",
    },
    late_slack: {
      key: "the time from the end of a session to the line of the fence, and to the takeover",
      scope: "broker",
      unit: "ms",
      default: 1000,
      note: "an assumption of this document, not a value of Kafka: the timer wheel and the write of the coordinator",
    },
    takeover_slack: {
      key: "the time from a heartbeat of the other member to its report of the partition",
      scope: "broker",
      unit: "ms",
      default: 500,
      note: "an assumption of this document, not a value of Kafka: the reconcile and the next poll",
    },
  },
  timers: {
    fence: {
      // the last heartbeat came up to one interval before the stop
      duration: { expr: "consumer_session_timeout", unit: "ms" },
      early: { expr: "consumer_heartbeat_interval + early_slack", unit: "ms" },
      lateness: { expr: "late_slack", unit: "ms" },
      arms: ["enter:stable"],
      cancels: ["rx.heartbeat"],
      fires: "timer.session",
      note: "from the stop. It runs in the coordinator",
    },
    takeover: {
      // the other member can have a heartbeat at the fence, or one whole interval after it
      duration: { expr: "consumer_session_timeout", unit: "ms" },
      early: { expr: "consumer_heartbeat_interval + early_slack", unit: "ms" },
      lateness: { expr: "consumer_heartbeat_interval + late_slack + takeover_slack", unit: "ms" },
      arms: ["enter:stable"],
      fires: "timer.takeover",
      note: "from the stop: the fence, then the next heartbeat of the other member and its next poll",
    },
    classic_fence: {
      duration: { expr: "classic_session_timeout", unit: "ms" },
      early: { expr: "classic_heartbeat_interval + early_slack", unit: "ms" },
      lateness: { expr: "late_slack", unit: "ms" },
      arms: ["enter:stable"],
      cancels: ["rx.heartbeat"],
      fires: "timer.session",
      note: "from the stop, for a classic member. It runs in the coordinator",
    },
  },
  transitions: [
    { id: "group.heartbeat", from: "stable", to: "stable", on: "rx.heartbeat", note: "the session starts again", source: "GroupMetadataManager.java:2475" },
    { id: "group.commit", from: "stable", to: "stable", on: "rx.commit", emits: ["reply"], note: "a stop below the session: the epoch is the same, and the commit passes", source: "ConsumerGroup.java:649-690" },
    { id: "group.fence", from: "stable", to: "fenced", on: "timer.session", emits: ["fence line"], note: "the coordinator removes the member and raises the group epoch", source: "GroupMetadataManager.java:4358, :4687, :4775-4787, :7026" },
    { id: "group.takeover", from: "fenced", to: "fenced", on: "timer.takeover", note: "the other member owns the partition and reads from the last committed offset", source: "GroupMetadataManager.java:3867, :3900-3947" },
    {
      id: "group.commit-fails",
      from: "fenced",
      to: "fenced",
      on: "rx.commit-after-fence",
      emits: ["UNKNOWN_MEMBER_ID"],
      note: "the client throws CommitFailedException",
      source: "ConsumerGroup.java:649-690, CommitRequestManager.java:901-905, ConsumerCoordinator.java:1433-1448",
    },
    {
      id: "group.rejoin",
      from: "fenced",
      to: "rejoined",
      on: "local.poll",
      note: "the client signals the lost partitions, clears its assignment and joins at epoch 0",
      source: "AbstractMembershipManager.java:388, ConsumerMembershipManager.java:367-374, AsyncKafkaConsumer.java:1006",
    },
    {
      id: "group.stale-commit",
      from: "rejoined",
      to: "rejoined",
      on: "rx.commit",
      emits: ["reply"],
      note: "the check at the same epoch asks no question about who owns the partition, thus the committed offset moves back",
      source: "ConsumerGroup.java:649-690",
    },
  ],
});
