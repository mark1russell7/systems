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
} from "../client/core.ts";
import {
  ageProblems,
  attachClient,
  clientBounds,
  clientProblems,
  clientRecorder,
  dialCheck,
  finiteMs,
  idleCloseProblem,
  inFlight,
  localStateCheck,
  message,
  ms,
  notSent,
  operationTable,
  readyWait,
  retryProblems,
  roundTripCheck,
  sendWithReissue,
  socketEnds,
  stepChecks,
  timeProblems,
  wholeProblems,
  withinBound,
  wrapperTimerProblems,
  zeroProblems,
} from "../client/core.ts";
import type { Judge } from "../client/dial.ts";
import { authority, helloDial } from "../client/dial.ts";
import { NEVER } from "../client/meets.ts";
import type { Dependency } from "../description.ts";
import type { DependencyHandle } from "../lifecycle.ts";
import type { Operation } from "../operation.ts";
import { heartbeatDetection } from "../timing.ts";
import type { GrpcCallHandle, GrpcChannel, GrpcConnectOptions, GrpcFactory, GrpcState, GrpcStatus } from "./connection.ts";
import { nodeGrpc } from "./connection.ts";
import { grpcMeetings } from "./meets.ts";

/**
 * These are the knobs of the client, each a time, by the names of the ordering law and of the gRPC
 * cells. The runtime has no defaults, thus each knob is necessary. The constant
 * `GRPC_CLIENT_STARTING_KNOBS` gives a declaration from the gRPC cells. The knobs that each client has come from the core.
 */
export interface GrpcKnobs extends ClientKnobs, RetryKnobs {
  /** This time bounds the wait of the startup for a ready channel. The grpc-js driver has no connect timeout, and the wrapper cannot stop one connect. */
  readonly connect_bound: Quantity;
  /** This time is the deadline of each call, from its start. A second try ends in the same bound. The grpc-js driver sends it as `grpc-timeout`. */
  readonly request_timeout: Quantity;
  /** This time is the interval of the HTTP/2 PING of keepalive (`grpc.keepalive_time_ms`). "infinite" sends no PING, as grpc-js does at its defaults. */
  readonly keepalive_time: Extent;
  /** This time bounds the ACK of each PING (`grpc.keepalive_timeout_ms`). With no ACK, grpc-js ends the transport. */
  readonly keepalive_timeout: Quantity;
  /** This time with no call puts the channel in IDLE and closes its connection (`grpc.client_idle_timeout_ms`). The client then connects again. */
  readonly client_idle_timeout: Quantity;
  /**
   * This time is the shortest interval of the PING that the server permits: `MinTime` of the
   * enforcement policy of grpc-go. A shorter keepalive gets GOAWAY too_many_pings (O26). It is a fact of the server, not a knob of the client.
   */
  readonly server_keepalive_min_time: Quantity;
  /** This time is when the server or a proxy ends an idle connection with GOAWAY, or "infinite". The client must close first (O01). */
  readonly server_idle_close: Extent;
  /** This time is the first delay of grpc-js before a new try to connect (`grpc.initial_reconnect_backoff_ms`). */
  readonly retry_base: Quantity;
  /** This time is the most that one delay of grpc-js can be, before its jitter of 20 % (`grpc.max_reconnect_backoff_ms`). */
  readonly retry_cap: Quantity;
  /** The grpc-js driver sets no TCP keepalive on its socket: the PING of `keepalive_time` is its keepalive. Thus this knob must be "infinite". */
  readonly keepalive_idle: Extent;
  /** The client does not replace its connection at an age, thus this knob must be "infinite". */
  readonly max_connection_age: Extent;
  /** This time bounds the close at the shutdown: the calls in flight. At the bound, the client cancels each call, then closes the channel. */
  readonly close_bound: Quantity;
}

