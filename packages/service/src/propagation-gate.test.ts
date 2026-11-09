import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { trace, type ProxyTracerProvider } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { contextValue, defineContextKeys, withContext, withInternalCall } from "@mark1russell7/otel-ts/context";
import { startNodeTelemetry } from "@mark1russell7/otel-ts/node";
import { formatPropagationReport, localTransport, propagationGate, type PropagationTransport } from "@mark1russell7/rigor-testkit/propagation";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { MetricReader } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HTTP_CLIENT_STARTING_KNOBS, httpClient } from "./http-client.ts";
import { httpTransport, pathOf } from "./http.ts";
import { callContext } from "./otel.ts";
import { detachedLifecycle } from "./testing.ts";

// The propagation gate of rigor-testkit (C11): one context id goes from an HTTP client of this package to an
// HTTP transport of this package over the loopback, and from there to the spans, the log records and the
// metrics. The SDK is the one of otel-ts, as in a service.

const KEY = "request.id";

/** A metric reader that collects only when the test asks */
class PullReader extends MetricReader {
  protected override async onForceFlush(): Promise<void> {}
  protected override async onShutdown(): Promise<void> {}
}

const spans = new InMemorySpanExporter();
const logRecords = new InMemoryLogRecordExporter();
const reader = new PullReader();

/** This function flushes a provider of the global API. A proxy gives its delegate. */
const flush = async (provider: object): Promise<void> => {
  const real = "getDelegate" in provider ? (provider as ProxyTracerProvider).getDelegate() : provider;
  await (real as { forceFlush?: () => Promise<void> }).forceFlush?.();
};

const capture = {
  spans: async () => {
    await flush(trace.getTracerProvider());
    return spans.getFinishedSpans();
  },
  logRecords: async () => {
    await flush(logs.getLoggerProvider());
    return logRecords.getFinishedLogRecords();
  },
  metricPoints: async () => {
    const { resourceMetrics } = await reader.collect();
    return resourceMetrics.scopeMetrics.flatMap((scope) =>
      scope.metrics.flatMap((metric) => metric.dataPoints.map((point) => ({ name: metric.descriptor.name, attributes: point.attributes }))),
    );
  },
  reset: async () => {
    await flush(trace.getTracerProvider());
    await flush(logs.getLoggerProvider());
    spans.reset();
    logRecords.reset();
  },
};

let telemetry: ReturnType<typeof startNodeTelemetry> | undefined;
const server = createServer();
let handler: (() => Promise<void>) | undefined;

beforeAll(async () => {
  defineContextKeys({ [KEY]: { cardinality: "high", propagate: "internal" } });
  telemetry = startNodeTelemetry({ enabled: true, stopOnSignals: false, env: {}, traceExporter: spans, logExporter: logRecords, metricReaders: [reader] });
  const transport = httpTransport(
    server,
    { server_idle_close: { value: 5, unit: "s" }, server_idle_sweep_interval: { value: 200, unit: "ms" }, server_retry_after: { value: 1, unit: "s" } },
    // The client is the test itself, so each request is trusted
    { listen: { port: 0, host: "127.0.0.1" }, callContext, trustBaggage: () => true },
  );
  transport.mount(async (req, res) => {
    if (pathOf(req.url) === "/gate" && handler !== undefined) await handler();
    res.end("ok");
    return true;
  });
  await transport.start(new AbortController().signal, detachedLifecycle());
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await telemetry?.shutdown();
});

/** The transport `service-http`: a request of `httpClient` with the call context, to `httpTransport` with the call context */
const serviceHttp = async (): Promise<PropagationTransport> => {
  const { port } = server.address() as AddressInfo;
  const client = httpClient(
    "gate",
    { host: "127.0.0.1", port, system: "systems.component.http", knobs: HTTP_CLIENT_STARTING_KNOBS, pool: { max: 1 }, operations: {} },
    { callContext },
  );
  await client.handle.connect(new AbortController().signal);
  return {
    name: "service-http",
    call: async (run) => {
      handler = run;
      try {
        // An internal call: the propagator of otel-ts sends the baggage only on an internal call
        const sent = await withInternalCall(() => client.request({ method: "GET", path: "/gate" }));
        if (sent.outcome !== "ok") throw new Error(`the call of the gate failed: ${JSON.stringify(sent)}`);
      } finally {
        handler = undefined;
      }
    },
  };
};

describe("the propagation gate (C11)", () => {
  it("takes the context id from the HTTP client to the HTTP transport, and into each span, log record and metric", async () => {
    const report = await propagationGate({
      key: KEY,
      transports: [localTransport(withInternalCall), await serviceHttp()],
      capture,
      withValue: (key, value, fn) => withContext({ [key]: value }, fn),
      readValue: (key) => contextValue(key),
    });
    expect(formatPropagationReport(report)).not.toMatch(/\| fail \|/);
    expect(report.lines.map((line) => [line.transport, line.verdict, line.faults])).toEqual([
      ["local", "pass", []],
      ["service-http", "pass", []],
    ]);
    expect(report.ok).toBe(true);
  });
});
