import type { Extent, Quantity } from "@mark1russell7/quantity";
import type { IncomingMessage, Server, ServerEventMap, ServerResponse } from "node:http";
import type { ListenOptions, Socket } from "node:net";
import type { Cancel, Clock } from "../clock.ts";
import { realClock } from "../clock.ts";
import type { LateHold } from "../drains.ts";
import { holdLate, noteOutside } from "../drains.ts";
import { millisecondsOf as knobMilliseconds } from "../knobs.ts";
import type { Lifecycle, TransportImpl } from "../lifecycle.ts";
import { answerOwner, watchAnswers } from "./answers.ts";

/**
 * These are the knobs of an HTTP transport, by the names of the ordering law. The transport has no
 * defaults, thus each knob is necessary. The declaration of the server gets the same record.
 */
export interface HttpKnobs {
  /**
   * This time is the real idle close of the server, which O01 compares with the idle time of a
   * client. Node closes an idle connection at `keepAliveTimeout` plus `keepAliveTimeoutBuffer`.
   * Thus the transport sets `keepAliveTimeout` to this time less the buffer of the server.
   * A time without a bound stops the timer.
   */
  readonly server_idle_close: Extent;
  /**
   * This time is the interval of the sweep of idle connections, from the stop of the intake until the
   * close. A time without a bound gives one sweep, at the stop of the intake.
   */
  readonly server_idle_sweep_interval: Extent;
  /** This time goes in the `Retry-After` of each 503 that the transport gives after its intake stops. */
  readonly server_retry_after: Quantity;
  /** The other knobs of the server go to the declaration. The transport does not read them. */
  readonly [knob: string]: Extent;
}

/**
 * These are the knobs that the transport gives the declaration: the knobs of the caller, and the two
 * times that the transport found. Thus the declaration shows the three times of the idle close.
 */
export interface HttpTransportKnobs extends HttpKnobs {
  /** This time is the hint that each response sends (`Keep-Alive: timeout=…`), in whole seconds. A time without a bound tells that no hint goes. */
  readonly server_idle_close_hint: Extent;
  /** This time is the `keepAliveTimeoutBuffer` of the server, which Node adds to the timer and not to the hint. */
  readonly server_idle_close_buffer: Quantity;
}

/** A mount stage is the stage of the shutdown at which a mount stops: the stop of the intake, or the close. */
export type MountStage = "stop intake" | "close transports";

/** A mount context gives each handler the signals of the shutdown, the lifecycle and the time of a retry. */
export interface MountContext {
  /** This signal aborts when the intake stops. A long stream ends in its own protocol at it. */
  readonly intake: AbortSignal;
  /** This signal aborts at the cooperative abort of the drain, or at the close. The work in flight stops at it. */
  readonly signal: AbortSignal;
  /** This lifecycle is the lifecycle that the transport got at its start, or null before the start. */
  readonly life: Lifecycle | null;
  /** This time is the knob `server_retry_after`: the `Retry-After` of each 503 of the handlers. */
  readonly retryAfter: Quantity;
}

/**
 * A request handler answers a request and gives true, or it gives false and does not touch the
 * response. Then the next handler gets the request. `until` tells when the handler stops.
 */
export interface RequestHandler {
  (req: IncomingMessage, res: ServerResponse, context: MountContext): boolean | Promise<boolean>;
  readonly until?: MountStage | undefined;
}

type UpgradeArgs = ServerEventMap["upgrade"];

/** An upgrade socket is the stream of an upgraded connection, as the `upgrade` event of Node gives it. */
export type UpgradeSocket = UpgradeArgs[1];

/** An upgrade handler takes an upgraded connection, for example a WebSocket server in its `noServer` mode. */
export interface UpgradeHandler {
  (req: IncomingMessage, socket: UpgradeSocket, head: UpgradeArgs[2], context: MountContext): void;
  readonly until?: MountStage | undefined;
}

/** An upgrade match is a path, without its query, or a function that tells if a handler takes a request. */
export type UpgradeMatch = string | ((req: IncomingMessage) => boolean);

