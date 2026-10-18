// The units of work of a worker loop and of a queue drain: the count of the units in flight, the
// drain to a deadline with the cooperative abort, the sleeps on the clock, the bound of each unit,
// and the request tracking of the service for each unit.

import { valueIn } from "@mark1russell7/quantity";
import type { Backoff } from "./backoff.ts";
import { backoffProblems } from "./backoff.ts";
import type { Cancel, Clock } from "./clock.ts";
import type { ServiceDescription } from "./description.ts";
import type { KnobRecord } from "./knobs.ts";
import { boundedMillisecondsOf } from "./knobs.ts";
import type { Lifecycle } from "./lifecycle.ts";
import type { RequestEnd } from "./requests.ts";

/**
 * A unit request names the route of each unit of work in the request tracking of the service. Then
 * the service admits, counts, drains and cuts each unit as it does each request (`life.request`).
 * The controller declares the route, thus its idempotency tells if a cut unit can go again.
 */
export interface UnitRequest<U> {
  /** This name is the controller that declares the route. */
  readonly controller: string;
  /** This name is the route of each unit, or a function that gives it from the unit. A route can match a route pattern. */
  readonly route: string | ((unit: U) => string);
  /** This function gives the detail of a unit, for the function of a route pattern. */
  readonly detail?: ((unit: U) => unknown) | undefined;
}

/**
 * A unit end tells how one unit of work ended:
 * - `done`: the work gave its value.
 * - `failed`: the work threw for a cause of its own, or after its bound aborted it.
 * - `refused`: the service did not admit the unit, thus the work did not start.
 * - `cut`: the shutdown stopped the unit. It is not a failure. `retryable` tells if the unit can go again.
 */
export type UnitEnd =
  | { readonly kind: "done"; readonly value: unknown }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "refused"; readonly cause: string }
  | { readonly kind: "cut"; readonly cause: string; readonly retryable: boolean };

/** This function gives the cause of an abort as text. */
export const causeOf = (signal: AbortSignal): string =>
  signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "the unit got an abort");

/** These are the parts of one unit of work. */
export interface UnitRun<U> {
  readonly clock: Clock;
  /** This time is the bound of the unit, in milliseconds, or infinity. At it, the signal of the work aborts. */
  readonly bound: number;
  /** This controller is the abort of the transport for the unit: the cooperative abort and the close. */
  readonly abort: AbortController;
  readonly life: Lifecycle;
  readonly request: UnitRequest<U> | undefined;
  readonly unit: U;
  /** This function starts the work, and gives its value or a promise. */
  readonly work: (signal: AbortSignal) => unknown;
}

/**
 * This function does one unit of work, and gives its end. With a request, the unit goes through
 * `life.request`, thus the service counts it, drains it and can cut it. A throw after the abort of
 * the transport is a cut, not a failure (S6 A10). A throw after the bound is a failure.
 */
export const runUnit = async <U>(run: UnitRun<U>): Promise<UnitEnd> => {
  const { clock, bound, abort, life, request, unit, work } = run;
  const timeout = new AbortController();
  const cancel: Cancel = Number.isFinite(bound)
    ? clock.after(bound, () => timeout.abort(new Error(`the unit did not end in its unit_processing_time of ${bound} ms`)))
    : () => {};
  const call = async (tracker?: AbortSignal): Promise<unknown> =>
    work(AbortSignal.any(tracker === undefined ? [abort.signal, timeout.signal] : [abort.signal, timeout.signal, tracker]));
  // the transport cannot read the idempotency of the route, thus a cut of its own does not go again
  const thrown = (error: unknown): UnitEnd => {
    if (abort.signal.aborted) return { kind: "cut", cause: causeOf(abort.signal), retryable: false };
    if (timeout.signal.aborted) return { kind: "failed", error: timeout.signal.reason };
    return { kind: "failed", error };
  };
  try {
    if (request === undefined) {
      try {
        return { kind: "done", value: await call() };
      } catch (error) {
        return thrown(error);
      }
    }
    let collected: Promise<{ readonly items: readonly unknown[]; readonly end: RequestEnd }>;
    try {
      const route = typeof request.route === "string" ? request.route : request.route(unit);
      const detail = request.detail?.(unit);
      // the value goes in a box: a work that gives an async iterable is one value here, not a stream
      const stream = life.request(request.controller, route, (signal) => call(signal).then((value) => ({ value })), detail === undefined ? {} : { detail });
      collected = stream.collect();
    } catch (error) {
      // an undeclared route, or a lifecycle with no service
      return { kind: "failed", error };
    }
    const { items, end } = await collected;
    if (end.kind === "done") return { kind: "done", value: (items[0] as { readonly value: unknown } | undefined)?.value };
    if (end.kind === "failed") return thrown(end.error);
    if (end.kind === "refused") return { kind: "refused", cause: end.cause };
    return { kind: "cut", cause: end.cause, retryable: end.retryable };
  } finally {
    cancel();
  }
};

