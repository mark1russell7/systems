import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Cancel, Clock } from "./clock.ts";
import type { Gate } from "./description.ts";
import type { Outcome, Trace } from "./latch.ts";
import type { Poll } from "./timing.ts";

/**
 * A watchdog spec declares a watchdog of the event loop. The service declares it as a check whose
 * function the watchdog gives: the process's own wedge, which a liveness window reads.
 */
export interface WatchdogSpec {
  readonly name: string;
  /** This time is the interval of the tick of the watchdog. */
  readonly tick: Quantity;
  /** This time is the most that a tick can be late before the loop counts as blocked. */
  readonly threshold: Quantity;
  /** This gate is the policy that the check controls, or null for a check that only reports. */
  readonly gates: Gate | null;
  readonly poll: Poll;
}

/**
 * A watchdog measures how late its own tick comes. A blocked event loop delays each timer, thus a
 * tick that comes later than the threshold shows the block. Its states are `watching`, `blocked`
 * and `stopped`.
 */
export interface Watchdog {
  /** This function is the check: it fails when a tick since the last poll came late, or the loop is still blocked. */
  readonly check: () => Outcome;
  /** This time is the most that a tick was late, in milliseconds, since the start. */
  readonly worst: number;
  readonly blocked: boolean;
  stop(): void;
}

/** This function starts a watchdog on a clock. */
export const watchdog = (clock: Clock, spec: WatchdogSpec, trace?: Trace): Watchdog => {
  const tick = valueIn(spec.tick, "ms");
  const threshold = valueIn(spec.threshold, "ms");
  if (!(tick > 0)) throw new RangeError(`watchdog ${spec.name} ticks every ${tick} ms, not above zero`);
  let blocked = false;
  let stopped = false;
  let worst = 0;
  // the worst lateness since the last poll of the check
  let sincePoll = 0;
  let next: Cancel | null = null;

  const named = (): string => (stopped ? "stopped" : blocked ? "blocked" : "watching");
  const arm = (): void => {
    const due = clock.now() + tick;
    next = clock.after(tick, () => {
      next = null;
      if (stopped) return;
      const late = Math.max(0, clock.now() - due);
      worst = Math.max(worst, late);
      sincePoll = Math.max(sincePoll, late);
      const from = named();
      blocked = late > threshold;
      trace?.(from, named(), "tick");
      arm();
    });
  };
  arm();

  return {
    check: () => {
      const failed = blocked || sincePoll > threshold;
      sincePoll = 0;
      return failed ? "error" : "ok";
    },
    get worst() {
      return worst;
    },
    get blocked() {
      return blocked;
    },
    stop() {
      if (stopped) return;
      const from = named();
      stopped = true;
      next?.();
      next = null;
      trace?.(from, "stopped", "stop");
    },
  };
};