/** A gRPC client spec is the declaration of one gRPC client: where it connects, and its knobs. */
export interface GrpcClientSpec extends ClientSpec<GrpcKnobs> {
  /**
   * True sends the PING of keepalive with no call in flight too (`grpc.keepalive_permit_without_calls`).
   * The server must permit that (`PermitWithoutStream` of grpc-go), or it answers with GOAWAY too_many_pings (O26).
   */
  readonly keepaliveWithoutCalls: boolean;
  /** These headers go with each call, for example `authorization`. The metadata of a call adds to them. */
  readonly metadata?: Readonly<Record<string, string>> | undefined;
  /** This name is the service that the round-trip check asks the health service about. The default is "", the whole server. */
  readonly healthService?: string | undefined;
  /**
   * These operations are the methods of the service, by their full path, with their idempotency. The
   * client sends again only a method that this table names as idempotent. `grpcOperations` makes the
   * table from the `idempotency_level` of each method in its proto.
   */
  readonly operations?: ClientSpec<GrpcKnobs>["operations"];
}

/** These options make a client. Without them, it uses grpc-js, the real clock, and a dial with the HTTP/2 preface. */
export type GrpcClientOptions = ClientOptions<GrpcFactory>;

/**
 * A join is one generation of the client: each time that its channel becomes READY (D1, D2). The
 * grpc-js driver gives no socket of its transport, thus the ends of the socket are null.
 */
export interface GrpcJoin extends ClientJoin {
  /** This text is the target of the channel. */
  readonly target: string;
}