/** A flight set counts the units in flight, from their events, and drains them to a deadline. */
export interface Flights {
  /** This count is the number of units in flight. */
  readonly size: number;
  /** This method adds a unit, and gives the function that removes it. A unit after the cooperative abort gets the abort at once. */
  add(unit: AbortController): () => void;
  /** This method aborts each unit in flight and each later unit: the cooperative abort, or the close. */
  abort(reason: unknown): void;
  /** This method removes each unit from the count: the close cuts them. */
  clear(): void;
  /** This method waits until no unit is in flight, or until the deadline. The signal is the cooperative abort. It does not throw. */
  drain(deadline: number, signal: AbortSignal): Promise<void>;
  /** This method gives a promise that ends when the count goes down, or at `release()`. */
  less(): Promise<void>;
  /** This method ends each promise of `less()`. */
  release(): void;
}

/** This function makes a flight set on a clock. */
export const flights = (clock: Clock): Flights => {
  const units = new Set<AbortController>();
  const idle = new Set<() => void>();
  const lower = new Set<() => void>();
  let aborted: { readonly reason: unknown } | null = null;
  const settle = (): void => {
    for (const done of [...lower]) done();
    lower.clear();
    if (units.size === 0) for (const done of [...idle]) done();
  };
  const abort = (reason: unknown): void => {
    aborted ??= { reason };
    for (const unit of [...units]) if (!unit.signal.aborted) unit.abort(aborted.reason);
  };
  return {
    get size() {
      return units.size;
    },
    add(unit) {
      units.add(unit);
      if (aborted !== null && !unit.signal.aborted) unit.abort(aborted.reason);
      return () => {
        if (units.delete(unit)) settle();
      };
    },
    abort,
    clear() {
      units.clear();
      settle();
    },
    drain(deadline, signal) {
      const cooperative = (): void => abort(signal.reason);
      if (signal.aborted) cooperative();
      else signal.addEventListener("abort", cooperative, { once: true });
      // nothing in flight, or a deadline that passed: the drain ends at once, with no timer
      if (units.size === 0 || deadline <= clock.now()) {
        signal.removeEventListener("abort", cooperative);
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        let cancel: Cancel = () => {};
        const done = (): void => {
          idle.delete(done);
          cancel();
          signal.removeEventListener("abort", cooperative);
          resolve();
        };
        idle.add(done);
        cancel = clock.after(Math.max(0, deadline - clock.now()), done);
      });
    },
    less() {
      return new Promise<void>((resolve) => lower.add(resolve));
    },
    release() {
      for (const done of [...lower]) done();
      lower.clear();
    },
  };
};

/**
 * A sleeper gives the waits of a loop on the clock. `wake()` ends each wait that it can end, and
 * `stop()` ends each wait. A wait without a bound uses no timer.
 */
export interface Sleeper {
  /** This count goes up at each `wake()`. A loop reads it before a unit, and a wake during the unit then ends the next sleep at once. */
  readonly wakes: number;
  /** This method waits on the clock. A wake after `since` ends it, and with `since` past, it ends at once. */
  sleep(ms: number, since: number): Promise<void>;
  /** This method waits on the clock. A wake does not end it: it is a backoff after a failure. */
  backoff(ms: number): Promise<void>;
  /** This method ends each sleep, and gives the count of sleeps that it ended. */
  wake(): number;
  /** This method ends each wait, the backoffs too. Each later wait then ends at once. */
  stop(): void;
}