/** These options change one mount. */
export interface MountOptions {
  /**
   * This stage is when the mount stops. Without it, the stage of the handler applies, and then
   * `stop intake`. A mount until `close transports` keeps the listener open through the drain.
   */
  readonly until?: MountStage | undefined;
}

/** These options make an HTTP transport. */
export interface HttpTransportOptions {
  /**
   * These are the listen options of `start()`, or a function that makes the server listen. Without
   * them, `start()` takes a server that listens already.
   */
  readonly listen?: ListenOptions | ((server: Server) => Promise<void> | void) | undefined;
  /** This clock is the clock of the lifecycle. The deadline of the drain and the sweep use it. */
  readonly clock?: Clock | undefined;
  /**
   * This function tells if a response can keep its connection open. Without it, the transport reads
   * `life.keepAlive()` of the lifecycle of its start. The transport reads it when the headers of
   * each response go, and false gives `Connection: close`.
   */
  readonly keepAlive?: (() => boolean) | undefined;
  /** This function receives each error of a handler. The transport then answers 500, or it destroys the response. */
  readonly onError?: ((error: unknown, req: IncomingMessage) => void) | undefined;
}

/** An HTTP transport is a server of `node:http` as a transport of the lifecycle, with a list of mounts on its listener. */
export interface HttpTransport extends TransportImpl {
  readonly server: Server;
  /** These knobs go to the declaration of the server: the knobs of the caller, the hint and the buffer. */
  readonly knobs: HttpTransportKnobs;
  /** This method adds a request handler at the end of the list, and gives the function that removes it. */
  mount(handler: RequestHandler, options?: MountOptions): () => void;
  /** This method adds an upgrade handler for a path, and gives the function that removes it. */
  upgrade(match: UpgradeMatch, handler: UpgradeHandler, options?: MountOptions): () => void;
  /** This count is the number of open connections, idle connections and upgraded connections too. */
  readonly connections: number;
  /** This flag tells if the transport stopped its intake. */
  readonly intakeStopped: boolean;
}

interface RequestMount {
  readonly handler: RequestHandler;
  readonly until: MountStage;
}

interface UpgradeMount {
  readonly matches: (req: IncomingMessage) => boolean;
  readonly handler: UpgradeHandler;
  readonly until: MountStage;
}

/** This function gives the path of a request target, without its query and fragment. */
export const pathOf = (url: string | undefined): string => {
  const raw = url ?? "/";
  const end = raw.search(/[?#]/);
  const path = end === -1 ? raw : raw.slice(0, end);
  if (path.startsWith("/")) return path;
  // an absolute target, as a proxy sends it
  try {
    return new URL(raw).pathname;
  } catch {
    return path;
  }
};

/** This function gives a knob in milliseconds, or infinity for a time without a bound. */
const millisecondsOf = (knobs: Readonly<Record<string, Extent | undefined>>, name: string, owner = "httpTransport"): number =>
  knobMilliseconds(knobs, name, owner);

/**
 * This function gives the `Retry-After` of the knob `server_retry_after`, in whole seconds, rounded
 * up. The knob is necessary, and it has a bound.
 */
export const retryAfterOf = (knobs: Readonly<Record<string, Extent | undefined>>, owner: string): string => {
  const retryAfter = millisecondsOf(knobs, "server_retry_after", owner);
  if (!Number.isFinite(retryAfter)) throw new Error("the knob server_retry_after has no bound: a Retry-After needs a time");
  return String(Math.ceil(retryAfter / 1000));
};

/** This function tells if the headers of a call of `writeHead` name a header, an object or a flat list of names and values. */
const names = (headers: unknown, name: string): boolean => {
  if (Array.isArray(headers)) return headers.some((each, at) => at % 2 === 0 && String(each).toLowerCase() === name);
  return typeof headers === "object" && headers !== null && Object.keys(headers).some((key) => key.toLowerCase() === name);
};

/** This function gives the headers of a call of `writeHead` without one header. */
const without = (headers: unknown, name: string): unknown => {
  if (Array.isArray(headers)) {
    const kept: unknown[] = [];
    for (let at = 0; at + 1 < headers.length; at += 2)
      if (String(headers[at]).toLowerCase() !== name) kept.push(headers[at], headers[at + 1]);
    return kept;
  }
  if (typeof headers !== "object" || headers === null) return headers;
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== name));
};

