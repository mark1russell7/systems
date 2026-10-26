import type { Detector, Meeting, Situation } from "../client/meets.ts";
import { WHAT, immediate, keepaliveAnswered, keepaliveReset, keepaliveSilent, kernelGiveUp } from "../client/meets.ts";
import type { HttpClientKnobs } from "./client.ts";

/**
 * This function gives the manifestations that an HTTP client can meet, and the detectors of each,
 * from its knobs. The HTTP cells measured them on the agent of Node 24.21.0:
 * - The agent has no timer of a call, thus the timer of the wrapper finds each silent call in flight.
 * - The free socket timer closes an idle socket at `pool_idle_expiry` at most. Thus no request goes
 *   later on a socket that went silent while it was free.
 * - A FIN on a busy socket fails the call with "socket hang up". A FIN on a free socket destroys it.
 */
export const httpClientMeetings = (name: string, knobs: HttpClientKnobs): Meeting[] => {
  const call: Detector = {
    by: "request_timeout",
    within: knobs.request_timeout,
    situation: "in flight",
    effect: `the timer of the wrapper ends the call as indeterminate, and ${name} destroys its socket`,
  };
  const idleExpiry = (situation: Situation): Detector => ({
    by: "pool_idle_expiry",
    within: knobs.pool_idle_expiry,
    situation,
    effect: "the free socket timer of the agent closes the socket, and the next request opens a new socket",
  });
  const giveUp = kernelGiveUp(knobs.retrans_giveup_time, "the call fails as indeterminate");
  const silent = (manifestation: "blackhole" | "freeze-host"): Meeting => ({
    manifestation,
    what: WHAT[manifestation],
    detectors: [call, giveUp, idleExpiry("idle"), keepaliveSilent(knobs.keepalive_idle)],
  });
  return [
    {
      manifestation: "rst",
      what: WHAT.rst,
      detectors: [
        immediate("in flight", "the call fails with ECONNRESET as indeterminate, and the next request opens a new socket"),
        idleExpiry("idle"),
        keepaliveReset(knobs.keepalive_idle),
      ],
    },
    {
      manifestation: "fin",
      what: WHAT.fin,
      detectors: [
        immediate("in flight", 'the call fails with "socket hang up" as indeterminate'),
        immediate("idle", "the agent destroys the free socket, and the next request opens a new socket"),
      ],
    },
    silent("blackhole"),
    silent("freeze-host"),
    {
      manifestation: "freeze-process",
      what: WHAT["freeze-process"],
      detectors: [call, idleExpiry("idle"), keepaliveAnswered()],
    },
    {
      manifestation: "app-stall",
      what: "the server holds its reply, for example in a slow handler, and its kernel stays up",
      detectors: [call, idleExpiry("idle"), keepaliveAnswered()],
    },
  ];
};
