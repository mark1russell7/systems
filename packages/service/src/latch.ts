import { valueIn } from "@mark1russell7/quantity";
import type { Cancel, Clock } from "./clock.ts";
import type { Timing } from "./timing.ts";

/**
 * An outcome is the result of one poll of a check. Only `"ok"` passes. An `"indeterminate"`
 * outcome measured nothing: it does not pass, and it does not fail.
 */
export type Outcome = "ok" | "error" | "indeterminate";

/** A result is one poll of a check, as the runtime records it. */
export interface Result {
  readonly outcome: Outcome;
  /** This time is when the result came, on the monotonic clock, in milliseconds. */
  readonly at: number;
  /** This time is how long the poll took, in milliseconds. */
  readonly took: number;
  /** This text tells why the poll did not pass, or it is null. */
  readonly cause: string | null;
  /** This flag tells if the poll failed at its timeout. */
  readonly timedOut: boolean;
  /** This flag tells if the check threw. A throw is an error with a flag. */
  readonly thrown: boolean;
  /** This flag tells if the force-fail list made the poll fail. */
  readonly forced: boolean;
}

/**
 * A latch turns the results of one check into a verdict, by the timing of its policy. A debounce
 * counts polls in sequence. A window measures time on the monotonic clock from the first failure
 * of a sequence. A tripped latch fails its policy.
 */
export interface Latch {
  readonly tripped: boolean;
  /** This time is when the latch last tripped or released. */
  readonly since: number;
  /** This count is the sequence of the latest results: above zero for passes, below zero for failures. */
  readonly streak: number;
  record(result: Result): void;
  /** This method stops the timers of a window. */
  stop(): void;
}

/**
 * A trace receives each transition of a machine of the runtime: the state before, the state after,
 * and the event. The machine documents of the lifecycle name the same states and events, thus a
 * test can replay a trace against its document.
 */
export type Trace = (from: string, to: string, on: string) => void;

const ms = (amount: { readonly value: number; readonly unit: string }): number =>
  valueIn(amount, "ms");

/**
 * This function makes a latch. `tripped` is its state at the start: a readiness latch starts
 * tripped, and a liveness latch starts released. The latch starts `changed` each time it trips or
 * releases, and it gives each transition to `trace`. A debounce has the states `released` and
 * `tripped`. A window also has the states `failing` and `recovering`, while one of its timers runs.
 */
export const latch = (
  timing: Timing,
  clock: Clock,
  tripped: boolean,
  changed: () => void,
  trace?: Trace,
): Latch => {
  let state = tripped;
  let since = clock.now();
  let streak = 0;
  let fails = 0;
  let passes = 0;
  // the timers of a window: the time that a sequence of failures or passes started, and its timer
  let failingSince: number | null = null;
  let passingSince: number | null = null;
  let failTimer: Cancel | null = null;
  let passTimer: Cancel | null = null;

  /** This function gives the name of the state, as the machine documents name it. */
  const named = (): string =>
    state
      ? passingSince === null
        ? "tripped"
        : "recovering"
      : failingSince === null
        ? "released"
        : "failing";
  /** This function does one step of the machine, and gives its transition to the trace. */
  const step = (on: string, change: () => void): void => {
    const from = named();
    change();
    trace?.(from, named(), on);
  };

  const set = (next: boolean): void => {
    if (next === state) return;
    state = next;
    since = clock.now();
    changed();
  };
  const stopFail = (): void => {
    failTimer?.();
    failTimer = null;
    failingSince = null;
  };
  const stopPass = (): void => {
    passTimer?.();
    passTimer = null;
    passingSince = null;
  };

  const debounce = (result: Result): void => {
    if (timing.type !== "debounce") return;
    if (result.outcome === "ok") {
      passes += 1;
      fails = 0;
      if (state && passes >= timing.recoverAfter) set(false);
    } else {
      fails += 1;
      passes = 0;
      if (!state && fails >= timing.failAfter) set(true);
    }
  };

  const windowed = (result: Result): void => {
    if (timing.type !== "window") return;
    if (result.outcome === "ok") {
      stopFail();
      if (!state) return;
      if (timing.recoverAfter === undefined) {
        set(false);
        return;
      }
      if (passingSince !== null) return;
      const wait = ms(timing.recoverAfter);
      if (wait <= 0) {
        stopPass();
        set(false);
        return;
      }
      passingSince = result.at;
      passTimer = clock.after(wait, () =>
        step("window.recovered", () => {
          passTimer = null;
          passingSince = null;
          set(false);
        }),
      );
      return;
    }
    stopPass();
    if (state || failingSince !== null) return;
    const wait = ms(timing.failAfter);
    if (wait <= 0) {
      stopFail();
      set(true);
      return;
    }
    failingSince = result.at;
    failTimer = clock.after(wait, () =>
      step("window.failed", () => {
        failTimer = null;
        failingSince = null;
        set(true);
      }),
    );
  };

  return {
    get tripped() {
      return state;
    },
    get since() {
      return since;
    },
    get streak() {
      return streak;
    },
    record(result) {
      // an indeterminate poll measured nothing: it moves no sequence and no streak
      if (result.outcome === "indeterminate") return;
      const pass = result.outcome === "ok";
      step(pass ? "poll.ok" : "poll.fail", () => {
        streak = pass ? Math.max(0, streak) + 1 : Math.min(0, streak) - 1;
        debounce(result);
        windowed(result);
      });
    },
    stop() {
      stopFail();
      stopPass();
    },
  };
};
