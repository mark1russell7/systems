import type { Detector, Meeting, Situation } from "../client/meets.ts";
import { NEVER, WHAT, immediate, keepaliveAnswered, keepaliveReset, keepaliveSilent, kernelGiveUp } from "../client/meets.ts";
import { finiteMs } from "../client/core.ts";
import { heartbeatDetection } from "../timing.ts";
import type { WsKnobs } from "./client.ts";

/**
 * This function gives the manifestations that a WebSocket client can meet, and the detectors of
 * each, from its knobs. The WS cells measured them on ws 8:
 * - At a heartbeat of 2 s, a timeout of 1 s and 1 miss, the drop came 0.999 s to 1.0035 s after the
 *   ping that got no pong. The slowest of 495 runs took 1.003761 s.
 * - `terminate()` closes the socket 0.3 ms to 1 ms after the drop. The close of the global WebSocket
 *   only writes a close frame, and its socket stayed ESTABLISHED.
 * - The kernel of a frozen server acknowledges each ping, thus only the heartbeat finds it.
 * - At `tcp_retries2 = 3`, the kernel gave up before a pong timeout of 10 s.
 * - Without a heartbeat, the client waited for the keepalive of undici: 70 s. ws sets no keepalive.
 */
export const wsMeetings = (name: string, knobs: WsKnobs, misses: number): Meeting[] => {
  const interval = finiteMs(knobs.heartbeat_interval);
  const detection = heartbeatDetection(knobs.heartbeat_interval, knobs.heartbeat_timeout, misses);
  const heartbeat = (situation: Situation): Detector => ({
    by: "heartbeat_detection_time",
    within: detection,
    situation,
    effect: `the heartbeat destroys the socket with terminate(), each call in flight fails as indeterminate, and ${name} connects again`,
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
        immediate("in flight", "ws closes with code 1006, the call fails as indeterminate, and the client connects again"),
        {
          by: "heartbeat_interval",
          within: interval === undefined ? NEVER : knobs.heartbeat_interval,
          situation: "idle",
          effect: "the next ping frame gets a reset, and the client connects again",
        },
        keepaliveReset(knobs.keepalive_idle),
      ],
    },
    {
      manifestation: "fin",
      what: WHAT.fin,
      detectors: [
        immediate("in flight", "the FIN arrives, ws closes with code 1006, and the call fails as indeterminate"),
        immediate("idle", "the FIN arrives, ws closes with code 1006, and the client connects again"),
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
      what: "the server holds its reply, for example in a slow handler, and its library still answers each ping",
      detectors: [call, { ...heartbeat("idle"), within: NEVER, effect: "the library of the server still answers each ping with a pong" }, keepaliveAnswered()],
    },
  ];
};
