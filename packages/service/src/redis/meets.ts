import type { Extent } from "@mark1russell7/quantity";
import type { Detector, Meeting, Situation } from "../client/meets.ts";
import { WHAT, immediate, keepaliveAnswered, keepaliveReset, keepaliveSilent, kernelGiveUp } from "../client/meets.ts";
import type { RedisKnobs } from "./client.ts";

// the shapes and the queries moved to the core of the clients: this entry keeps them for the users of 0.5
export type { Detector, Meeting, Situation } from "../client/meets.ts";
export { firstDetector, unwatched } from "../client/meets.ts";

/**
 * This function gives the manifestations that a Redis client can meet, and the detectors of each, from
 * its knobs. A reset or a FIN arrives on the next segment. A black hole and a host that is gone give
 * no answer at all. A frozen process and a stalled server keep a kernel that acknowledges each
 * segment. Thus TCP keepalive does not fire on them, and only the client's own timers find them.
 */
export const meetings = (name: string, knobs: RedisKnobs, heartbeat: Extent): Meeting[] => {
  const watchdog = (situation: Situation): Detector => ({
    by: "heartbeat_detection_time",
    within: heartbeat,
    situation,
    effect: `the watchdog of ${name} closes the connection, and the client connects again`,
  });
  const writeoff: Detector = {
    by: "driver_writeoff_time",
    within: knobs.driver_writeoff_time,
    situation: "in flight",
    effect: "ioredis destroys the socket of a command without data, and the client connects again",
  };
  const command: Detector = {
    by: "request_timeout",
    within: knobs.request_timeout,
    situation: "in flight",
    effect: "the command fails as indeterminate, and the state of the connection does not change",
  };
  const giveUp = kernelGiveUp(knobs.retrans_giveup_time);
  const silent = (manifestation: "blackhole" | "freeze-host"): Meeting => ({
    manifestation,
    what: WHAT[manifestation],
    detectors: [command, writeoff, watchdog("in flight"), giveUp, watchdog("idle"), keepaliveSilent(knobs.keepalive_idle)],
  });
  const acknowledged = (manifestation: string, what: string): Meeting => ({
    manifestation,
    what,
    detectors: [command, writeoff, watchdog("in flight"), watchdog("idle"), keepaliveAnswered()],
  });
  return [
    {
      manifestation: "rst",
      what: WHAT.rst,
      detectors: [
        immediate("in flight", "the command fails, and the client connects again, and each attempt is refused"),
        watchdog("idle"),
        keepaliveReset(knobs.keepalive_idle),
      ],
    },
    {
      manifestation: "fin",
      what: WHAT.fin,
      detectors: [immediate("in flight", "the close arrives, and the command fails"), immediate("idle", "the close arrives")],
    },
    silent("blackhole"),
    silent("freeze-host"),
    acknowledged("freeze-process", WHAT["freeze-process"]),
    acknowledged("app-stall", "the server stops its replies for a time, for example a long command, and its kernel stays up"),
  ];
};
