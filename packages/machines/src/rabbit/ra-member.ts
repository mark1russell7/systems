import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra";

// The source of each fact below is ra 3.1.10, the Raft library that RabbitMQ 4.3.6 locks
// (rabbitmq-components.mk:58) and ships in deps/ra, unless a line names RabbitMQ. Each line number is
// a line of that file in that release. A fact of the BEAM is an assumption of this document, and its
// note says so.
const RA = "ra 3.1.10 src";
const RMQ = "rabbitmq v4.3.6 deps/rabbit/src";

/**
 * This document is ra 3.1.10, for one member of the Raft cluster of a quorum queue of RabbitMQ 4.3.6.
 * It gives the roles of the member, the election timers, and the change of leader.
 *
 * A follower watches the node of its leader with aten. When aten reports that node down, the follower
 * arms a long election timeout: 1 s and a random part up to 1 s. A valid message of the leader cancels
 * it. When the timeout fires, the follower asks for pre-votes in its term.
 *
 * A member grants a pre-vote when the log of the candidate is not behind its own. A member that is
 * still a follower of a live leader grants it too. A majority of pre-votes makes a candidate. The
 * candidate starts a new term and asks for votes, and a majority makes it the leader. The new leader
 * of the queue tells each publisher of the queue. Then the channel of each publisher sends its pending
 * publishes again to the new leader.
 *
 * A leader ignores the events of aten. Thus a leader that loses the majority stays the leader in its
 * minority, and it commits nothing, until it sees a higher term.
 */