/** This function makes a sleeper on a clock. */
export const sleeper = (clock: Clock): Sleeper => {
  let wakes = 0;
  let stopped = false;
  const sleeps = new Set<() => void>();
  const backoffs = new Set<() => void>();
  const wait = (ms: number, into: Set<() => void>): Promise<void> =>
    stopped
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          let cancel: Cancel = () => {};
          const done = (): void => {
            if (!into.delete(done)) return;
            cancel();
            resolve();
          };
          into.add(done);
          if (Number.isFinite(ms)) cancel = clock.after(ms, done);
        });
  return {
    get wakes() {
      return wakes;
    },
    sleep(ms, since) {
      if (since !== wakes) return Promise.resolve();
      return wait(ms, sleeps);
    },
    backoff(ms) {
      return wait(ms, backoffs);
    },
    wake() {
      wakes += 1;
      const ended = sleeps.size;
      for (const done of [...sleeps]) done();
      return ended;
    },
    stop() {
      stopped = true;
      for (const done of [...sleeps, ...backoffs]) done();
    },
  };
};

/** A settled wait tells how a work ended in its bound: it ended, it threw, or the bound came first. */
export type Settled = { readonly kind: "done" } | { readonly kind: "failed"; readonly error: unknown } | { readonly kind: "bound" };

/** This function waits for a work until a bound on the clock, in milliseconds. */
export const settleWithin = (clock: Clock, ms: number, work: Promise<unknown>): Promise<Settled> =>
  new Promise<Settled>((resolve) => {
    const cancel: Cancel = Number.isFinite(ms) ? clock.after(ms, () => resolve({ kind: "bound" })) : () => {};
    work.then(
      () => {
        cancel();
        resolve({ kind: "done" });
      },
      (error: unknown) => {
        cancel();
        resolve({ kind: "failed", error });
      },
    );
  });

/**
 * This function gives the backoff of the knobs of a loop. The first delay is `retry_base`, and each
 * delay is two times longer, up to `retry_cap`. Each delay has a jitter up to the base, as in the Redis client.
 */
export const retryOf = (knobs: KnobRecord, owner: string): Backoff => {
  const base = boundedMillisecondsOf(knobs, "retry_base", owner);
  const cap = boundedMillisecondsOf(knobs, "retry_cap", owner);
  const backoff: Backoff = { base, factor: 2, cap, jitter: { kind: "add", amount: base } };
  const problems = backoffProblems(backoff);
  if (problems.length > 0) throw new Error(`${owner}: the retry_base and retry_cap give no backoff: ${problems.join(", ")}`);
  return backoff;
};

/**
 * This function gives the problems of the bounds of a loop in a declaration. The close bound fits
 * in the cap of `close transports`. The bound of a unit fits in the cap of `drain`, or the drain can cut a unit (S6 A10).
 */
export const boundProblems = (owner: string, closeBound: number, unitBound: number, description: ServiceDescription): string[] => {
  const capOf = (name: string): number | undefined => {
    const phase = description.shutdown.phases.find((each) => each.name === name);
    return phase === undefined ? undefined : valueIn(phase.cap, "ms");
  };
  const found: string[] = [];
  const close = capOf("close transports");
  if (close === undefined) found.push(`${owner} needs the phase "close transports" to close`);
  else if (closeBound >= close)
    found.push(`the close_bound of ${owner}, ${closeBound} ms, does not fit in the cap of "close transports", ${close} ms`);
  const drain = capOf("drain");
  if (drain === undefined) found.push(`${owner} needs the phase "drain" to end its units`);
  else if (!Number.isFinite(unitBound))
    found.push(`the unit_processing_time of ${owner} has no bound, thus the drain can cut a unit at its cap of ${drain} ms`);
  else if (unitBound >= drain)
    found.push(`the unit_processing_time of ${owner}, ${unitBound} ms, does not fit in the cap of "drain", ${drain} ms`);
  return found;
};
