// @mark1russell7/algebra/run: a live instance of a machine document. The run takes the transitions
// of the document on each event, and it operates the timers of the document on a clock. The entry
// does not import zod or a `node:` module. Thus a client in a browser can run its own machines.

import type { Extent, Unknown } from "@mark1russell7/quantity";
import { convertExact, isUnbounded, quantity, rationals as r } from "@mark1russell7/quantity";
import type { KnobValues } from "./algebra.ts";
import { timerOf, transitionOn } from "./algebra.ts";
import type { Cancel, Clock } from "./clock.ts";
import type { Machine, TransitionDef } from "./machine.ts";
import { machineProblems } from "./machine.ts";
import type { Transition } from "./replay.ts";

/** These options start a run of a machine document. */
export interface RunMachineOptions {
  /** This clock gives the time of the run and operates its timers. A test gives `fakeClock()`. */
  readonly clock: Clock;
  /** This function gives the knob values for the durations of the timers. The default is the `default` of each knob. */
  readonly values?: KnobValues | undefined;
  /** This state is the start state. The default is the initial state of the document. */
  readonly state?: string | undefined;
  /** This name identifies the instance in each transition record. The default is the `id` of the document. */
  readonly instance?: string | undefined;
  /** This function gets each transition that the run takes, in the form that `replay` reads. */
  readonly onTransition?: ((transition: Transition) => void) | undefined;
}

/** A machine run is one live instance of a machine document. */
export interface MachineRun {
  /** This name is the state where the instance is. */
  readonly state: string;
  /**
   * This method gives one event to the instance. It gives the transition that the instance takes, or
   * undefined when the state has no transition on the event.
   */
  send(event: string): TransitionDef | undefined;
  /** This method stops each timer. After it, each send does nothing and gives undefined. */
  stop(): void;
}

/** This function gives the values of the knobs at their defaults. A knob without a default or without a unit has no value. */
const knobDefaults =
  (doc: Machine): KnobValues =>
  (name) => {
    const knob = Object.hasOwn(doc.knobs, name) ? doc.knobs[name] : undefined;
    if (knob === undefined || knob.unit === null || knob.default === null) return undefined;
    return quantity(knob.default, knob.unit);
  };

/** This function gives the start state of a run: the state of the options, or the one initial state of the document. */
const startState = (doc: Machine, state: string | undefined): string => {
  if (state !== undefined) {
    if (!Object.hasOwn(doc.states, state)) throw new Error(`${doc.title} has no state ${state}`);
    return state;
  }
  const initial = Object.keys(doc.states).filter((name) => doc.states[name]!.initial === true);
  if (initial.length !== 1) {
    throw new Error(`${doc.title} has ${initial.length} initial states: give the start state in the options`);
  }
  return initial[0]!;
};

/**
 * This function starts a live instance of a machine document on a clock. It gives the run: its
 * state, `send` and `stop`. The run applies these rules:
 *
 * - The run refuses a document with problems (`machineProblems`), as each reader does. With a start
 *   state in the options, a document with no initial state is correct.
 * - At the start, the instance enters its start state. The pseudo event `enter:<state>` operates
 *   the timers, as after a transition.
 * - An event that the document does not name is an error. The run throws an `Error` that names it.
 * - `send` takes the transition of `transitionOn` from the state on the event. Then, in sequence,
 *   these events operate the timers: the event itself, each event that the transition emits, and
 *   `enter:<to>`. A transition to the state that it leaves also enters that state again.
 * - An event without a transition also operates the timers.
 * - For each timer, an event of `backoff.resets` first sets its count of firings to 0. Then an
 *   event of `cancels` stops it, or else an event of `arms` starts it again from the full
 *   duration. An event in `arms` and in `cancels` stops the timer, as in `detection`.
 * - The run reads the duration of each start from `timerOf`, with the values and the count of
 *   firings of a backoff timer. It converts the duration to milliseconds exactly. It does not read
 *   the lateness or the early bound. A duration with no bound does not start the timer.
 * - The run reads the first duration of each timer when it starts. Thus a knob without a value is an
 *   error at the start, not in a callback of the clock.
 * - When a timer fires, its `fires` event goes through `send`. A backoff timer first adds 1 to its
 *   count and starts again with its next wait. Thus its own `cancels` can stop it.
 * - The entry to a final state stops each timer. In a final state, `send` does nothing and gives undefined.
 * - The run gives each transition that it takes to `onTransition`, after the timers. The record has
 *   the machine (the `id` of the document), the instance, the states, the event and the time of the clock.
 * - The `timer` of a transition is a note for the reader. The run does not read it.
 */