/** These options tell how the client sends one call. */
export interface GrpcCallOptions extends SendOptions {
  /** These headers go with this call, after the metadata of the spec. */
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

/** A serving status is the status of a HealthCheckResponse of the health service (grpc.health.v1). */
export type GrpcServingStatus = "UNKNOWN" | "SERVING" | "NOT_SERVING" | "SERVICE_UNKNOWN";

/** A gRPC client is a dependency of a service: its declaration, its handle, its checks and its calls. */
export interface GrpcClient extends Client<ClientStep, GrpcJoin> {
  /** This text is the state of the client, as `GRPC_CLIENT_MACHINE` names it. */
  readonly status: string;
  /**
   * This method sends one unary call, and waits for its status. `request` holds the bytes of the
   * request message, and an OK status gives the bytes of the response message. The client sends again
   * only an idempotent method, one time at most, after an outcome that is not certain.
   */
  call(method: string, request: Buffer, options?: GrpcCallOptions): Promise<Sent<Buffer>>;
  /** This method sends one Check of the health service (grpc.health.v1), and gives the serving status of the reply. */
  health(service?: string, options?: SendOptions): Promise<Sent<GrpcServingStatus>>;
}

/** The names of the status codes of gRPC, by their value. */
export const GRPC_CODES = [
  "OK",
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
  "UNAUTHENTICATED",
] as const;

/**
 * These codes are certain errors: each one tells that the server or a proxy refused the call, and did
 * not apply it. A proxy that answers 401, 403 or 404 gives UNAUTHENTICATED, PERMISSION_DENIED or UNIMPLEMENTED.
 */
const CERTAIN = new Set([3, 5, 6, 7, 9, 10, 11, 12, 16]);

/**
 * These statuses of grpc-js tell that the call did not leave the client. A status with another
 * details text of the same code can come after the send, thus it is indeterminate:
 * - UNAVAILABLE "No connection established": the pick of a channel in TRANSIENT_FAILURE (picker.ts:105).
 * - UNAVAILABLE "Name resolution failed": the resolver found no address (resolver-dns.ts:119).
 * - UNAVAILABLE "Stream refused by server": RST_STREAM REFUSED_STREAM. The server did not process the stream (RFC 9113 §8.7).
 * - INTERNAL "Failed to start HTTP/2 stream": the stream did not start (load-balancing-call.ts:281).
 * - DEADLINE_EXCEEDED with "Waiting for LB pick" or "waiting for name resolution": the deadline came before a stream.
 */
const NOT_SENT: ReadonlyArray<readonly [number, RegExp]> = [
  [14, /^No connection established/],
  [14, /^Name resolution failed/],
  [14, /^Stream refused by server$/],
  [13, /^Failed to start HTTP\/2 stream/],
  [4, /(^|,)(Waiting for LB pick|waiting for name resolution)(,|$)/],
];

/** This function gives the name of a status code, for example "UNAVAILABLE". */
export const codeName = (code: number): string => GRPC_CODES[code] ?? `code ${code}`;

/**
 * This function gives the outcome of one call from its status:
 * - OK is `ok`.
 * - A code that tells that the server refused the call is a certain error: `reply` is true.
 * - A status that tells that the call did not leave the client is a certain error with `reply` false.
 * - Each other status is indeterminate: CANCELLED, UNKNOWN, DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED,
 *   INTERNAL, UNAVAILABLE and DATA_LOSS can come after the server applied the call.
 */
export const grpcOutcome = (status: GrpcStatus, response: Buffer | undefined): Attempt<Buffer> => {
  if (status.code === 0) return { outcome: "ok", value: response ?? Buffer.alloc(0) };
  const error = `${codeName(status.code)}: ${status.details}`;
  if (CERTAIN.has(status.code)) return { outcome: "error", error, reply: true };
  if (NOT_SENT.some(([code, details]) => code === status.code && details.test(status.details))) return notSent(`${error} (the call did not leave the client)`);
  return { outcome: "indeterminate", error };
};

/** This method is the Check of the health service. Its request names a service, and its response gives a serving status. */
export const HEALTH_CHECK = "/grpc.health.v1.Health/Check";

/** These operations are in each table: the Check of the health service has no side effects. */
export const GRPC_OPERATIONS: Readonly<Record<string, Operation>> = { [HEALTH_CHECK]: { idempotent: true } };

/** An idempotency level is the option `idempotency_level` of a method in its proto (descriptor.proto). */
export type GrpcIdempotencyLevel = "IDEMPOTENCY_UNKNOWN" | "NO_SIDE_EFFECTS" | "IDEMPOTENT";

/**
 * This function makes a table of operations from the idempotency level of each method, by its full
 * path. NO_SIDE_EFFECTS and IDEMPOTENT are idempotent. IDEMPOTENCY_UNKNOWN, the default of a proto, is not.
 */
export const grpcOperations = (levels: Readonly<Record<string, GrpcIdempotencyLevel>>): Record<string, Operation> =>
  Object.fromEntries(Object.entries(levels).map(([method, level]) => [method, { idempotent: level !== "IDEMPOTENCY_UNKNOWN" }]));

/** This function gives the bytes of a varint of protobuf. */
const varint = (value: number): Buffer => {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
};

/** This function gives the bytes of a HealthCheckRequest. The service "" is the whole server, and its message is empty. */
export const healthRequest = (service: string): Buffer => {
  if (service === "") return Buffer.alloc(0);
  const name = Buffer.from(service, "utf8");
  return Buffer.concat([Buffer.from([0x0a]), varint(name.length), name]);
};

const SERVING: readonly GrpcServingStatus[] = ["UNKNOWN", "SERVING", "NOT_SERVING", "SERVICE_UNKNOWN"];

/** This function gives the status of a HealthCheckResponse, or null when the bytes are not one. An empty message is UNKNOWN. */
export const healthStatus = (bytes: Buffer): GrpcServingStatus | null => {
  let at = 0;
  let status = 0;
  const read = (): number | null => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = bytes[at];
      if (byte === undefined) return null;
      at += 1;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
    }
    return null;
  };
  while (at < bytes.length) {
    const tag = read();
    if (tag === null) return null;
    const wire = tag & 7;
    if (wire === 0) {
      const value = read();
      if (value === null) return null;
      if (tag >> 3 === 1) status = value;
    } else if (wire === 2) {
      const length = read();
      if (length === null || at + length > bytes.length) return null;
      at += length;
    } else if (wire === 1 || wire === 5) {
      at += wire === 1 ? 8 : 4;
      if (at > bytes.length) return null;
    } else return null;
  }
  return SERVING[status] ?? null;
};

