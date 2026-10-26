import type { Extent, Quantity } from "@mark1russell7/quantity";
import { quantity } from "@mark1russell7/quantity";
import { realClock } from "../clock.ts";
import type { Attempt, CheckOptions, Client, ClientJoin, ClientKnobs, ClientOptions, ClientSpec, ClientStep, DialFn, RetryKnobs, SendOptions, Sent } from "../client/core.ts";
import {
  ageProblems,
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
  retrySchedule,
  roundTripCheck,
  sendWithReissue,
  socketEnds,
  stepChecks,
  timeProblems,
  trackWithTimer,
  wholeProblems,
  withinBound,
  wrapperTimerProblems,
  zeroProblems,
} from "../client/core.ts";
import type { Judge } from "../client/dial.ts";
import { helloDial } from "../client/dial.ts";
import type { Dependency } from "../description.ts";
import type { DependencyHandle } from "../lifecycle.ts";
import type { JobSettle } from "../queue.ts";
import type { RabbitChannel, RabbitConnectOptions, RabbitConnection, RabbitFactory, RabbitMessage, RabbitPublishOptions } from "./connection.ts";
import { nodeAmqp } from "./connection.ts";
import { rabbitMeetings } from "./meets.ts";

/**
 * These are the knobs of the client, each a time, by the names of the ordering law where the law
 * has them. The runtime has no defaults, thus each knob is necessary. A bound that nobody gives is
 * "infinite", not zero. The constant `RABBIT_STARTING_KNOBS` gives a declaration from the cells of R3. The knobs
 * that each client has come from the core.
 */
export interface RabbitKnobs extends ClientKnobs, RetryKnobs {
  /**
   * This time bounds the TCP connect and the handshake (`socketOptions.timeout`). The client also
   * bounds the open of its channel with it. The timer of amqplib stops when the connection opens.
   */
  readonly connect_bound: Quantity;
  /** This time bounds each call: a publish until its confirm, and an RPC until its reply. The wrapper has this timer, because amqplib has none. */
  readonly request_timeout: Quantity;
  /**
   * This time is the heartbeat that the client asks for (`heartbeat` in the URL), in whole seconds.
   * The connection uses the smaller of this value and the value of the broker. The value "infinite" asks for no heartbeat.
   */
  readonly heartbeat_interval: Extent;
  /** This time is the first delay before a new try to connect. The delay doubles after each try. */
  readonly retry_base: Quantity;
  /** This time is the most that one delay can be, before its jitter. */
  readonly retry_cap: Quantity;
  /** This time is the idle time of TCP keepalive (`keepAliveDelay`), in whole seconds. The value "infinite" turns keepalive off, as amqplib does by default. */
  readonly keepalive_idle: Extent;
  /** The client does not replace its connection at an age, thus this knob must be "infinite". */
  readonly max_connection_age: Extent;
  /** This time bounds the close of the client at the shutdown: `connection.close`, then a destroy of the socket. */
  readonly close_bound: Quantity;
}

/** A seed is one more node of the cluster. The client connects to the next node after each failure, in sequence. */
export interface RabbitSeed {
  readonly host: string;
  readonly port: number;
}

/** A RabbitMQ client spec is the declaration of one RabbitMQ client: where it connects, and its knobs. */
export interface RabbitClientSpec extends ClientSpec<RabbitKnobs> {
  /** This name is the virtual host. The default of the broker is "/". */
  readonly vhost?: string | undefined;
  /** This name is the user. Without it, amqplib connects as the user "guest". */
  readonly username?: string | undefined;
  /** These nodes are more nodes of the cluster, after `host` and `port`. */
  readonly seeds?: readonly RabbitSeed[] | undefined;
  /**
   * These operations are the calls of the service, by name, with their idempotency. A message does
   * not tell if a consumer removes its duplicates. Thus the client sends again only a call that this table names.
   */
  readonly operations?: ClientSpec<RabbitKnobs>["operations"];
}

/** These options make a client. Without them, it uses amqplib, the real clock, `Math.random`, and a dial with the protocol header. */
export interface RabbitClientOptions extends ClientOptions<RabbitFactory> {
  readonly random?: (() => number) | undefined;
}

/**
 * A join is one generation of the client: one connection and its channel, when the channel is open
 * (D1, D2). The prober joins its kernel records to the view of the broker through it.
 */
