import type { Extent } from "@mark1russell7/quantity";
import { quantity } from "@mark1russell7/quantity";
import type { Detector, Meeting, Situation } from "../client/meets.ts";
import { NEVER, WHAT, immediate, keepaliveAnswered, keepaliveReset, keepaliveSilent, kernelGiveUp } from "../client/meets.ts";
import { finiteMs } from "../client/core.ts";
import type { RabbitKnobs } from "./client.ts";

/**
 * This function gives the manifestations that a RabbitMQ client can meet, and the detectors of each,
 * from its knobs. The cells of R3 measured them on amqplib 2.2.0 against RabbitMQ 4.3.6:
 * - The heartbeat ends a silent connection 2 to 3 heartbeats after the last data. The cells measured
 *   180.009 s at 60 s, and 45.009 s at 15 s (O17). It finds a silent broker in flight and idle.
 * - A stopped broker resets each client at once, because each socket of RabbitMQ has linger 0.
 * - At `tcp_retries2 = 7`, the kernel gave up at 53.016 s.
 * - A broker with a resource alarm blocks each connection that publishes, and it still sends its heartbeats.
 */
export const rabbitMeetings = (name: string, knobs: RabbitKnobs): Meeting[] => {
  const beat = finiteMs(knobs.heartbeat_interval);
  const detection: Extent = beat === undefined ? NEVER : quantity((3 * beat) / 1000, "s");
  const heartbeat = (situation: Situation): Detector => ({
    by: "heartbeat_detection_time",
    within: detection,
    situation,
    effect: `the heartbeat of amqplib ends the connection, each call in flight fails as indeterminate, and ${name} connects again`,
  });
  const call: Detector = {
    by: "request_timeout",
    within: knobs.request_timeout,
    situation: "in flight",
    effect: "the timer of the wrapper ends the call as indeterminate, and the connection stays",
  };
  const giveUp = kernelGiveUp(knobs.retrans_giveup_time, "each call in flight fails as indeterminate");
  const silent = (manifestation: "blackhole" | "freeze-host"): Meeting => ({
    manifestation,
    what: WHAT[manifestation],
    detectors: [call, heartbeat("in flight"), giveUp, heartbeat("idle"), keepaliveSilent(knobs.keepalive_idle)],
  });
  return [
    {
      manifestation: "rst",
      what: WHAT.rst,
      detectors: [
        immediate("in flight", "the call fails with ECONNRESET as indeterminate, and the client connects again"),
        {
          by: "heartbeat_interval",
          within: beat === undefined ? NEVER : knobs.heartbeat_interval,
          situation: "idle",
          effect: "the next heartbeat frame of the client gets a reset, and the client connects again",
        },
        keepaliveReset(knobs.keepalive_idle),
      ],
    },
    {
      manifestation: "fin",
      what: WHAT.fin,
      detectors: [
        immediate("in flight", "the broker closes its socket with linger 0, thus a reset arrives, and the call fails as indeterminate"),
        immediate("idle", "the reset of the broker arrives, and the client connects again"),
      ],
    },
    silent("blackhole"),
    silent("freeze-host"),
    {
      manifestation: "freeze-process",
      what: WHAT["freeze-process"],
      detectors: [call, heartbeat("in flight"), heartbeat("idle"), keepaliveAnswered()],
    },
    {
      manifestation: "app-stall",
      what: "the broker stops its confirms and its replies for a time, and still sends its heartbeats: a resource alarm, or a quorum queue with no leader",
      detectors: [
        call,
        {
          by: "connection.blocked",
          within: quantity(0, "s"),
          situation: "idle",
          effect: "a resource alarm blocks a connection that publishes at once. The client then refuses each call as not sent, until the unblock",
        },
        { ...heartbeat("idle"), within: NEVER, effect: "the broker still sends its heartbeats" },
        keepaliveAnswered(),
      ],
    },
  ];
};