/** The longest timer of Node, in milliseconds. A longer delay starts at 1 ms, thus grpc-js cannot take it. */
const LONGEST_TIMER = 0x7fffffff;

/** This function gives the problems of the times that grpc-js gives to `setTimeout` with no check: each one is at most the longest timer. */
const longestTimerProblems = (name: string, knobs: object, names: readonly string[]): string[] =>
  names.flatMap((knob) => {
    const amount = (knobs as Record<string, Extent>)[knob]!;
    return amount.value !== "infinite" && ms(amount) > LONGEST_TIMER ? [`${name}'s ${knob} is above ${LONGEST_TIMER} ms, the longest timer of Node`] : [];
  });

/** This function gives the problems of a spec: the knobs that the client cannot use. */
export const specProblems = (name: string, spec: GrpcClientSpec): string[] => {
  const { knobs } = spec;
  const timers = ["keepalive_time", "keepalive_timeout", "client_idle_timeout", "retry_base", "retry_cap"];
  const problems = [
    ...timeProblems(name, knobs),
    // The grpc-js driver has no connect timeout, and gives a call no deadline: the wrapper gives both
    ...wrapperTimerProblems(name, knobs, { connect_bound: "the wait of the startup for a ready channel", request_timeout: "a call" }),
    ...zeroProblems(name, "grpc-js", knobs, { open: ["keepalive_time"] }),
    // The grpc-js driver takes each timer in whole milliseconds
    ...wholeProblems(name, knobs, { millis: timers }),
    ...longestTimerProblems(name, knobs, timers),
    ...retryProblems(name, knobs),
    ...ageProblems(name, knobs, "grpc-js does not replace its connection at an age"),
  ];
  for (const knob of ["keepalive_timeout", "client_idle_timeout", "retry_base", "retry_cap"] as const)
    if (finiteMs(knobs[knob]) === undefined || !(ms(knobs[knob]) > 0)) problems.push(`${name}'s ${knob} is not a finite time above zero`);
  // The grpc-js driver raises an idle timeout below 1 s to 1 s (internal-channel.ts:323-326)
  if (ms(knobs.client_idle_timeout) < 1000) problems.push(`${name}'s client_idle_timeout is below 1 s: grpc-js raises it to 1 s`);
  if (knobs.keepalive_idle.value !== "infinite")
    problems.push(`${name}'s keepalive_idle is not "infinite": grpc-js sets no TCP keepalive, and the PING of keepalive_time is its keepalive`);
  if (spec.password !== undefined) problems.push(`${name} takes no password: give the credentials in metadata, for example authorization`);
  return problems;
};

/** This function gives the target of a channel from a spec: the host and the port, for the DNS resolver of grpc-js. */
export const grpcTarget = (spec: Pick<GrpcClientSpec, "host" | "port">): string => authority(spec.host, spec.port);

/**
 * This function gives the arguments of `new Client` from a spec. Each timer of grpc-js comes from the
 * declaration. The retries of grpc-js are off, and the resolver gives no service config.
 */
export const grpcOptions = (spec: GrpcClientSpec): GrpcConnectOptions => {
  const { knobs } = spec;
  const keepalive = finiteMs(knobs.keepalive_time);
  return {
    target: grpcTarget(spec),
    options: {
      "grpc.enable_retries": 0,
      "grpc.service_config_disable_resolution": 1,
      ...(keepalive === undefined ? {} : { "grpc.keepalive_time_ms": keepalive }),
      "grpc.keepalive_timeout_ms": ms(knobs.keepalive_timeout),
      "grpc.keepalive_permit_without_calls": spec.keepaliveWithoutCalls ? 1 : 0,
      "grpc.client_idle_timeout_ms": ms(knobs.client_idle_timeout),
      "grpc.initial_reconnect_backoff_ms": ms(knobs.retry_base),
      "grpc.max_reconnect_backoff_ms": ms(knobs.retry_cap),
    },
  };
};

