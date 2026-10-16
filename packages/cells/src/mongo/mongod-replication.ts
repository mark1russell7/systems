import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra";

// The source of each fact below is src/mongo/db/repl of MongoDB at the tag r9.0.4, unless a line
// names another folder. Each line number is a line of that file at that tag.
const AT = "mongodb r9.0.4 src/mongo/db/repl";

/**
 * This document is the replication of mongod 9.0.4. It gives one member of a replica set, its view
 * of the primary, and the election that it can hold. The states are the states of the member. The
 * timers are the heartbeats, the election timeout, the liveness check of a primary, the vote, the
 * catch-up of a new primary and a step-down.
 *
 * Each member sends a heartbeat to each other member. A heartbeat window is 10 s: in it, a failed
 * request goes again at once, two times at most. A window without a response marks the target
 * DOWN. A secondary starts an election when it hears nothing from the primary for the election
 * timeout and a random offset. A primary steps down when it cannot see a majority for the election
 * timeout.
 */
export const MONGOD_REPL: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "mongod-replication",
  title: "mongod 9.0.4 replication: one member of a replica set, its heartbeats, its elections and its step-downs",
  layer: "server",
  version: "9.0.4",
  conditions: { mongodb: "9.0.4", protocol: "replication protocol version 1", members: "three members, each with one vote and priority 1" },
  sources: [
    { ref: `${AT}/repl_set_config.idl:74-109 the settings: heartbeatIntervalMillis 2000, heartbeatTimeoutSecs 10, electionTimeoutMillis 10000, catchUpTimeoutMillis -1, catchUpTakeoverDelayMillis 30000`, rung: "implemented" },
    { ref: `${AT}/repl_server_parameters.idl:320-328 replElectionTimeoutOffsetLimitFraction 0.15`, rung: "implemented" },
    { ref: `${AT}/topology_coordinator.cpp:1058-1101 the heartbeat window and the timeout of each request, :1124-1147 the next heartbeat, :1239-1248 a member DOWN`, rung: "implemented" },
    { ref: `${AT}/topology_coordinator.h:62 kMaxHeartbeatRetries 2`, rung: "implemented" },
    { ref: `${AT}/replication_coordinator_impl_heartbeat.cpp:97-111 the random offset, :346-352 a heartbeat from the primary postpones the election, :1215-1271 the election timeout and its offset`, rung: "implemented" },
    { ref: `${AT}/data_replicator_external_state_impl.cpp:70-81 an oplog batch that names a primary postpones the election`, rung: "implemented" },
    { ref: `${AT}/delayable_timeout_callback.cpp:149-172 the offset changes at most once in its own length`, rung: "implemented" },
    { ref: `${AT}/topology_coordinator.cpp:1440-1457 and :1476-1489 the liveness check: a primary that cannot see a majority steps down`, rung: "implemented" },
    { ref: `${AT}/replication_coordinator_impl_heartbeat.cpp:1158-1188 the liveness check runs at the stalest member's last update plus the election timeout`, rung: "implemented" },
    { ref: `${AT}/replication_coordinator_impl_elect_v1.cpp:189-226 the dry run, :268-382 the term, the durable vote and the real vote, :408-468 the win`, rung: "implemented" },
    { ref: `${AT}/vote_requester.cpp:96 a vote request times out at min(electionTimeoutMillis, 30 s), :160-177 a majority of yes votes ends the round`, rung: "implemented" },
    { ref: `${AT}/topology_coordinator.cpp:3741-3790 a member votes for each candidate whose data is not staler than its own, and only an arbiter refuses one because it sees a primary`, rung: "implemented" },
    { ref: `${AT}/replication_coordinator_impl_catchup.cpp:35-85 the catch-up and its timeout, :110-133 it ends when each other member answered a heartbeat since the win, or failed one, :349-379 the win restarts each heartbeat`, rung: "implemented" },
    { ref: `${AT}/topology_coordinator.cpp:3841-3849 and :3910-3932 a restarted heartbeat, and the latest optime that the catch-up waits for`, rung: "implemented" },
    { ref: `${AT}/replication_coordinator_impl.cpp:1490-1570 the end of the drain: a reconfig of the term, then writes, :2580-2588 the hello of a primary that cannot write yet`, rung: "implemented" },
    { ref: `${AT}/replication_coordinator_impl_step_up_step_down.cpp:64-329 replSetStepDown: the wait for a caught-up secondary, the step-down and the hand-off`, rung: "implemented" },
    { ref: `${AT}/repl_set_commands.cpp:545-561 stepDownSecs 60 and secondaryCatchUpPeriodSecs 10`, rung: "implemented" },
    { ref: `${AT}/replication_coordinator_impl.idl:18-26 enableElectionHandoff true, and replication_coordinator_impl.cpp:2830-2873 the hand-off: replSetStepUp with skipDryRun`, rung: "implemented" },
  ],
  states: {
    startup: { initial: true, pseudo: true },
    secondary: { note: "SECONDARY: it replicates from its sync source, and its election timeout runs" },
    "dry-run": { note: "a dry run: votes are asked in the current term (replication_coordinator_impl_elect_v1.cpp:200-226)" },
    candidate: { note: "the real election: a new term, a durable vote for itself, and a vote request to each member" },
    catchup: { note: "PRIMARY in catch-up: it waits for a heartbeat answer from each other member, or a failure (log 21359)" },
    drain: { note: "PRIMARY in drain mode: the applier ends its buffer, and the hello says secondary (replication_coordinator_impl.cpp:2580-2584)" },
    primary: { note: "PRIMARY that accepts writes (log 21331)" },
    "stepping-down": { note: "replSetStepDown waits for a caught-up secondary, and the hello says not writable (step_up_step_down.cpp:46-52)" },
  },
  events: {
    "tx.heartbeat": { kind: "tx", note: "a heartbeat request, the first of a window or a retry in it" },
    "rx.heartbeat": { kind: "rx", note: "a heartbeat response" },
    "rx.primary-heartbeat": { kind: "rx", note: "a heartbeat response from the primary in the current term" },
    "rx.primary-oplog": { kind: "rx", note: "an oplog batch whose metadata names a primary" },
    "rx.member": { kind: "rx", note: "any message from a member: a heartbeat request or response, or an update of its position" },
    "timer.heartbeat": { kind: "timer" },
    "timer.heartbeat-window": { kind: "timer", note: "the window ends without a response: the target is DOWN (log 21216)" },
    "timer.election": { kind: "timer", note: "log 4615652: Starting an election" },
    "timer.liveness": { kind: "timer", note: "log 21809: Can't see a majority of the set, relinquishing primary" },
    "rx.votes": { kind: "rx", note: "a majority of yes votes" },
    "rx.no-votes": { kind: "rx", note: "the round ends without a majority" },
    "local.caught-up": { kind: "local", note: "log 21364 or 21368" },
    "timer.catchup": { kind: "timer" },
    "local.drained": { kind: "local", note: "log 21331: Transition to primary complete" },
    "rx.higher-term": { kind: "rx" },
    "app.step-down": { kind: "app", note: "replSetStepDown" },
    "timer.step-down-wait": { kind: "timer" },
    "local.secondary-caught-up": { kind: "local" },
    "app.step-up": { kind: "app", note: "replSetStepUp, as a hand-off sends it with skipDryRun" },
    "timer.catchup-takeover": { kind: "timer" },
    "timer.step-down-hold": { kind: "timer" },
  },
  knobs: {
    heartbeatIntervalMillis: { key: "settings.heartbeatIntervalMillis", scope: "replica set", unit: "ms", default: 2000, note: "repl_set_config.idl:74-78" },
    heartbeatTimeoutSecs: { key: "settings.heartbeatTimeoutSecs", scope: "replica set", unit: "s", default: 10, note: "repl_set_config.idl:79-85" },
    electionTimeoutMillis: { key: "settings.electionTimeoutMillis", scope: "replica set", unit: "ms", default: 10000, note: "repl_set_config.idl:86-92" },
    offset_fraction: {
      key: "replElectionTimeoutOffsetLimitFraction",
      scope: "process",
      unit: "count",
      default: 0.15,
      note: "repl_server_parameters.idl:320-328: a fraction, thus the offset is less than 0.15 × electionTimeoutMillis",
    },
    catchUpTimeoutMillis: {
      key: "settings.catchUpTimeoutMillis",
      scope: "replica set",
      unit: "ms",
      default: null,
      note: "repl_set_config.idl:93-101: -1 at the defaults, which is no bound. 0 skips the catch-up",
    },
    catchUpTakeoverDelayMillis: { key: "settings.catchUpTakeoverDelayMillis", scope: "replica set", unit: "ms", default: 30000, note: "repl_set_config.idl:102-109" },
    secondaryCatchUpPeriodSecs: { key: "replSetStepDown secondaryCatchUpPeriodSecs", scope: "command", unit: "s", default: 10, note: "repl_set_commands.cpp:553-561" },
    stepDownSecs: { key: "replSetStepDown stepDownSecs", scope: "command", unit: "s", default: 60, note: "repl_set_commands.cpp:545-548" },
    heartbeat_retries: { key: "kMaxHeartbeatRetries", scope: "build", unit: "count", default: 2, note: "topology_coordinator.h:62" },
    vote_timeout_max: { key: "maximumVoteRequestTimeoutMS", scope: "build", unit: "ms", default: 30000, note: "vote_requester.cpp:96" },
    executor_slack: {
      key: "the lateness of the replication executor for one step",
      scope: "process",
      unit: "ms",
      default: 10,
      note: "an assumption of this document, not a value of mongod: a callback of the executor that comes late",
    },
    election_work: {
      key: "the local work of an election or a step-up",
      scope: "process",
      unit: "ms",
      default: 100,
      note: "an assumption of this document, not a value of mongod: the durable vote, the reconfig of the term and the first oplog entry of a new primary are local writes",
    },
    rtt: { key: "the round trip between members", scope: "path", unit: "ms", default: null },
  },
  timers: {
    heartbeat: {
      // the next heartbeat starts heartbeatIntervalMillis after a response or a failed window (topology_coordinator.cpp:1129, :1146)
      duration: { knob: "heartbeatIntervalMillis", unit: "ms" },
      lateness: { knob: "executor_slack", unit: "ms" },
      arms: ["rx.heartbeat", "timer.heartbeat-window"],
      fires: "timer.heartbeat",
    },
    heartbeat_fast: {
      // a member that is not primary and has no sync source sends its heartbeats more often (topology_coordinator.cpp:1133-1136)
      duration: { expr: "min(electionTimeoutMillis / 2, heartbeatIntervalMillis / 4)", unit: "ms" },
      lateness: { knob: "executor_slack", unit: "ms" },
      arms: ["rx.heartbeat", "timer.heartbeat-window"],
      fires: "timer.heartbeat",
      note: "500 ms at the defaults",
    },
    heartbeat_window: {
      // a window is heartbeatTimeoutSecs from its first request, and each retry gets what is left (topology_coordinator.cpp:1058-1068, :1096-1100)
      duration: { expr: "heartbeatTimeoutSecs * 1000", unit: "ms" },
      lateness: { knob: "executor_slack", unit: "ms" },
      arms: ["tx.heartbeat"],
      cancels: ["rx.heartbeat"],
      fires: "timer.heartbeat-window",
      note: "the target is DOWN at the end of a window without a response (topology_coordinator.cpp:1245-1247, member_data.cpp:86-99)",
    },
    election: {
      // now + electionTimeoutMillis + an offset in [0, fraction × electionTimeoutMillis) (heartbeat.cpp:1249-1253, :97-111)
      duration: { knob: "electionTimeoutMillis", unit: "ms" },
      lateness: { expr: "electionTimeoutMillis * offset_fraction + executor_slack", unit: "ms" },
      arms: ["enter:secondary", "rx.primary-heartbeat", "rx.primary-oplog"],
      fires: "timer.election",
      note: "the offset is random, and it changes at most once in its own length (delayable_timeout_callback.cpp:149-158)",
    },
    liveness: {
      // a member whose last update is older than the election timeout is stale (topology_coordinator.cpp:1444-1449)
      duration: { knob: "electionTimeoutMillis", unit: "ms" },
      lateness: { knob: "executor_slack", unit: "ms" },
      arms: ["enter:primary", "rx.member"],
      fires: "timer.liveness",
      note: "a primary steps down when the stale members leave it without a majority (topology_coordinator.cpp:1452-1455)",
    },
    vote_request: {
      duration: { expr: "min(electionTimeoutMillis, vote_timeout_max)", unit: "ms" },
      arms: ["enter:dry-run", "enter:candidate"],
      cancels: ["rx.votes"],
      fires: "rx.no-votes",
      note: "a majority of yes votes ends the round before it (vote_requester.cpp:160-177)",
    },
    catchup: {
      duration: { knob: "catchUpTimeoutMillis", unit: "ms" },
      lateness: { knob: "executor_slack", unit: "ms" },
      arms: ["enter:catchup"],
      cancels: ["local.caught-up"],
      fires: "timer.catchup",
      note: "no bound at -1, and no catch-up at 0 (catchup.cpp:48-75)",
    },
    catchup_takeover: {
      duration: { knob: "catchUpTakeoverDelayMillis", unit: "ms" },
      arms: ["rx.heartbeat"],
      cancels: ["local.caught-up"],
      fires: "timer.catchup-takeover",
      note: "a secondary that is ahead of a primary in catch-up takes over after this delay (heartbeat.cpp:501-515)",
    },
    step_down_wait: {
      duration: { knob: "secondaryCatchUpPeriodSecs", unit: "s" },
      lateness: { knob: "executor_slack", unit: "ms" },
      arms: ["app.step-down"],
      cancels: ["local.secondary-caught-up"],
      fires: "timer.step-down-wait",
      note: "the wait of replSetStepDown for an electable secondary at the primary's optime (step_up_step_down.cpp:197-292)",
    },
    step_down_hold: {
      duration: { knob: "stepDownSecs", unit: "s" },
      arms: ["app.step-down"],
      fires: "timer.step-down-hold",
      note: "the old primary cannot be elected in this time (step_up_step_down.cpp:313-315)",
    },
  },
  realizes: {
    "systems.mechanism.failure-detection": { timer: "heartbeat_window" },
    "systems.mechanism.election-timeout": { timer: "election" },
    "systems.mechanism.primary-liveness": { timer: "liveness" },
  },
  transitions: [
    { id: "rs.secondary", from: "startup", to: "secondary", on: "rx.heartbeat" },
    { id: "rs.election", from: "secondary", to: "dry-run", on: "timer.election", timer: "election", emits: ["4615652"], source: "replication_coordinator_impl_heartbeat.cpp:1345-1352" },
    { id: "rs.step-up", from: "secondary", to: "candidate", on: "app.step-up", note: "a hand-off skips the dry run", source: "replication_coordinator_impl_elect_v1.cpp:192-198" },
    { id: "rs.dry-run-won", from: "dry-run", to: "candidate", on: "rx.votes", source: "replication_coordinator_impl_elect_v1.cpp:257-265" },
    { id: "rs.dry-run-lost", from: "dry-run", to: "secondary", on: "rx.no-votes", timer: "vote_request", emits: ["21440"], source: "replication_coordinator_impl_elect_v1.cpp:244-246" },
    {
      id: "rs.won",
      from: "candidate",
      to: "catchup",
      on: "rx.votes",
      emits: ["21450", "21359"],
      note: "the win restarts each heartbeat, and the catch-up waits for each other member's answer or failure",
      source: "replication_coordinator_impl_elect_v1.cpp:435-463, replication_coordinator_impl_catchup.cpp:349-379",
    },
    { id: "rs.lost", from: "candidate", to: "secondary", on: "rx.no-votes", timer: "vote_request", emits: ["21448"] },
    { id: "rs.caught-up", from: "catchup", to: "drain", on: ["local.caught-up", "timer.catchup"], emits: ["21363"], source: "replication_coordinator_impl_catchup.cpp:87-133" },
    { id: "rs.writable", from: "drain", to: "primary", on: "local.drained", emits: ["21331"], source: "replication_coordinator_impl.cpp:1490-1570" },
    { id: "rs.no-majority", from: ["primary", "catchup", "drain"], to: "secondary", on: "timer.liveness", timer: "liveness", emits: ["21809"], source: "topology_coordinator.cpp:1440-1457" },
    { id: "rs.higher-term", from: ["primary", "catchup", "drain"], to: "secondary", on: "rx.higher-term", emits: ["21475"], source: "replication_coordinator_impl_heartbeat.cpp:469-480" },
    { id: "rs.step-down", from: "primary", to: "stepping-down", on: "app.step-down", note: "writes stop, and the hello says not writable", source: "replication_coordinator_impl_step_up_step_down.cpp:46-52, :118-125" },
    {
      id: "rs.stepped-down",
      from: "stepping-down",
      to: "secondary",
      on: "local.secondary-caught-up",
      emits: ["962660", "21347"],
      note: "then the hand-off: replSetStepUp with skipDryRun to the best secondary",
      source: "replication_coordinator_impl_step_up_step_down.cpp:207-321",
    },
    { id: "rs.step-down-failed", from: "stepping-down", to: "primary", on: "timer.step-down-wait", timer: "step_down_wait", errno: "ExceededTimeLimit" },
  ],
  observe: {
    "mongod-log": {
      fidelity: "complete",
      note: "the JSON log of mongod: id 21358 gives each state change, and the ids of the transitions give the steps between them",
      states: { SECONDARY: "secondary", PRIMARY: "catchup" },
    },
  },
});