/**
 * This function applies the rule of `Retry-After` to a call of `writeHead`, and gives its arguments.
 * A 503 without `Retry-After` gets the time of `server_retry_after` (RFC 9110). A 500 loses each
 * `Retry-After`, from the call and from the response.
 */
const retryRule = (res: ServerResponse, args: unknown[], retryAfter: string): unknown[] => {
  const status = typeof args[0] === "number" ? args[0] : res.statusCode;
  const at = typeof args[1] === "string" ? 2 : 1;
  if (status === 503 && !res.hasHeader("retry-after") && !names(args[at], "retry-after")) res.setHeader("retry-after", retryAfter);
  if (status !== 500) return args;
  res.removeHeader("retry-after");
  if (!names(args[at], "retry-after")) return args;
  const given = [...args];
  given[at] = without(args[at], "retry-after");
  return given;
};

const STATUS_TEXT: Readonly<Record<number, string>> = { 404: "Not Found", 500: "Internal Server Error", 503: "Service Unavailable" };

/**
 * This function makes a server of `node:http` a transport of the lifecycle (S6 A8 and A13). It is not
 * a framework: it has no routes, no body parser and no middleware.
 * - The count of work in flight comes from events: each response until its `close`, and each upgraded
 *   connection until its `close`.
 * - `stopIntake` closes the listener, and new connections get a refusal. It closes the idle connections
 *   at once and at each `server_idle_sweep_interval`. Each later response gets `Connection: close`.
 *   A connection is not idle while the bytes of its answer go (SYS-33).
 * - `drain` waits until no work is in flight, or until the deadline. It gives the cooperative abort to
 *   the handlers through their context. At the deadline, it also waits for each answer that is to come
 *   or to go out (SYS-29). The cap of the phase bounds that wait. Answers that did not go out by the
 *   cap are not a failure of the phase. A stream outside the lifecycle of the transport does not hold it.
 * - `close` destroys each connection. A second close gives the same promise.
 * - The mounts share one port. The first request handler that gives true answers. After the stop of
 *   the intake, only the mounts until `close transports` answer, and each other request gets a 503.
 */
