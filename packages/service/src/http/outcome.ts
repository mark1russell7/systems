import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { ServerResponse } from "node:http";
import type { RequestOutcome } from "../requests.ts";

/** An outcome response is the status, the headers and the body of a request outcome, for any HTTP framework or none. */
export interface OutcomeResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array;
}

/** A response part is what a hook gives for one outcome. The parts that it does not give keep the values of the mapping. */
export interface ResponsePart {
  readonly status?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | Uint8Array | undefined;
}

/** These options map a request outcome to a response. */
export interface OutcomeOptions<T> {
  /**
   * This value tells if the response can keep its connection open, as `life.keepAlive()` does. False
   * gives `Connection: close`. A function is read when the response is made.
   */
  readonly keepAlive: boolean | (() => boolean);
  /** This time goes in the `Retry-After` of a retryable 503, in whole seconds, rounded up. */
  readonly retryAfter: Quantity;
  /**
   * This function gives the response of a value. Without it, the mapping gives 200 and the value as
   * JSON, or 204 for no value.
   */
  readonly done?: ((value: T) => ResponsePart) | undefined;
  /**
   * This function gives the response of a failure of the route. Without it, the mapping gives 500
   * with no detail, because an error can hold private data.
   */
  readonly failed?: ((error: unknown) => ResponsePart) | undefined;
}

const JSON_TYPE = "application/json; charset=utf-8";

const valueResponse = (value: unknown): OutcomeResponse => {
  if (value === undefined) return { status: 204, headers: {}, body: "" };
  if (typeof value === "string") return { status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, body: value };
  if (value instanceof Uint8Array) return { status: 200, headers: { "content-type": "application/octet-stream" }, body: value };
  return { status: 200, headers: { "content-type": JSON_TYPE }, body: JSON.stringify(value) };
};

const merge = (base: OutcomeResponse, part: ResponsePart | undefined): OutcomeResponse =>
  part === undefined
    ? base
    : {
        status: part.status ?? base.status,
        headers: { ...base.headers, ...part.headers },
        body: part.body ?? base.body,
      };

/**
 * This function maps a request outcome to a response (S6 A12 and A13):
 * - `done`: 200 with the value, or the response of the `done` hook.
 * - `failed`: 500, or the response of the `failed` hook.
 * - `refused`: 503 with `Retry-After`. The work did not start, thus the caller can send it again.
 * - `cut`: the status of the outcome. A retryable cut gets `Retry-After`.
 *
 * Each response gets `Connection: close` while the service cannot keep the connection.
 */
export const outcomeResponse = <T>(outcome: RequestOutcome<T>, options: OutcomeOptions<T>): OutcomeResponse => {
  const retryAfter = String(Math.max(0, Math.ceil(valueIn(options.retryAfter, "s"))));
  let response: OutcomeResponse;
  switch (outcome.kind) {
    case "done":
      response = merge(valueResponse(outcome.value), options.done?.(outcome.value));
      break;
    case "failed":
      response = merge(
        { status: 500, headers: { "content-type": JSON_TYPE }, body: JSON.stringify({ outcome: "failed", retryable: false }) },
        options.failed?.(outcome.error),
      );
      break;
    case "refused":
    case "cut": {
      const body = JSON.stringify({ outcome: outcome.kind, retryable: outcome.retryable, cause: outcome.cause });
      const retry = outcome.retryable && outcome.status === 503 ? { "retry-after": retryAfter } : {};
      response = { status: outcome.status, headers: { "content-type": JSON_TYPE, ...retry }, body };
      break;
    }
  }
  const keepAlive = typeof options.keepAlive === "function" ? options.keepAlive() : options.keepAlive;
  return keepAlive ? response : { ...response, headers: { ...response.headers, connection: "close" } };
};

/**
 * This function writes a request outcome to a response of `node:http`, with `outcomeResponse`. A
 * response whose headers went already gets no second status: the function destroys it.
 */
export const writeOutcome = <T>(res: ServerResponse, outcome: RequestOutcome<T>, options: OutcomeOptions<T>): void => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const response = outcomeResponse(outcome, options);
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