export const RA_MEMBER: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "ra-member",
  title: "ra 3.1.10: one member of the Raft cluster of a quorum queue of RabbitMQ 4.3.6, its elections and its leader",
  layer: "server",
  version: "3.1.10",
  conditions: {
    ra: "3.1.10",
    aten: "0.6.0",
    rabbitmq: "4.3.6",
    queue: "a quorum queue of three members, one on each node of the cluster, each one a voter",
  },
  sources: [
    { ref: "rabbitmq v4.3.6 rabbitmq-components.mk:58 dep_ra = hex 3.1.10", rung: "implemented" },
    { ref: `${RA}/ra_server_proc.erl:66-68 DEFAULT_BROADCAST_TIME 100, DEFAULT_ELECTION_MULT 5, TICK_INTERVAL_MS 1000`, rung: "implemented" },
    { ref: `${RA}/ra_server_proc.erl:384 the member reads the poll interval of aten (default 1000 ms)`, rung: "implemented" },
    {
      ref: `${RA}/ra_server_proc.erl:1931-1950 the election timeouts: really_short rand(broadcast), short rand(5 × broadcast) + broadcast, medium rand(poll) + broadcast, long rand(10 × broadcast) + poll`,
      rung: "implemented",
    },
    { ref: `${RA}/ra_server_proc.erl:2350-2357 an election timeout that is set is not set again, and :2359-2367 each change of role cancels it`, rung: "implemented" },
    { ref: `${RA}/ra_server_proc.erl:802-825 a follower that is not new arms a long timeout when it enters the role`, rung: "implemented" },
    { ref: `${RA}/ra_server_proc.erl:1844-1851 a valid message of the leader cancels the election timeout of a follower`, rung: "implemented" },
    { ref: `${RA}/ra_server_proc.erl:899-919 aten reports the node of the leader down: a long timeout; up again: the timeout stops`, rung: "implemented" },
    { ref: `${RA}/ra_server_proc.erl:869-896 the monitor of the leader goes down: short for noconnection, really_short for each other reason`, rung: "implemented" },
    { ref: `${RA}/ra_server_proc.erl:1958-1981 a follower watches the node of a new leader with aten, and logs the new leader`, rung: "implemented" },
    { ref: `${RA}/ra_server.erl:1625-1626 the election timeout of a follower asks for pre-votes, and :2900-2923 a pre-vote round is in the current term`, rung: "implemented" },
    { ref: `${RA}/ra_server_proc.erl:739-743 a member in pre-vote arms a long timeout, and ra_server.erl:1255-1256 its timeout asks again`, rung: "implemented" },
    {
      ref: `${RA}/ra_server.erl:2925-2985 a member grants a pre-vote when the term is not lower and the log of the candidate is not behind; a follower that declines arms its own long timeout`,
      rung: "implemented",
    },
    { ref: `${RA}/ra_server.erl:1229-1245 a majority of pre-votes makes a candidate, and :2880-2899 the candidate starts a new term and asks for votes`, rung: "implemented" },
    { ref: `${RA}/ra_server_proc.erl:674-677 a candidate arms a short timeout, and ra_server.erl:1161-1162 its timeout starts a new election`, rung: "implemented" },
    { ref: `${RA}/ra_server.erl:1045-1061 a majority of votes makes the leader`, rung: "implemented" },
    { ref: `${RA}/ra_server_proc.erl:1742-1755 each vote request is a call with the poll interval of aten as its timeout`, rung: "implemented" },
    { ref: `${RA}/ra_server_proc.erl:597-598 a leader ignores the events of aten`, rung: "implemented" },
    { ref: `${RA}/ra_server.erl:928-942 and :946-960 a leader that sees a vote request or a pre-vote request of a higher term becomes a follower`, rung: "implemented" },
    {
      ref: `${RA}/ra_server.erl:1008-1032 a transfer of leadership: the leader waits, and it sends an election timeout to the member that gets the leadership`,
      rung: "implemented",
    },
    { ref: `${RA}/ra_server_proc.erl:683-687 and :749-753 a candidate and a member in pre-vote reject a command`, rung: "implemented" },
    { ref: `${RA}/ra_server_proc.erl:1336-1345 each change from or to leader is a NOTICE in the log, and each other change is DEBUG`, rung: "implemented" },
    { ref: `${RMQ}/rabbit_fifo.erl:1111-1123 a new leader of the queue sends leader_change to each publisher`, rung: "implemented" },
    { ref: `${RMQ}/rabbit_fifo_client.erl:738-760 the channel sends each pending publish again to the new leader, on leader_change or on a rejection`, rung: "implemented" },
    { ref: `${RMQ}/rabbit_quorum_queue.erl:175 and :2427-2441 the tick of a member is quorum_tick_interval, 5000 ms; RabbitMQ sets no broadcast time`, rung: "implemented" },
  ],
  states: {
    follower: { initial: true, note: "it follows the leader, and its election timeout runs when no valid message of the leader cancels it" },
    pre_vote: { note: "it asks for pre-votes in its term, and it rejects each command" },
    candidate: {
      note: "a new term, its vote for itself, and a vote request to each member. A round with no majority before the timeout starts a new election after a medium timeout (101 ms to 1.1 s)",
    },
    leader: { note: "it commits with a majority. It ignores aten: without a majority it stays the leader and commits nothing" },
  },
  events: {
    "local.leader-node-down": { kind: "local", note: "{node_event, Node, down}: aten reports the node of the leader down" },
    "local.leader-node-up": { kind: "local", note: "{node_event, Node, up}: aten reports the node of the leader up again" },
    "rx.leader-noconnection": { kind: "rx", note: "the monitor of the leader goes down with noconnection: the distribution to its node closed" },
    "rx.leader-exit": { kind: "rx", note: "the monitor of the leader goes down with another reason: the process of the leader is gone" },
    "rx.leader-message": { kind: "rx", note: "a valid append_entries or heartbeat of the leader (record_leader_msg)" },
    "timer.election": { kind: "timer", note: "the state timeout election_timeout" },
    "rx.pre-votes": { kind: "rx", note: "a majority of granted pre-votes, its own one too" },
    "rx.pre-vote-declined": { kind: "rx", note: "a pre-vote request whose candidate has a log behind this member: it declines and arms its own timeout" },
    "rx.votes": { kind: "rx", note: "a majority of votes, its own one too" },
    "rx.higher-term": { kind: "rx", note: "a message of a term that is not lower: a leader of that term, or a vote request of a higher term" },
    "app.transfer": { kind: "app", note: "the leader sends election_timeout to the member that gets the leadership (rabbitmq-queues transfer_leadership)" },
  },
  knobs: {
    broadcast_time: { key: "broadcast_time of the ra server", scope: "queue", unit: "ms", default: 100, note: "ra_server_proc.erl:66: RabbitMQ sets none" },
    election_mult: { key: "DEFAULT_ELECTION_MULT", scope: "build", unit: "count", default: 5, note: "ra_server_proc.erl:67" },
    aten_poll_interval: { key: "raft.adaptive_failure_detector.poll_interval (aten poll_interval)", scope: "node", unit: "ms", default: 1000, note: "ra_server_proc.erl:384" },
    tick_timeout: { key: "quorum_tick_interval", scope: "node", unit: "ms", default: 5000, note: "rabbit_quorum_queue.erl:175, :2435-2441" },
    slack: {
      key: "the lateness of a timer of the BEAM for one step",
      scope: "node",
      unit: "ms",
      default: 10,
      note: "an assumption of this document, not a value of ra: a state timeout that fires late",
    },
    rtt: { key: "the round trip between members", scope: "path", unit: "ms", default: null },
  },
  timers: {
    election_long: {
      // rand:uniform(broadcast_time × election_mult × 2) + the poll interval: 1001 ms to 2000 ms at the defaults
      duration: { expr: "aten_poll_interval + 1", unit: "ms" },
      lateness: { expr: "broadcast_time * election_mult * 2 - 1 + slack", unit: "ms" },
      arms: ["enter:follower", "enter:pre_vote", "local.leader-node-down", "rx.pre-vote-declined"],
      cancels: ["rx.leader-message", "local.leader-node-up"],
      fires: "timer.election",
      note: "longer than one poll of aten, thus a false report of aten can end before an election (ra_server_proc.erl:1944-1949)",
    },
    election_short: {
      // rand:uniform(broadcast_time × election_mult) + broadcast_time: 101 ms to 600 ms at the defaults
      duration: { expr: "broadcast_time + 1", unit: "ms" },
      lateness: { expr: "broadcast_time * election_mult - 1 + slack", unit: "ms" },
      arms: ["enter:candidate", "rx.leader-noconnection"],
      cancels: ["rx.leader-message"],
      fires: "timer.election",
    },
    election_really_short: {
      // rand:uniform(broadcast_time): 1 ms to 100 ms at the defaults
      duration: { const: 1, unit: "ms" },
      lateness: { expr: "broadcast_time - 1 + slack", unit: "ms" },
      arms: ["rx.leader-exit"],
      cancels: ["rx.leader-message"],
      fires: "timer.election",
    },
  },
  realizes: {
    "systems.mechanism.election-timeout": { timer: "election_long" },
  },
  transitions: [
    { id: "ra.leader-message", from: "follower", to: "follower", on: "rx.leader-message", note: "the election timeout stops", source: "ra_server_proc.erl:1844-1851" },
    { id: "ra.leader-node-down", from: "follower", to: "follower", on: "local.leader-node-down", note: "the long election timeout starts", source: "ra_server_proc.erl:899-908" },
    { id: "ra.pre-vote", from: "follower", to: "pre_vote", on: ["timer.election", "app.transfer"], source: "ra_server.erl:1625-1626, :2900-2923" },
    { id: "ra.pre-vote-again", from: "pre_vote", to: "pre_vote", on: "timer.election", timer: "election_long", source: "ra_server.erl:1255-1256" },
    { id: "ra.candidate", from: "pre_vote", to: "candidate", on: "rx.pre-votes", source: "ra_server.erl:1229-1245, :2880-2899" },
    { id: "ra.election-again", from: "candidate", to: "candidate", on: "timer.election", timer: "election_short", source: "ra_server.erl:1161-1162" },
    {
      id: "ra.leader",
      from: "candidate",
      to: "leader",
      on: "rx.votes",
      emits: ["candidate -> leader", "leader_change"],
      note: "the NOTICE of the change, and leader_change to each publisher of the queue",
      source: "ra_server.erl:1045-1061, ra_server_proc.erl:1336-1345, rabbit_fifo.erl:1111-1123",
    },
    { id: "ra.follow", from: ["pre_vote", "candidate"], to: "follower", on: "rx.higher-term", source: "ra_server.erl:1062-1084" },
    { id: "ra.abdicate", from: "leader", to: "follower", on: "rx.higher-term", emits: ["leader -> follower"], source: "ra_server.erl:928-942, :946-960" },
  ],
  observe: {
    "rabbitmq-log": {
      fidelity: "lossy",
      states: { leader: "leader", follower: "follower" },
      hides: ["pre_vote", "candidate"],
      note: "at the default level the log has each change from or to leader (NOTICE), and the new leader that a follower detects (INFO). The elections are DEBUG",
    },
  },
});
