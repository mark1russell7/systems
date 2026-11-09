import { context, trace, type SpanContext } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { afterEach, describe, expect, it } from "vitest";
import type { ConsoleTarget, LogFormat, TraceIdsSource } from "./index.ts";
import { consoleLogger } from "./index.ts";
import { traceIds } from "./otel.ts";

/** This function gives a console target that keeps each call of each level, as the arguments of the call. */
const recorder = (): { target: ConsoleTarget; calls: unknown[][] } => {
  const calls: unknown[][] = [];
  const keep = (...data: unknown[]): void => void calls.push(data);
  return { target: { debug: keep, info: keep, warn: keep, error: keep }, calls };
};

/** All writes use this error, thus each write gives the same stack. */
const BOOM = new Error("boom");

/** This function writes the same three entries with a logger, and gives the calls of its console target. */
const write = (format: LogFormat, source?: TraceIdsSource): unknown[][] => {
  const { target, calls } = recorder();
  const logger = consoleLogger({ console: target, format, traceIds: source });
  logger.log("info", "ready", {});
  logger.log("warn", "slow", { phase: "drain", trace_id: "set by the caller" });
  logger.log("error", "failed", { cause: BOOM, count: 3n });
  return calls;
};

const SPAN: SpanContext = { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", traceFlags: 1 };

afterEach(() => {
  context.disable();
});

describe("the trace ids of the console logger (C11)", () => {
  it("writes each entry as before when no API is registered, in json and in text", () => {
    // No context manager and no SDK: the API gives no active span, so traceIds gives nothing
    expect(traceIds()).toBeUndefined();
    for (const format of ["json", "text"] as const) {
      const before = write(format);
      expect(write(format, traceIds), format).toEqual(before);
      // json: the same lines, byte for byte
      if (format === "json") expect(write(format, traceIds).map(String).join("\n")).toBe(before.map(String).join("\n"));
    }
  });

  it("writes each entry as before when no span is active, also with a context manager", () => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    expect(traceIds()).toBeUndefined();
    expect(write("json", traceIds)).toEqual(write("json"));
  });

  it("adds the trace id and the span id of the active span, and keeps a field of the entry with the same name", () => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    const lines = context.with(trace.setSpanContext(context.active(), SPAN), () => {
      expect(traceIds()).toEqual({ trace_id: SPAN.traceId, span_id: SPAN.spanId });
      return write("json", traceIds).map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    });
    expect(lines.map((line) => [line["message"], line["trace_id"], line["span_id"]])).toEqual([
      ["ready", SPAN.traceId, SPAN.spanId],
      ["slow", "set by the caller", SPAN.spanId],
      ["failed", SPAN.traceId, SPAN.spanId],
    ]);
  });

  it("gives the ids in the fields of the text format, after the message", () => {
    const calls = write("text", () => ({ trace_id: "t", span_id: "s" }));
    expect(calls[0]).toEqual(["ready", { trace_id: "t", span_id: "s" }]);
    expect(calls[1]).toEqual(["slow", { trace_id: "set by the caller", span_id: "s", phase: "drain" }]);
  });

  it("gives no ids for a span context that is not valid", () => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    const invalid: SpanContext = { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 };
    expect(context.with(trace.setSpanContext(context.active(), invalid), traceIds)).toBeUndefined();
  });
});
