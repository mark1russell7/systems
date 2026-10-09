/**
 * The closed forms of the Linux TCP timers that tell a client that its peer is gone, at v6.6. Each
 * form uses the rules of the kernel: integer jiffies, the doubling of the retransmission timeout (RTO)
 * and the granularity of the timer wheel.
 *
 * These forms are a copy of the algebra in jarvis (`domain-systems/src/algebra.ts`). The tests hold
 * both to the same figures until the algebra moves into this repository.
 */

/** The settings that the forms read. The times are in milliseconds. */
export interface Knobs {
  /** `net.ipv4.tcp_keepalive_time`: the idle time before the first keepalive probe */
  readonly keepidle: number;
  /** `net.ipv4.tcp_keepalive_intvl`: the time between two keepalive probes */
  readonly keepintvl: number;
  /** `net.ipv4.tcp_keepalive_probes`: the count of probes without an answer */
  readonly keepcnt: number;
  /** `net.ipv4.tcp_retries2`: the retransmission budget, as a count */
  readonly retries: number;
  /** the smoothed round trip of the path */
  readonly rtt: number;
  /** `CONFIG_HZ`: the ticks of the kernel clock in each second */
  readonly hz: number;
}

/** The defaults of Linux 6.6, with HZ 250 and a round trip of 0.1 ms. */
export const LINUX_66: Knobs = {
  keepidle: 7_200_000,
  keepintvl: 75_000,
  keepcnt: 9,
  retries: 15,
  rtt: 0.1,
  hz: 250,
};

/** `TCP_RTO_MIN` and `TCP_RTO_MAX` in milliseconds. */
export const RTO_MIN = 200;
export const RTO_MAX = 120_000;

/** A time that a timer can take: the closed form, and how late or early the timer can fire. */
export interface Bounds {
  readonly duration: number;
  readonly early: number;
  readonly late: number;
}

/** The count of whole jiffies for a time, rounded up as `msecs_to_jiffies` rounds it. */
export const jiffiesOf = (ms: number, hz: number): number => Math.ceil((ms * hz) / 1000 - 1e-9);

/**
 * The granularity of the timer wheel, in jiffies, for a timer that is due in `jiffies`. The wheel
 * keeps a timer that is due in fewer than 63 jiffies at level 0. Each level above keeps timers that
 * are 8 times longer, with 8 times the granularity. The wheel rounds a timer up to its granularity.
 */
export const granularity = (jiffies: number): number => {
  let level = 0;
  while (level < 8 && jiffies >= 63 * 8 ** level) level += 1;
  return 8 ** level;
};

/**
 * Keepalive: the idle time, and then one interval for each probe without an answer. The idle
 * timer and each interval can fire late by their granularity. The count starts in the jiffy
 * before the last segment, so the timer can fire one jiffy early.
 */
export const keepalive = (knobs: Knobs): Bounds & { readonly probes: readonly number[] } => {
  const tick = 1000 / knobs.hz;
  const idle = granularity(jiffiesOf(knobs.keepidle, knobs.hz));
  const interval = granularity(jiffiesOf(knobs.keepintvl, knobs.hz));
  const probes = Array.from({ length: knobs.keepcnt }, (_, n) => knobs.keepidle + n * knobs.keepintvl);
  return {
    duration: knobs.keepidle + knobs.keepcnt * knobs.keepintvl,
    early: tick,
    late: (idle + knobs.keepcnt * interval) * tick,
    probes,
  };
};

/**
 * The retransmission budget of `tcp_model_timeout`: the waits double from `TCP_RTO_MIN`, until a
 * wait passes `TCP_RTO_MAX`, and then each wait is `TCP_RTO_MAX`.
 */
export const budget = (retries: number): number => {
  let thresh = 0;
  while (RTO_MIN * 2 ** (thresh + 1) <= RTO_MAX) thresh += 1;
  if (retries <= thresh) return RTO_MIN * (2 ** (retries + 1) - 1);
  return RTO_MIN * (2 ** (thresh + 1) - 1) + (retries - thresh) * RTO_MAX;
};

/**
 * The retransmission give-up. The budget starts at the first retransmission of the RTO timer.
 * The real RTO is the round trip plus `TCP_RTO_MIN`, in whole jiffies, and each firing doubles it.
 * The give-up comes at the first firing at or after the budget. Thus the give-up is late by at most
 * one step, plus the rounding of each firing on the wheel.
 */
export const retransmission = (
  knobs: Knobs,
): Bounds & { readonly firings: readonly number[]; readonly giveUp: number } => {
  const tick = 1000 / knobs.hz;
  const base = jiffiesOf(RTO_MIN + knobs.rtt, knobs.hz);
  const cap = jiffiesOf(RTO_MAX, knobs.hz);
  const total = budget(knobs.retries);
  let step = base;
  let wheel = 0;
  for (let k = 1; k <= knobs.retries + 1; k += 1) {
    step = Math.min(base * 2 ** k, cap);
    wheel += granularity(step);
  }
  // the firings after the first retransmission of the RTO timer, without the rounding of the wheel
  const firings: number[] = [];
  let at = 0;
  for (let k = 1; at < total && k <= 64; k += 1) {
    at += Math.min(base * 2 ** k, cap) * tick;
    firings.push(at);
  }
  return { duration: total, early: 0, late: (step + wheel) * tick, firings, giveUp: at };
};

/** What the connection did when the failure started. */
export type Situation = "idle" | "in-flight" | "frozen";

/** The detector that fires first, or `null` when the failure is silent at the TCP level. */
export interface Detection {
  readonly timer: "keepalive" | "retransmission" | null;
  readonly bounds: Bounds | null;
  /** the reason for each timer that does not fire */
  readonly held: readonly string[];
}

/**
 * Detection is the first of the timers that stay live. A black hole lets nothing back. The kernel
 * of a frozen process keeps the acknowledgments, so each acknowledgment starts keepalive again.
 */
export const detection = (knobs: Knobs, situation: Situation, keepaliveOn: boolean): Detection => {
  if (situation === "frozen") {
    return {
      timer: null,
      bounds: null,
      held: ["An acknowledgment from the frozen kernel starts keepalive again.", "The kernel acknowledges the data, so nothing is retransmitted."],
    };
  }
  if (situation === "in-flight") {
    return {
      timer: "retransmission",
      bounds: retransmission(knobs),
      held: ["The first retransmission stops keepalive."],
    };
  }
  if (!keepaliveOn) return { timer: null, bounds: null, held: ["Keepalive is off, and nothing is in flight."] };
  return { timer: "keepalive", bounds: keepalive(knobs), held: [] };
};
