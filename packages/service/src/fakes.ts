// The fakes of the runtime for tests: a fake clock gives exact, repeatable timing, a seeded random
// gives the same jitter on each run, and a fake process takes signals and keeps the exit codes.

import { mulberry32 } from "@mark1russell7/rigor-generators";
import type { Clock } from "./clock.ts";
import type { ExitSignal, ExitTrigger, ProcessPort, UncaughtOrigin } from "./process.ts";

// the fake clock lives beside the clock, in @mark1russell7/automata/clock
export type { FakeClock } from "@mark1russell7/automata/clock";
export { fakeClock } from "@mark1russell7/automata/clock";

/** A fake process receives triggers from a test, and keeps each exit code in place of an exit. */
export interface FakeProcess extends ProcessPort {
  /** This method sends a signal to each handler of it. */
  signal(name: ExitSignal): void;
  /** This method sends a trigger to each handler of it: a signal, or a process trigger, for example `stdin-close`. */
  trigger(name: ExitTrigger): void;
  /** This method sends a message of the IPC channel to each handler of the trigger `ipc-message`. */
  message(value: unknown): void;
  /** This method sends an error that no code caught to each handler of `onUncaught`. The default origin is `uncaughtException`. */
  uncaught(error: unknown, origin?: UncaughtOrigin): void;
  /** These are the exit codes, in sequence. A correct runtime exits one time. */
  readonly exits: readonly number[];
  /** This count is the number of handlers that are registered. */
  readonly handlers: number;
  /** These are the triggers that have a handler, in the sequence of their first handler. */
  readonly triggers: readonly ExitTrigger[];
  /** These are the times of the clock of the options at each flush and each exit, when the options give a clock. */
  readonly log: readonly string[];
  /** This count is the number of flushes of the output. */
  readonly flushes: number;
  /** This count is the number of holds of the process that are not released. */
  readonly holds: number;
  /** These counts are the holds that were not released at each exit, in sequence. */
  readonly heldAtExit: readonly number[];
}

/** These options shape a fake process. */
export interface FakeProcessOptions {
  /** This function is the flush of the output, for example a wait on a fake clock. Without it, a flush ends at once. */
  readonly flush?: (() => Promise<void> | void) | undefined;
  /** This clock stamps each line of the log. */
  readonly clock?: Clock | undefined;
}

/** This function makes a fake process. */
export const fakeProcess = (options: FakeProcessOptions = {}): FakeProcess => {
  const handlers = new Map<ExitTrigger, Set<(message?: unknown) => void>>();
  const uncaughtHandlers = new Set<(error: unknown, origin: UncaughtOrigin) => void>();
  const exits: number[] = [];
  const log: string[] = [];
  let flushes = 0;
  let holds = 0;
  const heldAtExit: number[] = [];
  const stamp = (what: string): void => {
    log.push(options.clock === undefined ? what : `${options.clock.now()} ${what}`);
  };
  const send = (name: ExitTrigger, message?: unknown): void => {
    for (const handler of [...(handlers.get(name) ?? [])]) handler(message);
  };
  return {
    on(trigger, handler) {
      const set = handlers.get(trigger) ?? new Set();
      set.add(handler);
      handlers.set(trigger, set);
      return () => {
        set.delete(handler);
      };
    },
    onUncaught(handler) {
      // each registration is a handler of its own, as with `on`
      const own = (error: unknown, origin: UncaughtOrigin): void => handler(error, origin);
      uncaughtHandlers.add(own);
      return () => {
        uncaughtHandlers.delete(own);
      };
    },
    async flush() {
      stamp("flush");
      await options.flush?.();
      flushes += 1;
      stamp("flushed");
    },
    hold() {
      holds += 1;
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        holds -= 1;
      };
    },
    exit(code) {
      stamp(`exit ${code}`);
      heldAtExit.push(holds);
      exits.push(code);
    },
    signal: (name) => send(name),
    trigger: (name) => send(name),
    message: (value) => send("ipc-message", value),
    uncaught: (error, origin = "uncaughtException") => {
      for (const handler of [...uncaughtHandlers]) handler(error, origin);
    },
    get exits() {
      return [...exits];
    },
    get handlers() {
      let count = uncaughtHandlers.size;
      for (const set of handlers.values()) count += set.size;
      return count;
    },
    get triggers() {
      return [...handlers.keys()];
    },
    get log() {
      return [...log];
    },
    get flushes() {
      return flushes;
    },
    get holds() {
      return holds;
    },
    get heldAtExit() {
      return [...heldAtExit];
    },
  };
};

/**
 * This function gives a seeded random number generator (mulberry32), with numbers in [0, 1). It is
 * `mulberry32` of @mark1russell7/rigor-generators.
 */
export const seeded = (seed: number): (() => number) => mulberry32(seed);
