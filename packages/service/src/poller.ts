import { valueIn } from "@mark1russell7/quantity";
import type { Clock } from "./clock.ts";
import type { Outcome, Result, Trace } from "./latch.ts";
import type { Loop } from "./loop.ts";
import { runLoop } from "./loop-kernel.ts";
import type { Poll } from "./timing.ts";

/**
 * A check function measures one step of a connection. It ends with nothing or `"ok"` for a pass,
 * or with `"error"` or `"indeterminate"`. A throw is an error with a flag. The runtime aborts the
 * signal at the timeout of the poll.
 */
export type CheckFn = (signal: AbortSignal) => Outcome | void | Promise<Outcome | void>;

/** A poller starts one check on its own loop, and gives each result to `record`. */
export interface Poller {
  /** This result is the latest one, or null before the first poll. */
  readonly last: Result | null;
  /** This method polls one time at once, outside the loop, and gives the result. */
  pollNow(): Promise<Result>;
  /** This method starts the loop. The first poll of the loop comes after `delay` milliseconds. */
  start(delay: number): void;
  /** This method gives the next delay of the loop: the interval, with the jitter. */
  jittered(): number;
  stop(): void;
}

export interface PollerOptions {
  readonly name: string;
  readonly poll: Poll;
  readonly run: CheckFn;
  readonly clock: Clock;
  readonly random: () => number;
  /** This function tells if the force-fail list names the check at this time. */
  readonly forced: () => boolean;
  readonly record: (result: Result) => void;
  /**
   * This function receives each transition of the poller. Its states are `idle`, `waiting`,
   * `calling`, `hung` (a call that outlived its timeout) and `stopped`.
   */
  readonly trace?: Trace | undefined;
  /**
   * True makes the timer of the loop not keep a Node process alive. A loop that only watches other
   * work uses it: that work keeps the process alive. The default is false. The timeout of a poll
   * keeps the process alive at each value, because a caller can await a poll (SYS-126).
   */
  readonly unrefLoop?: boolean | undefined;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * This function makes a poller. The loop is on a fixed delay from the planned start of each poll.
 * Thus the next poll starts one interval after the planned start of the current poll, with the
 * jitter (±20 % is 0.2). The timing algebra of the declaration uses this model.
 *
 * Each poll is a round of the loop core, from `start` with the overlap `allow`. After a block of
 * the event loop, the late poll starts at once, and the next poll keeps its planned time.
 *
 * Each poll makes a new measurement. While a use of the check is pending, the poller does not
 * start the check again. Such a poll fails at once with the same cause, and the sequence of
 * failures continues. The polls of the loop and `pollNow()` share this rule.
 */
export const poller = (options: PollerOptions): Poller => {
  const { clock, poll, run } = options;
  const interval = valueIn(poll.interval, "ms");
  const timeout = valueIn(poll.timeout, "ms");
  let last: Result | null = null;
  // the loop of the polls. `start()` makes it, because its first delay comes with the start
  let ticks: Omit<Loop, "schedule"> | undefined;
  let stopped = false;
  let looping = false;
  // the call that has not ended, and when it started; `late` once the call outlived its timeout
  let pending: { readonly since: number; late: boolean } | null = null;
  // the polls in flight: stop() ends each one, and its timer
  const active = new Set<() => void>();

  /** This function gives the name of the state, as the machine document of the poller names it. */
  const named = (): string =>
    stopped
      ? "stopped"
      : pending !== null
        ? pending.late
          ? "hung"
          : "calling"
        : looping
          ? "waiting"
          : "idle";
  const step = (on: string, change: () => void): void => {
    const from = named();
    change();
    options.trace?.(from, named(), on);
  };

  const result = (
    outcome: Outcome,
    started: number,
    fields: Partial<Pick<Result, "cause" | "timedOut" | "thrown" | "forced">> = {},
  ): Result => ({
    outcome,
    at: clock.now(),
    took: clock.now() - started,
    cause: fields.cause ?? null,
    timedOut: fields.timedOut ?? false,
    thrown: fields.thrown ?? false,
    forced: fields.forced ?? false,
  });

  const once = (): Promise<Result> => {
    const started = clock.now();
    if (options.forced())
      return Promise.resolve(result("error", started, { cause: "the force-fail list names it", forced: true }));
    if (pending !== null) {
      const cause = `its call of ${Math.round(started - pending.since)} ms ago is still pending`;
      return Promise.resolve(result("error", started, { cause }));
    }
    const controller = new AbortController();
    return new Promise<Result>((resolve) => {
      let done = false;
      const finish = (value: Result): void => {
        if (done) return;
        done = true;
        active.delete(abandon);
        cancel();
        resolve(value);
      };
      const abandon = (): void => {
        controller.abort();
        finish(result("error", started, { cause: "the runtime stopped" }));
      };
      active.add(abandon);
      const call = { since: started, late: false };
      pending = call;
      // a caller can await this poll, thus its timeout keeps the process alive (SYS-126)
      const cancel = clock.after(timeout, () => {
        controller.abort();
        // the poll fails at its timeout. The call stays pending until it settles
        step("timeout", () => {
          if (pending === call) call.late = true;
        });
        finish(result("error", started, { cause: `no answer in ${timeout} ms`, timedOut: true }));
      });
      const settled = (): void => {
        if (pending !== call) return;
        step(call.late ? "late-answer" : "answer", () => {
          pending = null;
        });
      };
      let answer: Promise<Outcome | void>;
      try {
        answer = Promise.resolve(run(controller.signal));
      } catch (error) {
        answer = Promise.reject(error);
      }
      answer.then(
        (value) => {
          settled();
          const outcome = value ?? "ok";
          finish(result(outcome, started, outcome === "ok" ? {} : { cause: `the check gave ${outcome}` }));
        },
        (error: unknown) => {
          settled();
          finish(result("error", started, { cause: message(error), thrown: true }));
        },
      );
    });
  };

  const handle = (value: Result): Result => {
    last = value;
    if (!stopped) options.record(value);
    return value;
  };

  // with no jitter, the delay takes no draw of the random function, as in the loop core
  const jittered = (): number =>
    poll.jitter === 0 ? interval : interval * (1 + poll.jitter * (2 * options.random() - 1));

  return {
    get last() {
      return last;
    },
    pollNow: () => {
      let polled: Promise<Result> | undefined;
      step("sweep", () => {
        polled = once();
      });
      return polled!.then(handle);
    },
    start(delay) {
      if (stopped || ticks !== undefined) return;
      step("start", () => {
        looping = true;
        ticks = runLoop(
          {
            from: "start",
            period: interval,
            jitter: poll.jitter,
            first: Math.max(0, delay),
            // the poller bounds each call with its own timer: the call stays pending after its timeout
            timeout: Number.POSITIVE_INFINITY,
            backoff: null,
            overlap: "allow",
            lanes: 1,
            budget: null,
            // a loop that watches other work does not keep the process alive. The timeout of a poll keeps it (SYS-126)
            hold: options.unrefLoop !== true,
            stable: null,
          },
          () => {
            if (stopped) return;
            let polled: Promise<Result> | undefined;
            step("tick", () => {
              polled = once();
            });
            // a record that throws is an error of the caller: the host gets it, as before the loop core
            void polled!.then(handle);
            return polled!.then(() => undefined);
          },
          { name: options.name, clock, random: options.random },
        );
        ticks.start();
      });
    },
    jittered,
    stop() {
      if (stopped) return;
      step("stop", () => {
        stopped = true;
      });
      // the stop of the loop cancels its timer. Each poll in flight ends below, thus its round settles
      void ticks?.stop().catch(() => undefined);
      for (const abandon of [...active]) abandon();
    },
  };
};
