import type { Extent, Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Gate } from "../description.ts";
import type { Poll, Timing } from "../timing.ts";
import { failSpan, recoverSpan } from "../timing.ts";
import type { RedisKnobs } from "./client.ts";

/**
 * The F6 matrix for the Redis client: each manifestation × the gating posture of its check. The
 * tests on the fake ioredis and the tests on a real Redis share this plan. The bounds of each case
 * come from the declaration itself: its timing, its poll and the client's knobs.
 */

/** The manifestations of F6, by the names of the vocabulary: refusal, freeze, black hole, death without a close, and app stall. */
export const F6_MANIFESTATIONS = ["rst", "freeze-process", "blackhole", "freeze-host", "app-stall"] as const;
export type F6Manifestation = (typeof F6_MANIFESTATIONS)[number];

/** A posture is what the check of the client controls: readiness, liveness, or nothing (it only reports). */
export const F6_POSTURES = ["readiness", "liveness", "reports"] as const;
export type F6Posture = (typeof F6_POSTURES)[number];

export const gateOf = (posture: F6Posture): Gate | null => (posture === "reports" ? null : posture);

const ms = (amount: Extent): number =>
  amount.value === "infinite" ? Number.POSITIVE_INFINITY : valueIn(amount as Quantity, "ms");

/** A band is a range of times in milliseconds after an event. */
export interface Band {
  readonly low: number;
  readonly high: number;
}

/**
 * This function gives the band of the trip of a policy after a fault. Its earliest is the failSpan
 * of checks that fail at once (a client that is not ready). Its latest is the failSpan of checks
 * that fail at their timeout (a silent server).
 */
export const tripBand = (timing: Timing, poll: Poll): Band => ({
  low: valueIn(failSpan(timing, poll, "error").min, "ms"),
  high: valueIn(failSpan(timing, poll, "timeout").max, "ms"),
});

/**
 * This function gives the most time that the client takes to be ready again after the server is
 * back. It adds four times: a try that waits for its connect bound, and a handshake that waits for
 * its request timeout. Then the longest delay of the retry strategy with its jitter, and the
 * watchdog that starts an ended client.
 */
export const reconnectBound = (knobs: RedisKnobs): number =>
  ms(knobs.connect_bound) + ms(knobs.request_timeout) + ms(knobs.retry_cap) + ms(knobs.retry_base) + ms(knobs.heartbeat_interval);

/** This function gives the band of the release of a policy after the server is back: recoverSpan, plus the reconnect bound. */
export const recoverBand = (timing: Timing, poll: Poll, knobs: RedisKnobs): Band => ({
  low: valueIn(recoverSpan(timing, poll).min, "ms"),
  high: valueIn(recoverSpan(timing, poll).max, "ms") + reconnectBound(knobs),
});

/** This function gives the band of the first failing result of a check that only reports: one jittered interval and its timeout. */
export const reportBand = (poll: Poll): Band => ({
  low: 0,
  high: valueIn(poll.interval, "ms") * (1 + poll.jitter) + valueIn(poll.timeout, "ms"),
});
