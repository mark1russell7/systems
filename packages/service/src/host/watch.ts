import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Latch, Result, Trace } from "../latch.ts";
import { latch } from "../latch.ts";
import type { Poller } from "../poller.ts";
import { poller } from "../poller.ts";
import type { Timing } from "../timing.ts";
import type { HostPorts } from "./ports.ts";
import type { ProbeResult, ReadyProbe } from "./probes.ts";
import { probeOnce, probeProblems } from "./probes.ts";
import { isTime } from "./render.ts";

/**
 * A verdict tells when a target goes down and when it comes up again.
 * - `debounce`: `failAfter` failed polls in sequence make it down, and `recoverAfter` passed polls in sequence make it up.
 * - `window`: failures for the time `failAfter` make it down. Passes for the time `recoverAfter` make it up. Without
 *   `recoverAfter`, the first pass makes it up.
 */
export type TargetVerdict =
  | { readonly type: "debounce"; readonly failAfter: number; readonly recoverAfter: number }
  | { readonly type: "window"; readonly failAfter: Quantity; readonly recoverAfter?: Quantity | undefined };

/** A watch target is one thing that a watcher probes on its own loop. */
export interface WatchTarget {
  /** This name is unique in the spec. A change names its target with it. */
  readonly name: string;
  readonly probe: ReadyProbe;
  /** This time is between the starts of two polls. */
  readonly interval: Quantity;
  /** This time is the most that one poll waits. It is not above the interval. */
  readonly timeout: Quantity;
  /** This fraction moves each interval by up to ± its part, thus two watchers do not poll in step. The default is 0.1. */
  readonly jitter?: number | undefined;
  /** The default is a debounce: 3 failures make it down, and 2 passes make it up. */
  readonly verdict?: TargetVerdict | undefined;
}

/** A watch spec lists the targets of one watcher. */
export interface WatchSpec {
  readonly targets: readonly WatchTarget[];
}

/** The health of a target is `unknown` until its first verdict. */
export type TargetHealth = "unknown" | "up" | "down";

/** A target change is one transition of the health of a target. */
export interface TargetChange {
  readonly target: string;
  readonly from: TargetHealth;
  readonly to: "up" | "down";
  /** This time is the wall time of the change, in milliseconds after the epoch. */
  readonly at: number;
  /** This text tells why the latest poll failed, for a change to down. It is null for a change to up. */
  readonly why: string | null;
}

/** A target state is what a watcher knows of one target at this time. */
export interface TargetState {
  readonly name: string;
  readonly health: TargetHealth;
  /** This time is the wall time of the latest change of the health, or of the start. */
  readonly since: number;
  /** This result is the latest poll, or null before the first poll. */
  readonly last: ProbeResult | null;
  /** This time is the wall time of the latest poll, or null. */
  readonly lastAt: number | null;
  /** This count is the failed polls in sequence. */
  readonly failures: number;
}

export interface WatchOptions {
  /** This function gets each change of the health of a target. A throw in it does not stop the watcher. */
  readonly onChange: (change: TargetChange) => void;
  /** This function gives a number in [0, 1) for the jitter. The default is `Math.random`. */
  readonly random?: (() => number) | undefined;
  /** This function gets each transition of the poller and the latch of each target, with the name of the target. */
  readonly trace?: ((target: string, from: string, to: string, on: string) => void) | undefined;
}

/** A target watch is a running watcher. */
export interface TargetWatch {
  /** This method gives the state of each target, in the sequence of the spec. */
  states(): TargetState[];
  /** This method polls each target one time at once, outside its loop, and gives the states after the polls. */
  pollNow(): Promise<TargetState[]>;
  /** This method stops each loop. A stopped watcher gives no change. */
  stop(): void;
}

/** This verdict is the default: 3 failures in sequence make a target down, and 2 passes make it up. */
export const DEFAULT_VERDICT: TargetVerdict = { type: "debounce", failAfter: 3, recoverAfter: 2 };
const DEFAULT_JITTER = 0.1;

const ms = (amount: Quantity): number => valueIn(amount, "ms");
const isTimeAtLeast = (value: unknown, floor: number, strict: boolean): boolean => isTime(value) && (strict ? ms(value) > floor : ms(value) >= floor);
const whole = (value: number): boolean => Number.isInteger(value) && value >= 1;

