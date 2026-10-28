// The parts of a client wrapper that do not change from one client to the next. Each client entry
// (`./redis`, `./pg`, `./http-client`, `./websocket`, and each later client of S1) fills them in with its driver. The core gives
// the shapes of a client, the outcome of a call in three values, the rule that sends a call again,
// the record of the calls in flight, the bounded close, the checks of the steps of a connection,
// and the problems of a spec and of a client in a description. It loads only quantity.
// The section "Unified or separate" of docs/S6.md gives each part, and the reason for each part that stays in a driver.

import type { Extent, Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { Backoff } from "../backoff.ts";
import { retrierOn } from "../retrier.ts";
import type { ServiceBuilder } from "../builder.ts";
import type { Cancel, Clock } from "../clock.ts";
import type { Check, Dependency, Gate, ServiceDescription, Step } from "../description.ts";
import type { Recorder } from "../events.ts";
import type { Outcome } from "../latch.ts";
import type { DependencyHandle } from "../lifecycle.ts";
import type { Operation } from "../operation.ts";
import { mayReissue } from "../operation.ts";
import type { CheckFn } from "../poller.ts";
import type { Poll } from "../timing.ts";
import type { Meeting } from "./meets.ts";

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
  /**
   * With a catalog, the client gives a check for each step that it has (B19). The steps of `steps` are
   * the nominated checks. Each other step reports only, and polls at the catalog poll. `true` is a poll
   * of 30 s with the jitter and the timeout of `poll`. A nominated step that the client has no check
   * for then fails the attach. Without a catalog, the client gives only the steps of `steps`.
   */
  readonly catalog?: true | Poll | undefined;
}

/** This interval is the poll of a catalog check that gates nothing (B19). */
export const CATALOG_INTERVAL: Quantity = quantity(30, "s");

/** A step check is the function of one step, and if it uses the connection of the application. */
export interface StepCheck {
  readonly ownConnection: boolean;
  readonly run: CheckFn;
}

/** This function gives an amount in milliseconds. "infinite" is `Infinity`. */
export const ms = (amount: Extent): number =>
  amount.value === "infinite" ? Number.POSITIVE_INFINITY : valueIn(amount as Quantity, "ms");

/** This function gives an amount in milliseconds, or undefined for "infinite". Each driver then writes its own form of "no timer". */
export const finiteMs = (amount: Extent): number | undefined => {
  const value = ms(amount);
  return Number.isFinite(value) ? value : undefined;
};

/** This function gives the text of an error. */
export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * These are the knobs that each client has, by the names of the ordering law. Each driver adds its
 * own knobs. The comments of each driver tell which option of the driver a knob sets.
 */
export interface ClientKnobs {
  /** This time bounds a new connection. */
  readonly connect_bound: Quantity;
  /** This time bounds each call on the connection of the application. */
  readonly request_timeout: Quantity;
  /** This time is the idle time of TCP keepalive. Node then sends 10 probes 1 s apart. */
  readonly keepalive_idle: Extent;
  /** This time is the age at which the client replaces a connection. */
  readonly max_connection_age: Extent;
  /** This time bounds the close of the client at the shutdown. */
  readonly close_bound: Quantity;
  /**
   * This time is when the kernel gives up a segment that it retransmits. Node cannot set it, thus
   * the declaration states it for the ordering law (O17), from the platform.
   */
  readonly retrans_giveup_time: Extent;
}

/** A client spec is the declaration of one client: where it connects, and its knobs. Each driver adds its own fields. */
export interface ClientSpec<K extends ClientKnobs = ClientKnobs> {
  readonly host: string;
  readonly port: number;
  readonly password?: string | undefined;
  /** This identifier is the component in the corpus, for example `systems.component.redis`, or null. */
  readonly system: string | null;
  readonly knobs: K;
  /** These operations add to the table of the client, or change it. */
  readonly operations?: Readonly<Record<string, Operation>> | undefined;
}

/** A factory makes the connection or the pool of a client from the options of its driver. */
export type Factory<O, C> = (options: O) => C | Promise<C>;

/** These options make a client. Without them, a client uses its driver, the real clock, and the dial of its protocol. */
export interface ClientOptions<F> {
  readonly create?: F | undefined;
  readonly clock?: Clock | undefined;
  /** This function receives each transition of the client, for the prober (D3). */
  readonly record?: Recorder | undefined;
  readonly dial?: DialFn | undefined;
}

