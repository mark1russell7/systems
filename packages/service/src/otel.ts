// @mark1russell7/service/otel: the trace ids of the active span and the context of a call, from the API of OpenTelemetry.
// This entry is the only entry that loads @opentelemetry/api, an optional peer. A service gives
// `traceIds` to `consoleLogger`, and then each log entry has the `trace_id` and the `span_id` of
// its span. The API does nothing until a program registers an SDK (for example
// `startNodeTelemetry()` of @mark1russell7/otel-ts/node). Before that, `traceIds` gives nothing,
// and each entry stays as it was.
//
// `callContext` takes the context across the network: the HTTP transport (option `callContext`) does each
// handler in the scope of its request, and the HTTP and gRPC clients send the trace and the remaining time of the
// active scope. The propagator that the program registers writes and reads the headers.
//
// The scope functions keep a scope of `@mark1russell7/service/scope` in the context of OpenTelemetry (SYS-134).
// `traceOf` reads the trace of an incoming request for `entry()`, `runScope` makes a scope the active scope, and
// `scopeHeaders` writes the trace and the remaining time of a scope for an outgoing request. The context manager
// that the program registers keeps the scope through `await`: one store for the trace and the scope.

import { incomingContext } from "@mark1russell7/otel-ts/context";
import { type Context, context, createContextKey, isSpanContextValid, propagation, trace } from "@opentelemetry/api";
import type { CallContext, IncomingHeaders } from "./call-context.ts";
import type { TraceIds } from "./logger.ts";
import { type Scope, timeoutHeaders } from "./scope.ts";

export type { CallContext, IncomingHeaders } from "./call-context.ts";
export type { TraceIds, TraceIdsSource } from "./logger.ts";

/** This function gives the trace id and the span id of the active span, or nothing when no valid span is active. */
export const traceIds = (): TraceIds | undefined => {
  const span = trace.getActiveSpan()?.spanContext();
  return span !== undefined && isSpanContextValid(span) ? { trace_id: span.traceId, span_id: span.spanId } : undefined;
};

/**
 * This function gives the trace of an incoming request: the context of the propagator that the program
 * registers, read from the headers. It starts from the root context, thus the request gets no value of the
 * context that runs the server. A request that is not trusted keeps its trace and loses its baggage.
 * Give the result to the option `trace` of `entry()`.
 *
 * The read is `incomingContext` of otel-ts, the home of the context of a trace. A trusted request has the
 * trust `"all"`, and another request has the trust `"trace"`. A header name in any case reads the same.
 */
export const traceOf = (headers: IncomingHeaders, trusted: boolean): Context =>
  incomingContext(headers, { trust: trusted ? "all" : "trace" });

/** This key holds the active scope in the context of OpenTelemetry. */
const SCOPE = createContextKey("@mark1russell7/service/scope");

/** This function tells a context of OpenTelemetry from another value of the slot `trace`. */
const isContext = (value: unknown): value is Context =>
  typeof value === "object" && value !== null && typeof (value as Context).getValue === "function" && typeof (value as Context).setValue === "function";

/** This function gives the active scope: the scope of the innermost `runScope`, or `undefined` outside each `runScope`. */
export const currentScope = (): Scope | undefined => context.active().getValue(SCOPE) as Scope | undefined;

/**
 * This function tells if the active context already holds the trace of a scope. That is true when the
 * active scope is the scope or an ancestor of it with the same trace. The active context then also holds
 * each span that started after the start of that scope.
 */
const inLine = (scope: Scope): boolean => {
  const current = currentScope();
  if (current === undefined || current.trace !== scope.trace) return false;
  for (let at: Scope | null = scope; at !== null; at = at.parent) if (at === current) return true;
  return false;
};

/** This function gives the context of OpenTelemetry of a scope: the active context in its line, or else its trace. */
const contextOf = (scope: Scope): Context => (!inLine(scope) && isContext(scope.trace) ? scope.trace : context.active());

/**
 * This function makes a scope the active scope while `fn` operates: `currentScope()` gives it, also after
 * `await` when the program registers a context manager. The active context of OpenTelemetry gets the trace of
 * the scope, thus each span that starts in `fn` is in the trace of the scope. Inside the line of the scope,
 * the active context stays, with each span that started in it. A trace that is not a context of OpenTelemetry
 * keeps the active context.
 */
export const runScope = <T>(scope: Scope, fn: () => T): T => context.with(contextOf(scope).setValue(SCOPE, scope), fn);

/**
 * This function gives the headers of an outgoing request of a scope. They are the trace of the scope, as the
 * registered propagator writes it (for example `traceparent` and `baggage`), and the remaining time in
 * `timeout-ms`.
 */
export const scopeHeaders = (scope: Scope): Record<string, string> => ({ ...traceHeaders(contextOf(scope)), ...timeoutHeaders(scope) });

/** This function gives the trace headers of a context, as the registered propagator writes them. */
const traceHeaders = (from: Context): Record<string, string> => {
  const headers: Record<string, string> = {};
  propagation.inject(from, headers);
  return headers;
};

/**
 * This call context uses the propagator and the context manager that the program registers. The trace of an
 * incoming call starts from the root context, thus it gets no value of the context that runs the server. A call
 * that is not trusted loses its baggage. The headers of an outgoing call come from its scope, or else from the
 * active context.
 */
export const callContext: CallContext = {
  trace: traceOf,
  run: runScope,
  current: currentScope,
  headers: (scope) => traceHeaders(scope === undefined ? context.active() : contextOf(scope)),
};
