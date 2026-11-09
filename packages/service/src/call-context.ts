// The context of a call across the network: the trace and the baggage in the headers of the call.
// This file has types only. The entry @mark1russell7/service/otel gives `callContext`, an implementation
// on the API of OpenTelemetry. The HTTP transport, the HTTP client and the gRPC client take one as an
// option, thus they do not load the API themselves.

/** These are the headers of an incoming call, as `node:http` gives them: the names are in lower case. */
export type IncomingHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

/** A call context reads the context of an incoming call, and writes the context of an outgoing call. */
export interface CallContext {
  /**
   * This function runs `fn` in the context of the headers of an incoming call. The context has the
   * trace of `traceparent`. It has the baggage only when `trusted` is true. A call that is not trusted
   * joins the trace of its caller, but its baggage is dropped.
   */
  run<T>(headers: IncomingHeaders, trusted: boolean, fn: () => T): T;
  /** This function gives the headers of the active context for an outgoing call, for example `traceparent`. */
  headers(): Record<string, string>;
}