/** A client socket is the part of the socket of a connection that the join of the prober and the bounded close read. */
export interface ClientSocket {
  readonly localAddress?: string | undefined;
  readonly localPort?: number | undefined;
  readonly remoteAddress?: string | undefined;
  readonly remotePort?: number | undefined;
  /** This method closes the socket at once. A close of the driver only half-closes it, and a silent peer does not answer that. */
  destroy?(): void;
}

/**
 * A client join is one connection, at the time when it can serve (D1, D2). The prober joins its
 * kernel records to the server's view of the connection through it. Each driver adds the server's id of the connection.
 */
export interface ClientJoin {
  readonly generation: number;
  /** This time is when the connection became ready, in milliseconds on the monotonic clock. */
  readonly at: number;
  readonly localAddress: string | null;
  readonly localPort: number | null;
  readonly remoteAddress: string | null;
  readonly remotePort: number | null;
}

/** This function gives the addresses and the ports of a socket for a join. Each one is null when the socket does not give it. */
export const socketEnds = (
  socket: ClientSocket | undefined,
): Pick<ClientJoin, "localAddress" | "localPort" | "remoteAddress" | "remotePort"> => ({
  localAddress: socket?.localAddress ?? null,
  localPort: socket?.localPort ?? null,
  remoteAddress: socket?.remoteAddress ?? null,
  remotePort: socket?.remotePort ?? null,
});

/** A client is a dependency of a service: its declaration, its handle and its checks. Each driver adds the method that sends a call. */
export interface Client<S extends Step = ClientStep, J extends ClientJoin = ClientJoin> {
  readonly name: string;
  /** This declaration goes to `svc.dependency(name, declaration, handle)`. */
  readonly declaration: Omit<Dependency, "name">;
  readonly handle: DependencyHandle;
  /** These are the manifestations that the client can meet, and the detectors of each (E9). */
  readonly meets: readonly Meeting[];
  /** This text is the state of the client, as the machine document of the client names it. */
  readonly status: string;
  /** These are the connections of the client, the latest last. */
  readonly joins: readonly J[];
  /** This method gives the checks of the client and their functions, for `svc.check(check, run)`. */
  checks(options: CheckOptions<S>): ReadonlyArray<readonly [Check, CheckFn]>;
  /** This method declares the client in a service: its dependency, its handle and its checks. */
  attach(svc: ServiceBuilder, options: CheckOptions<S>): ServiceBuilder;
  /** This method gives the problems of the client in a description: a close that does not fit in its phase, for example. */
  problems(description: ServiceDescription): string[];
}

/** This function declares a client in a service: its dependency, its handle, and each of its checks. */
export const attachClient = (
  svc: ServiceBuilder,
  name: string,
  declaration: Omit<Dependency, "name">,
  handle: DependencyHandle,
  checks: ReadonlyArray<readonly [Check, CheckFn]>,
): ServiceBuilder => {
  svc.dependency(name, declaration, handle);
  for (const [check, run] of checks) svc.check(check, run);
  return svc;
};

/** This function gives the table of operations of a client: the defaults of its driver, then the operations of its spec. */
export const operationTable = (
  defaults: Readonly<Record<string, Operation>>,
  more: Readonly<Record<string, Operation>> | undefined,
): Readonly<Record<string, Operation>> => ({ ...defaults, ...more });

/** A client recorder gives one transition of a client to the recorder of the options, for the prober (D3). */
export type ClientRecorder = (from: string, to: string, on: string, detail?: string) => void;

/** This function makes the recorder of a client. Each event has the machine "client", and the name of the client as its instance. */
export const clientRecorder =
  (record: Recorder | undefined, clock: Clock, name: string): ClientRecorder =>
  (from, to, on, detail) =>
    record?.({ at: clock.now(), machine: "client", instance: name, from, to, on, ...(detail === undefined ? {} : { detail }) });

/** This function gives the outcome of a call that did not leave the client. It is certain: the call did not apply. */
export const notSent = (error: string): Attempt<never> => ({ outcome: "error", error, reply: false });

/** A settle function gives the outcome of a call in flight. A driver can give a cause, for example the error that ends a client of a pool. */
export type Settle<T = unknown> = (value: Attempt<T>, cause?: Error) => void;

/**
 * This record holds the calls in flight of a client. Each call settles one time. A call that the
 * caller abandons after it left the client is indeterminate, because a sent call cannot be
 * cancelled (principle 9). The close and a closed connection settle each call that stays (C10).
 */