/** This function gives the problems of a watch spec: each value that the watcher cannot use. */
export const watchProblems = (spec: WatchSpec): string[] => {
  const problems: string[] = [];
  if (spec.targets.length === 0) problems.push("the spec has no target");
  const names = new Set<string>();
  for (const target of spec.targets) {
    const of = `the target ${JSON.stringify(target.name)}`;
    if (target.name === "") problems.push("a target name is empty");
    if (names.has(target.name)) problems.push(`${of} is in the spec two times`);
    names.add(target.name);
    problems.push(...probeProblems(target.probe).map((problem) => `${of}: ${problem}`));
    if (!isTimeAtLeast(target.interval, 0, true)) problems.push(`${of}: the interval is not a time above zero`);
    if (!isTimeAtLeast(target.timeout, 0, true)) problems.push(`${of}: the timeout is not a time above zero`);
    else if (isTimeAtLeast(target.interval, 0, true) && ms(target.timeout) > ms(target.interval)) problems.push(`${of}: the timeout is above the interval`);
    const jitter = target.jitter ?? DEFAULT_JITTER;
    if (!(Number.isFinite(jitter) && jitter >= 0 && jitter < 1)) problems.push(`${of}: the jitter ${jitter} is not a fraction from 0 to below 1`);
    const verdict = target.verdict ?? DEFAULT_VERDICT;
    if (verdict.type === "debounce") {
      if (!whole(verdict.failAfter)) problems.push(`${of}: the verdict fails after ${verdict.failAfter} polls, not a whole number above zero`);
      if (!whole(verdict.recoverAfter)) problems.push(`${of}: the verdict recovers after ${verdict.recoverAfter} polls, not a whole number above zero`);
    } else if (verdict.type === "window") {
      if (!isTimeAtLeast(verdict.failAfter, 0, false)) problems.push(`${of}: the failAfter of the window is not a time of zero or more`);
      if (verdict.recoverAfter !== undefined && !isTimeAtLeast(verdict.recoverAfter, 0, false))
        problems.push(`${of}: the recoverAfter of the window is not a time of zero or more`);
    } else problems.push(`${of}: the verdict type ${JSON.stringify((verdict as { type: unknown }).type)} is not debounce or window`);
  }
  return problems;
};

const timingOf = (target: WatchTarget): Timing => {
  const verdict = target.verdict ?? DEFAULT_VERDICT;
  return verdict.type === "debounce"
    ? { type: "debounce", interval: target.interval, failAfter: verdict.failAfter, recoverAfter: verdict.recoverAfter }
    : { type: "window", failAfter: verdict.failAfter, recoverAfter: verdict.recoverAfter };
};

interface Unit {
  readonly target: WatchTarget;
  health: TargetHealth;
  since: number;
  last: ProbeResult | null;
  lastAt: number | null;
  failures: number;
  /** This text is the reason of the latest failed poll. */
  why: string | null;
}

/**
 * This function starts a watcher of targets: an outside prober. Each target has its own loop of polls, on the
 * clock of the ports, with a jitter. A verdict turns the polls into the health of the target: a debounce or a
 * window. A target is `unknown` at the start. Its first pass makes it up, and its verdict makes it down. Each change
 * goes to `onChange`, with the reason of the latest failed poll. The watcher throws at the start when the spec has a
 * problem.
 */
export const watchTargets = (spec: WatchSpec, ports: HostPorts, options: WatchOptions): TargetWatch => {
  const problems = watchProblems(spec);
  if (problems.length > 0) throw new Error(`the watch spec has problems: ${problems.join("; ")}`);
  const random = options.random ?? Math.random;
  let stopped = false;

  const emit = (unit: Unit, to: "up" | "down"): void => {
    if (unit.health === to) return;
    const change: TargetChange = { target: unit.target.name, from: unit.health, to, at: ports.wall(), why: to === "down" ? unit.why : null };
    unit.health = to;
    unit.since = change.at;
    if (stopped) return;
    try {
      options.onChange(change);
    } catch (error) {
      ports.logger?.log("warn", `the change handler of the watch failed: ${error instanceof Error ? error.message : String(error)}`, { target: change.target });
    }
  };

  const watched = spec.targets.map((target): { readonly unit: Unit; readonly gate: Latch; readonly loop: Poller } => {
    const unit: Unit = { target, health: "unknown", since: ports.wall(), last: null, lastAt: null, failures: 0, why: null };
    const trace: Trace | undefined = options.trace === undefined ? undefined : (from, to, on) => options.trace?.(target.name, from, to, on);
    const timeout = ms(target.timeout);
    // the result of the latest probe: a poller result tells only the outcome
    let probed: ProbeResult | null = null;
    const gate: Latch = latch(timingOf(target), ports.clock, false, () => emit(unit, gate.tripped ? "down" : "up"), trace);
    const record = (result: Result): void => {
      const own = probed;
      probed = null;
      // a timeout or a pending call has the cause of the poller: the probe gave no result for this poll
      const seen: ProbeResult =
        result.outcome === "ok" ? { ok: true } : { ok: false, why: !result.timedOut && own !== null && !own.ok ? own.why : (result.cause ?? "the poll failed") };
      unit.last = seen;
      unit.lastAt = ports.wall();
      unit.failures = seen.ok ? 0 : unit.failures + 1;
      if (!seen.ok) unit.why = seen.why;
      gate.record(result);
      if (seen.ok && unit.health === "unknown" && !gate.tripped) emit(unit, "up");
    };
    const loop = poller({
      name: target.name,
      poll: { interval: target.interval, jitter: target.jitter ?? DEFAULT_JITTER, timeout: target.timeout },
      run: async () => {
        const result = await probeOnce(target.probe, timeout, ports);
        probed = result;
        return result.ok ? "ok" : "error";
      },
      clock: ports.clock,
      random,
      forced: () => false,
      record,
      trace,
    });
    return { unit, gate, loop };
  });

  const states = (): TargetState[] =>
    watched.map(({ unit }) => ({ name: unit.target.name, health: unit.health, since: unit.since, last: unit.last, lastAt: unit.lastAt, failures: unit.failures }));

  for (const { loop } of watched) loop.start(0);

  return {
    states,
    async pollNow() {
      await Promise.all(watched.map(({ loop }) => loop.pollNow()));
      return states();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const { gate, loop } of watched) {
        loop.stop();
        gate.stop();
      }
    },
  };
};