/** These are the bytes of the dial: the connection preface of the client (RFC 9113 §3.4), and a SETTINGS frame with no setting. */
export const HTTP2_PREFACE: Buffer = Buffer.concat([Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", "latin1"), Buffer.from([0, 0, 0, 4, 0, 0, 0, 0, 0])]);

/**
 * This judge reads the first frame of the server. Only a SETTINGS frame on stream 0, with no ACK,
 * passes: RFC 9113 §3.4 makes it the first frame of an HTTP/2 server. An HTTP/1.1 server answers with a status line.
 */
export const settingsJudge: Judge = (received) => {
  if (received.length < 9) return "more";
  const type = received[3];
  const flags = received[4]!;
  const stream = received.readUInt32BE(5) & 0x7fffffff;
  return type === 0x04 && (flags & 0x01) === 0 && stream === 0
    ? null
    : new Error(`the server did not answer the HTTP/2 preface with a SETTINGS frame: its first bytes are ${received.subarray(0, 9).toString("hex")}`);
};

/** This dial opens a new TCP connection, sends the HTTP/2 preface, and waits for the SETTINGS frame of the server. The dial then destroys its socket. */
export const grpcDial: DialFn = helloDial(HTTP2_PREFACE, settingsJudge);

/**
 * This function makes a gRPC client, a dependency of a service over grpc-js 1.14.
 * - It has one channel for its life. Each time that the channel becomes READY is one generation.
 * - The grpc-js driver connects again by itself, after its own backoff. The client connects an IDLE channel again at once.
 * - A call is one unary call, until its status. Its deadline is the time that is left in `request_timeout`.
 * - It tells the outcome of a call in three values from its status code (C8).
 * - The retries of grpc-js are off, thus only the core sends a call again.
 * - Its keepalive is the HTTP/2 PING of grpc-js. It records the target of each generation (D1).
 *
 * These parts come from the core of the clients: the outcomes, the second try and the wait for a ready client.
 * The calls in flight, the bounded close and the checks come from the core too. This entry gives what grpc-js does in its own way.
 */
export const grpcClient = (name: string, spec: GrpcClientSpec, options: GrpcClientOptions = {}): GrpcClient => {
  const problems = specProblems(name, spec);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const { knobs } = spec;
  const clock = options.clock ?? realClock;
  const create = options.create ?? nodeGrpc;
  const dial = options.dial ?? grpcDial;
  const operations = operationTable(GRPC_OPERATIONS, spec.operations);
  const requestTimeout = ms(knobs.request_timeout);
  const target = grpcTarget(spec);

  let status = "none";
  let channel: GrpcChannel | null = null;
  // This function ends the wait of the startup, at the first READY or TRANSIENT_FAILURE
  let settled: (() => void) | null = null;
  const joins: GrpcJoin[] = [];
  const flight = inFlight();
  const readied = readyWait(clock, () => status === "ready");

  const emit = clientRecorder(options.record, clock, name);
  const record = (on: string, to: string = status, detail?: string): void => {
    const from = status;
    status = to;
    emit(from, to, on, detail);
  };
  const closing = (): boolean => status === "closing" || status === "end";

  /** This function follows one state of the channel. The grpc-js driver ends each call in flight by itself when its transport ends. */
  const follow = (c: GrpcChannel, state: GrpcState): void => {
    if (c !== channel || closing()) return;
    if (state === "READY") {
      if (status === "ready") return;
      const generation = joins.length + 1;
      joins.push({ generation, at: clock.now(), target, ...socketEnds(undefined) });
      record("join", "ready", `generation ${generation}, ${target}`);
      readied.wake();
      settled?.();
    } else if (state === "TRANSIENT_FAILURE") {
      if (status === "failing") return;
      record("connect.failed", "failing", "the channel is in TRANSIENT_FAILURE: grpc-js connects again after its backoff");
      settled?.();
    } else if (state === "CONNECTING") {
      if (status !== "connecting") record("channel.connecting", "connecting", target);
    } else if (state === "IDLE") {
      if (status === "ready") record("connection.end", "idle", "the transport ended: a GOAWAY, a reset, a FIN, the keepalive, or client_idle_timeout");
      else if (status !== "idle") record("channel.idle", "idle", "the channel is IDLE");
      // An IDLE channel connects only for a call: the client connects at once, thus readiness is earned again
      c.state(true);
    }
  };

  /** This function watches the state of the channel. It watches again before it follows, thus no change goes away. */
  const watch = (c: GrpcChannel, current: GrpcState): void =>
    c.watch(current, () => {
      if (c !== channel || closing()) return;
      const next = c.state(false);
      if (next !== "SHUTDOWN") watch(c, next);
      follow(c, next);
    });

  /** This function gives the channel for a call, or the reason that the call does not leave the client. */
  const usable = (signal: AbortSignal | undefined): GrpcChannel | Attempt<never> => {
    if (status === "none") return notSent(`${name} has not connected`);
    if (status !== "ready" || channel === null) return notSent(`${name} is ${status}, not ready: the call did not leave the client`);
    if (signal?.aborted) return notSent("the caller aborted the call before it left the client");
    return channel;
  };

  /** This function makes one try of a call: the unary call until its status, with the deadline that is left. */
  const attempt = (
    method: string,
    request: Buffer,
    metadata: Readonly<Record<string, string>>,
    timeout: number,
    signal: AbortSignal | undefined,
  ): Promise<Attempt<Buffer>> => {
    const c = usable(signal);
    if ("outcome" in c) return Promise.resolve(c);
    if (!(timeout > 0)) return Promise.resolve(notSent("no time is left in request_timeout"));
    let handle: GrpcCallHandle | null = null;
    let ended = false;
    return flight.track<Buffer>(
      signal,
      "the caller abandoned the call after it left the client",
      (settle) => {
        try {
          handle = c.unary(method, request, metadata, timeout, (given, response) => {
            ended = true;
            settle(grpcOutcome(given, response));
          });
        } catch (error) {
          ended = true;
          settle(notSent(message(error)));
        }
      },
      // A call that the caller abandons, or that the close ends, gets RST_STREAM CANCEL
      () => {
        if (!ended) handle?.cancel();
      },
    );
  };

  const call = (method: string, request: Buffer, callOptions: GrpcCallOptions = {}): Promise<Sent<Buffer>> => {
    const started = clock.now();
    const metadata = { ...spec.metadata, ...callOptions.metadata };
    return sendWithReissue({
      clock,
      bound: requestTimeout,
      operation: operations[method],
      options: callOptions,
      // The deadline of each try is the time that is left: a second try ends at the bound of the call
      attempt: (signal) => attempt(method, request, metadata, requestTimeout - (clock.now() - started), signal),
      // The grpc-js driver connects again by itself: the second try waits for a ready channel, in the time that is left
      beforeAgain: (left, signal) => readied.wait(left, signal),
      onReissue: () => record("command.reissue", status, method),
    });
  };

  const health = async (service = "", sendOptions: SendOptions = {}): Promise<Sent<GrpcServingStatus>> => {
    const sent = await call(HEALTH_CHECK, healthRequest(service), sendOptions);
    if (sent.outcome !== "ok") return sent;
    const serving = healthStatus(sent.value);
    return serving === null
      ? { outcome: "error", error: "the response is not a HealthCheckResponse", reply: true, attempts: sent.attempts }
      : { outcome: "ok", value: serving, attempts: sent.attempts };
  };

  const handle: DependencyHandle = {
    async connect(signal) {
      if (signal.aborted) throw new Error(`${name}: the service stopped before the connect`);
      record("status.connecting", "connecting", target);
      let c: GrpcChannel;
      try {
        c = await create(grpcOptions(spec));
      } catch (error) {
        record("connect.failed", "failing", message(error));
        throw error;
      }
      if (closing()) {
        c.close();
        return;
      }
      channel = c;
      const first = new Promise<void>((resolve) => (settled = resolve));
      // A server that is down does not stop the startup: grpc-js connects again in the background,
      // and the checks keep readiness tripped until the channel is ready (readiness is earned)
      const now = c.state(true);
      watch(c, now);
      if (now !== "IDLE") follow(c, now);
      // The wait ends at the first READY or TRANSIENT_FAILURE, or at connect_bound. A connect into a black hole stays CONNECTING
      await withinBound(clock, ms(knobs.connect_bound), first);
      settled = null;
    },
    async close() {
      if (status === "none" || closing()) return;
      record("close.request", "closing");
      settled?.();
      const c = channel;
      if (c !== null) {
        // The calls in flight end first. At the bound, each one gets RST_STREAM CANCEL, and then the channel closes
        if (!(await withinBound(clock, ms(knobs.close_bound), flight.idle()))) {
          record("close.bound", "closing");
          record("close.destroy", "closing", `${flight.size} calls in flight`);
          flight.settleAll("the client closed with the call in flight");
        }
        c.close();
      }
      channel = null;
      flight.settleAll("the client closed with the call in flight");
      record("status.end", "end");
    },
  };

  const keepalive = finiteMs(knobs.keepalive_time);
  const declaration: Omit<Dependency, "name"> = {
    system: spec.system,
    knobs: {
      connect_bound: knobs.connect_bound,
      request_timeout: knobs.request_timeout,
      keepalive_time: knobs.keepalive_time,
      keepalive_timeout: knobs.keepalive_timeout,
      // One PING at a time, and the transport ends at its timeout: keepalive_time + keepalive_timeout
      heartbeat_detection_time: heartbeatDetection(knobs.keepalive_time, knobs.keepalive_timeout, 1),
      client_idle_timeout: knobs.client_idle_timeout,
      retry_base: knobs.retry_base,
      retry_cap: knobs.retry_cap,
      keepalive_idle: knobs.keepalive_idle,
      // A PING with no call in flight refreshes an idle flow (O03). Without it, nothing does
      idle_refresh_interval: spec.keepaliveWithoutCalls && keepalive !== undefined ? knobs.keepalive_time : NEVER,
      max_connection_age: knobs.max_connection_age,
      close_bound: knobs.close_bound,
      retrans_giveup_time: knobs.retrans_giveup_time,
    },
    operations,
  };

  /** The round-trip check passes only for SERVING: a health service that answers NOT_SERVING fails it, as a 5xx fails the HTTP check. */
  const roundTrip = async (sendOptions: SendOptions): Promise<Sent<unknown>> => {
    const sent = await health(spec.healthService ?? "", sendOptions);
    return sent.outcome === "ok" && sent.value !== "SERVING"
      ? { outcome: "error", error: `the health service answered ${sent.value}`, reply: true, attempts: sent.attempts }
      : sent;
  };

  const checks = (checkOptions: CheckOptions) =>
    stepChecks<ClientStep>(name, checkOptions, {
      // The state of the channel, without a round trip
      "local-state": localStateCheck(() => status === "ready"),
      // A Check of the health service on the channel of the application, until its status
      "round-trip": roundTripCheck(roundTrip),
      // A new connection each time, with the HTTP/2 preface
      dial: dialCheck(dial, spec.host, spec.port),
    });

  return {
    name,
    declaration,
    handle,
    meets: grpcMeetings(name, knobs, spec.keepaliveWithoutCalls),
    get status() {
      return status;
    },
    joins,
    call,
    health,
    checks,
    attach: (svc, checkOptions) => attachClient(svc, name, declaration, handle, checks(checkOptions)),
    problems(description) {
      const found = clientProblems(name, description, clientBounds(knobs));
      // O01: the channel must close an idle connection before the server or a proxy does
      const idle = idleCloseProblem(name, knobs.client_idle_timeout, knobs.server_idle_close, "client_idle_timeout");
      if (idle !== null) found.push(idle);
      // O26: a PING more often than the server permits gets GOAWAY too_many_pings
      if (keepalive !== undefined && keepalive < ms(knobs.server_keepalive_min_time))
        found.push(`${name}'s keepalive_time is below server_keepalive_min_time: the server answers with GOAWAY too_many_pings (O26)`);
      return found;
    },
  };
};