export interface InFlight {
  /** This number is the count of the calls in flight. */
  readonly size: number;
  /**
   * This method sends one call, and records it until it settles. `start` sends the call, and gives
   * its outcome to `settle`. `after` operates one time, after the call settles and before its promise resolves.
   */
  track<T>(
    signal: AbortSignal | undefined,
    abandoned: string,
    start: (settle: Settle<T>) => void,
    after?: (value: Attempt<T>, cause: Error | undefined) => void,
  ): Promise<Attempt<T>>;
  /** This method settles each call in flight as indeterminate, with this error. */
  settleAll(error: string): void;
  /** This method resolves when no call is in flight. A close that waits for its calls uses it in its bound. */
  idle(): Promise<void>;
}

/** This function makes the record of the calls in flight of a client. */
export const inFlight = (): InFlight => {
  const closes = new Set<(error: string) => void>();
  const waiters = new Set<() => void>();
  const wake = (): void => {
    if (closes.size > 0) return;
    for (const waiter of [...waiters]) waiter();
    waiters.clear();
  };
  return {
    get size() {
      return closes.size;
    },
    idle: () =>
      new Promise<void>((resolve) => {
        if (closes.size === 0) resolve();
        else waiters.add(resolve);
      }),
    track<T>(
      signal: AbortSignal | undefined,
      abandoned: string,
      start: (settle: Settle<T>) => void,
      after?: (value: Attempt<T>, cause: Error | undefined) => void,
    ): Promise<Attempt<T>> {
      return new Promise<Attempt<T>>((resolve) => {
        let settled = false;
        const settle: Settle<T> = (value, cause) => {
          if (settled) return;
          settled = true;
          closes.delete(close);
          signal?.removeEventListener("abort", aborted);
          after?.(value, cause);
          resolve(value);
          wake();
        };
        const close = (error: string): void => settle({ outcome: "indeterminate", error }, new Error(error));
        const aborted = (): void => close(abandoned);
        closes.add(close);
        signal?.addEventListener("abort", aborted, { once: true });
        start(settle);
      });
    },
    settleAll(error) {
      for (const close of [...closes]) close(error);
    },
  };
};

/**
 * This function sends one call through the record of the calls in flight, with a timer of the
 * wrapper. A driver with no timer for its call uses it: amqplib, and the agent of Node. At `bound`
 * milliseconds the call is indeterminate with the error `timedOut`, because it left the client.
 * The timer stops when the call settles, before `after` operates.
 */
export const trackWithTimer = <T>(
  flight: InFlight,
  clock: Clock,
  bound: number,
  signal: AbortSignal | undefined,
  abandoned: string,
  timedOut: string,
  start: (settle: Settle<T>) => void,
  after?: (value: Attempt<T>, cause: Error | undefined) => void,
): Promise<Attempt<T>> => {
  let stop: Cancel = () => {};
  return flight.track<T>(
    signal,
    abandoned,
    (settle) => {
      stop = clock.after(bound, () => settle({ outcome: "indeterminate", error: timedOut }));
      start(settle);
    },
    (value, cause) => {
      stop();
      after?.(value, cause);
    },
  );
};

/**
 * This function waits for the work of a close, for `bound` milliseconds at most. It gives true when
 * the work ended in its bound, with a success or a failure. It gives false at the bound. The driver
 * then destroys each socket that stays, because a silent server does not close its half.
 */
export const withinBound = (clock: Clock, bound: number, work: Promise<unknown>): Promise<boolean> => {
  const done = work.then(
    () => true,
    () => true,
  );
  let cancel: Cancel = () => {};
  const timer = new Promise<boolean>((resolve) => {
    cancel = clock.after(bound, () => resolve(false));
  });
  return Promise.race([done, timer]).then((ended) => {
    cancel();
    return ended;
  });
};

/**
 * A ready wait holds the calls that wait for a ready connection before their second try. A client
 * that connects again by itself uses it: Redis and RabbitMQ.
 */
export interface ReadyWait {
  /** This method waits until the client is ready, for `within` milliseconds at most. It gives true when the client is ready. */
  wait(within: number, signal?: AbortSignal): Promise<boolean>;
  /** This method ends each wait with true. The client uses it when its connection is ready. */
  wake(): void;
}

