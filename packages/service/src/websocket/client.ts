import type { Extent, Quantity } from "@mark1russell7/quantity";
import { realClock } from "../clock.ts";
import type {
  Attempt,
  CheckOptions,
  Client,
  ClientJoin,
  ClientKnobs,
  ClientOptions,
  ClientSpec,
  ClientStep,
  DialFn,
  RetryKnobs,
  SendOptions,
  Sent,
  Settle,
} from "../client/core.ts";
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
  missesProblems,
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
import { authority, helloDial, statusLineJudge } from "../client/dial.ts";
import type { Dependency } from "../description.ts";
import type { Heartbeat } from "../heartbeat.ts";
import { heartbeat } from "../heartbeat.ts";
import type { DependencyHandle } from "../lifecycle.ts";
import type { Operation } from "../operation.ts";
import { heartbeatDetection } from "../timing.ts";
import type { WsConnectOptions, WsConnection, WsFactory } from "./connection.ts";
import { nodeWs } from "./connection.ts";
import { wsMeetings } from "./meets.ts";

/**
 * These are the knobs of the client, each a time, by the names of the ordering law. The runtime has
 * no defaults, thus each knob is necessary. A bound that nobody gives is "infinite", not zero. The
 * constant `WS_CLIENT_STARTING_KNOBS` gives a declaration from the WS cells. The knobs that each client has come from the core.
 */
export interface WsKnobs extends ClientKnobs, RetryKnobs {
  /** This time bounds the TCP connect and the upgrade (`handshakeTimeout` of ws). The wrapper also bounds the open with it. */
  readonly connect_bound: Quantity;
  /** This time bounds each call: a request until its reply, and a ping until its pong. The wrapper has this timer, because ws has none. */
  readonly request_timeout: Quantity;
  /** This time is the interval of the ping frames of the heartbeat, from the start of one to the start of the next. "infinite" sends no ping. */
  readonly heartbeat_interval: Extent;
  /** This time bounds each ping of the heartbeat. A ping with no pong in this time is a miss. */
  readonly heartbeat_timeout: Quantity;
  /** This time is the first delay before a new try to connect. The delay doubles after each try. */
  readonly retry_base: Quantity;
  /** This time is the most that one delay can be, before its jitter. */
  readonly retry_cap: Quantity;
  /** This time is the idle time of TCP keepalive (`keepAliveInitialDelay`), in whole seconds. "infinite" keeps keepalive off, as ws does. */
  readonly keepalive_idle: Extent;
  /** The client does not replace its connection at an age, thus this knob must be "infinite". */
  readonly max_connection_age: Extent;
  /** This time bounds the close at the shutdown: the calls in flight, then the close handshake. At the bound, `terminate()` destroys the socket. */
  readonly close_bound: Quantity;
}

/** A reply is the id of the request that a message answers, and the error of the server when the reply tells one. */
export interface WsReply {
  readonly id: string;
  readonly error?: string | undefined;
}

/**
 * The replies of a protocol tell which message of the server answers which request. WebSocket has no
 * reply of its own: each application protocol puts an id in its messages, for example JSON-RPC 2.0.
 */
export interface WsReplies {
  /** This function reads one message of the server. It gives its reply, or null for a message that answers no request. */
  reply(data: Buffer, binary: boolean): WsReply | null;
}

/** A WebSocket client spec is the declaration of one WebSocket client: where it connects, and its knobs. */
export interface WsClientSpec extends ClientSpec<WsKnobs> {
  /** This path is the path of the upgrade request. The default is "/". */
  readonly path?: string | undefined;
  /** These names are the subprotocols that the client offers (`Sec-WebSocket-Protocol`). */
  readonly protocols?: readonly string[] | undefined;
  /** These headers go with the upgrade request and with the dial, for example `authorization`. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** This count is the number of heartbeat misses in sequence that end the connection. The cells used 1. */
  readonly heartbeatMisses: number;
  /** These replies match a message of the server to its request. Without them, the client sends no request. */
  readonly replies?: WsReplies | undefined;
  /**
   * These operations are the calls of the service, by name, with their idempotency. A message does
   * not tell if the server removes its duplicates. Thus the client sends again only a call that this table names, and a ping.
   */
  readonly operations?: ClientSpec<WsKnobs>["operations"];
}

