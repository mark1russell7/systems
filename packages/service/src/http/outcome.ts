import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Refused } from "../limiter/policy.ts";
import { retryAfterSeconds } from "../limiter/policy.ts";
import type { RequestEnd, RequestEvent, RequestOptions, RequestStream, RequestWork } from "../requests.ts";
import type { MountContext, RequestHandler } from "./transport.ts";
import { pathOf } from "./transport.ts";

/** An outcome response is the status, the headers and the body of a request, for any HTTP framework or none. */
export interface OutcomeResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array;
}

/** A response part is what a hook gives for one value or one failure. The parts that it does not give keep the values of the mapping. */
export interface ResponsePart {
  readonly status?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | Uint8Array | undefined;
}

/**
 * A stream format writes the items of a stream and its end in the body, as they come. An end after
 * the first item goes in the body, because the status went with the first item.
 */
export interface StreamFormat<T = unknown> {
  readonly contentType: string;
  /** This function gives the bytes of one item. */
  item(value: T): string | Uint8Array;
  /** This function gives the bytes of the end, the last part of the body. */
  end(end: RequestEnd): string | Uint8Array;
}

/** These options map a request to a response. */
export interface OutcomeOptions<T> {
  /**
   * This value tells if the response can keep its connection open, as `life.keepAlive()` does. False
   * gives `Connection: close`. A function is read when the headers go.
   */
  readonly keepAlive: boolean | (() => boolean);
  /** This time goes in the `Retry-After` of each 503, in whole seconds, rounded up. It is the knob `server_retry_after`. */
  readonly retryAfter: Quantity;
  /**
   * This function gives the response of the value of a unary request. Without it, the mapping gives
   * 200 and the value as JSON, or 204 for no value.
   */
  readonly done?: ((value: T) => ResponsePart) | undefined;
  /**
   * This function gives the response of a failure of the route before the first byte. Without it,
   * the mapping gives 500 with no detail, because an error can hold private data.
   */
  readonly failed?: ((error: unknown) => ResponsePart) | undefined;
  /**
   * This format makes the response a stream: the status and each item go as they come, and the end
   * goes in the body. Without it, the response is unary: one status and the one value.
   */
  readonly stream?: StreamFormat<T> | undefined;
}

const JSON_TYPE = "application/json; charset=utf-8";

/**
 * This function gives an end as a record for a body: its kind and the count of its items. A cut and
 * a refusal also give their cause, and if the caller can send the request again. A failure gives
 * no detail.
 */
export const endRecord = (end: RequestEnd): Readonly<Record<string, unknown>> => {
  if (end.kind === "refused" || end.kind === "cut")
    return { end: end.kind, delivered: end.delivered, retryable: end.retryable, cause: end.cause };
  return { end: end.kind, delivered: end.delivered };
};

/** This format writes each item and the end as one line of JSON (NDJSON). */
export const ndjson: StreamFormat = {
  contentType: "application/x-ndjson; charset=utf-8",
  item: (value) => `${JSON.stringify(value)}\n`,
  end: (end) => `${JSON.stringify(endRecord(end))}\n`,
};

/** This format writes each item as an event of server-sent events, and the end as the event `end`. */
export const sse: StreamFormat = {
  contentType: "text/event-stream; charset=utf-8",
  item: (value) => `data: ${JSON.stringify(value)}\n\n`,
  end: (end) => `event: end\ndata: ${JSON.stringify(endRecord(end))}\n\n`,
};

const valueResponse = (value: unknown): OutcomeResponse => {
  if (value === undefined) return { status: 204, headers: {}, body: "" };
  if (typeof value === "string") return { status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, body: value };
  if (value instanceof Uint8Array) return { status: 200, headers: { "content-type": "application/octet-stream" }, body: value };
  return { status: 200, headers: { "content-type": JSON_TYPE }, body: JSON.stringify(value) };
};

const merge = (base: OutcomeResponse, part: ResponsePart | undefined): OutcomeResponse =>
  part === undefined
    ? base
    : { status: part.status ?? base.status, headers: { ...base.headers, ...part.headers }, body: part.body ?? base.body };

const keeps = (keepAlive: boolean | (() => boolean)): boolean => (typeof keepAlive === "function" ? keepAlive() : keepAlive);

/**
 * This function applies the rules of the headers to a response. Each 503 gets `Retry-After`, and a
 * 500 gets none. The response closes its connection while the service cannot keep it.
 */