/** This function makes the ready wait of a client. The function `ready` tells if the client is ready. */
export const readyWait = (clock: Clock, ready: () => boolean): ReadyWait => {
  const waiters = new Set<() => void>();
  return {
    wait: (within, signal) =>
      new Promise((resolve) => {
        if (ready()) {
          resolve(true);
          return;
        }
        let cancel: Cancel = () => {};
        const done = (value: boolean): void => {
          waiters.delete(wake);
          cancel();
          signal?.removeEventListener("abort", aborted);
          resolve(value);
        };
        const wake = (): void => done(true);
        const aborted = (): void => done(false);
        waiters.add(wake);
        cancel = clock.after(within, () => done(ready()));
        signal?.addEventListener("abort", aborted, { once: true });
      }),
    wake() {
      for (const wake of [...waiters]) wake();
    },
  };
};

/** These are the knobs of a client that connects again by itself, after a delay that doubles. */
export interface RetryKnobs {
  /** This time is the first delay before a new try to connect. The delay doubles after each try. */
  readonly retry_base: Quantity;
  /** This time is the most that one delay can be, before its jitter. */
  readonly retry_cap: Quantity;
}

/**
 * This function gives the backoff of the tries to connect: from `retry_base`, doubling to
 * `retry_cap`, each with a jitter up to the base. The client rounds each delay to a whole millisecond.
 */
export const retryBackoff = (knobs: RetryKnobs): Backoff => ({
  base: ms(knobs.retry_base),
  factor: 2,
  cap: ms(knobs.retry_cap),
  jitter: { kind: "add", amount: ms(knobs.retry_base) },
});

/**
 * A retry schedule holds the next try to connect, for a client that connects again by itself. It
 * counts the tries since the last join. Each delay comes from the backoff, rounded to a whole millisecond.
 */
export interface RetrySchedule {
  /** This count is the number of tries since the last reset. */
  readonly tries: number;
  /** This method counts one more try, and starts `due` after the delay of that try. It stops a try that waits. */
  schedule(due: () => void): void;
  /** This method stops the try that waits. The close uses it. */
  cancel(): void;
  /** This method sets the count of tries to zero. The client uses it at each join. */
  reset(): void;
}

/** This function makes the retry schedule of a client, from its backoff and its random numbers. RabbitMQ and WebSocket use it. */
export const retrySchedule = (clock: Clock, backoff: Backoff, random: () => number): RetrySchedule => {
  // the public retrier does the same work: the schedule only names its count `tries`
  const retry = retrierOn(clock, backoff, random);
  return {
    get tries() {
      return retry.attempts;
    },
    schedule(due) {
      retry.schedule(due);
    },
    cancel: () => retry.cancel(),
    reset: () => retry.reset(),
  };
};

/** This function gives the problems of the retry knobs: the cap must not be below the base. */
export const retryProblems = (name: string, knobs: RetryKnobs): string[] =>
  ms(knobs.retry_cap) < ms(knobs.retry_base) ? [`${name}'s retry_cap is below its retry_base`] : [];

/**
 * This function gives the problem of a count of misses that is not a whole number above zero. A
 * client that closes its connection after a count of heartbeat misses uses it. `mechanism` names the heartbeat, for example "watchdog".
 */
export const missesProblems = (name: string, misses: number, mechanism: string): string[] =>
  Number.isInteger(misses) && misses >= 1 ? [] : [`${name}'s ${mechanism} closes the connection after ${misses} misses, not a whole number above zero`];

/** This function gives the problems of the knobs of a spec that each client has: each knob must be a time of zero or more. */
export const timeProblems = (name: string, knobs: object): string[] => {
  const problems: string[] = [];
  for (const [knob, amount] of Object.entries(knobs) as Array<[string, Extent]>) {
    if (amount.value !== "infinite" && !(ms(amount) >= 0)) problems.push(`${name}'s ${knob} is not a time of zero or more`);
  }
  return problems;
};

/** This function writes a bound for a driver that reads 0 as no timer: "infinite" is 0. */
export const orZero = (amount: Extent): number => finiteMs(amount) ?? 0;

/** This function tells if an amount is a whole number of milliseconds. "infinite" is whole. */
export const wholeMs = (amount: Extent): boolean => amount.value === "infinite" || Number.isInteger(ms(amount));

/** This function tells if an amount is a whole number of seconds. "infinite" is whole. */
export const wholeSeconds = (amount: Extent): boolean =>
  amount.value === "infinite" || Number.isInteger(valueIn(amount as Quantity, "s"));

/** These are the knobs of a spec that `zeroProblems` and `wholeProblems` examine, by their kind. */
export interface KnobKinds {
  /** These knobs must be a finite time above zero, because the driver reads 0 as no bound. */
  readonly bounded?: readonly string[] | undefined;
  /** These knobs can be "infinite", which the driver writes as 0. Thus 0 itself is not a bound. */
  readonly open?: readonly string[] | undefined;
  /** These knobs go to the driver in whole milliseconds. */
  readonly millis?: readonly string[] | undefined;
  /** These knobs go to the driver or to Node in whole seconds. */
  readonly seconds?: readonly string[] | undefined;
}