/** These options make a client. Without them, it uses ws, the real clock, `Math.random`, and a dial with the upgrade request. */
export interface WsClientOptions extends ClientOptions<WsFactory> {
  readonly random?: (() => number) | undefined;
  /**
   * This function waits one turn of the event loop. The heartbeat waits it before it counts a miss,
   * thus a pong that is in the socket counts first. The default is `setImmediate`.
   */
  readonly turn?: (() => Promise<void>) | undefined;
}

/** A join is one generation of the client: one connection, when its upgrade ended with 101 (D1, D2). WebSocket gives no id of a connection. */
export interface WsJoin extends ClientJoin {
  /** This URL is the URL of the connection. */
  readonly url: string;
  /** This text is the subprotocol that the server chose, or "" when it chose none. */
  readonly protocol: string;
}

/** A request is one message to the server, with the id that its reply gives back. */
export interface WsRequest {
  readonly id: string;
  /** This data goes as one message. A string goes as a text message, and a buffer as a binary message. */
  readonly data: string | Buffer;
}

/** A response is the message of the server that answered a request. */
export interface WsResponse {
  readonly data: Buffer;
  readonly binary: boolean;
}

/** A message listener receives each message of the server that answers no request. */
export type WsMessageListener = (data: Buffer, binary: boolean) => void;

/** A WebSocket client is a dependency of a service: its declaration, its handle, its checks and its calls. */
export interface WsClient extends Client<ClientStep, WsJoin> {
  /** This text is the state of the client, as `WS_CLIENT_MACHINE` names it. */
  readonly status: string;
  /**
   * This method sends a request, and waits for its reply. A reply is `ok`, or a certain error when it
   * tells one. The client sends again only an idempotent operation, one time at most, after an outcome that is not certain.
   */
  request(operation: string, call: WsRequest, options?: SendOptions): Promise<Sent<WsResponse>>;
  /** This method sends a ping frame, and waits for a pong. A pong is `ok`. A ping is idempotent, thus the client can send it again. */
  ping(options?: SendOptions): Promise<Sent<void>>;
  /** This method sends one message with no reply. It gives true when ws took the message, and false when the client is not ready. */
  send(data: string | Buffer): boolean;
  /** This method adds a listener of the messages that answer no request. It gives the function that removes it. */
  onMessage(listener: WsMessageListener): () => void;
}

/** These operations are in each table: a ping frame is idempotent (RFC 6455 §5.5.2). */
export const WS_OPERATIONS: Readonly<Record<string, Operation>> = { ping: { idempotent: true } };

/** This function gives the problems of a spec: the knobs that the client cannot use. */
export const specProblems = (name: string, spec: WsClientSpec): string[] => {
  const { knobs } = spec;
  const problems = [
    ...timeProblems(name, knobs),
    // ws has no timer of a call. The open and the pings have a timer of the wrapper too
    ...wrapperTimerProblems(name, knobs, { connect_bound: "an open", request_timeout: "a call", heartbeat_timeout: "a ping of the heartbeat" }),
    ...zeroProblems(name, "the client", knobs, { open: ["heartbeat_interval", "keepalive_idle"] }),
    // Node truncates the keepalive delay to whole seconds
    ...wholeProblems(name, knobs, { seconds: ["keepalive_idle"] }),
    ...retryProblems(name, knobs),
    ...missesProblems(name, spec.heartbeatMisses, "heartbeat"),
    ...ageProblems(name, knobs, "the client does not replace its connection at an age"),
  ];
  // one ping at a time: the time of detection holds only when each tick sends a ping
  const interval = finiteMs(knobs.heartbeat_interval);
  const timeout = finiteMs(knobs.heartbeat_timeout);
  if (interval !== undefined && interval > 0 && timeout !== undefined && spec.heartbeatMisses > 1 && timeout >= interval)
    problems.push(`${name}'s heartbeat_timeout is not below its heartbeat_interval: with one ping at a time, a tick sends no ping while a ping waits`);
  if (spec.path !== undefined && !spec.path.startsWith("/")) problems.push(`${name}'s path does not start with "/"`);
  if (spec.password !== undefined) problems.push(`${name} takes no password: give the credentials in headers, for example authorization`);
  return problems;
};

