// The context of a call across the network: the trace and the baggage in the headers of the call, and the
// active scope. This file has types only. The entry @mark1russell7/service/otel gives `callContext`, an
// implementation on the API of OpenTelemetry. The HTTP transport, the HTTP client and the gRPC client take one
// as an option, thus they do not load the API themselves.

import type { Scope } from "./scope.ts";

/** These are the headers of an incoming call, as `node:http` gives them: the names are in lower case. */
export type IncomingHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * A call context reads the trace of an incoming call, keeps the active scope, and writes the trace of an
 * outgoing call. The HTTP transport makes one scope for each request, with the trace of `trace()`, and does
 * the handler in `run()`. The clients read `current()` for the trace and the remaining time of a call.
 */
export interface CallContext {
  /**
   * This function gives the trace of an incoming call from its headers, for the option `trace` of `entry()`.
   * The trace has the baggage only when `trusted` is true. A call that is not trusted joins the trace of its
   * caller, but its baggage is dropped.
   */
  trace(headers: IncomingHeaders, trusted: boolean): unknown;
  /** This function makes a scope the active scope while `fn` operates. The active context gets the trace of the scope. */
  run<T>(scope: Scope, fn: () => T): T;
  /** This function gives the active scope, or `undefined` outside each `run()`. */
  current(): Scope | undefined;
  /**
   * This function gives the trace headers of an outgoing call, for example `traceparent`. They come from the
   * scope, or from the active context without a scope. The headers have no time: `timeoutHeaders` of the entry
   * `/scope` gives `timeout-ms`.
   */
  headers(scope?: Scope): Record<string, string>;
}
