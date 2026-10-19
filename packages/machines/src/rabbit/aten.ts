import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra";

// The source of each fact below is aten 0.6.0, the failure detector between the nodes that ra
// 3.1.10 locks (rebar.lock of ra), as RabbitMQ 4.3.6 ships it in deps/aten. Each line number is a line
// of that file in that release. A fact of the BEAM is an assumption of this document, and its note says so.
const ATEN = "aten 0.6.0";

/**
 * This document is aten 0.6.0, the failure detector between the nodes of RabbitMQ 4.3.6. It gives one
 * node that another node watches: up or down, as the detector of the watching node sees it.
 *
 * Each node sends a heartbeat to each connected node each 100 ms. The sink of the watching node keeps
 * the gaps between the heartbeats of each node. Its detector polls each 1000 ms.
 *
 * At a poll, the probability of a failure is a share of the gaps. A gap counts when 1.5 times the gap
 * is not longer than the time since the last heartbeat. The node is down when that share reaches 0.99.
 * With gaps of approximately 100 ms, that is approximately 150 ms after the last heartbeat, at the first
 * poll after it. Thus a silent node is down 150 ms to approximately 1.15 s after its last heartbeat,
 * long before the tick of the distribution.
 *
 * A closed connection of the distribution (a stopped node) removes the data of the node from the
 * sink. The next poll then reports the node down.
 */
export const ATEN_DETECTOR: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "aten",
  title: "aten 0.6.0: one node that the failure detector of another node of RabbitMQ watches, up or down",
  layer: "server",
  version: "0.6.0",
  conditions: {
    aten: "0.6.0",
    ra: "3.1.10",
    rabbitmq: "4.3.6",
    nodes: "two nodes of one cluster, connected by the Erlang distribution",
  },
  sources: [
    { ref: `${ATEN} src/aten.app.src: the defaults poll_interval 1000, scaling_factor 1.5, heartbeat_interval 100, detection_threshold 0.99`, rung: "implemented" },
    {
      ref: `${ATEN} src/aten_emitter.erl:49-54 and :95-98 the emitter arms its next send heartbeat_interval after it sends to each node, :63-82 it sends to each node in nodes() with noconnect and nosuspend`,
      rung: "implemented",
    },
    { ref: `${ATEN} src/aten_sink.erl:69-79 a heartbeat adds a sample to the state of its node, :81-87 nodedown removes the state of the node`, rung: "implemented" },
    {
      ref: `${ATEN} src/aten_detect.erl:17 a window of 1000 samples, :44-52 a sample is the gap since the heartbeat before it, :54-68 the probability is the share of the gaps S with S × factor ≤ the time since the last heartbeat`,
      rung: "implemented",
    },
    {
      ref: `${ATEN} src/aten_detector.erl:53-59 the threshold and the poll interval, :105-113 each poll arms the next poll first, then reads the probabilities, :148-186 a node goes down when its probability crosses the threshold between two polls, or when it leaves the sink`,
      rung: "implemented",
    },
    { ref: `${ATEN} src/aten_detector.erl:134-146 the detector sends {node_event, Node, down} or up to each process that watches the node`, rung: "implemented" },
    {
      ref: "rabbitmq v4.3.6 deps/rabbit/priv/schema/rabbit.schema:2540-2589 raft.adaptive_failure_detector.poll_interval, scaling_factor, heartbeat_interval and detection_threshold map to aten",
      rung: "implemented",
    },
  ],
  states: {
    up: { initial: true, note: "the probability of the node is below the threshold at the last poll" },
    down: { note: "{node_event, Node, down}: the probability crossed the threshold, or the node left the sink" },
  },
  events: {
    "rx.heartbeat": { kind: "rx", note: "a heartbeat of the node reaches the sink of the watching node" },
    "rx.nodedown": { kind: "rx", note: "the connection of the distribution to the node closed: the sink removes the node" },
    "timer.detect": { kind: "timer", note: "the first poll at which the share of the gaps reaches the threshold" },
    "timer.left": { kind: "timer", note: "the first poll after the node left the sink" },
  },
  knobs: {
    heartbeat_interval: { key: "raft.adaptive_failure_detector.heartbeat_interval (aten heartbeat_interval)", scope: "node", unit: "ms", default: 100, note: "aten.app.src" },
    poll_interval: { key: "raft.adaptive_failure_detector.poll_interval (aten poll_interval)", scope: "node", unit: "ms", default: 1000, note: "aten.app.src" },
    scaling_factor: { key: "raft.adaptive_failure_detector.scaling_factor (aten scaling_factor)", scope: "node", unit: "count", default: 1.5, note: "aten.app.src" },
    detection_threshold: {
      key: "raft.adaptive_failure_detector.detection_threshold (aten detection_threshold)",
      scope: "node",
      unit: "count",
      default: 0.99,
      note: "aten.app.src: the share of the gaps that the time since the last heartbeat must reach",
    },
    gap_slack: {
      key: "how much longer than heartbeat_interval the 99th percentile gap is",
      scope: "node",
      unit: "ms",
      default: 10,
      note: "an assumption of this document, not a value of aten: the emitter arms its next send after its sends (aten_emitter.erl:95-98), and the BEAM schedules it a little late",
    },
    slack: {
      key: "the lateness of a timer of the BEAM for one step",
      scope: "node",
      unit: "ms",
      default: 10,
      note: "an assumption of this document, not a value of aten: a send_after that fires late",
    },
  },
  timers: {
    detect: {
      // the share reaches the threshold when the time since the last heartbeat is the factor times the
      // 99th percentile gap. The detector sees it at its first poll after that time (aten_detector.erl:105-113)
      duration: { expr: "scaling_factor * heartbeat_interval", unit: "ms" },
      lateness: { expr: "scaling_factor * gap_slack + poll_interval + slack", unit: "ms" },
      arms: ["rx.heartbeat"],
      fires: "timer.detect",
      note: "150 ms after the last heartbeat at the defaults, and up to one poll later",
    },
    nodedown_poll: {
      // a node that left the sink is down at the next poll (aten_detector.erl:159-175)
      duration: { const: 0, unit: "ms" },
      lateness: { expr: "poll_interval + slack", unit: "ms" },
      arms: ["rx.nodedown"],
      fires: "timer.left",
    },
  },
  realizes: {
    "systems.mechanism.heartbeat-detection-time": { timer: "detect" },
    "systems.mechanism.heartbeat-interval": {
      duration: { knob: "heartbeat_interval", unit: "ms" },
      lateness: { knob: "gap_slack", unit: "ms" },
      note: "each node sends a heartbeat to each connected node at this interval (aten_emitter.erl:95-98)",
    },
  },
  transitions: [
    { id: "aten.heartbeat", from: "up", to: "up", on: "rx.heartbeat", note: "a new sample of the gap", source: "aten_sink.erl:69-79" },
    { id: "aten.down", from: "up", to: "down", on: "timer.detect", timer: "detect", emits: ["node_event down"], source: "aten_detector.erl:148-186" },
    { id: "aten.left", from: "up", to: "down", on: "timer.left", timer: "nodedown_poll", emits: ["node_event down"], source: "aten_detector.erl:159-175" },
    { id: "aten.up", from: "down", to: "up", on: "rx.heartbeat", emits: ["node_event up"], note: "at the next poll the share is below the threshold again", source: "aten_detector.erl:153-155" },
  ],
});