export interface RabbitJoin extends ClientJoin {
  /** This text is the node of the connection, as `host:port`. */
  readonly address: string;
  /** This text is the name of the connection in the broker, `local:port -> remote:port`, or null when the socket gives no addresses. */
  readonly connectionName: string | null;
}

/** A publish is one message to an exchange. A string content goes as UTF-8. */
export interface RabbitPublish {
  readonly exchange: string;
  readonly routingKey: string;
  readonly content: Buffer | string;
  /** These properties go to amqplib, for example `persistent`, `messageId` and `headers`. */
  readonly properties?: RabbitPublishOptions | undefined;
}

/** A delivery is one message that the client took from a queue. It stays on the channel of its generation until a settle. */
export interface RabbitDelivery {
  readonly message: RabbitMessage;
  /** This number is the generation of the channel that holds the message. */
  readonly generation: number;
  /** This count is the delivery of the message, 1 at the first, from `x-delivery-count` or `redelivered`. */
  readonly delivery: number;
}

/** These are the source and the settle of a queue drain on one queue: `queueDrain({ source, settle, ... })`. */
export interface RabbitJobs {
  /** This function takes one job, or gives null when the queue is empty. It is a `JobSource` of the drain. */
  readonly source: (signal: AbortSignal) => Promise<RabbitDelivery | null>;
  readonly settle: JobSettle<RabbitDelivery>;
}

/** A RabbitMQ client is a dependency of a service: its declaration, its handle, its checks and its calls. */
export interface RabbitClient extends Client<ClientStep, RabbitJoin> {
  /** This text is the state of the client, as `RABBIT_CLIENT_MACHINE` names it. */
  readonly status: string;
  /**
   * This method publishes one message, and waits for its confirm. An ack is `ok`. The client sends
   * again only an idempotent operation, one time at most, after an outcome that is not certain.
   */
  publish(operation: string, message: RabbitPublish, options?: SendOptions): Promise<Sent<void>>;
  /** This method takes one message from a queue (`basic.get`), or gives null when the queue is empty. */
  get(operation: string, queue: string, options?: SendOptions): Promise<Sent<RabbitDelivery | null>>;
  /** This method gives the source and the settle of a queue drain. The source takes each job with `get`. */
  jobs(operation: string, queue: string): RabbitJobs;
}

/** This function gives the problems of a spec: the knobs that the client cannot use. */
export const specProblems = (name: string, spec: RabbitClientSpec): string[] => {
  const { knobs } = spec;
  return [
    ...timeProblems(name, knobs),
    // amqplib reads a socket timeout of 0 as no bound, and a heartbeat of 0 as no heartbeat
    ...zeroProblems(name, "amqplib", knobs, { bounded: ["connect_bound"], open: ["heartbeat_interval", "keepalive_idle"] }),
    // the URL takes the heartbeat in whole seconds, and Node truncates the keepalive delay to whole seconds
    ...wholeProblems(name, knobs, { millis: ["connect_bound"], seconds: ["heartbeat_interval", "keepalive_idle"] }),
    ...retryProblems(name, knobs),
    // amqplib has no timer of a call
    ...wrapperTimerProblems(name, knobs, { request_timeout: "a call" }),
    ...ageProblems(name, knobs, "the client does not replace its connection at an age"),
  ];
};

/** This function gives the node of a try: `host`, then each seed, in sequence. */
const nodeOf = (spec: RabbitClientSpec, index: number): RabbitSeed => {
  const nodes = [{ host: spec.host, port: spec.port }, ...(spec.seeds ?? [])];
  return nodes[index % nodes.length]!;
};

/**
 * This function gives the arguments of `connect` for one node of a spec. Each timer of amqplib
 * comes from the declaration. The heartbeat goes in the URL, and "infinite" is 0, no heartbeat.
 */
export const rabbitOptions = (name: string, spec: RabbitClientSpec, index = 0): RabbitConnectOptions => {
  const { knobs } = spec;
  const node = nodeOf(spec, index);
  const user = spec.username === undefined ? "" : `${encodeURIComponent(spec.username)}:${encodeURIComponent(spec.password ?? "")}@`;
  const heartbeat = finiteMs(knobs.heartbeat_interval);
  const keepalive = finiteMs(knobs.keepalive_idle);
  return {
    url: `amqp://${user}${node.host}:${node.port}/${encodeURIComponent(spec.vhost ?? "/")}?heartbeat=${heartbeat === undefined ? 0 : heartbeat / 1000}`,
    socketOptions: {
      timeout: ms(knobs.connect_bound),
      noDelay: true,
      keepAlive: keepalive !== undefined,
      ...(keepalive === undefined ? {} : { keepAliveDelay: keepalive }),
      clientProperties: { connection_name: name },
    },
  };
};