const knobOf = (knobs: object, knob: string): Extent => (knobs as Record<string, Extent>)[knob]!;

/**
 * This function gives the problems of the knobs of a driver that reads 0 as no timer. pg and the
 * MongoDB driver read 0 so. A bounded knob must be a finite time above zero. An open knob can be
 * "infinite", and 0 is then a mistake.
 */
export const zeroProblems = (name: string, driver: string, knobs: object, kinds: KnobKinds): string[] => {
  const problems: string[] = [];
  for (const knob of kinds.bounded ?? []) {
    const value = ms(knobOf(knobs, knob));
    if (!(value > 0) || !Number.isFinite(value)) problems.push(`${name}'s ${knob} is not a finite time above zero: ${driver} reads 0 as no bound`);
  }
  for (const knob of kinds.open ?? []) {
    const amount = knobOf(knobs, knob);
    if (amount.value !== "infinite" && !(ms(amount) > 0)) problems.push(`${name}'s ${knob} is zero: give "infinite" for no bound`);
  }
  return problems;
};

/** This function gives the problems of the knobs that a driver takes in whole milliseconds or in whole seconds. */
export const wholeProblems = (name: string, knobs: object, kinds: KnobKinds): string[] => [
  ...(kinds.millis ?? []).filter((knob) => !wholeMs(knobOf(knobs, knob))).map((knob) => `${name}'s ${knob} is not a whole number of milliseconds`),
  ...(kinds.seconds ?? []).filter((knob) => !wholeSeconds(knobOf(knobs, knob))).map((knob) => `${name}'s ${knob} is not a whole number of seconds`),
];

/** This function gives the problems of the sizes of a pool: at most `max` connections, and `min` from 0 to `max`. */
export const poolProblems = (name: string, pool: { readonly max: number; readonly min: number }): string[] => {
  const problems: string[] = [];
  if (!Number.isInteger(pool.max) || pool.max < 1) problems.push(`${name}'s pool has a max of ${pool.max}, not a whole number above zero`);
  if (!Number.isInteger(pool.min) || pool.min < 0 || pool.min > pool.max)
    problems.push(`${name}'s pool has a min of ${pool.min}, not a whole number from 0 to its max`);
  return problems;
};

/**
 * This function gives the problem O07 of a client whose server has a deadline, or null. The client
 * must wait longer than the deadline of the server. Then the server ends a slow call with an error
 * first. Otherwise the client gives up first, and the server goes on with the call. `call` names
 * the call of the server, for example a statement.
 */
export const deadlineProblem = (name: string, request: Quantity, deadline: Extent, call: string): string | null =>
  deadline.value !== "infinite" && ms(request) <= ms(deadline)
    ? `${name}'s request_timeout is not above its statement_timeout: the server goes on with a ${call} that the client gave up (O07)`
    : null;

/**
 * This function gives the problem O01 of a client pool, or null. The pool must close an idle
 * connection before its server does. Otherwise a request can go on a connection that the server
 * closed. A server that keeps an idle connection with no bound gives no problem. `knob` names the
 * idle time of the client: `pool_idle_expiry` of a pool, or `client_idle_timeout` of a gRPC channel.
 */
export const idleCloseProblem = (name: string, expiry: Extent, close: Extent, knob = "pool_idle_expiry"): string | null =>
  close.value !== "infinite" && !(ms(expiry) < ms(close))
    ? `${name}'s ${knob} is not below the idle close of its server: a request can go on a connection that the server closed (O01)`
    : null;

/**
 * This function gives the problems of the timers that the wrapper has, because its driver has none.
 * Each one must be a finite time above zero. `bounds` gives what each knob bounds, for example "a call".
 */
export const wrapperTimerProblems = (name: string, knobs: object, bounds: Readonly<Record<string, string>>): string[] =>
  Object.entries(bounds)
    .filter(([knob]) => {
      const value = ms(knobOf(knobs, knob));
      return !(value > 0) || !Number.isFinite(value);
    })
    .map(([knob, what]) => `${name}'s ${knob} is not a finite time above zero: the timer of the wrapper is the only bound of ${what}`);