/** This function gives the URL of a spec. The client speaks ws:// only. */
export const wsUrl = (spec: WsClientSpec): string => `ws://${authority(spec.host, spec.port)}${spec.path ?? "/"}`;

/** This function gives the arguments of `new WebSocket` from a spec. Each timer of ws comes from the declaration. */
export const wsOptions = (spec: WsClientSpec): WsConnectOptions => {
  const { knobs } = spec;
  const keepalive = finiteMs(knobs.keepalive_idle);
  return {
    url: wsUrl(spec),
    protocols: spec.protocols ?? [],
    options: {
      handshakeTimeout: ms(knobs.connect_bound),
      autoPong: true,
      closeTimeout: ms(knobs.close_bound),
      keepAlive: keepalive !== undefined,
      ...(keepalive === undefined ? {} : { keepAliveInitialDelay: keepalive }),
      ...(spec.headers === undefined ? {} : { headers: spec.headers }),
    },
  };
};

/** The key of the dial. RFC 6455 §1.3 gives it as its example. The dial does not read the accept of the server. */
const DIAL_KEY = "dGhlIHNhbXBsZSBub25jZQ==";

/** This function gives the bytes of the dial: the upgrade request of RFC 6455 §4.1, with the subprotocols and the headers of the spec. */
export const upgradeRequest = (spec: Pick<WsClientSpec, "host" | "port" | "path" | "protocols" | "headers">): string => {
  const lines = [
    `GET ${spec.path ?? "/"} HTTP/1.1`,
    `Host: ${authority(spec.host, spec.port)}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${DIAL_KEY}`,
    "Sec-WebSocket-Version: 13",
    ...(spec.protocols === undefined || spec.protocols.length === 0 ? [] : [`Sec-WebSocket-Protocol: ${spec.protocols.join(", ")}`]),
    ...Object.entries(spec.headers ?? {}).map(([header, value]) => `${header}: ${value}`),
  ];
  return `${lines.join("\r\n")}\r\n\r\n`;
};

/** This judge reads the status line of the answer to the upgrade. Only 101 passes: a WebSocket server takes the upgrade. */
export const upgradeJudge: Judge = statusLineJudge((status, line) =>
  status === 101 ? null : new Error(`the server answered ${JSON.stringify(line)} to the upgrade, not 101`),
);

/** This function makes the dial of a spec: a new TCP connection, the upgrade request, and a wait for 101. The dial then destroys its socket. */
export const wsDial =
  (spec: Pick<WsClientSpec, "path" | "protocols" | "headers">): DialFn =>
  (host, port, signal) =>
    helloDial(upgradeRequest({ ...spec, host, port }), upgradeJudge)(host, port, signal);

/** This function gives the payload of a ping: its sequence number as text. */
const payload = (sequence: number): Buffer => Buffer.from(String(sequence), "latin1");

/**
 * This function makes a WebSocket client, a dependency of a service over ws 8.
 * - It has one connection as one generation. The end of the connection ends the generation. The
 *   client then connects again by itself, after a backoff.
 * - Its calls are a request until its reply, and a ping until its pong. Each call has a timer of
 *   the wrapper, because ws has none.
 * - Its heartbeat sends a ping frame each interval, one at a time. A ping with no pong in its timeout
 *   is a miss. At the last miss, `terminate()` destroys the socket at once, and the client connects again.
 * - It tells the outcome of a call in three values, and it settles each call in flight at the end of its generation (C8, C10).
 * - It records the URL and the ends of the socket of each connection at its open (D1).
 *
 * These parts come from the core of the clients: the outcomes, the second try and the wait for a ready
 * client. The backoff and its schedule, the calls in flight, the bounded close and the checks come from
 * the core too. The heartbeat is the heartbeat of the package. This entry gives what ws does in its own way.
 */
