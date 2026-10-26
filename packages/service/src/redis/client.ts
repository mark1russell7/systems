import type { Extent, Quantity } from "@mark1russell7/quantity";
import { backoffDelay } from "../backoff.ts";
import type { Cancel } from "../clock.ts";
import { realClock } from "../clock.ts";
import type { Attempt, CheckOptions, Client, ClientJoin, ClientKnobs, ClientOptions, ClientSpec, ClientStep, DialFn, RetryKnobs, SendOptions, Sent } from "../client/core.ts";
import {
  attachClient,
  clientBounds,
  clientProblems,
  clientRecorder,
  dialCheck,
  finiteMs,
  inFlight,
  localStateCheck,
  message,
  ms,
  notSent,
  operationTable,
  readyWait,
  retryBackoff,
  retryProblems,
  roundTripCheck,
  sendWithReissue,
  socketEnds,
  stepChecks,
  timeProblems,
  withinBound,
} from "../client/core.ts";
import { helloDial } from "../client/dial.ts";
import type { Dependency } from "../description.ts";
import type { Heartbeat } from "../heartbeat.ts";
import { heartbeat } from "../heartbeat.ts";
import type { DependencyHandle } from "../lifecycle.ts";
import { heartbeatDetection } from "../timing.ts";
import type { ConnectionFactory, RedisConnection, RedisConnectionOptions } from "./connection.ts";
import { ioredis } from "./connection.ts";
import { meetings } from "./meets.ts";
import { REDIS_OPERATIONS, commandName } from "./operations.ts";

// the three outcomes, the send options and the checks moved to the core of the clients: this entry keeps them for the users of 0.5
export type { CheckOptions, ClientStep, DialFn, SendOptions, Sent } from "../client/core.ts";
// the backoff of the tries to connect moved to the core, for RabbitMQ too: this entry keeps it for the users of 0.5
export { retryBackoff } from "../client/core.ts";

/**
 * These are the knobs of the client, each a time, by the names of the ordering law where the law
 * has them. The runtime has no defaults, thus each knob is necessary, and a bound that nobody gives
 * is "infinite", not zero. The knobs that each client has come from the core.
 */
export interface RedisKnobs extends ClientKnobs, RetryKnobs {
  /** This time bounds a try to connect, until the TCP connection exists (`connectTimeout`). */
  readonly connect_bound: Quantity;
  /** This time bounds each command, the handshake commands too (`commandTimeout`). */
  readonly request_timeout: Quantity;
  /** This time destroys a socket that gives no data while a command waits (`socketTimeout`). */
  readonly driver_writeoff_time: Extent;
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
}

/** A Redis client spec is the declaration of one Redis client: where it connects, and its knobs. */
export interface RedisClientSpec extends ClientSpec<RedisKnobs> {
  readonly db?: number | undefined;
  readonly username?: string | undefined;
  /** This count is the number of PINGs in sequence without an answer that make the watchdog connect again. */
  readonly heartbeatMisses: number;
}