export const runMachine = (doc: Machine, options: RunMachineOptions): MachineRun => {
  const problems = machineProblems(doc).filter((problem) => options.state === undefined || problem !== "no initial state");
  if (problems.length > 0) throw new Error(`${doc.title} has problems: ${problems.join(", ")}`);
  const clock = options.clock;
  const values = options.values ?? knobDefaults(doc);
  const instance = options.instance ?? doc.id;
  let state = startState(doc, options.state);
  let stopped = false;
  const timers = Object.entries(doc.timers).map(([name, def]) => ({
    name,
    def,
    fired: 0,
    cancel: undefined as Cancel | undefined,
  }));
  type Live = (typeof timers)[number];

  /** This function gives the wait of a timer in milliseconds, or undefined for a duration with no bound. */
  const waitOf = (timer: Live): number | undefined => {
    const duration: Extent | Unknown = timerOf(doc, timer.name, values, timer.def.backoff === undefined ? undefined : timer.fired).duration;
    if ("unknown" in duration) throw new Error(`${doc.title}'s ${timer.name} has no known duration: ${duration.unknown}`);
    if (isUnbounded(duration)) return undefined;
    return r.toNumber(convertExact(r.fromNumber(duration.value), duration.unit, "ms"));
  };
  const halt = (timer: Live): void => {
    timer.cancel?.();
    timer.cancel = undefined;
  };
  const begin = (timer: Live): void => {
    halt(timer);
    const ms = waitOf(timer);
    if (ms !== undefined) timer.cancel = clock.after(ms, () => fire(timer));
  };
  const fire = (timer: Live): void => {
    timer.cancel = undefined;
    if (stopped) return;
    if (timer.def.backoff !== undefined) {
      timer.fired += 1;
      begin(timer);
    }
    run.send(timer.def.fires);
  };
  /** This function operates each timer for one event. */
  const occur = (event: string): void => {
    for (const timer of timers) {
      if (timer.def.backoff?.resets.includes(event) === true) timer.fired = 0;
      if (timer.def.cancels?.includes(event) === true) halt(timer);
      else if (timer.def.arms.includes(event)) begin(timer);
    }
  };
  const isFinal = (name: string): boolean => doc.states[name]?.final === true;
  /** This function enters a state: `enter:<state>` operates the timers, and a final state stops each timer. */
  const enter = (to: string): void => {
    occur(`enter:${to}`);
    if (isFinal(to)) for (const timer of timers) halt(timer);
  };

  const run: MachineRun = {
    get state() {
      return state;
    },
    send(event) {
      if (!Object.hasOwn(doc.events, event)) throw new Error(`${doc.title} has no event ${event}`);
      if (stopped || isFinal(state)) return undefined;
      const from = state;
      const taken = transitionOn(doc, from, event);
      if (taken !== undefined) state = taken.to;
      occur(event);
      if (taken === undefined) return undefined;
      for (const sent of taken.emits ?? []) occur(sent);
      enter(taken.to);
      options.onTransition?.({ machine: doc.id, instance, from, on: event, to: taken.to, at: clock.now() });
      return taken;
    },
    stop() {
      stopped = true;
      for (const timer of timers) halt(timer);
    },
  };

  // a first duration that is not known stops the start, before a timer runs
  for (const timer of timers) waitOf(timer);
  enter(state);
  return run;
};
