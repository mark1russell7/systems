import { connect as dialTcp } from "node:net";
import type { Extent, Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { Backoff } from "../backoff.ts";
import { backoffDelay } from "../backoff.ts";
import type { ServiceBuilder } from "../builder.ts";
import type { Cancel, Clock } from "../clock.ts";
import { realClock } from "../clock.ts";
import type { CheckOptions, ClientStep, DialFn, SendOptions, Sent } from "../client/core.ts";
import type { Check, Dependency, ServiceDescription } from "../description.ts";
import type { Recorder } from "../events.ts";
import type { Heartbeat } from "../heartbeat.ts";
import { heartbeat } from "../heartbeat.ts";
import type { Outcome } from "../latch.ts";
import type { DependencyHandle } from "../lifecycle.ts";
import type { Operation } from "../operation.ts";
import { mayReissue } from "../operation.ts";
import type { CheckFn } from "../poller.ts";
import { heartbeatDetection } from "../timing.ts";
import type { ConnectionFactory, RedisConnection, RedisConnectionOptions } from "./connection.ts";
import { ioredis } from "./connection.ts";
import type { Meeting } from "./meets.ts";
import { meetings } from "./meets.ts";
import { REDIS_OPERATIONS, commandName } from "./operations.ts";

// the three outcomes, the send options and the checks moved to the core of the clients: this entry keeps them for the users of 0.5
export type { CheckOptions, ClientStep, DialFn, SendOptions, Sent } from "../client/core.ts";

/**
 * These are the knobs of the client, each a time, by the names of the ordering law where the law
 * has them. The runtime has no defaults, thus each knob is necessary, and a bound that nobody gives
 * is "infinite", not zero.
 */
export interface RedisKnobs {
  /** This time bounds a try to connect, until the TCP connection exists (`connectTimeout`). */
  readonly connect_bound: Quantity;
  /** This time bounds each command, the handshake commands too (`commandTimeout`). */
  readonly request_timeout: Quantity;
  /** This time destroys a socket that gives no data while a command waits (`socketTimeout`). */
  readonly driver_writeoff_time: Extent;
  /** This time is the idle time of TCP keepalive. Node then sends 10 probes 1 s apart. */
  readonly keepalive_idle: Extent;
  /** This time is the interval of the in-band watchdog: a PING on the connection of the application. */
  readonly heartbeat_interval: Extent;
  /** This time bounds each PING of the watchdog. */
  readonly heartbeat_timeout: Quantity;
  /** This time is how long the client tries to connect again before it stops. The watchdog then starts it again. */
  readonly client_retry_window: Extent;
  /** This time is the first delay before a new try to connect. The delay doubles after each try. */
  readonly retry_base: Quantity;
  /** This time is the most that one delay can be, before its jitter. */
  readonly retry_cap: Quantity;
  /** This time bounds the close of the client at the shutdown: a QUIT, then a disconnect. */
  readonly close_bound: Quantity;
  /** This time is the age at which the client replaces its connection. The client supports only "infinite". */
  readonly max_connection_age: Extent;
  /**
   * This time is when the kernel gives up a segment that it retransmits. Node cannot set it, thus
   * the declaration states it for the ordering law (O17), from the platform.
   */
  readonly retrans_giveup_time: Extent;
}

/** A Redis client spec is the declaration of one Redis client: where it connects, and its knobs. */
export interface RedisClientSpec {
  readonly host: string;
  readonly port: number;
  readonly db?: number | undefined;
  readonly username?: string | undefined;
  readonly password?: string | undefined;
  /** This identifier is the component in the corpus (`systems.component.redis`), or null. */
  readonly system: string | null;
  readonly knobs: RedisKnobs;
  /** This count is the number of PINGs in sequence without an answer that make the watchdog connect again. */
  readonly heartbeatMisses: number;
  /** These operations add to the table of the client, or change it. */
  readonly operations?: Readonly<Record<string, Operation>> | undefined;
}

/** These options make a client. Without them, it uses ioredis, the real clock and `Math.random`. */
export interface RedisClientOptions {
  readonly create?: ConnectionFactory | undefined;
  readonly clock?: Clock | undefined;
  readonly random?: (() => number) | undefined;
  /** This function receives each transition of the client, for the prober (D3). */
  readonly record?: Recorder | undefined;
  readonly dial?: DialFn | undefined;
  /**
   * This function waits one turn of the event loop. The watchdog waits it before it counts a miss,
   * thus a reply that is in the socket is read first. Without it, the client uses `setImmediate`.
   */
  readonly turn?: (() => Promise<void>) | undefined;
}

/**
 * A join is one generation of the connection, at its `ready` (D1, D2). The prober joins its kernel
 * records to the server's view of the connection through it. A join holds the server's id of the
 * connection, and the local address and port of the socket.
 */
export interface Join {
  readonly generation: number;
  /** This time is when the connection became ready, in milliseconds on the monotonic clock. */
  readonly at: number;
  /** This number is the reply of CLIENT ID, or null when the server gave none. */
  readonly clientId: number | null;
  readonly localAddress: string | null;
  readonly localPort: number | null;
  readonly remoteAddress: string | null;
  readonly remotePort: number | null;
}

type Attempt =
  | { readonly outcome: "ok"; readonly value: unknown }
  | { readonly outcome: "error"; readonly error: string; readonly reply: boolean }
  | { readonly outcome: "indeterminate"; readonly error: string };

/** A Redis client is a dependency of a service: its declaration, its handle, its checks and its commands. */
export interface RedisClient {
  readonly name: string;
  /** This declaration goes to `svc.dependency(name, declaration, handle)`. */
  readonly declaration: Omit<Dependency, "name">;
  readonly handle: DependencyHandle;
  /** These are the manifestations that the client can meet, and the detector of each (E9). */
  readonly meets: readonly Meeting[];
  /** This text is the state of the connection, as ioredis names it, or "none" before the connect. */
  readonly status: string;
  /** These are the generations of the connection, the latest last. */
  readonly joins: readonly Join[];
  /**
   * This method sends a command, and gives its outcome in three values. The client sends again
   * only an idempotent operation, one time at most, after an outcome that is not certain. The
   * second try stays in the bound of the request. The client does not send again an operation that
   * the table does not name.
   */
  send<T = unknown>(command: string, args?: ReadonlyArray<string | number>, options?: SendOptions): Promise<Sent<T>>;
  /** This method gives the checks of the client and their functions, for `svc.check(check, run)`. */
  checks(options: CheckOptions): ReadonlyArray<readonly [Check, CheckFn]>;
  /** This method declares the client in a service: its dependency, its handle and its checks. */
  attach(svc: ServiceBuilder, options: CheckOptions): ServiceBuilder;
  /** This method gives the problems of the client in a description: a close that does not fit in its phase, for example. */
  problems(description: ServiceDescription): string[];
}

const ms = (amount: Extent): number =>
  amount.value === "infinite" ? Number.POSITIVE_INFINITY : valueIn(amount as Quantity, "ms");
const finite = (amount: Extent): number | undefined => {
  const value = ms(amount);
  return Number.isFinite(value) ? value : undefined;
};
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * This function gives the backoff of the tries to connect: from `retry_base`, doubling to
 * `retry_cap`, each with a jitter up to the base. The client rounds each delay to a whole millisecond.
 */
export const retryBackoff = (knobs: RedisKnobs): Backoff => ({
  base: ms(knobs.retry_base),
  factor: 2,
  cap: ms(knobs.retry_cap),
  jitter: { kind: "add", amount: ms(knobs.retry_base) },
});

/** This function gives the problems of a spec: the knobs that the client cannot use. */
export const specProblems = (name: string, spec: RedisClientSpec): string[] => {
  const problems: string[] = [];
  const { knobs } = spec;
  if (!Number.isInteger(spec.heartbeatMisses) || spec.heartbeatMisses < 1)
    problems.push(`${name}'s watchdog closes the connection after ${spec.heartbeatMisses} misses, not a whole number above zero`);
  if (knobs.max_connection_age.value !== "infinite")
    problems.push(`${name} cannot replace its connection at an age: max_connection_age must be "infinite"`);
  for (const [knob, amount] of Object.entries(knobs) as Array<[string, Extent]>) {
    if (amount.value !== "infinite" && !(ms(amount) >= 0))
      problems.push(`${name}'s ${knob} is not a time of zero or more`);
  }
  if (ms(knobs.request_timeout) <= 0) problems.push(`${name}'s request_timeout is not above zero: each command must have a bound`);
  if (ms(knobs.heartbeat_timeout) <= 0) problems.push(`${name}'s heartbeat_timeout is not above zero`);
  if (ms(knobs.retry_cap) < ms(knobs.retry_base)) problems.push(`${name}'s retry_cap is below its retry_base`);
  return problems;
};

/** This dial function opens a TCP connection, sends an inline PING, and waits for +PONG. */
export const tcpDial: DialFn = (host, port, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("the dial was aborted"));
      return;
    }
    const socket = dialTcp({ host, port });
    let reply = "";
    const end = (error?: Error): void => {
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = (): void => end(new Error("the dial was aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => socket.write("PING\r\n"));
    socket.on("data", (chunk) => {
      reply += chunk.toString();
      if (reply.includes("\r\n")) end(reply.startsWith("+PONG") ? undefined : new Error(`the reply was ${reply.trim()}`));
    });
    socket.once("error", (error) => end(error));
    socket.once("close", () => end(new Error("the server closed the dial")));
  });

/**
 * This function makes a Redis client. It is a dependency of a service, with ioredis under it:
 * - It sets each timer of ioredis from the declaration, and it does not let ioredis send a command
 *   again (R5 §8).
 * - It tells the outcome of a command in three values, and it settles each command in flight as
 *   indeterminate when its connection closes (C8, C10).
 * - It records the server's id of each connection at `ready` (D1).
 * - A watchdog sends a PING in the band of the connection, and it connects again after the misses
 *   of the declaration. It also starts a client that stopped (principle 19).
 */
export const redisClient = (name: string, spec: RedisClientSpec, options: RedisClientOptions = {}): RedisClient => {
  const problems = specProblems(name, spec);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const { knobs } = spec;
  const clock = options.clock ?? realClock;
  const random = options.random ?? Math.random;
  const create = options.create ?? ioredis;
  const dial = options.dial ?? tcpDial;
  const turn = options.turn ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const operations: Readonly<Record<string, Operation>> = { ...REDIS_OPERATIONS, ...spec.operations };
  const requestTimeout = ms(knobs.request_timeout);
  const detection = heartbeatDetection(knobs.heartbeat_interval, knobs.heartbeat_timeout, spec.heartbeatMisses);
  const backoff = retryBackoff(knobs);

  let connection: RedisConnection | null = null;
  let status = "none";
  let closing = false;
  const joins: Join[] = [];
  // the commands that the client wrote while the connection was ready: a close settles each one
  const inFlight = new Set<(attempt: Attempt) => void>();
  const readyWaiters = new Set<() => void>();
  const listeners: Array<[string, (...args: unknown[]) => void]> = [];

  const record = (from: string, to: string, on: string, detail?: string): void =>
    options.record?.({ at: clock.now(), machine: "client", instance: name, from, to, on, ...(detail === undefined ? {} : { detail }) });

  // the delays of the tries to connect (`retryBackoff`), and none after the retry window. The
  // watchdog starts the client again after that
  let retrySince: number | null = null;
  const retryStrategy = (times: number): number | null => {
    const now = clock.now();
    retrySince ??= now;
    if (now - retrySince > ms(knobs.client_retry_window)) {
      record(status, status, "retry.window-ended");
      return null;
    }
    return Math.round(backoffDelay(backoff, times, random));
  };

  const connectionOptions: RedisConnectionOptions = {
    host: spec.host,
    port: spec.port,
    ...(spec.db === undefined ? {} : { db: spec.db }),
    ...(spec.username === undefined ? {} : { username: spec.username }),
    ...(spec.password === undefined ? {} : { password: spec.password }),
    lazyConnect: true,
    connectTimeout: ms(knobs.connect_bound),
    commandTimeout: requestTimeout,
    socketTimeout: finite(knobs.driver_writeoff_time),
    keepAlive: finite(knobs.keepalive_idle) ?? false,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectionName: name,
    retryStrategy,
  };

  /** This function gives the outcome of a failed command: a reply of the server, a command that did not leave the client, or neither. */
  const failed = (error: unknown): Attempt => {
    const text = message(error);
    if (error instanceof Error && error.name === "ReplyError") return { outcome: "error", error: text, reply: true };
    if (/isn't writeable|enableOfflineQueue/i.test(text)) return { outcome: "error", error: text, reply: false };
    return { outcome: "indeterminate", error: text };
  };

  const onReady = async (): Promise<void> => {
    retrySince = null;
    const c = connection;
    if (c === null) return;
    const generation = joins.length + 1;
    const at = clock.now();
    const socket = c.stream;
    let clientId: number | null = null;
    try {
      const reply = await c.call("CLIENT", "ID");
      clientId = typeof reply === "number" ? reply : Number(reply);
      if (!Number.isFinite(clientId)) clientId = null;
    } catch {
      clientId = null;
    }
    // a connection that closed before its reply is a generation that never served
    if (connection !== c || c.status !== "ready") return;
    joins.push({
      generation,
      at,
      clientId,
      localAddress: socket?.localAddress ?? null,
      localPort: socket?.localPort ?? null,
      remoteAddress: socket?.remoteAddress ?? null,
      remotePort: socket?.remotePort ?? null,
    });
    record("ready", "ready", "join", `generation ${generation}, client id ${clientId ?? "unknown"}`);
    for (const wake of [...readyWaiters]) wake();
  };

  const onStatus = (to: string) => (): void => {
    const from = status;
    status = to;
    record(from, to, `status.${to}`);
    if (to === "close" || to === "end") {
      // the lower layer gave up the connection: each command in flight learns it now (C10)
      for (const settle of [...inFlight]) settle({ outcome: "indeterminate", error: `the connection closed with the command in flight (${from})` });
    }
    if (to === "ready") void onReady();
  };

  const watch = (c: RedisConnection): void => {
    for (const state of ["connecting", "connect", "ready", "close", "reconnecting", "end"]) {
      const listener = onStatus(state);
      c.on(state, listener);
      listeners.push([state, listener]);
    }
    // an error of the connection comes before its close, which settles the commands: here it is only recorded
    const onError = (error: unknown): void => record(status, status, "error", message(error));
    c.on("error", onError);
    listeners.push(["error", onError]);
  };

  /** This function waits until the connection is ready, for `within` milliseconds at most. It gives true when it is ready. */
  const waitReady = (within: number, signal?: AbortSignal): Promise<boolean> =>
    new Promise((resolve) => {
      if (connection?.status === "ready") {
        resolve(true);
        return;
      }
      let cancel: Cancel = () => {};
      const done = (value: boolean): void => {
        readyWaiters.delete(wake);
        cancel();
        signal?.removeEventListener("abort", aborted);
        resolve(value);
      };
      const wake = (): void => done(true);
      const aborted = (): void => done(false);
      readyWaiters.add(wake);
      cancel = clock.after(within, () => done(connection?.status === "ready"));
      signal?.addEventListener("abort", aborted, { once: true });
    });

  const attempt = (command: string, args: ReadonlyArray<string | number>, signal?: AbortSignal): Promise<Attempt> => {
    const c = connection;
    if (c === null) return Promise.resolve({ outcome: "error", error: `${name} has not connected`, reply: false });
    if (c.status !== "ready") return Promise.resolve({ outcome: "error", error: `${name} is ${c.status}, not ready: the command did not leave the client`, reply: false });
    if (signal?.aborted) return Promise.resolve({ outcome: "error", error: "the caller aborted the command before it left the client", reply: false });
    return new Promise<Attempt>((resolve) => {
      let settled = false;
      const settle = (value: Attempt): void => {
        if (settled) return;
        settled = true;
        inFlight.delete(settle);
        signal?.removeEventListener("abort", aborted);
        resolve(value);
      };
      // a sent command cannot be cancelled: the caller abandons it, and its outcome is not known (principle 9)
      const aborted = (): void => settle({ outcome: "indeterminate", error: "the caller abandoned the command after it was sent" });
      inFlight.add(settle);
      signal?.addEventListener("abort", aborted, { once: true });
      c.call(command, ...args).then(
        (value) => settle({ outcome: "ok", value }),
        (error: unknown) => settle(failed(error)),
      );
    });
  };

  const send = async <T>(command: string, args: ReadonlyArray<string | number> = [], sendOptions: SendOptions = {}): Promise<Sent<T>> => {
    const { signal } = sendOptions;
    const operation = sendOptions.reissue === false ? undefined : operations[commandName(command, args)];
    const started = clock.now();
    const first = await attempt(command, args, signal);
    if (first.outcome === "ok") return { outcome: "ok", value: first.value as T, attempts: 1 };
    // a reply of the server is final, and an operation that the table does not name is never sent again
    const again =
      !(first.outcome === "error" && first.reply) &&
      operation !== undefined &&
      signal?.aborted !== true &&
      mayReissue(operation, quantity((clock.now() - started) / 1000, "s"));
    const left = requestTimeout - (clock.now() - started);
    if (!again || left <= 0 || !(await waitReady(left, signal))) return { ...first, attempts: 1 };
    record(status, status, "command.reissue", commandName(command, args));
    // the second attempt ends at the bound of the request, not one command timeout after it starts
    const bound = new AbortController();
    const end = clock.after(Math.max(0, requestTimeout - (clock.now() - started)), () => bound.abort());
    const forward = (): void => bound.abort();
    signal?.addEventListener("abort", forward, { once: true });
    const second = await attempt(command, args, bound.signal);
    end();
    signal?.removeEventListener("abort", forward);
    return second.outcome === "ok" ? { outcome: "ok", value: second.value as T, attempts: 2 } : { ...second, attempts: 2 };
  };

  // the watchdog: a heartbeat of PINGs on the connection of the application, each interval from the
  // start of the one before. A reply, an error reply too, is an answer. It waits one turn of the
  // event loop before it counts a miss, thus a slow loop is not a silent server. It acts only on a
  // ready connection, thus it never closes a connection in the middle of a new attempt
  let watchdog: Heartbeat | null = null;
  const startWatchdog = (): Heartbeat =>
    heartbeat({
      interval: ms(knobs.heartbeat_interval),
      timeout: ms(knobs.heartbeat_timeout),
      misses: spec.heartbeatMisses,
      clock,
      turn,
      // a PING starts at each tick, also while an earlier PING waits
      overlap: true,
      due: () => {
        const c = connection;
        if (c === null || closing) return false;
        if (c.status === "end") {
          // the retry window ended: the watchdog starts the client again
          record(status, status, "watchdog.revive");
          retrySince = null;
          c.connect().catch(() => {});
          return false;
        }
        return c.status === "ready";
      },
      ping: (signal) =>
        attempt("PING", [], signal).then((result) => result.outcome === "ok" || (result.outcome === "error" && result.reply)),
      live: () => connection?.status === "ready" && !closing,
      onMiss: (misses) => record(status, status, "watchdog.miss", `${misses} of ${spec.heartbeatMisses}`),
      onDead: () => {
        record(status, status, "watchdog.reconnect");
        connection?.disconnect(true);
      },
    });

  const handle: DependencyHandle = {
    async connect(signal) {
      closing = false;
      const c = await create(connectionOptions);
      connection = c;
      watch(c);
      if (signal.aborted) throw new Error(`${name}: the service stopped before the connect`);
      // a server that is down at the start does not stop the startup: the client connects again in
      // the background, and its checks keep readiness tripped until it is ready (readiness is earned)
      await c.connect().catch((error: unknown) => record(status, status, "connect.failed", message(error)));
      watchdog?.stop();
      watchdog = startWatchdog();
    },
    async close() {
      closing = true;
      watchdog?.stop();
      watchdog = null;
      const c = connection;
      if (c === null) return;
      // a QUIT lets the replies in flight arrive. A silent server never answers it, thus the close has its bound
      const quit = c.quit().then(
        () => "quit" as const,
        () => "quit" as const,
      );
      let cancel: Cancel = () => {};
      const bound = new Promise<"bound">((resolve) => {
        cancel = clock.after(ms(knobs.close_bound), () => resolve("bound"));
      });
      const startedClose = clock.now();
      const first = await Promise.race([quit, bound]);
      cancel();
      if (first === "bound") record(status, status, "close.bound");
      // a client that is not ready refuses the QUIT at once, and it would connect again: the close stops it
      if (c.status !== "end") c.disconnect(false);
      // ioredis is at `end` when its socket closes, a moment after the reply: the close waits for it, in its bound
      const ended = (within: number): Promise<void> =>
        c.status === "end"
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              let stop: Cancel = () => {};
              const end = (): void => {
                c.off("end", end);
                stop();
                resolve();
              };
              c.on("end", end);
              stop = clock.after(Math.max(0, within), end);
            });
      await ended(ms(knobs.close_bound) - (clock.now() - startedClose));
      // a disconnect only half-closes the socket, and a silent server never closes its half: the bound destroys it
      if (c.status !== "end") {
        record(status, status, "close.destroy");
        c.stream?.destroy?.();
        await ended(0);
      }
      for (const [event, listener] of listeners) c.off(event, listener);
      listeners.length = 0;
      for (const settle of [...inFlight]) settle({ outcome: "indeterminate", error: "the client closed with the command in flight" });
      status = "end";
    },
  };

  const declaration: Omit<Dependency, "name"> = {
    system: spec.system,
    knobs: {
      connect_bound: knobs.connect_bound,
      request_timeout: knobs.request_timeout,
      driver_writeoff_time: knobs.driver_writeoff_time,
      keepalive_idle: knobs.keepalive_idle,
      heartbeat_interval: knobs.heartbeat_interval,
      heartbeat_timeout: knobs.heartbeat_timeout,
      heartbeat_detection_time: detection,
      client_retry_window: knobs.client_retry_window,
      retry_base: knobs.retry_base,
      retry_cap: knobs.retry_cap,
      close_bound: knobs.close_bound,
      max_connection_age: knobs.max_connection_age,
      retrans_giveup_time: knobs.retrans_giveup_time,
    },
    operations,
  };

  const checks = (checkOptions: CheckOptions): ReadonlyArray<readonly [Check, CheckFn]> => {
    const made: Array<readonly [Check, CheckFn]> = [];
    const declare = (step: ClientStep, ownConnection: boolean, run: CheckFn): void => {
      if (!(step in checkOptions.steps)) return;
      made.push([
        { name: `${name}.${step}`, dependency: name, step, ownConnection, gates: checkOptions.steps[step] ?? null, poll: checkOptions.poll },
        run,
      ]);
    };
    // the state of the client, without a round trip
    declare("local-state", true, () => (connection?.status === "ready" ? "ok" : "error"));
    // a PING on the connection of the application: blind to nothing that the application meets
    declare("round-trip", true, async (signal): Promise<Outcome> => {
      // a check measures the step now: it does not wait for a new connection, and it sends nothing again
      const result = await send("PING", [], { signal, reissue: false });
      return result.outcome === "ok" ? "ok" : "error";
    });
    // a new connection each time: it finds a server that refuses connections, but not a stalled connection of the application
    declare("dial", false, async (signal): Promise<Outcome> => {
      await dial(spec.host, spec.port, signal);
      return "ok";
    });
    return made;
  };

  return {
    name,
    declaration,
    handle,
    meets: meetings(name, knobs, detection),
    get status() {
      return connection === null ? "none" : connection.status;
    },
    joins,
    send,
    checks,
    attach(svc, checkOptions) {
      svc.dependency(name, declaration, handle);
      for (const [check, run] of checks(checkOptions)) svc.check(check, run);
      return svc;
    },
    problems(description) {
      const found: string[] = [];
      const teardown = description.shutdown.phases.find((phase) => phase.name === "tear down dependencies");
      if (teardown === undefined) found.push(`${name} needs the phase "tear down dependencies" to close`);
      else if (ms(knobs.close_bound) >= valueIn(teardown.cap, "ms"))
        found.push(`${name}'s close_bound of ${ms(knobs.close_bound)} ms does not fit in the cap of "tear down dependencies"`);
      for (const check of description.checks) {
        if (check.dependency !== name) continue;
        const slowest = valueIn(check.poll.timeout, "ms");
        if (check.step === "round-trip" && requestTimeout > slowest + valueIn(check.poll.interval, "ms") * (1 + check.poll.jitter))
          found.push(`${name}'s request_timeout outlives one jittered poll of ${check.name} (B7, O13)`);
      }
      return found;
    },
  };
};