/** These options make a client. Without them, it uses ioredis, the real clock and `Math.random`. */
export interface RedisClientOptions extends ClientOptions<ConnectionFactory> {
  readonly random?: (() => number) | undefined;
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
export interface Join extends ClientJoin {
  /** This number is the reply of CLIENT ID, or null when the server gave none. */
  readonly clientId: number | null;
}

/** A Redis client is a dependency of a service: its declaration, its handle, its checks and its commands. */
export interface RedisClient extends Client<ClientStep, Join> {
  /** This text is the state of the connection, as ioredis names it, or "none" before the connect. */
  readonly status: string;
  /**
   * This method sends a command, and gives its outcome in three values. The client sends again
   * only an idempotent operation, one time at most, after an outcome that is not certain. The
   * second try stays in the bound of the request. The client does not send again an operation that
   * the table does not name.
   */
  send<T = unknown>(command: string, args?: ReadonlyArray<string | number>, options?: SendOptions): Promise<Sent<T>>;
}

/** This function gives the problems of a spec: the knobs that the client cannot use. */
export const specProblems = (name: string, spec: RedisClientSpec): string[] => {
  const problems: string[] = [];
  const { knobs } = spec;
  if (!Number.isInteger(spec.heartbeatMisses) || spec.heartbeatMisses < 1)
    problems.push(`${name}'s watchdog closes the connection after ${spec.heartbeatMisses} misses, not a whole number above zero`);
  if (knobs.max_connection_age.value !== "infinite")
    problems.push(`${name} cannot replace its connection at an age: max_connection_age must be "infinite"`);
  problems.push(...timeProblems(name, knobs));
  if (ms(knobs.request_timeout) <= 0) problems.push(`${name}'s request_timeout is not above zero: each command must have a bound`);
  if (ms(knobs.heartbeat_timeout) <= 0) problems.push(`${name}'s heartbeat_timeout is not above zero`);
  problems.push(...retryProblems(name, knobs));
  return problems;
};

/** This dial function opens a TCP connection, sends an inline PING, and waits for +PONG. */
export const tcpDial: DialFn = helloDial("PING\r\n", (received) => {
  const reply = received.toString();
  if (!reply.includes("\r\n")) return "more";
  return reply.startsWith("+PONG") ? null : new Error(`the reply was ${reply.trim()}`);
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
 *
 * The outcomes, the second try, the commands in flight, the bounded close and the checks come
 * from the core of the clients. This entry gives what ioredis does in its own way.
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
  const operations = operationTable(REDIS_OPERATIONS, spec.operations);
  const requestTimeout = ms(knobs.request_timeout);
  const detection = heartbeatDetection(knobs.heartbeat_interval, knobs.heartbeat_timeout, spec.heartbeatMisses);
  const backoff = retryBackoff(knobs);

  let connection: RedisConnection | null = null;
  let status = "none";
  let closing = false;
  const joins: Join[] = [];
  // the commands that the client wrote while the connection was ready: a close settles each one
  const flight = inFlight();
  // the commands that wait for a ready connection before their second try
  const readied = readyWait(clock, () => connection?.status === "ready");
  const listeners: Array<[string, (...args: unknown[]) => void]> = [];

  const record = clientRecorder(options.record, clock, name);

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
    // ioredis reads undefined as no socket timeout, and false as no keepalive
    socketTimeout: finiteMs(knobs.driver_writeoff_time),
    keepAlive: finiteMs(knobs.keepalive_idle) ?? false,
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
    if (/isn't writeable|enableOfflineQueue/i.test(text)) return notSent(text);
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
    joins.push({ generation, at, clientId, ...socketEnds(socket) });
    record("ready", "ready", "join", `generation ${generation}, client id ${clientId ?? "unknown"}`);
    readied.wake();
  };

  const onStatus = (to: string) => (): void => {
    const from = status;
    status = to;
    record(from, to, `status.${to}`);
    // the lower layer gave up the connection: each command in flight learns it now (C10)
    if (to === "close" || to === "end") flight.settleAll(`the connection closed with the command in flight (${from})`);
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

  const attempt = (command: string, args: ReadonlyArray<string | number>, signal?: AbortSignal): Promise<Attempt> => {
    const c = connection;
    if (c === null) return Promise.resolve(notSent(`${name} has not connected`));
    // ioredis has no offline queue here: a command while the client is not ready fails at once, before it leaves the client
    if (c.status !== "ready") return Promise.resolve(notSent(`${name} is ${c.status}, not ready: the command did not leave the client`));
    if (signal?.aborted) return Promise.resolve(notSent("the caller aborted the command before it left the client"));
    return flight.track(signal, "the caller abandoned the command after it was sent", (settle) => {
      c.call(command, ...args).then(
        (value) => settle({ outcome: "ok", value }),
        (error: unknown) => settle(failed(error)),
      );
    });
  };

  const send = <T>(command: string, args: ReadonlyArray<string | number> = [], sendOptions: SendOptions = {}): Promise<Sent<T>> =>
    sendWithReissue({
      clock,
      bound: requestTimeout,
      operation: operations[commandName(command, args)],
      options: sendOptions,
      attempt: (signal) => attempt(command, args, signal) as Promise<Attempt<T>>,
      // ioredis connects again by itself: the second try waits for a ready connection, in the time that is left
      beforeAgain: (left, signal) => readied.wait(left, signal),
      onReissue: () => record(status, status, "command.reissue", commandName(command, args)),
    });

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
      const startedClose = clock.now();
      if (!(await withinBound(clock, ms(knobs.close_bound), c.quit()))) record(status, status, "close.bound");
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
      flight.settleAll("the client closed with the command in flight");
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

  const checks = (checkOptions: CheckOptions) =>
    stepChecks<ClientStep>(name, checkOptions, {
      // the state of the client, without a round trip
      "local-state": localStateCheck(() => connection?.status === "ready"),
      // a PING on the connection of the application: blind to nothing that the application meets
      "round-trip": roundTripCheck((sendOptions) => send("PING", [], sendOptions)),
      // a new connection each time: it finds a server that refuses connections, but not a stalled connection of the application
      dial: dialCheck(dial, spec.host, spec.port),
    });

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
    attach: (svc, checkOptions) => attachClient(svc, name, declaration, handle, checks(checkOptions)),
    problems: (description) => clientProblems(name, description, clientBounds(knobs)),
  };
};