export const wsClient = (name: string, spec: WsClientSpec, options: WsClientOptions = {}): WsClient => {
  const problems = specProblems(name, spec);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const { knobs } = spec;
  const clock = options.clock ?? realClock;
  const random = options.random ?? Math.random;
  const create = options.create ?? nodeWs;
  const dial = options.dial ?? wsDial(spec);
  const turn = options.turn ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const operations = operationTable(WS_OPERATIONS, spec.operations);
  const requestTimeout = ms(knobs.request_timeout);
  const url = wsUrl(spec);

  let status = "none";
  let connection: WsConnection | null = null;
  // the token of the open that is current, and the sequence of the ping frames
  let token = 0;
  let sequence = 0;
  let beat: Heartbeat | null = null;
  // this function ends the wait of the close for the close frame of the server
  let closed: (() => void) | null = null;
  const retries = retrySchedule(clock, retryBackoff(knobs), random);
  const joins: WsJoin[] = [];
  const flight = inFlight();
  const readied = readyWait(clock, () => status === "ready");
  const replies = new Map<string, Settle<WsResponse>>();
  const pings = new Map<number, Settle<void>>();
  const listeners = new Set<WsMessageListener>();

  const emit = clientRecorder(options.record, clock, name);
  const record = (on: string, to: string = status, detail?: string): void => {
    const from = status;
    status = to;
    emit(from, to, on, detail);
  };
  const closing = (): boolean => status === "closing" || status === "end";

  /** This function waits for the backoff of the next try, then opens a new generation. */
  const scheduleRetry = (): void =>
    retries.schedule(() => {
      if (closing()) return;
      record("retry.connect", "connecting", `try ${retries.tries}, ${url}`);
      void open();
    });

  /** This function ends the generation that is open. It destroys the socket, because a close frame to a silent server gets no answer. */
  const lose = (on: string, detail: string): void => {
    const c = connection;
    if (c === null) return;
    connection = null;
    beat?.stop();
    beat = null;
    if (closing()) return;
    record(on, "failing", detail);
    flight.settleAll(`the generation ended with the call in flight (${detail})`);
    c.terminate();
    scheduleRetry();
  };

  /** This function gives a message of the server to the call that waits for it, or to the listeners. A late reply goes to nobody. */
  const receive = (data: Buffer, binary: boolean): void => {
    let matched: WsReply | null = null;
    try {
      matched = spec.replies?.reply(data, binary) ?? null;
    } catch {
      // a message that the replies cannot read answers no request
    }
    if (matched !== null) {
      replies.get(matched.id)?.(
        matched.error === undefined ? { outcome: "ok", value: { data, binary } } : { outcome: "error", error: matched.error, reply: true },
      );
      return;
    }
    for (const listener of [...listeners]) listener(data, binary);
  };

  /** This function counts a pong. Each pong answers the heartbeat. A pong for a ping answers each earlier ping too, as RFC 6455 §5.5.3 lets it. */
  const pong = (data: Buffer): void => {
    beat?.answer();
    const text = data.toString("latin1");
    if (!/^\d{1,15}$/.test(text)) return;
    const upTo = Number(text);
    for (const [at, settle] of [...pings]) if (at <= upTo) settle({ outcome: "ok", value: undefined });
  };

  /** This function starts the heartbeat of a generation: one ping at a time, while the client is ready. */
  const startBeat = (): Heartbeat =>
    heartbeat({
      interval: ms(knobs.heartbeat_interval),
      timeout: ms(knobs.heartbeat_timeout),
      misses: spec.heartbeatMisses,
      clock,
      turn,
      due: () => status === "ready",
      live: () => status === "ready",
      ping: () => {
        if (connection === null) throw new Error(`${name} has no connection`);
        connection.ping(payload((sequence += 1)));
      },
      onMiss: (misses) => record("heartbeat.miss", status, `${misses} of ${spec.heartbeatMisses}`),
      onDead: () => lose("heartbeat.dead", `no pong in heartbeat_timeout, ${spec.heartbeatMisses} times in sequence`),
    });

  const join = (c: WsConnection): void => {
    connection = c;
    retries.reset();
    const generation = joins.length + 1;
    joins.push({ generation, at: clock.now(), url, protocol: c.protocol, ...socketEnds(c.socket) });
    record("join", "ready", `generation ${generation}, ${url}`);
    beat = startBeat();
    readied.wake();
  };

  /**
   * This function opens one generation in `connect_bound`. A failure goes to `failing`, and the
   * backoff starts. A connection that opens after its bound or after the close is destroyed at once.
   * The promise resolves when this try ends.
   */
  const open = (): Promise<void> => {
    const mine = (token += 1);
    let opened: WsConnection | null = null;
    let joined = false;
    let finish: () => void = () => {};
    const ended = new Promise<void>((resolve) => (finish = resolve));
    const stale = (): boolean => mine !== token || closing();
    const fail = (detail: string): void => {
      bound();
      finish();
      if (stale()) return;
      token += 1;
      opened?.terminate();
      record("connect.failed", "failing", detail);
      scheduleRetry();
    };
    const bound = clock.after(ms(knobs.connect_bound), () => fail("no open connection in connect_bound"));
    void (async () => {
      const c = await create(wsOptions(spec));
      opened = c;
      if (stale()) {
        c.terminate();
        return;
      }
      c.listen({
        open: () => {
          if (stale()) {
            c.terminate();
            return;
          }
          bound();
          joined = true;
          join(c);
          finish();
        },
        message: (data, binary) => {
          if (c === connection) receive(data, binary);
        },
        pong: (data) => {
          if (c === connection) pong(data);
        },
        close: (code, reason) => {
          if (c === connection) closed?.();
          if (joined) {
            if (c === connection) lose("connection.end", `code ${code}${reason === "" ? "" : `, ${reason}`}`);
          } else if (!stale()) fail(`the connection closed before its open, with code ${code}`);
        },
        error: (error) => {
          if (joined) {
            if (c === connection) record("connection.error", status, message(error));
          } else if (!stale()) fail(message(error));
        },
      });
    })().catch((error: unknown) => fail(message(error)));
    return ended;
  };

  /** This function gives the connection for a call, or the reason that the call does not leave the client. */
  const usable = (signal: AbortSignal | undefined): WsConnection | Attempt<never> => {
    if (status === "none") return notSent(`${name} has not connected`);
    if (status !== "ready" || connection === null) return notSent(`${name} is ${status}, not ready: the call did not leave the client`);
    if (signal?.aborted) return notSent("the caller aborted the call before it left the client");
    return connection;
  };

  /** This function makes one try of a request: the write, then the reply, in `request_timeout`. */
  const requestAttempt = (call: WsRequest, signal: AbortSignal | undefined): Promise<Attempt<WsResponse>> => {
    const c = usable(signal);
    if ("outcome" in c) return Promise.resolve(c);
    if (spec.replies === undefined) return Promise.resolve(notSent(`${name} has no replies in its spec: no message can answer a request`));
    if (replies.has(call.id)) return Promise.resolve(notSent(`${name} has a request with the id ${call.id} in flight`));
    return trackWithTimer<WsResponse>(
      flight,
      clock,
      requestTimeout,
      signal,
      "the caller abandoned the request after it was written",
      "no reply in request_timeout: the server can have applied the request",
      (settle) => {
        replies.set(call.id, settle);
        try {
          c.send(call.data, (error) => {
            if (error !== undefined) settle({ outcome: "indeterminate", error: `the write failed: ${message(error)}` });
          });
        } catch (error) {
          settle(notSent(message(error)));
        }
      },
      () => {
        replies.delete(call.id);
      },
    );
  };

  /** This function makes one try of a ping: the ping frame, then a pong, in `request_timeout`. */
  const pingAttempt = (signal: AbortSignal | undefined): Promise<Attempt<void>> => {
    const c = usable(signal);
    if ("outcome" in c) return Promise.resolve(c);
    const at = (sequence += 1);
    return trackWithTimer<void>(
      flight,
      clock,
      requestTimeout,
      signal,
      "the caller abandoned the ping after it was written",
      "no pong in request_timeout",
      (settle) => {
        pings.set(at, settle);
        try {
          c.ping(payload(at));
        } catch (error) {
          settle(notSent(message(error)));
        }
      },
      () => {
        pings.delete(at);
      },
    );
  };

  const request = (operation: string, call: WsRequest, sendOptions: SendOptions = {}): Promise<Sent<WsResponse>> =>
    sendWithReissue({
      clock,
      bound: requestTimeout,
      operation: operations[operation],
      options: sendOptions,
      attempt: (signal) => requestAttempt(call, signal),
      // the client connects again by itself: the second try waits for a ready client, in the time that is left
      beforeAgain: (left, signal) => readied.wait(left, signal),
      onReissue: () => record("command.reissue", status, operation),
    });

  const ping = (sendOptions: SendOptions = {}): Promise<Sent<void>> =>
    sendWithReissue({
      clock,
      bound: requestTimeout,
      operation: operations["ping"],
      options: sendOptions,
      attempt: (signal) => pingAttempt(signal),
      beforeAgain: (left, signal) => readied.wait(left, signal),
      onReissue: () => record("command.reissue", status, "ping"),
    });

  const send = (data: string | Buffer): boolean => {
    const c = usable(undefined);
    if ("outcome" in c) return false;
    try {
      c.send(data, () => {});
      return true;
    } catch {
      return false;
    }
  };

  const handle: DependencyHandle = {
    async connect(signal) {
      if (signal.aborted) throw new Error(`${name}: the service stopped before the connect`);
      record("status.connecting", "connecting");
      // a server that is down does not stop the startup: the client connects again in the background,
      // and its checks keep readiness tripped until it is ready (readiness is earned)
      await open();
    },
    async close() {
      if (status === "none" || closing()) return;
      record("close.request", "closing");
      retries.cancel();
      // an open in flight is stale now: its connection is destroyed when it opens
      token += 1;
      beat?.stop();
      beat = null;
      const c = connection;
      if (c !== null) {
        // the calls in flight end first, then the close handshake. A silent server answers neither: the bound destroys the socket
        const handshake = flight.idle().then(
          () =>
            new Promise<void>((resolve) => {
              closed = resolve;
              c.close(1000, "the client closed");
            }),
        );
        if (!(await withinBound(clock, ms(knobs.close_bound), handshake))) {
          record("close.bound", "closing");
          record("close.destroy", "closing");
          c.terminate();
        }
        closed = null;
      }
      connection = null;
      flight.settleAll("the client closed with the call in flight");
      record("status.end", "end");
    },
  };

  const interval = finiteMs(knobs.heartbeat_interval);
  const declaration: Omit<Dependency, "name"> = {
    system: spec.system,
    knobs: {
      connect_bound: knobs.connect_bound,
      request_timeout: knobs.request_timeout,
      heartbeat_interval: knobs.heartbeat_interval,
      heartbeat_timeout: knobs.heartbeat_timeout,
      // the last of the misses in sequence fails at its timeout: misses × interval + timeout
      heartbeat_detection_time: heartbeatDetection(knobs.heartbeat_interval, knobs.heartbeat_timeout, spec.heartbeatMisses),
      retry_base: knobs.retry_base,
      retry_cap: knobs.retry_cap,
      keepalive_idle: knobs.keepalive_idle,
      // a ping frame each interval refreshes an idle flow (O03). With no heartbeat, keepalive does
      idle_refresh_interval: interval === undefined ? knobs.keepalive_idle : knobs.heartbeat_interval,
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
      // a ping frame on the connection of the application, until its pong
      "round-trip": roundTripCheck((sendOptions) => ping(sendOptions)),
      // a new connection each time, with the upgrade request
      dial: dialCheck(dial, spec.host, spec.port),
    });

  return {
    name,
    declaration,
    handle,
    meets: wsMeetings(name, knobs, spec.heartbeatMisses),
    get status() {
      return status;
    },
    joins,
    request,
    ping,
    send,
    onMessage(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    checks,
    attach: (svc, checkOptions) => attachClient(svc, name, declaration, handle, checks(checkOptions)),
    problems: (description) => clientProblems(name, description, clientBounds(knobs)),
  };
};
