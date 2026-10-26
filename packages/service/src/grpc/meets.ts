import type { Detector, Meeting, Situation } from "../client/meets.ts";
import { NEVER, WHAT, immediate, kernelGiveUp } from "../client/meets.ts";
import { finiteMs } from "../client/core.ts";
import { heartbeatDetection } from "../timing.ts";
import type { GrpcKnobs } from "./client.ts";

/**
 * This function gives the manifestations that a gRPC client can meet, and the detectors of each,
 * from its knobs. The gRPC cells measured them on grpc-js 1.14.6:
 * - At its defaults, grpc-js has no detector: no keepalive, no deadline, and no TCP keepalive.
 * - A reset gave each call ECONNRESET in 1.1 ms to 1.4 ms. The FIN of a stopped server ended an idle connection in 43 µs.
 * - The keepalive ended a silent transport at keepalive_time + keepalive_timeout: 80.012 s at 60 s
 *   against etcd, and 320.005 s at 300 s against grpc-go (DP24).
 * - Without `keepaliveWithoutCalls`, grpc-js sends a PING only with a call in flight.
 * - At client_idle_timeout, the channel goes IDLE, and the client connects again. A server that does
 *   not answer then keeps the channel out of READY.
 */
export const grpcMeetings = (name: string, knobs: GrpcKnobs, withoutCalls: boolean): Meeting[] => {
  const interval = finiteMs(knobs.keepalive_time);
  const detection = heartbeatDetection(knobs.keepalive_time, knobs.keepalive_timeout, 1);
  const keepalive = (situation: Situation): Detector => ({
    by: "heartbeat_detection_time",
    within: situation === "idle" && !withoutCalls ? NEVER : detection,
    situation,
    effect:
      situation === "idle" && !withoutCalls
        ? "grpc-js sends no PING with no call in flight"
        : `the PING gets no ACK in keepalive_timeout, the transport ends, each call in flight fails with UNAVAILABLE, and ${name} connects again`,
  });
  const deadline: Detector = {
    by: "request_timeout",
    within: knobs.request_timeout,
    situation: "in flight",
    effect: "the deadline ends the call with DEADLINE_EXCEEDED as indeterminate, and the transport stays",
  };
  // A new connection after client_idle_timeout meets the failure, and the channel does not become READY
  const reconnect: Detector = {
    by: "client_idle_timeout",
    within: knobs.client_idle_timeout,
    situation: "idle",
    effect: `the channel goes IDLE, ${name} connects again, and the new connection does not become ready`,
  };
  const giveUp = kernelGiveUp(knobs.retrans_giveup_time, "each call in flight fails with UNAVAILABLE");
  const silent = (manifestation: "blackhole" | "freeze-host"): Meeting => ({
    manifestation,
    what: WHAT[manifestation],
    detectors: [deadline, keepalive("in flight"), giveUp, keepalive("idle"), reconnect],
  });
  return [
    {
      manifestation: "rst",
      what: WHAT.rst,
      detectors: [
        immediate("in flight", "the reset arrives, each call fails with UNAVAILABLE as indeterminate, and the channel goes IDLE"),
        {
          by: "keepalive_time",
          within: interval === undefined || !withoutCalls ? NEVER : knobs.keepalive_time,
          situation: "idle",
          effect: "the next PING gets a reset, and the client connects again",
        },
        { ...reconnect, effect: `the channel goes IDLE, ${name} connects again, and the server refuses the connect` },
      ],
    },
    {
      manifestation: "fin",
      what: WHAT.fin,
      detectors: [
        immediate("in flight", "the FIN arrives, and each call fails with UNAVAILABLE as indeterminate"),
        immediate("idle", "the FIN arrives, the channel goes IDLE, and the client connects again"),
      ],
    },
    silent("blackhole"),
    silent("freeze-host"),
    {
      manifestation: "freeze-process",
      what: WHAT["freeze-process"],
      // The kernel of the server completes a new TCP connect, but its process sends no SETTINGS frame
      detectors: [deadline, keepalive("in flight"), keepalive("idle"), reconnect],
    },
    {
      manifestation: "app-stall",
      what: "the server holds its reply, for example in a slow handler, and its library still answers each PING",
      detectors: [
        deadline,
        { ...keepalive("idle"), within: NEVER, effect: "the library of the server still answers each PING with an ACK" },
        { ...reconnect, within: NEVER, effect: "the library of the server still takes a new connection" },
      ],
    },
  ];
};
