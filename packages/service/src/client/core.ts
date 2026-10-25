// The parts of a client wrapper that do not change from one client to the next. A client entry
// (`./pg`, and later each other client of S1) fills them in with its driver. The core gives the
// outcome of a call in three values, the rule that sends a call again, the checks of the steps of
// a connection, and the problems of a client in a description. It loads only quantity.

import type { Extent, Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { Clock } from "../clock.ts";
import type { Check, Gate, ServiceDescription, Step } from "../description.ts";
import type { Outcome } from "../latch.ts";
import type { Operation } from "../operation.ts";
import { mayReissue } from "../operation.ts";
import type { CheckFn } from "../poller.ts";
import type { Poll } from "../timing.ts";

/**
 * A sent result is the outcome of a call, in three values (C8):
 * - `ok`: the server answered.
 * - `error`: the call did not apply. The server answered with an error (`reply`), or the call did
 *   not leave the client.
 * - `indeterminate`: the call can have reached the server, and nothing tells if it applied.
 */
export type Sent<T> =
  | { readonly outcome: "ok"; readonly value: T; readonly attempts: number }
  | { readonly outcome: "error"; readonly error: string; readonly reply: boolean; readonly attempts: number }
  | { readonly outcome: "indeterminate"; readonly error: string; readonly attempts: number };

/** This type is the outcome of one try of a call, before the core counts the tries. */
export type Attempt<T = unknown> =
  | { readonly outcome: "ok"; readonly value: T }
  | { readonly outcome: "error"; readonly error: string; readonly reply: boolean }
  | { readonly outcome: "indeterminate"; readonly error: string };

/** Send options tell how the client sends one call. */
export interface SendOptions {
  /** This signal abandons the call. A call that left the client is then indeterminate. */
  readonly signal?: AbortSignal | undefined;
  /** False stops the client: it does not send the call again. A check that must fail at once uses it. */
  readonly reissue?: boolean | undefined;
}

/** A dial function opens a new connection to the server, and reads one reply of the protocol. The `dial` check uses it. */
export type DialFn = (host: string, port: number, signal: AbortSignal) => Promise<void>;

/** The steps of a connection that each client gives a check for (B14). A client can add more steps. */
export type ClientStep = Extract<Step, "dial" | "round-trip" | "local-state">;

/** Check options tell which checks the client gives the health runtime, and which policy each one controls. */
export interface CheckOptions<S extends Step = ClientStep> {
  readonly poll: Poll;
  /** For each step, the policy that its check controls, or null for a check that only reports. A step that is absent has no check. */
  readonly steps: Partial<Record<S, Gate | null>>;
}

/** A step check is the function of one step, and if it uses the connection of the application. */
export interface StepCheck {
  readonly ownConnection: boolean;
  readonly run: CheckFn;
}

/** This function gives an amount in milliseconds. "infinite" is `Infinity`. */
export const ms = (amount: Extent): number =>
  amount.value === "infinite" ? Number.POSITIVE_INFINITY : valueIn(amount as Quantity, "ms");

/** This function gives the text of an error. */
export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** These are the parts of one call that the core uses to send it, and to send it again. */
export interface Reissue<T> {
  readonly clock: Clock;
  /** This time bounds the call and its second try, in milliseconds from its start. */
  readonly bound: number;
  /** This operation is the declaration of the call, or undefined when the table does not name it. */
  readonly operation: Operation | undefined;
  readonly options: SendOptions;
  /** This function makes one try. Its signal ends the try. */
  readonly attempt: (signal: AbortSignal | undefined) => Promise<Attempt<T>>;
  /** This function operates before the second try, with the time that is left. False stops the second try. */
  readonly beforeAgain?: ((left: number, signal: AbortSignal | undefined) => Promise<boolean>) | undefined;
  /** This function receives the start of a second try, for the record of the client. */
  readonly onReissue: () => void;
}

/**
 * This function sends a call, and gives its outcome in three values. It sends again only an
 * idempotent operation, one time at most, after an outcome that is not certain. A reply of the
 * server is certain. The second try ends at the bound of the call, not one bound after its own start.
 */
export const sendWithReissue = async <T>(call: Reissue<T>): Promise<Sent<T>> => {
  const { clock, bound } = call;
  const { signal } = call.options;
  const operation = call.options.reissue === false ? undefined : call.operation;
  const started = clock.now();
  const first = await call.attempt(signal);
  if (first.outcome === "ok") return { outcome: "ok", value: first.value, attempts: 1 };
  const again =
    !(first.outcome === "error" && first.reply) &&
    operation !== undefined &&
    signal?.aborted !== true &&
    mayReissue(operation, quantity((clock.now() - started) / 1000, "s"));
  const left = bound - (clock.now() - started);
  if (!again || left <= 0) return { ...first, attempts: 1 };
  if (call.beforeAgain !== undefined && !(await call.beforeAgain(left, signal))) return { ...first, attempts: 1 };
  call.onReissue();
  const end = new AbortController();
  const stop = clock.after(Math.max(0, bound - (clock.now() - started)), () => end.abort());
  const forward = (): void => end.abort();
  signal?.addEventListener("abort", forward, { once: true });
  const second = await call.attempt(end.signal);
  stop();
  signal?.removeEventListener("abort", forward);
  return second.outcome === "ok" ? { outcome: "ok", value: second.value, attempts: 2 } : { ...second, attempts: 2 };
};

/**
 * This function gives the checks of a client, for `svc.check(check, run)`. It gives a check only for
 * each step that the options name, and only when the client has a function for that step.
 */
export const stepChecks = <S extends Step>(
  name: string,
  options: CheckOptions<S>,
  runs: Readonly<Partial<Record<S, StepCheck>>>,
): ReadonlyArray<readonly [Check, CheckFn]> => {
  const made: Array<readonly [Check, CheckFn]> = [];
  for (const [step, run] of Object.entries(runs) as Array<[S, StepCheck | undefined]>) {
    if (run === undefined || !(step in options.steps)) continue;
    made.push([
      { name: `${name}.${step}`, dependency: name, step, ownConnection: run.ownConnection, gates: options.steps[step] ?? null, poll: options.poll },
      run.run,
    ]);
  }
  return made;
};

/** This function makes a check outcome from a sent result: only `ok` passes. */
export const passes = (sent: Sent<unknown>): Outcome => (sent.outcome === "ok" ? "ok" : "error");

/** These are the bounds of a client that the core examines in a description. */
export interface ClientBounds {
  /** This time bounds the close of the client, in milliseconds. */
  readonly close: number;
  /** This time bounds a call on the connection of the application, in milliseconds. */
  readonly request: number;
}

/**
 * This function gives the problems of a client in a description:
 * - The client needs the phase "tear down dependencies", and its close must fit in the cap of that phase.
 * - A round-trip check must end in one jittered poll (B7, O13).
 */
export const clientProblems = (name: string, description: ServiceDescription, bounds: ClientBounds): string[] => {
  const found: string[] = [];
  const teardown = description.shutdown.phases.find((phase) => phase.name === "tear down dependencies");
  if (teardown === undefined) found.push(`${name} needs the phase "tear down dependencies" to close`);
  else if (bounds.close >= valueIn(teardown.cap, "ms"))
    found.push(`${name}'s close_bound of ${bounds.close} ms does not fit in the cap of "tear down dependencies"`);
  for (const check of description.checks) {
    if (check.dependency !== name || check.step !== "round-trip") continue;
    const slowest = valueIn(check.poll.timeout, "ms") + valueIn(check.poll.interval, "ms") * (1 + check.poll.jitter);
    if (bounds.request > slowest) found.push(`${name}'s request_timeout outlives one jittered poll of ${check.name} (B7, O13)`);
  }
  return found;
};
