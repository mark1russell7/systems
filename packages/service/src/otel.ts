// @mark1russell7/service/otel: the trace ids of the active span and the context of a call, from the API of OpenTelemetry.
// This entry is the only entry that loads @opentelemetry/api, an optional peer. A service gives
// `traceIds` to `consoleLogger`, and then each log entry has the `trace_id` and the `span_id` of
// its span. The API does nothing until a program registers an SDK (for example
// `startNodeTelemetry()` of @mark1russell7/otel-ts/node). Before that, `traceIds` gives nothing,
// and each entry stays as it was.
//
// `callContext` takes the context across the network: the HTTP transport (option `callContext`) runs each
// handler in the context of its request, and the HTTP and gRPC clients send the headers of the active context.
// The propagator that the program registers writes and reads the headers.

import { context, isSpanContextValid, propagation, ROOT_CONTEXT, trace, type TextMapGetter } from "@opentelemetry/api";
import type { CallContext, IncomingHeaders } from "./call-context.ts";
import type { TraceIds } from "./logger.ts";

export type { CallContext, IncomingHeaders } from "./call-context.ts";
export type { TraceIds, TraceIdsSource } from "./logger.ts";

/** This function gives the trace id and the span id of the active span, or nothing when no valid span is active. */
export const traceIds = (): TraceIds | undefined => {
  const span = trace.getActiveSpan()?.spanContext();
  return span !== undefined && isSpanContextValid(span) ? { trace_id: span.traceId, span_id: span.spanId } : undefined;
};

/** This getter reads the headers of `node:http`: the names are in lower case, and a value can be a list. */
const incoming: TextMapGetter<IncomingHeaders> = {
  keys: (headers) => Object.keys(headers),
  get: (headers, key) => headers[key.toLowerCase()] as string | string[] | undefined,
};

/**
 * This call context uses the propagator that the program registers. An incoming call starts from the root
 * context, thus it gets no value of the context that runs the server. A call that is not trusted loses its baggage.
 */
export const callContext: CallContext = {
  run: (headers, trusted, fn) => {
    const kept = trusted ? headers : Object.fromEntries(Object.entries(headers).filter(([name]) => name !== "baggage"));
    return context.with(propagation.extract(ROOT_CONTEXT, kept, incoming), fn);
  },
  headers: () => {
    const headers: Record<string, string> = {};
    propagation.inject(context.active(), headers);
    return headers;
  },
};