const ruled = (response: OutcomeResponse, retryAfter: Quantity, keepAlive: boolean | (() => boolean)): OutcomeResponse => {
  const headers: Record<string, string> = { ...response.headers };
  if (response.status === 503 && headers["retry-after"] === undefined)
    headers["retry-after"] = String(Math.max(0, Math.ceil(valueIn(retryAfter, "s"))));
  if (response.status === 500) delete headers["retry-after"];
  if (!keeps(keepAlive)) headers["connection"] = "close";
  return { ...response, headers };
};

/** This function gives the status response of an end before the first byte of the body. */
const endStatus = <T>(end: RequestEnd, options: OutcomeOptions<T>): OutcomeResponse => {
  const body = JSON.stringify(endRecord(end));
  switch (end.kind) {
    case "refused":
      return { status: 503, headers: { "content-type": JSON_TYPE }, body };
    case "cut":
      // a cut after the first item has no status of its own, but no byte went: its route decides
      return { status: end.status ?? (end.retryable ? 503 : 500), headers: { "content-type": JSON_TYPE }, body };
    case "failed":
      return merge({ status: 500, headers: { "content-type": JSON_TYPE }, body }, options.failed?.(end.error));
    case "done":
      return { status: 204, headers: {}, body: "" };
  }
};

/**
 * This function maps a unary request to its response, from its items and its end (S6 A12 and A13).
 * - One value and the end `done`: 200 with the value, or the response of the `done` hook.
 * - No value and the end `done`: 204. More than one value: 500, because the route is not a stream.
 * - `refused`: 503. The work did not start, thus the caller can send it again. The service did not
 *   start, it stopped its intake, or a controller is not ready.
 * - `cut`: 503 for a route whose callers can send it again (S6 A12), and 500 for each other route.
 * - `failed`: 500 with no detail, or the response of the `failed` hook. A failure of the route is not a 503.
 *
 * Each 503 gets `Retry-After` (RFC 9110), and a 500 gets none. Each response gets `Connection: close`
 * while the service cannot keep the connection.
 */
export const outcomeResponse = <T>(items: readonly T[], end: RequestEnd, options: OutcomeOptions<T>): OutcomeResponse => {
  let response: OutcomeResponse;
  if (end.kind !== "done") response = endStatus(end, options);
  else if (items.length === 1) response = merge(valueResponse(items[0]), options.done?.(items[0]!));
  else if (items.length === 0) response = endStatus(end, options);
  else
    response = endStatus(
      { kind: "failed", error: new Error(`the work gave ${items.length} values, and a unary response has one`), delivered: items.length },
      options,
    );
  return ruled(response, options.retryAfter, options.keepAlive);
};

/**
 * This function gives the response of a take that a keyed limiter refused: 429 (RFC 6585), with
 * `Retry-After` in whole seconds, rounded up (RFC 9110). The body tells the cause, `limit` or
 * `cap`, and the same whole seconds. The work did not start, thus the caller can send it again.
 */
export const limitedResponse = (refused: Refused): OutcomeResponse => {
  const seconds = retryAfterSeconds(refused.retryAfter);
  return {
    status: 429,
    headers: { "content-type": JSON_TYPE, "retry-after": String(seconds) },
    body: JSON.stringify({ end: "refused", delivered: 0, retryable: true, cause: `the limiter refused the take: ${refused.cause}`, retryAfter: seconds }),
  };
};

/** This function writes a whole response of `node:http`. A response whose headers went gets no second status: it is destroyed. */
const writeWhole = (res: ServerResponse, response: OutcomeResponse): void => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (response.headers["connection"] === "close") res.shouldKeepAlive = false;
  // a 204 has no body, thus no length
  if (response.status === 204) {
    res.writeHead(204, response.headers);
    res.end();
    return;
  }
  const length = typeof response.body === "string" ? Buffer.byteLength(response.body) : response.body.byteLength;
  res.writeHead(response.status, { ...response.headers, "content-length": String(length) });
  res.end(response.body);
};

/**
 * This function writes the stream of a request to a response of `node:http`, and gives its end. It
 * gives null when the client closed the connection first. Then the work stops through `return()`.
 * - Unary (no format): it waits for the end, and it writes the status and the body of `outcomeResponse`.
 * - Stream: the status 200 goes with the first item, then each item goes as it comes, then the end
 *   goes in the body (in-band). The next item waits until the client reads, thus a slow client
 *   slows the work. An end before the first item gets a status, as a unary end does.
 */
