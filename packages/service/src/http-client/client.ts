import type { Extent, Quantity } from "@mark1russell7/quantity";
import type { Cancel } from "../clock.ts";
import { realClock } from "../clock.ts";
import type { Attempt, CheckOptions, Client, ClientJoin, ClientKnobs, ClientOptions, ClientSpec, ClientStep, DialFn, SendOptions, Sent } from "../client/core.ts";
import {
  ageProblems,
  attachClient,
  clientBounds,
  clientProblems,
  clientRecorder,
  dialCheck,
  idleCloseProblem,
  inFlight,
  keepaliveOnProblems,
  localStateCheck,
  message,
  ms,
  notSent,
  operationTable,
  poolProblems,
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
import type { Operation } from "../operation.ts";
import type { AgentExchange, AgentFactory, HttpAgent, HttpAgentOptions, HttpResponse, HttpSocket } from "./connection.ts";
import { nodeAgent } from "./connection.ts";
import { httpClientMeetings } from "./meets.ts";

/**
 * These are the knobs of the client, each a time, by the names of the ordering law where the law
 * has them. The runtime has no defaults, thus each knob is necessary. The constant
 * `HTTP_CLIENT_STARTING_KNOBS` gives a declaration from the HTTP cells. The knobs that each client has come from the core.
 */
export interface HttpClientKnobs extends ClientKnobs {
  /** This time bounds the TCP connect of a new socket. The wrapper has this timer, because the agent has none. */
  readonly connect_bound: Quantity;
  /**
   * This time bounds each call: from its start until the end of the body of its response. It also
   * bounds the wait for a socket. The wrapper has this timer, because the agent has none.
   */
  readonly request_timeout: Quantity;
  /**
   * This time is the free socket timer of the agent (`timeout`). The agent closes a free socket at the
   * smaller of this time and the hint of the server less `hint_buffer`. It must be below `server_idle_close` (O01).
   */
  readonly pool_idle_expiry: Extent;
  /** This time is what the agent subtracts from the hint of the server (`agentKeepAliveTimeoutBuffer`). A hint at or below it gives no reuse. */
  readonly hint_buffer: Quantity;
  /**
   * This time is when the server closes an idle connection, after its response. A Node server closes
   * at `keepAliveTimeout` plus `keepAliveTimeoutBuffer`. "infinite" is a server that keeps an idle
   * connection with no bound. The client does not set it: `problems` compares it with `pool_idle_expiry` (O01).
   */
  readonly server_idle_close: Extent;
  /** This time is the idle time of TCP keepalive (`keepAliveMsecs`), in whole seconds. The agent always turns keepalive on. */
  readonly keepalive_idle: Extent;
  /** The agent does not replace a connection at an age, thus this knob must be "infinite". */
  readonly max_connection_age: Extent;
  /** This time bounds the close of the client: the wait for the calls in flight, then a destroy of each socket. */
  readonly close_bound: Quantity;
}

/** A check request is the request of the round-trip check, and of the first connection at the connect. */
export interface CheckRequest {
  readonly method: string;
  readonly path: string;
}

/**
 * This request asks about the server, not about a resource (RFC 9110 §9.3.7). Thus it changes no
 * state. A server that does not route it still answers with a status, and the status tells that it is alive.
 */
export const OPTIONS_STAR: CheckRequest = { method: "OPTIONS", path: "*" };

/** An HTTP client spec is the declaration of one HTTP client: the origin that it connects to, its pool, and its knobs. */
export interface HttpClientSpec extends ClientSpec<HttpClientKnobs> {
  /** This count is the most sockets of the pool (`maxSockets`). It is also the most free sockets. */
  readonly pool: { readonly max: number };
  /** This request is the request of the round-trip check and of the first connection. Without it, the client uses `OPTIONS *`. */
  readonly check?: CheckRequest | undefined;
  /**
   * These operations add to the table of the client, or change it. The table names each method by
   * its idempotency in RFC 9110. A caller can name an operation of its own, for example a POST with an `Idempotency-Key`.
   */
  readonly operations?: Readonly<Record<string, Operation>> | undefined;
}

/** These options make a client. Without them, it uses the agent of Node, the real clock, and a dial with `OPTIONS *`. */
export type HttpClientOptions = ClientOptions<AgentFactory>;

/** An HTTP call is one request. A string body goes as UTF-8, with its `content-length`. */
export interface HttpCall {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | Uint8Array | undefined;
  /** This name is the operation of the call in the table. Without it, the operation is the method. */
  readonly operation?: string | undefined;
}

/** An HTTP client is a dependency of a service: its declaration, its handle, its checks and its requests. */
export interface HttpClient extends Client<ClientStep, ClientJoin> {
  /** This text is the state of the client, as `HTTP_CLIENT_MACHINE` names it. */
  readonly status: string;
  /**
   * This method sends a request, and gives its outcome in three values. A whole response of each
   * status is `ok`. The client sends again only an idempotent operation, one time at most, after an
   * outcome that is not certain. The second try stays in the bound of the request.
   */
  request(call: HttpCall, options?: SendOptions): Promise<Sent<HttpResponse>>;
}

/**
 * These operations are the methods of HTTP, by their idempotency in RFC 9110 §9.2.2. A second
 * request of GET, HEAD, OPTIONS, TRACE, PUT or DELETE has the same effect as one. POST and PATCH do not.
 */
export const HTTP_OPERATIONS: Readonly<Record<string, Operation>> = {
  GET: { idempotent: true },
  HEAD: { idempotent: true },
  OPTIONS: { idempotent: true },
  TRACE: { idempotent: true },
  PUT: { idempotent: true },
  DELETE: { idempotent: true },
  POST: { idempotent: false },
  PATCH: { idempotent: false },
};

/** This function gives the problems of a spec: the knobs that the agent cannot use. */
export const specProblems = (name: string, spec: HttpClientSpec): string[] => {
  const { knobs } = spec;
  const problems = [
    ...timeProblems(name, knobs),
    // the agent has no timer of a connect or of a call
    ...wrapperTimerProblems(name, knobs, { connect_bound: "a connect", request_timeout: "a call" }),
    // the agent reads a timeout of 0 as no free socket timer, and then the hint of the server does not apply
    ...zeroProblems(name, "the agent", knobs, { bounded: ["pool_idle_expiry"] }),
    ...keepaliveOnProblems(name, knobs, "the agent"),
    // Node truncates the keepalive delay to whole seconds
    ...wholeProblems(name, knobs, { millis: ["connect_bound", "request_timeout", "pool_idle_expiry", "hint_buffer"], seconds: ["keepalive_idle"] }),
    ...poolProblems(name, { max: spec.pool.max, min: 0 }),
    ...ageProblems(name, knobs, "the agent does not replace a connection at an age"),
  ];
  if (!Number.isFinite(ms(knobs.hint_buffer))) problems.push(`${name}'s hint_buffer is not a finite time: the agent subtracts it from the hint of the server`);
  return problems;
};

/** This function gives the options of `new http.Agent` from a spec. Each timer of the agent comes from the declaration. */
export const agentOptions = (spec: HttpClientSpec): HttpAgentOptions => {
  const { knobs } = spec;
  return {
    keepAlive: true,
    timeout: ms(knobs.pool_idle_expiry),
    agentKeepAliveTimeoutBuffer: ms(knobs.hint_buffer),
    keepAliveMsecs: ms(knobs.keepalive_idle),
    maxSockets: spec.pool.max,
    maxFreeSockets: spec.pool.max,
    scheduling: "lifo",
  };
};

/** This function gives the authority of a host and a port for a Host header. An IPv6 address goes in brackets. */
const authority = (host: string, port: number): string => `${host.includes(":") ? `[${host}]` : host}:${port}`;

/** This function gives the bytes of the dial: `OPTIONS *` with the Host header, and a close after the answer. */
export const optionsRequest = (host: string, port: number): string => `OPTIONS * HTTP/1.1\r\nHost: ${authority(host, port)}\r\nConnection: close\r\n\r\n`;

/** This judge reads the status line of the answer. Any status passes, because it tells that an HTTP server answered. */
export const statusJudge: Judge = (received) => {
  const end = received.indexOf("\r\n");
  if (end < 0) return received.length > 8192 ? new Error("the answer has no status line in its first 8 KiB") : "more";
  const line = received.toString("latin1", 0, end);
  return /^HTTP\/1\.[01] \d{3}/.test(line) ? null : new Error(`the answer ${JSON.stringify(line)} is not an HTTP/1.1 status line`);
};

/** This dial function opens a TCP connection, sends `OPTIONS *`, and waits for the status line. It changes no state on the server. */
export const httpDial: DialFn = (host, port, signal) => helloDial(optionsRequest(host, port), statusJudge)(host, port, signal);

/**
 * This function makes an HTTP client, a dependency of a service over an `http.Agent` of Node.
 * - It sets each timer of the agent from the declaration. The agent sends no request again by itself,
 *   and the client sends again only an idempotent operation of its table.
 * - Its call is a request until the end of the body of its response. The wrapper has a timer for the
 *   connect and one for the call, because the agent has none.
 * - It tells the outcome of a call in three values. A request that did not get a connected socket
 *   did not leave the client. A failure after that is not certain.
 * - It destroys the socket of each call that is not `ok`, thus no later request gets that socket.
 * - It records each new socket of the pool (D1). HTTP gives no id of a connection.
 *
 * The core of the clients gives the outcomes, the second try, the calls in flight and the timer of a
 * call. It also gives the bounded close and the checks. This entry gives what the agent does in its own way.
 */
export const httpClient = (name: string, spec: HttpClientSpec, options: HttpClientOptions = {}): HttpClient => {
  const problems = specProblems(name, spec);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const { knobs } = spec;
  const clock = options.clock ?? realClock;
  const create = options.create ?? nodeAgent;
  const dial = options.dial ?? httpDial;
  const operations = operationTable(HTTP_OPERATIONS, spec.operations);
  const requestTimeout = ms(knobs.request_timeout);
  const connectBound = ms(knobs.connect_bound);
  const check = spec.check ?? OPTIONS_STAR;

  let agent: HttpAgent | null = null;
  let status = "none";
  const joins: ClientJoin[] = [];
  // the calls that left the client: the close waits for them, in its bound
  const flight = inFlight();
  // the calls that did not leave the client: the close ends each one as not sent
  const waiting = new Set<(error: string) => void>();

  const emit = clientRecorder(options.record, clock, name);
  // the state of the client is the outcome of the last connect of a socket of its pool
  const record = (on: string, to: string = status, detail?: string): void => {
    const from = status;
    status = to;
    emit(from, to, on, detail);
  };
  const closing = (): boolean => status === "closing" || status === "end";

  /**
   * This function makes one try of a call. The try waits for a socket of the agent: a free one, or a
   * new one in `connect_bound`. A failure before the socket is ready is certain: the request did not
   * leave the client. After that, the try waits for the whole response in the rest of `request_timeout`.
   */
  const attempt = async (call: HttpCall, signal: AbortSignal | undefined): Promise<Attempt<HttpResponse>> => {
    const a = agent;
    if (a === null) return notSent(`${name} has not connected`);
    if (closing()) return notSent(`${name} is ${status}: the request did not leave the client`);
    if (signal?.aborted) return notSent("the caller aborted the request before it left the client");
    const started = clock.now();
    const body = typeof call.body === "string" ? Buffer.from(call.body, "utf8") : call.body;
    const headers = { ...call.headers, ...(body === undefined ? {} : { "content-length": String(body.byteLength) }) };

    let socket: HttpSocket | undefined;
    let reused = false;
    let left = false;
    // true when the wrapper ended the try itself: the error of the agent that follows is not a failed connect
    let ending = false;
    let connectTimer: Cancel = () => {};
    let decide: (value: true | Attempt<never>) => void = () => {};
    const leaving = new Promise<true | Attempt<never>>((resolve) => {
      let decided = false;
      decide = (value) => {
        if (decided) return;
        decided = true;
        resolve(value);
      };
    });
    // a result of the agent that arrives before the try records it
    let deliver: ((value: Attempt<HttpResponse>, cause?: Error) => void) | null = null;
    let early: { readonly value: Attempt<HttpResponse>; readonly cause: Error | undefined } | null = null;
    let settled = false;
    const settleWith = (value: Attempt<HttpResponse>, cause?: Error): void => {
      if (deliver === null) early ??= { value, cause };
      else deliver(value, cause);
    };

    let exchange: AgentExchange | null = null;
    const stop = (text: string): void => {
      if (left) return;
      ending = true;
      connectTimer();
      exchange?.abort(new Error(text));
      decide(notSent(text));
    };
    const ready = (): void => {
      left = true;
      connectTimer();
      decide(true);
    };
    exchange = a.request(
      { host: spec.host, port: spec.port, method: call.method, path: call.path, headers, body },
      {
        socket(given, isReused) {
          socket = given;
          reused = isReused;
          if (isReused) {
            ready();
            return;
          }
          connectTimer = clock.after(connectBound, () => {
            if (left) return;
            record("connect.failed", closing() ? status : "failing", "no connection in connect_bound");
            stop("no connection in connect_bound: the request did not leave the client");
          });
        },
        connect() {
          const generation = joins.length + 1;
          joins.push({ generation, at: clock.now(), ...socketEnds(socket) });
          record("join", closing() ? status : "ready", `socket ${generation}`);
          ready();
        },
      },
    );
    // the agent can fail a request in its queue or at its connect: it did not leave the client
    exchange.response.then(
      (response) => settleWith({ outcome: "ok", value: response }),
      (error: unknown) => {
        const cause = error instanceof Error ? error : new Error(message(error));
        if (!left) {
          connectTimer();
          if (!ending) record("connect.failed", closing() ? status : "failing", message(error));
          decide(notSent(message(error)));
          return;
        }
        // the abort of the wrapper after the call settled is not a failure of the socket
        if (settled) return;
        // a reused socket that fails before the response: the server closed it, as in the keep-alive race
        if (reused) record("reuse.failed", status, message(error));
        settleWith({ outcome: "indeterminate", error: message(error) }, cause);
      },
    );

    const abandoned = (): void => stop("the caller abandoned the request before it left the client");
    signal?.addEventListener("abort", abandoned, { once: true });
    const queued = clock.after(requestTimeout, () => stop("no socket in request_timeout: the request did not leave the client"));
    waiting.add(stop);
    const got = await leaving;
    signal?.removeEventListener("abort", abandoned);
    queued();
    waiting.delete(stop);
    if (got !== true) return got;

    const sent = exchange;
    return trackWithTimer<HttpResponse>(
      flight,
      clock,
      Math.max(0, requestTimeout - (clock.now() - started)),
      signal,
      "the caller abandoned the request after it left the client",
      "no whole response in request_timeout: the server can have the request",
      (settle) => {
        deliver = settle;
        if (early !== null) settle(early.value, early.cause);
      },
      (value, cause) => {
        settled = true;
        // the socket of a call that is not ok can hold a part of a response: it goes, and no later request gets it
        if (value.outcome !== "ok") sent.abort(cause ?? new Error(value.error));
      },
    );
  };

  const request = (call: HttpCall, sendOptions: SendOptions = {}): Promise<Sent<HttpResponse>> => {
    const method = call.method.toUpperCase();
    const named = call.operation ?? method;
    return sendWithReissue({
      clock,
      bound: requestTimeout,
      operation: operations[named],
      options: sendOptions,
      attempt: (signal) => attempt({ ...call, method }, signal),
      onReissue: () => record("command.reissue", status, named),
    });
  };

  const handle: DependencyHandle = {
    async connect(signal) {
      record("status.connecting", "connecting");
      agent = await create(agentOptions(spec));
      if (signal.aborted) throw new Error(`${name}: the service stopped before the connect`);
      // the check request opens the first socket of the pool. A server that is down does not stop the
      // startup: the checks keep readiness tripped until a connect succeeds (readiness is earned)
      await request(check, { signal, reissue: false });
    },
    async close() {
      const a = agent;
      if (a === null || closing()) return;
      record("close.request", "closing");
      for (const stop of [...waiting]) stop("the client closed before the request left");
      // the agent has no close that waits: the client waits for its calls in flight, in its bound
      if (!(await withinBound(clock, ms(knobs.close_bound), flight.idle()))) {
        record("close.bound");
        const open = a.sockets().length;
        flight.settleAll("the client closed with the request in flight");
        a.destroy();
        record("close.destroy", status, `open sockets: ${open}`);
      } else {
        // each free socket closes with a FIN
        a.destroy();
      }
      record("status.end", "end");
    },
  };

  const declaration: Omit<Dependency, "name"> = {
    system: spec.system,
    knobs: {
      connect_bound: knobs.connect_bound,
      request_timeout: knobs.request_timeout,
      pool_idle_expiry: knobs.pool_idle_expiry,
      hint_buffer: knobs.hint_buffer,
      keepalive_idle: knobs.keepalive_idle,
      // the agent sends nothing on a free socket, thus its keepalive is the only refresh of an idle flow (O03)
      idle_refresh_interval: knobs.keepalive_idle,
      max_connection_age: knobs.max_connection_age,
      close_bound: knobs.close_bound,
      retrans_giveup_time: knobs.retrans_giveup_time,
    },
    operations,
  };

  const checks = (checkOptions: CheckOptions) =>
    stepChecks<ClientStep>(name, checkOptions, {
      // the outcome of the last connect of a socket, without a round trip
      "local-state": localStateCheck(() => status === "ready"),
      // the check request through the pool of the application. A status of 500 or more fails it
      "round-trip": roundTripCheck(async (sendOptions) => {
        const sent = await request(check, sendOptions);
        return sent.outcome === "ok" && sent.value.status >= 500
          ? { outcome: "error", error: `the server answered ${sent.value.status}`, reply: true, attempts: sent.attempts }
          : sent;
      }),
      // a new connection each time, with OPTIONS *
      dial: dialCheck(dial, spec.host, spec.port),
    });

  return {
    name,
    declaration,
    handle,
    meets: httpClientMeetings(name, knobs),
    get status() {
      return status;
    },
    joins,
    request,
    checks,
    attach: (svc, checkOptions) => attachClient(svc, name, declaration, handle, checks(checkOptions)),
    problems(description) {
      // O01: the pool must close an idle socket before the server does
      const idle = idleCloseProblem(name, knobs.pool_idle_expiry, knobs.server_idle_close);
      return [...clientProblems(name, description, clientBounds(knobs)), ...(idle === null ? [] : [idle])];
    },
  };
};