/** The bytes of the protocol header of AMQP 0-9-1. A broker answers it with `connection.start`, before the authentication. */
export const AMQP_HEADER: Uint8Array = Uint8Array.of(0x41, 0x4d, 0x51, 0x50, 0, 0, 9, 1);

/**
 * This judge reads the answer to the protocol header. A broker that takes the version sends a method
 * frame on channel 0: `connection.start`, class 10 and method 10. A broker that refuses the version
 * sends its own protocol header, and closes the socket.
 */
export const startJudge: Judge = (received) => {
  if (received.length < 4) return "more";
  if (received.toString("latin1", 0, 4) === "AMQP") return new Error(`the broker refused the version: it answered ${received.toString("hex")}`);
  if (received.length < 11) return "more";
  const type = received[0];
  const channel = received.readUInt16BE(1);
  const classId = received.readUInt16BE(7);
  const methodId = received.readUInt16BE(9);
  if (type !== 1 || channel !== 0) return new Error(`the answer to the header is a frame of type ${type} on channel ${channel}, not a method on channel 0`);
  return classId === 10 && methodId === 10 ? null : new Error(`the answer to the header is the method ${classId}.${methodId}, not connection.start (10.10)`);
};

/** This dial function opens a TCP connection, sends the protocol header, and waits for `connection.start`. It needs no password. */
export const amqpDial: DialFn = helloDial(AMQP_HEADER, startJudge);

/**
 * This function gives the outcome of a failure of amqplib. The library names few classes of error.
 * Thus the wrapper reads the fields:
 * - A throw before the write (`IllegalOperationError`: the channel is closed or closing) is certain: the call did not leave the client.
 * - A reply code of the broker, from the close of the channel, is certain. The broker refused the call, or a call before it.
 * - A nack, and an end of the channel before the reply or the confirm, are not certain.
 */
export const failureOutcome = (error: unknown): Attempt<never> => {
  const text = message(error);
  const { name, code } = (typeof error === "object" && error !== null ? error : {}) as { name?: unknown; code?: unknown };
  if (name === "IllegalOperationError") return notSent(text);
  if (typeof code === "number") return { outcome: "error", error: `${code} ${text}`, reply: true };
  if (text === "message nacked")
    return { outcome: "indeterminate", error: "the broker nacked the message: a queue of the route can hold it, or not" };
  return { outcome: "indeterminate", error: text };
};

/** This function gives the count of deliveries of a message, 1 at the first. A quorum queue counts in `x-delivery-count`. */
export const deliveryCount = (message: RabbitMessage): number => {
  const count = message.properties.headers?.["x-delivery-count"];
  if (typeof count === "number" && Number.isInteger(count) && count >= 0) return count + 1;
  return message.fields.redelivered ? 2 : 1;
};

/** The exchange of each broker: the round-trip check declares it in passive mode, which changes nothing. */
const CHECK_EXCHANGE = "amq.direct";

/**
 * This function makes a RabbitMQ client, a dependency of a service over amqplib 2.
 * - It has one connection and one confirm channel, as one generation. The end of either one ends
 *   the generation. The client then connects again by itself, to the next node, after a backoff.
 * - It sets each timer of amqplib from the declaration. The built-in recovery of amqplib stays off.
 * - Its call is a confirmed publish, or an RPC with a reply. Each call has a timer of the wrapper, because amqplib has none.
 * - It tells the outcome of a call in three values, and it settles each call in flight at the end of its generation (C8, C10).
 * - It records the node and the name of each connection at the open of its channel (D1).
 *
 * These parts come from the core of the clients: the outcomes, the second try, the wait for a ready client and the backoff.
 * The calls in flight, the bounded close and the checks also come from the core. This entry gives what amqplib does in its own way.
 */
