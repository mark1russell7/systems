/**
 * The model of the detection lab: the Linux TCP timers that tell a client that its peer is gone, at
 * v6.6. The times come from the algebra (`@mark1russell7/automata`) over the document `LINUX_TCP` of
 * `@mark1russell7/machines`. This module only turns the knobs of the lab into the values of that
 * document, and the bounds of the algebra into milliseconds.
 */
import { firings, probeTrain, timerOf, type KnobValues, type TimerBounds } from "@mark1russell7/automata";
import { LINUX_TCP } from "@mark1russell7/machines";
import { isUnbounded, quantity, valueIn, type Extent, type Quantity, type Unknown } from "@mark1russell7/quantity";

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

/** A time that a timer can take: the closed form, and how late or early the timer can fire, in milliseconds. */
export interface Bounds {
  readonly duration: number;
  readonly early: number;
  readonly late: number;
}

/** This function gives the values of the knobs of `LINUX_TCP` from the knobs of the lab, and the defaults of the document. */
const valuesOf =
  (knobs: Knobs): KnobValues =>
  (name) => {
    const given: Readonly<Record<string, Quantity>> = {
      keepidle: quantity(knobs.keepidle, "ms"),
      keepintvl: quantity(knobs.keepintvl, "ms"),
      keepcnt: quantity(knobs.keepcnt, "count"),
      tcp_retries2: quantity(knobs.retries, "count"),
      rtt: quantity(knobs.rtt, "ms"),
      hz: quantity(knobs.hz, "Hz"),
    };
    const own = given[name];
    if (own !== undefined) return own;
    const knob = LINUX_TCP.knobs[name];
    return knob === undefined || knob.default === null ? undefined : quantity(knob.default, knob.unit ?? "count");
  };

/** This function gives an amount in milliseconds. An amount that is not a known time is 0. */
const msOf = (extent: Extent | Unknown | undefined): number =>
  extent === undefined || "unknown" in extent || isUnbounded(extent) ? 0 : valueIn(extent, "ms");

const boundsOf = (bounds: TimerBounds): Bounds => ({ duration: msOf(bounds.duration), early: msOf(bounds.early), late: msOf(bounds.lateness) });

/**
 * Keepalive: the idle time, and then one interval for each probe without an answer. The idle
 * timer and each interval can fire late by the granularity of the timer wheel. The count starts in
 * the jiffy before the last segment, so the timer can fire one jiffy early.
 */
export const keepalive = (knobs: Knobs): Bounds & { readonly probes: readonly number[] } => {
  const probes = probeTrain(quantity(knobs.keepidle, "ms"), quantity(knobs.keepintvl, "ms"), knobs.keepcnt);
  return { ...boundsOf(timerOf(LINUX_TCP, "keepalive", valuesOf(knobs))), probes: probes.map(msOf) };
};

/**
 * The retransmission give-up. The budget of `tcp_retries2` starts at the first retransmission of
 * the RTO timer. The give-up comes at the first firing at or after the budget. Thus the give-up is
 * late by at most one step, plus the rounding of each firing on the wheel. The firings count from
 * the first retransmission, without the rounding of the wheel.
 */
export const retransmission = (
  knobs: Knobs,
): Bounds & { readonly firings: readonly number[]; readonly giveUp: number } => {
  const values = valuesOf(knobs);
  const giveUp = timerOf(LINUX_TCP, "retrans_giveup", values);
  // wait 0 ends in the tail loss probe and wait 1 in the first retransmission: the budget counts from wait 2
  const sends = firings(LINUX_TCP, "retransmit", values, { from: 2, count: 64, reach: giveUp.duration as Extent });
  const times = sends.map((firing) => msOf(firing.at));
  return { ...boundsOf(giveUp), firings: times, giveUp: times.at(-1) ?? 0 };
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
