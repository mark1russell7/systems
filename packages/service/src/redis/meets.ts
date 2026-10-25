import type { Extent, Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { Detector, Meeting, Situation } from "../client/meets.ts";
import type { RedisKnobs } from "./client.ts";

// the shapes and the queries moved to the core of the clients: this entry keeps them for the users of 0.5
export type { Detector, Meeting, Situation } from "../client/meets.ts";
export { firstDetector, unwatched } from "../client/meets.ts";

const never: Extent = { value: "infinite", unit: "s" };
const s = (value: number): Quantity => quantity(Math.round(value * 1e6) / 1e6, "s");
const seconds = (amount: Extent): number =>
  amount.value === "infinite" ? Number.POSITIVE_INFINITY : valueIn(amount as Quantity, "s");
const plus = (amount: Extent, more: number): Extent =>
  amount.value === "infinite" ? never : s(seconds(amount) + more);

/** Node gives keepalive 10 probes, 1 s apart, after its idle time: a silent peer is found 10 s after the idle time. */
const NODE_PROBES = 10;
const NODE_INTERVAL = 1;

/**
 * This function gives the manifestations that a Redis client can meet, and the detectors of each, from
 * its knobs. A reset or a FIN arrives on the next segment. A black hole and a host that is gone give
 * no answer at all. A frozen process and a stalled server keep a kernel that acknowledges each
 * segment. Thus TCP keepalive does not fire on them, and only the client's own timers find them.
 */
export const meetings = (name: string, knobs: RedisKnobs, heartbeat: Extent): Meeting[] => {
  const keepalive = plus(knobs.keepalive_idle, NODE_PROBES * NODE_INTERVAL);
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
  const giveUp: Detector = {
    by: "retrans_giveup_time",
    within: knobs.retrans_giveup_time,
    situation: "in flight",
    effect: "the kernel gives up the retransmissions and closes the socket",
  };
  const silent = (manifestation: string, what: string): Meeting => ({
    manifestation,
    what,
    detectors: [
      command,
      writeoff,
      watchdog("in flight"),
      giveUp,
      watchdog("idle"),
      { by: "keepalive_idle", within: keepalive, situation: "idle", effect: "TCP keepalive gives up, and the socket closes" },
    ],
  });
  const acknowledged = (manifestation: string, what: string): Meeting => ({
    manifestation,
    what,
    detectors: [
      command,
      writeoff,
      watchdog("in flight"),
      watchdog("idle"),
      { by: "keepalive_idle", within: never, situation: "idle", effect: "the kernel of the server answers each probe" },
    ],
  });
  const immediate = (situation: Situation, effect: string): Detector => ({ by: "the next segment", within: s(0), situation, effect });
  return [
    {
      manifestation: "rst",
      what: "the server answers each segment with a reset, and refuses each new connection",
      detectors: [
        immediate("in flight", "the command fails, and the client connects again, and each attempt is refused"),
        watchdog("idle"),
        { by: "keepalive_idle", within: keepalive.value === "infinite" ? never : knobs.keepalive_idle, situation: "idle", effect: "the first probe gets a reset" },
      ],
    },
    {
      manifestation: "fin",
      what: "the process of the server ends, and its kernel closes the connection",
      detectors: [immediate("in flight", "the close arrives, and the command fails"), immediate("idle", "the close arrives")],
    },
    silent("blackhole", "the network drops each segment in the two directions"),
    silent("freeze-host", "the host of the server stops, without a close: the death without a close"),
    acknowledged("freeze-process", "the process of the server stops, and its kernel stays up"),
    acknowledged("app-stall", "the server stops its replies for a time, for example a long command, and its kernel stays up"),
  ];
};