export const httpTransport = (server: Server, knobs: HttpKnobs, options: HttpTransportOptions = {}): HttpTransport => {
  const clock = options.clock ?? realClock;
  const idleClose = millisecondsOf(knobs, "server_idle_close");
  const sweepEvery = millisecondsOf(knobs, "server_idle_sweep_interval");
  if (sweepEvery === 0)
    throw new Error("the knob server_idle_sweep_interval is zero: a sweep needs an interval above zero");
  const retryAfterHeader = retryAfterOf(knobs, "httpTransport");
  for (const derived of ["server_idle_close_hint", "server_idle_close_buffer"])
    if ((knobs as Readonly<Record<string, Extent | undefined>>)[derived] !== undefined)
      throw new Error(`the knob ${derived} comes from the transport: give only server_idle_close`);
  if (server.listenerCount("request") > 0 || server.listenerCount("upgrade") > 0)
    throw new Error("the server has a request or upgrade listener of its own: mount it as a handler");
  // Node closes an idle connection at keepAliveTimeout + keepAliveTimeoutBuffer, and its hint is
  // keepAliveTimeout. The buffer stays, thus the hint is less than the real close. An older Node has no buffer
  const buffer = (server as { keepAliveTimeoutBuffer?: number }).keepAliveTimeoutBuffer ?? 0;
  if (Number.isFinite(idleClose) && idleClose <= buffer)
    throw new Error(
      `the knob server_idle_close is ${idleClose} ms, at or below the keepAliveTimeoutBuffer of the server, ${buffer} ms: ` +
        "the server closes an idle connection at keepAliveTimeout + keepAliveTimeoutBuffer",
    );
  // 0 stops the keep-alive timer and the hint in Node
  server.keepAliveTimeout = Number.isFinite(idleClose) ? idleClose - buffer : 0;
  const declared: HttpTransportKnobs = {
    ...knobs,
    server_idle_close_hint: Number.isFinite(idleClose)
      ? { value: Math.floor(server.keepAliveTimeout / 1000), unit: "s" }
      : { value: "infinite", unit: "s" },
    server_idle_close_buffer: { value: buffer, unit: "ms" },
  };

  const requestMounts: RequestMount[] = [];
  const upgradeMounts: UpgradeMount[] = [];
  const responses = new Set<ServerResponse>();
  const upgraded = new Set<UpgradeSocket>();
  const sockets = new Set<Socket>();
  // the check of each drain: it ends its drain when nothing holds it
  const drainers = new Set<() => void>();
  const closedWaiters = new Set<() => void>();
  const intake = new AbortController();
  const cooperative = new AbortController();
  // the lifecycle comes at the start, thus the context reads it at each request
  let life: Lifecycle | null = null;
  const context: MountContext = {
    intake: intake.signal,
    signal: cooperative.signal,
    get life() {
      return life;
    },
    retryAfter: knobs.server_retry_after,
  };
  let intakeOpen = true;
  let listenerOpen = server.listening;
  let serverClosed = !server.listening;
  let sweep: Cancel | null = null;
  let closing: Promise<void> | null = null;

  const inFlight = (): number => responses.size + upgraded.size;
  /**
   * This function gives what holds a drain after its deadline. An answer is unflushed when its handler
   * ended it and its bytes did not all go. It is unflushed too while `writeOutcome` waits for a client
   * that does not read. A call runs while `writeOutcome` waits for the end of its request, which the
   * cut of the drain gives. Only a stream of the lifecycle of the transport counts, because only its
   * cut ends the stream. A response that is open for another reason does not hold the drain.
   */
  const lateHold = (): LateHold & { readonly outside: number } => {
    let running = 0;
    let unflushed = 0;
    let outside = 0;
    for (const res of responses) {
      if (res.destroyed) continue;
      if (res.writableEnded) {
        if (!res.writableFinished) unflushed += 1;
        continue;
      }
      const owner = answerOwner(res);
      if (owner === undefined) continue;
      if (life === null || owner !== life) outside += 1;
      else if (res.writableNeedDrain) unflushed += 1;
      else running += 1;
    }
    return { running, unflushed, outside };
  };
  const answering = (): boolean => {
    const hold = lateHold();
    return hold.running + hold.unflushed > 0;
  };
  const report = (error: unknown, req: IncomingMessage): void => {
    try {
      options.onError?.(error, req);
    } catch {
      // an error of the error hook does not stop the transport
    }
  };
  const settled = (): void => {
    for (const check of [...drainers]) check();
    if (closing !== null && inFlight() === 0 && sockets.size === 0 && serverClosed)
      for (const done of [...closedWaiters]) done();
  };
  // before its start, a transport has no lifecycle: a server that listens already keeps its connections
  const keepsAlive = (): boolean => intakeOpen && (options.keepAlive?.() ?? life?.keepAlive() ?? true);
  const live = <T extends { readonly until: MountStage }>(mounts: readonly T[]): T[] =>
    intakeOpen ? [...mounts] : mounts.filter((mount) => mount.until === "close transports");
  const throughDrain = (): boolean =>
    requestMounts.some((mount) => mount.until === "close transports") ||
    upgradeMounts.some((mount) => mount.until === "close transports");
  const closeListener = (): void => {
    if (!listenerOpen) return;
    listenerOpen = false;
    server.close();
  };
  const startSweep = (): void => {
    if (!Number.isFinite(sweepEvery) || closing !== null) return;
    sweep = clock.after(sweepEvery, () => {
      sweep = null;
      if (closing !== null) return;
      server.closeIdleConnections();
      startSweep();
    });
  };

  /**
   * This function watches the headers of each response when they go, whatever wrote them. Each 503
   * gets `Retry-After`, and a 500 gets none. The response closes its connection while the transport
   * cannot keep it.
   */
  const watchHeaders = (res: ServerResponse): void => {
    const writeHead = res.writeHead as (...args: unknown[]) => ServerResponse;
    res.writeHead = ((...args: unknown[]): ServerResponse => {
      if (res.headersSent) return writeHead.apply(res, args);
      if (!keepsAlive()) {
        res.shouldKeepAlive = false;
        res.setHeader("connection", "close");
      }
      return writeHead.apply(res, retryRule(res, args, retryAfterHeader));
    }) as ServerResponse["writeHead"];
  };
  const answer = (res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const body = STATUS_TEXT[status] ?? "";
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": String(Buffer.byteLength(body)), ...headers });
    res.end(body);
  };
  const refuse = (res: ServerResponse): void => answer(res, 503, { "retry-after": retryAfterHeader, connection: "close" });

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const mounts = live(requestMounts);
    try {
      for (const mount of mounts) {
        const given = mount.handler(req, res, context);
        const taken = typeof given === "boolean" ? given : await given;
        // a handler that wrote its response took the request, whatever it gave
        if (taken || res.headersSent || res.writableEnded) return;
      }
    } catch (error) {
      report(error, req);
      if (!res.writableEnded) answer(res, 500);
      return;
    }
    if (intakeOpen) answer(res, 404);
    else refuse(res);
  };

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    responses.add(res);
    // the bytes of an answer went: a drain after its deadline can end
    res.once("finish", settled);
    res.once("close", () => {
      responses.delete(res);
      settled();
    });
    watchHeaders(res);
    void route(req, res);
  };

  const onUpgrade = (req: IncomingMessage, socket: UpgradeSocket, head: UpgradeArgs[2]): void => {
    socket.on("error", () => {});
    const mount = live(upgradeMounts).find((each) => each.matches(req));
    if (mount === undefined) {
      const status = intakeOpen ? 404 : 503;
      const extra = intakeOpen ? "" : `Retry-After: ${retryAfterHeader}\r\n`;
      socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status]!}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`);
      return;
    }
    if (socket.destroyed) return;
    upgraded.add(socket);
    socket.once("close", () => {
      upgraded.delete(socket);
      settled();
    });
    try {
      mount.handler(req, socket, head, context);
    } catch (error) {
      report(error, req);
      socket.destroy();
    }
  };

  const onConnection = (socket: Socket): void => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      settled();
    });
  };

  /**
   * Node counts a connection idle at the `end()` of its response, also while the bytes of the body
   * still go. Then `closeIdleConnections` destroys the socket and cuts the answer (SYS-33). This
   * method replaces it on the server, thus `server.close()` uses it too. Node keeps the socket of
   * a response that did not end. Thus the method shows each answer whose bytes did not go as not
   * ended, for the time of the call.
   */
  const closeIdle = server.closeIdleConnections;
  server.closeIdleConnections = function closeIdleConnections(this: Server): void {
    const going = [...responses].filter((res) => res.writableEnded && !res.writableFinished && !res.destroyed);
    for (const res of going) res.finished = false;
    try {
      closeIdle.call(this);
    } finally {
      for (const res of going) res.finished = true;
    }
  };

  server.on("request", onRequest);
  server.on("upgrade", onUpgrade);
  server.on("connection", onConnection);
  server.on("listening", () => {
    listenerOpen = true;
    serverClosed = false;
  });
  server.on("close", () => {
    listenerOpen = false;
    serverClosed = true;
    settled();
  });

  const remover = <T>(list: T[], entry: T) => (): void => {
    const at = list.indexOf(entry);
    if (at >= 0) list.splice(at, 1);
    // the last mount through the drain went: the listener closes as the stop of the intake asks
    if (!intakeOpen && closing === null && !throughDrain()) closeListener();
  };

  return {
    server,
    knobs: declared,
    get connections() {
      return sockets.size;
    },
    get intakeStopped() {
      return !intakeOpen;
    },
    mount(handler, mountOptions = {}) {
      const entry: RequestMount = { handler, until: mountOptions.until ?? handler.until ?? "stop intake" };
      requestMounts.push(entry);
      return remover(requestMounts, entry);
    },
    upgrade(match, handler, mountOptions = {}) {
      const matches = typeof match === "string" ? (req: IncomingMessage) => pathOf(req.url) === match : match;
      const entry: UpgradeMount = { matches, handler, until: mountOptions.until ?? handler.until ?? "stop intake" };
      upgradeMounts.push(entry);
      return remover(upgradeMounts, entry);
    },
    async start(_signal, given) {
      life = given;
      if (closing !== null) throw new Error("the transport closed: a closed transport does not start again");
      // a listener that another owner adds after the transport answers too, thus the start refuses it
      if (server.listenerCount("request") > 1 || server.listenerCount("upgrade") > 1)
        throw new Error("the server has a request or upgrade listener of its own: mount it as a handler");
      if (server.listening) return;
      const listen = options.listen;
      if (listen === undefined) throw new Error("the server does not listen, and the transport has no listen options");
      if (typeof listen === "function") {
        await listen(server);
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => {
          server.off("listening", listened);
          reject(error);
        };
        const listened = (): void => {
          server.off("error", failed);
          resolve();
        };
        server.once("error", failed);
        server.once("listening", listened);
        server.listen(listen);
      });
    },
    stopIntake() {
      if (!intakeOpen) return;
      intakeOpen = false;
      intake.abort(new Error("the transport stopped its intake"));
      if (!throughDrain()) closeListener();
      server.closeIdleConnections();
      startSweep();
    },
    drain(deadline, signal) {
      const abort = (): void => {
        if (!cooperative.signal.aborted) cooperative.abort(signal.reason);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      // nothing in flight: the drain ends at once, with no timer
      if (inFlight() === 0) {
        signal.removeEventListener("abort", abort);
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        let cancel: Cancel = () => {};
        let unwatch: () => void = () => {};
        let unhold: () => void = () => {};
        let late = false;
        let ended = false;
        // before the deadline, the work in flight holds the drain. After it, only an answer to come or to go out holds it
        const check = (): void => {
          if (ended || (inFlight() > 0 && (!late || answering()))) return;
          ended = true;
          drainers.delete(check);
          cancel();
          unwatch();
          unhold();
          signal.removeEventListener("abort", abort);
          resolve();
        };
        // the cut of the requests comes at the same time, before or after this timer: the drain waits for its answers in each case
        const reached = (): void => {
          late = true;
          unwatch = watchAnswers(check);
          // the lifecycle reads the hold at the cap: answers that do not go out are not a failure of the phase
          if (life !== null) {
            unhold = holdLate(life, () => {
              const { running, unflushed } = lateHold();
              return { running, unflushed };
            });
            // a stream outside the lifecycle does not hold the drain: the record of the phase gives the count
            noteOutside(life, lateHold().outside);
          }
          check();
        };
        drainers.add(check);
        if (deadline <= clock.now()) reached();
        else cancel = clock.after(deadline - clock.now(), reached);
      });
    },
    inFlight,
    close() {
      if (closing !== null) return closing;
      intakeOpen = false;
      if (!intake.signal.aborted) intake.abort(new Error("the transport closed"));
      if (!cooperative.signal.aborted) cooperative.abort(new Error("the transport closed"));
      sweep?.();
      sweep = null;
      closing = new Promise<void>((resolve) => {
        closedWaiters.add(resolve);
      });
      closeListener();
      server.closeAllConnections();
      for (const socket of [...upgraded]) socket.destroy();
      for (const socket of [...sockets]) socket.destroy();
      settled();
      return closing;
    },
  };
};