export const writeOutcome = async <T>(res: ServerResponse, stream: RequestStream<T>, options: OutcomeOptions<T>): Promise<RequestEnd | null> => {
  const iterator = stream[Symbol.asyncIterator]();
  let gone: () => void = () => {};
  const closed = new Promise<"gone">((resolve) => {
    gone = () => resolve("gone");
  });
  // a close before the end of the response is a client that went away
  const onClose = (): void => {
    if (!res.writableFinished) gone();
  };
  res.once("close", onClose);
  if (res.destroyed) gone();
  const leave = async (): Promise<null> => {
    await iterator.return?.();
    return null;
  };
  const next = async (): Promise<RequestEvent<T> | "gone"> => {
    const step = await Promise.race([iterator.next(), closed]);
    if (step === "gone") return step;
    if (step.done === true) throw new Error("the stream of the request ended without its end");
    return step.value;
  };
  /** This function writes one part of the body, and waits while the client reads slower than the work. */
  const send = async (chunk: string | Uint8Array): Promise<boolean> => {
    if (res.write(chunk)) return true;
    const drained = new Promise<"drained">((resolve) => res.once("drain", () => resolve("drained")));
    return (await Promise.race([drained, closed])) === "drained";
  };
  try {
    const format = options.stream;
    if (format === undefined) {
      const items: T[] = [];
      for (;;) {
        const event = await next();
        if (event === "gone") return await leave();
        if (event.kind === "item") {
          items.push(event.value);
          continue;
        }
        writeWhole(res, outcomeResponse(items, event, options));
        return event;
      }
    }
    const first = await next();
    if (first === "gone") return await leave();
    if (first.kind !== "item") {
      // an empty stream that ended well gives 200 and its end. Each other end before the first item gets a status
      if (first.kind === "done")
        writeWhole(res, ruled({ status: 200, headers: { "content-type": format.contentType, "cache-control": "no-store" }, body: format.end(first) }, options.retryAfter, options.keepAlive));
      else writeWhole(res, outcomeResponse([], first, options));
      return first;
    }
    if (res.headersSent) {
      res.destroy();
      return await leave();
    }
    const head = ruled({ status: 200, headers: { "content-type": format.contentType, "cache-control": "no-store" }, body: "" }, options.retryAfter, options.keepAlive);
    if (head.headers["connection"] === "close") res.shouldKeepAlive = false;
    res.writeHead(200, head.headers);
    if (!(await send(format.item(first.value)))) return await leave();
    for (;;) {
      const event = await next();
      if (event === "gone") return await leave();
      if (event.kind === "item") {
        if (!(await send(format.item(event.value)))) return await leave();
        continue;
      }
      // the end after the first item is in-band: the status went with the first item
      res.end(format.end(event));
      return event;
    }
  } finally {
    res.off("close", onClose);
  }
};

/** A route of a handler is the name of the route that a controller declares, or a function that gives it from the request. */
export type HandledRoute = string | ((req: IncomingMessage) => string | null);

/** A handled work does the work of one request of `node:http`. Its signal aborts when the shutdown or the client stops the request. */
export type HandledWork<T> = (req: IncomingMessage, signal: AbortSignal) => RequestWork<T>;

/** These options bind a request of `node:http` to the request tracking of the service. */
export interface HandleOptions<T> extends Omit<OutcomeOptions<T>, "keepAlive" | "retryAfter"> {
  /** This function gives the detail of a request, for the function of a route pattern. */
  readonly detail?: ((req: IncomingMessage) => unknown) | undefined;
}

/**
 * This function gives a request handler that does each request of a route through `life.request`
 * (S6 A12 and A13). The transport gives the lifecycle and `server_retry_after` through the context.
 * - A route name takes a request whose method and path are that name, for example `POST /orders`.
 *   A function gives the name of a route or of a pattern, or null for a request of another handler.
 * - Before the start of the transport, each request gets a retryable 503.
 * - The response is unary, or a stream with the option `stream`, as `writeOutcome` writes it.
 */
export const handle = <T>(controller: string, route: HandledRoute, work: HandledWork<T>, options: HandleOptions<T> = {}): RequestHandler => {
  const nameOf = (req: IncomingMessage): string | null => {
    if (typeof route === "function") return route(req);
    return `${req.method ?? "GET"} ${pathOf(req.url)}` === route ? route : null;
  };
  return async (req: IncomingMessage, res: ServerResponse, context: MountContext): Promise<boolean> => {
    const name = nameOf(req);
    if (name === null) return false;
    const life = context.life;
    const written: OutcomeOptions<T> = {
      ...options,
      keepAlive: () => life?.keepAlive() ?? false,
      retryAfter: context.retryAfter,
    };
    if (life === null) {
      const refused: RequestEnd = { kind: "refused", status: 503, retryable: true, cause: "the transport has not started", delivered: 0 };
      writeWhole(res, outcomeResponse<T>([], refused, written));
      return true;
    }
    const given: RequestOptions = options.detail === undefined ? {} : { detail: options.detail(req) };
    await writeOutcome(res, life.request(controller, name, (signal) => work(req, signal), given), written);
    return true;
  };
};