/** This function gives the problem of a finite connection age, for a client that does not replace a connection at an age. `reason` tells why. */
export const ageProblems = (name: string, knobs: Pick<ClientKnobs, "max_connection_age">, reason: string): string[] =>
  knobs.max_connection_age.value === "infinite" ? [] : [`${name}'s max_connection_age is not "infinite": ${reason}`];

/** This function gives the problem of a keepalive that is not a finite time above zero, for a driver that always turns keepalive on. */
export const keepaliveOnProblems = (name: string, knobs: Pick<ClientKnobs, "keepalive_idle">, driver: string): string[] => {
  const value = ms(knobs.keepalive_idle);
  return value > 0 && Number.isFinite(value) ? [] : [`${name}'s keepalive_idle is not a finite time above zero: ${driver} always turns keepalive on`];
};

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
 * This function gives the checks of a client, for `svc.check(check, run)`. Without a catalog, it gives
 * a check for each step that the options name, when the client has a function for that step. With a
 * catalog, it gives a check for each step of the client. It then throws for a nominated step that the
 * client does not have (B19). The name of each check is the pair of the component and the step, a
 * public contract.
 */
export const stepChecks = <S extends Step>(
  name: string,
  options: CheckOptions<S>,
  runs: Readonly<Partial<Record<S, StepCheck>>>,
): ReadonlyArray<readonly [Check, CheckFn]> => {
  const has = (Object.entries(runs) as Array<[S, StepCheck | undefined]>).filter(([, run]) => run !== undefined).map(([step]) => step);
  const catalog = options.catalog === true ? { ...options.poll, interval: CATALOG_INTERVAL } : options.catalog;
  if (catalog !== undefined) {
    const missing = Object.keys(options.steps).filter((step) => !has.includes(step as S));
    if (missing.length > 0) {
      throw new Error(`${name}: the nominated checks ${missing.join(", ")} are not in the catalog of the client (${has.join(", ")})`);
    }
  }
  const made: Array<readonly [Check, CheckFn]> = [];
  for (const step of has) {
    const run = runs[step] as StepCheck;
    const nominated = step in options.steps;
    if (!nominated && catalog === undefined) continue;
    made.push([
      {
        name: `${name}.${step}`,
        dependency: name,
        step,
        ownConnection: run.ownConnection,
        gates: nominated ? (options.steps[step] ?? null) : null,
        poll: nominated || catalog === undefined ? options.poll : catalog,
      },
      run.run,
    ]);
  }
  return made;
};

/** This function makes a check outcome from a sent result: only `ok` passes. */
export const passes = (sent: Sent<unknown>): Outcome => (sent.outcome === "ok" ? "ok" : "error");

/** This check gives the state of the client, without a round trip. */
export const localStateCheck = (ready: () => boolean): StepCheck => ({ ownConnection: true, run: () => (ready() ? "ok" : "error") });

/**
 * This check sends one call on the connection of the application. A check measures the step at this time.
 * Thus it does not send the call again, and only `ok` passes.
 */
export const roundTripCheck = (send: (options: SendOptions) => Promise<Sent<unknown>>): StepCheck => ({
  ownConnection: true,
  run: async (signal) => passes(await send({ signal, reissue: false })),
});

/**
 * This check opens a new connection each time. It finds a server that refuses connections, but not
 * a stalled connection of the application. A failed dial throws, and the poller counts the throw as an error.
 */
export const dialCheck = (dial: DialFn, host: string, port: number): StepCheck => ({
  ownConnection: false,
  run: async (signal) => {
    await dial(host, port, signal);
    return "ok" as const;
  },
});

/** These are the bounds of a client that the core examines in a description. */
export interface ClientBounds {
  /** This time bounds the close of the client, in milliseconds. */
  readonly close: number;
  /** This time bounds a call on the connection of the application, in milliseconds. */
  readonly request: number;
}

/** This function gives the bounds of a client that `clientProblems` examines, from its knobs. */
export const clientBounds = (knobs: ClientKnobs): ClientBounds => ({ close: ms(knobs.close_bound), request: ms(knobs.request_timeout) });

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

/**
 * This poll is a poll of the checks to start from: each 5 s with a jitter of 20 %, and a timeout of
 * 4 s (B6, O12). Its slowest poll is 4 s + 5 s × 1.2 = 10 s, the slowest poll of the cells of O13.
 * It does not depend on a driver. The starting knobs of each driver fit it.
 */
export const STARTING_POLL: Poll = { interval: { value: 5, unit: "s" }, jitter: 0.2, timeout: { value: 4, unit: "s" } };