export const rabbitClient = (name: string, spec: RabbitClientSpec, options: RabbitClientOptions = {}): RabbitClient => {
  const problems = specProblems(name, spec);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const { knobs } = spec;
  const clock = options.clock ?? realClock;
  const random = options.random ?? Math.random;
  const create = options.create ?? nodeAmqp;
  const dial = options.dial ?? amqpDial;
  const operations = operationTable({}, spec.operations);
  const requestTimeout = ms(knobs.request_timeout);
  const backoff = retryBackoff(knobs);

  let status = "none";
  let connection: RabbitConnection | null = null;
  let channel: RabbitChannel | null = null;
  // the generation of the channel that is open now, and the token of the open that is current
  let generation = 0;
  let token = 0;
  // the index of the node of the next try, and the tries since the last join
  let next = 0;
  const retries = retrySchedule(clock, backoff, random);
  const joins: RabbitJoin[] = [];
  const flight = inFlight();
  const readied = readyWait(clock, () => status === "ready");

  const emit = clientRecorder(options.record, clock, name);
  const record = (on: string, to: string = status, detail?: string): void => {
    const from = status;
    status = to;
    emit(from, to, on, detail);
  };
  const closing = (): boolean => status === "closing" || status === "end";

  /** This function closes a connection that the client does not use, in `close_bound`, then destroys its socket. */
  const retire = (c: RabbitConnection): void => {
    void withinBound(
      clock,
      ms(knobs.close_bound),
      Promise.resolve().then(() => c.close()),
    ).then((ended) => {
      if (!ended) c.connection.stream?.destroy?.();
    });
  };

  /** This function waits for the backoff of the next try, then opens a new generation on the next node. */
  const scheduleRetry = (): void =>
    retries.schedule(() => {
      if (closing()) return;
      record("retry.connect", "connecting", `try ${retries.tries}, ${nodeOf(spec, next).host}:${nodeOf(spec, next).port}`);
      void open();
    });

  /** This function ends the generation that is open. The calls in flight learn it after the rejections of amqplib, which can hold a reply code. */
  const lose = (on: string, detail: string): void => {
    const c = connection;
    connection = null;
    channel = null;
    if (closing() || c === null) return;
    record(on, "failing", detail);
    clock.after(0, () => flight.settleAll(`the generation ended with the call in flight (${detail})`));
    // the end of the channel leaves its connection open: the client closes it
    if (on === "channel.end") retire(c);
    scheduleRetry();
  };

  /** This function listens to a connection from its creation. The error listener stays: in Node, an error with no listener throws. */
  const watch = (c: RabbitConnection): void => {
    c.on("error", (error) => {
      if (c === connection) record("connection.error", status, message(error));
    });
    c.on("close", (error) => {
      if (c === connection) lose("connection.end", error === undefined ? "the connection closed" : message(error));
    });
    c.on("blocked", (reason) => {
      if (c === connection && status === "ready") record("connection.blocked", "blocked", String(reason));
    });
    c.on("unblocked", () => {
      if (c !== connection || status !== "blocked") return;
      record("connection.unblocked", "ready");
      readied.wake();
    });
  };

  const join = (c: RabbitConnection, ch: RabbitChannel, address: string): void => {
    connection = c;
    channel = ch;
    retries.reset();
    const ends = socketEnds(c.connection.stream);
    generation = joins.length + 1;
    const connectionName =
      ends.localAddress === null ? null : `${ends.localAddress}:${ends.localPort ?? "?"} -> ${ends.remoteAddress ?? "?"}:${ends.remotePort ?? "?"}`;
    joins.push({ generation, at: clock.now(), address, connectionName, ...ends });
    ch.on("error", (error) => {
      if (ch === channel) record("channel.error", status, message(error));
    });
    // amqplib closes each channel of a connection that ends, then it emits the close of the connection in the same turn.
    // Thus the client waits for that turn, and an end of the connection is not recorded as an end of the channel
    ch.on("close", () => {
      queueMicrotask(() => {
        if (ch === channel) lose("channel.end", "the channel closed");
      });
    });
    record("join", "ready", `generation ${generation}, ${address}`);
    readied.wake();
  };

  /**
   * This function opens one generation: a connection, then its confirm channel, in `connect_bound`.
   * A failure goes to `failing`, and the backoff starts. A connection that arrives after its bound
   * or after the close is closed at once. The promise resolves when this try ends.
   */
  const open = (): Promise<void> => {
    const mine = (token += 1);
    const index = next;
    next += 1;
    const node = nodeOf(spec, index);
    const address = `${node.host}:${node.port}`;
    let opened: RabbitConnection | null = null;
    let finish: () => void = () => {};
    const ended = new Promise<void>((resolve) => (finish = resolve));
    const stale = (): boolean => mine !== token || closing();
    const fail = (detail: string): void => {
      bound();
      finish();
      if (stale()) return;
      token += 1;
      if (opened !== null) retire(opened);
      record("connect.failed", "failing", `${address}: ${detail}`);
      scheduleRetry();
    };
    const bound = clock.after(ms(knobs.connect_bound), () => fail("no open connection and channel in connect_bound"));
    void (async () => {
      const c = await create(rabbitOptions(name, spec, index));
      opened = c;
      watch(c);
      if (stale()) {
        retire(c);
        return;
      }
      const ch = await c.createConfirmChannel();
      if (stale()) {
        retire(c);
        return;
      }
      bound();
      join(c, ch, address);
      finish();
    })().catch((error: unknown) => fail(message(error)));
    return ended;
  };

  /** This function gives the channel for a call, or the reason that the call does not leave the client. */
  const usable = (signal: AbortSignal | undefined): RabbitChannel | Attempt<never> => {
    if (status === "none") return notSent(`${name} has not connected`);
    if (status !== "ready" || channel === null) return notSent(`${name} is ${status}, not ready: the call did not leave the client`);
    if (signal?.aborted) return notSent("the caller aborted the call before it left the client");
    return channel;
  };

  /** This function makes one try of a publish: the write, then the confirm, in `request_timeout`. */
  const publishAttempt = (sent: RabbitPublish, signal: AbortSignal | undefined): Promise<Attempt<void>> => {
    const ch = usable(signal);
    if ("outcome" in ch) return Promise.resolve(ch);
    const content = typeof sent.content === "string" ? Buffer.from(sent.content, "utf8") : sent.content;
    return trackWithTimer<void>(
      flight,
      clock,
      requestTimeout,
      signal,
      "the caller abandoned the publish after it was written",
      "no confirm in request_timeout: the broker can have the message",
      (settle) => {
        try {
          ch.publish(sent.exchange, sent.routingKey, content, sent.properties ?? {}, (error) =>
            settle(error === null ? { outcome: "ok", value: undefined } : failureOutcome(error)),
          );
        } catch (error) {
          settle(failureOutcome(error));
        }
      },
    );
  };

  /**
   * This function makes one try of an RPC on the channel, in `request_timeout`. A reply that comes
   * after the call settled goes to `late`, thus a message that nobody receives goes back to its queue.
   */
  const rpcAttempt = <T, R>(
    signal: AbortSignal | undefined,
    what: string,
    run: (ch: RabbitChannel) => Promise<R>,
    value: (reply: R) => T,
    late?: (reply: R, ch: RabbitChannel) => void,
  ): Promise<Attempt<T>> => {
    const ch = usable(signal);
    if ("outcome" in ch) return Promise.resolve(ch);
    let finished = false;
    return trackWithTimer<T>(
      flight,
      clock,
      requestTimeout,
      signal,
      `the caller abandoned ${what} after it was sent`,
      `no reply to ${what} in request_timeout`,
      (settle) => {
        Promise.resolve()
          .then(() => run(ch))
          .then(
            (reply) => {
              if (finished) late?.(reply, ch);
              else settle({ outcome: "ok", value: value(reply) });
            },
            (error: unknown) => settle(failureOutcome(error)),
          );
      },
      () => {
        finished = true;
      },
    );
  };

  const publish = (operation: string, sent: RabbitPublish, sendOptions: SendOptions = {}): Promise<Sent<void>> =>
    sendWithReissue({
      clock,
      bound: requestTimeout,
      operation: operations[operation],
      options: sendOptions,
      attempt: (signal) => publishAttempt(sent, signal),
      // the client connects again by itself: the second try waits for a ready client, in the time that is left
      beforeAgain: (left, signal) => readied.wait(left, signal),
      onReissue: () => record("command.reissue", status, operation),
    });

  const get = (operation: string, queue: string, sendOptions: SendOptions = {}): Promise<Sent<RabbitDelivery | null>> => {
    const at = (): number => generation;
    return sendWithReissue({
      clock,
      bound: requestTimeout,
      operation: operations[operation],
      options: sendOptions,
      attempt: (signal) => {
        const held = at();
        return rpcAttempt<RabbitDelivery | null, RabbitMessage | false>(
          signal,
          "basic.get",
          (ch) => ch.get(queue, { noAck: false }),
          (reply) => (reply === false ? null : { message: reply, generation: held, delivery: deliveryCount(reply) }),
          // a message after the timeout or the abort: nobody holds it, thus it goes back to its queue at once
          (reply, ch) => {
            if (reply === false) return;
            try {
              ch.nack(reply, false, true);
            } catch {
              // the channel ended, and the broker puts the message back by itself
            }
          },
        );
      },
      beforeAgain: (left, signal) => readied.wait(left, signal),
      onReissue: () => record("command.reissue", status, operation),
    });
  };

  /** This function gives the channel that holds a delivery. A delivery of an ended generation is back on its queue already (at least once). */
  const holder = (job: RabbitDelivery): RabbitChannel => {
    const ch = channel;
    if (ch === null || job.generation !== generation)
      throw new Error(`${name}: the channel of generation ${job.generation} ended, thus the broker put the message back on its queue`);
    return ch;
  };

  const jobs = (operation: string, queue: string): RabbitJobs => ({
    source: async (signal) => {
      const taken = await get(operation, queue, { signal });
      if (taken.outcome === "ok") return taken.value;
      throw new Error(`${name} could not take a message from ${queue}: ${taken.error}`);
    },
    settle: {
      ack: (job) => holder(job).ack(job.message),
      requeue: (job) => holder(job).nack(job.message, false, true),
      reject: (job) => holder(job).nack(job.message, false, false),
      delivery: (job) => job.delivery,
    },
  });

  const handle: DependencyHandle = {
    async connect(signal) {
      if (signal.aborted) throw new Error(`${name}: the service stopped before the connect`);
      record("status.connecting", "connecting");
      // a broker that is down does not stop the startup: the client connects again in the background,
      // and its checks keep readiness tripped until it is ready (readiness is earned)
      await open();
    },
    async close() {
      if (status === "none" || closing()) return;
      record("close.request", "closing");
      retries.cancel();
      // an open in flight is stale now: its connection is closed when it arrives
      token += 1;
      const c = connection;
      if (c !== null) {
        // behind a black hole, connection.close waits for close-ok with no bound: the bound destroys the socket
        if (!(await withinBound(clock, ms(knobs.close_bound), Promise.resolve().then(() => c.close())))) {
          record("close.bound", "closing");
          record("close.destroy", "closing");
          c.connection.stream?.destroy?.();
        }
      }
      connection = null;
      channel = null;
      flight.settleAll("the client closed with the call in flight");
      record("status.end", "end");
    },
  };

  const heartbeat = finiteMs(knobs.heartbeat_interval);
  const declaration: Omit<Dependency, "name"> = {
    system: spec.system,
    knobs: {
      connect_bound: knobs.connect_bound,
      request_timeout: knobs.request_timeout,
      heartbeat_interval: knobs.heartbeat_interval,
      // each side checks for data at each heartbeat, and ends the connection after two checks with
      // none: 2 to 3 heartbeats after the last data. The cells measured 45.009 s at 15 s
      heartbeat_detection_time: heartbeat === undefined ? knobs.heartbeat_interval : quantity((3 * heartbeat) / 1000, "s"),
      retry_base: knobs.retry_base,
      retry_cap: knobs.retry_cap,
      keepalive_idle: knobs.keepalive_idle,
      // each side sends a heartbeat frame each half heartbeat when it sent nothing: that refreshes an idle flow (O03)
      idle_refresh_interval: heartbeat === undefined ? knobs.keepalive_idle : quantity(heartbeat / 2000, "s"),
      max_connection_age: knobs.max_connection_age,
      close_bound: knobs.close_bound,
      retrans_giveup_time: knobs.retrans_giveup_time,
    },
    operations,
  };

  const checks = (checkOptions: CheckOptions) =>
    stepChecks<ClientStep>(name, checkOptions, {
      // the state of the client, without a round trip
      "local-state": localStateCheck(() => status === "ready"),
      // a passive declare of an exchange of each broker, on the channel of the application
      "round-trip": roundTripCheck((sendOptions) =>
        sendWithReissue({
          clock,
          bound: requestTimeout,
          operation: undefined,
          options: sendOptions,
          attempt: (signal) => rpcAttempt(signal, "a passive exchange.declare", (ch) => ch.checkExchange(CHECK_EXCHANGE), () => undefined),
          onReissue: () => {},
        }),
      ),
      // a new connection each time, with the protocol header and no login
      dial: dialCheck(dial, spec.host, spec.port),
    });

  return {
    name,
    declaration,
    handle,
    meets: rabbitMeetings(name, knobs),
    get status() {
      return status;
    },
    joins,
    publish,
    get,
    jobs,
    checks,
    attach: (svc, checkOptions) => attachClient(svc, name, declaration, handle, checks(checkOptions)),
    problems: (description) => clientProblems(name, description, clientBounds(knobs)),
  };
};
