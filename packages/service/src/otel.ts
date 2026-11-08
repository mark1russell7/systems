// @mark1russell7/service/otel: the trace ids of the active span, from the API of OpenTelemetry.
// This entry is the only entry that loads @opentelemetry/api, an optional peer. A service gives
// `traceIds` to `consoleLogger`, and then each log entry has the `trace_id` and the `span_id` of
// its span. The API does nothing until a program registers an SDK (for example
// `startNodeTelemetry()` of @mark1russell7/otel-ts/node). Before that, `traceIds` gives nothing,
// and each entry stays as it was.

import { isSpanContextValid, trace } from "@opentelemetry/api";
import type { TraceIds } from "./logger.ts";

export type { TraceIds, TraceIdsSource } from "./logger.ts";

/** This function gives the trace id and the span id of the active span, or nothing when no valid span is active. */
export const traceIds = (): TraceIds | undefined => {
  const span = trace.getActiveSpan()?.spanContext();
  return span !== undefined && isSpanContextValid(span) ? { trace_id: span.traceId, span_id: span.spanId } : undefined;
};
