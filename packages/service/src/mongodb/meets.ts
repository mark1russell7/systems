import { quantity } from "@mark1russell7/quantity";
import type { Detector, Meeting } from "../client/meets.ts";
import { WHAT, immediate, keepaliveAnswered, keepaliveReset, keepaliveSilent, kernelGiveUp } from "../client/meets.ts";
import { ms } from "../client/core.ts";
import type { MongoKnobs } from "./client.ts";

/**
 * This function gives the manifestations that a MongoDB client can meet, and the detectors of each,
 * from its knobs. The cells of S1 measured them on the driver 7.7.0 against mongod 9.0.4:
 * - The monitor writes off a silent server at `connectTimeoutMS + heartbeatFrequencyMS` after its last
 *   answer: 40.002 s at the defaults, and 7 s for 5 s + 2 s. The driver then clears the pool, and
 *   fails each command in flight. With `connectTimeoutMS` 0, nothing found a freeze in 60 s.
 * - At `tcp_retries2 = 5`, the kernel gave up at 12.936 s.
 * - A `keepAliveInitialDelay` of 27 s ended an idle stream at 37.255 s.
 *
 * The monitor tests the server, not each connection of the pool. Thus a write-off finds a failure of
 * the server in flight and idle, and a failure of one connection waits for its own detector.
 */
export const mongoMeetings = (name: string, knobs: MongoKnobs): Meeting[] => {
  const writeoffTime = quantity((ms(knobs.connect_bound) + ms(knobs.heartbeat_interval)) / 1000, "s");
  const writeoff = (situation: "in flight" | "idle"): Detector => ({
    by: "driver_writeoff_time",
    within: writeoffTime,
    situation,
    effect:
      situation === "in flight"
        ? `the monitor writes the server off, and the driver fails the command as indeterminate. ${name} goes to failing`
        : `the monitor writes the server off, and the driver closes each idle connection. ${name} goes to failing`,
  });
  const read: Detector = {
    by: "request_timeout",
    within: knobs.request_timeout,
    situation: "in flight",
    effect: "the command fails with a timeout of the socket, as indeterminate, and the driver closes the connection",
  };
  const idleExpiry: Detector = {
    by: "pool_idle_expiry",
    within: knobs.pool_idle_expiry,
    situation: "idle",
    effect: "the next checkout ends the idle connection, thus no command gets the dead connection",
  };
  const giveUp = kernelGiveUp(knobs.retrans_giveup_time, "the command fails as indeterminate");
  const silent = (manifestation: "blackhole" | "freeze-host"): Meeting => ({
    manifestation,
    what: WHAT[manifestation],
    detectors: [writeoff("in flight"), read, giveUp, writeoff("idle"), idleExpiry, keepaliveSilent(knobs.keepalive_idle)],
  });
  return [
    {
      manifestation: "rst",
      what: WHAT.rst,
      detectors: [
        immediate("in flight", "the command fails with ECONNRESET, and the driver clears the pool"),
        {
          by: "heartbeat_interval",
          within: knobs.heartbeat_interval,
          situation: "idle",
          effect: "the next answer of the monitor gets a reset, thus the driver writes the server off and clears the pool",
        },
        idleExpiry,
        keepaliveReset(knobs.keepalive_idle),
      ],
    },
    {
      manifestation: "fin",
      what: WHAT.fin,
      detectors: [
        immediate("in flight", "the command fails: the connection closed"),
        immediate("idle", "the stream of the monitor closes, thus the driver writes the server off and clears the pool"),
      ],
    },
    silent("blackhole"),
    silent("freeze-host"),
    {
      manifestation: "freeze-process",
      what: WHAT["freeze-process"],
      detectors: [writeoff("in flight"), read, writeoff("idle"), idleExpiry, keepaliveAnswered()],
    },
    {
      manifestation: "app-stall",
      what: "the server stops its replies to commands for a time, for example behind a lock, and its monitor still answers",
      detectors: [
        {
          by: "statement_timeout",
          within: knobs.statement_timeout,
          situation: "in flight",
          effect: "the server ends the command with error 50 (MaxTimeMSExpired), a certain outcome, and the connection stays",
        },
        read,
        idleExpiry,
        keepaliveAnswered(),
      ],
    },
  ];
};
