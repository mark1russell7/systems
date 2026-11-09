import { appendFileSync } from "node:fs";
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
import { GRPC_CLIENT_STARTING_KNOBS, grpcClient, grpcOperations, nodeGrpc } from "./grpc.ts";
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

/** The part of grpc-js that the test uses for its server */
interface GrpcJs {
  Server: new () => {
    addService(service: Record<string, unknown>, handlers: Record<string, (call: GrpcCall, callback: (error: null, value: Buffer) => void) => void>): void;
    bindAsync(port: string, credentials: unknown, callback: (error: Error | null, port: number) => void): void;
    tryShutdown(callback: () => void): void;
  };
  ServerCredentials: { createInsecure(): unknown };
}
/** A unary call on the server side of grpc-js */
interface GrpcCall {
  readonly request: Buffer;
  readonly metadata: { getMap(): Record<string, string | Buffer> };
}

const GATE_METHOD = "/rigor.Gate/Run";
let grpcServer: InstanceType<GrpcJs["Server"]> | undefined;
let grpcPort = 0;

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

  // A gRPC server of grpc-js. systems has no gRPC server, so the handler takes the context of the call as a
  // service does: callContext.run with the metadata of the call.
  const specifier = "@grpc/grpc-js";
  const grpc = (await import(specifier)) as GrpcJs;
  grpcServer = new grpc.Server();
  const identity = (value: Buffer) => value;
  grpcServer.addService(
    { Run: { path: GATE_METHOD, requestStream: false, responseStream: false, requestSerialize: identity, requestDeserialize: identity, responseSerialize: identity, responseDeserialize: identity } },
    {
      Run: (call, callback) => {
        const headers = Object.fromEntries(Object.entries(call.metadata.getMap()).map(([name, value]) => [name, String(value)]));
        // The client is the test itself, so each call is trusted
        void callContext.run(headers, true, async () => {
          if (handler !== undefined) await handler();
          callback(null, call.request);
        });
      },
    },
  );
  grpcPort = await new Promise<number>((resolve, reject) =>
    grpcServer!.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, bound) => (error === null ? resolve(bound) : reject(error))),
  );
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => (grpcServer === undefined ? resolve() : grpcServer.tryShutdown(() => resolve())));
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

/** The transport `service-grpc`: a call of `grpcClient` with the call context, to a server of grpc-js that uses the call context */
const serviceGrpc = async (): Promise<PropagationTransport & { close: () => Promise<void> }> => {
  const client = grpcClient(
    "gate",
    {
      host: "127.0.0.1",
      port: grpcPort,
      system: "systems.component.grpc",
      knobs: GRPC_CLIENT_STARTING_KNOBS,
      keepaliveWithoutCalls: false,
      operations: grpcOperations({ [GATE_METHOD]: "IDEMPOTENCY_UNKNOWN" }),
    },
    { create: nodeGrpc, callContext },
  );
  await client.handle.connect(new AbortController().signal);
  return {
    name: "service-grpc",
    close: async () => {
      await client.handle.close();
    },
    call: async (run) => {
      handler = run;
      try {
        // An internal call: the propagator of otel-ts sends the baggage only on an internal call
        const sent = await withInternalCall(() => client.call(GATE_METHOD, Buffer.from("gate")));
        if (sent.outcome !== "ok") throw new Error(`the call of the gate failed: ${JSON.stringify(sent)}`);
      } finally {
        handler = undefined;
      }
    },
  };
};

describe("the propagation gate (C11, C12)", () => {
  it("takes the context id from the HTTP and gRPC clients to their servers, and into each span, log record and metric", async () => {
    const grpc = await serviceGrpc();
    const report = await propagationGate({
      key: KEY,
      transports: [localTransport(withInternalCall), await serviceHttp(), grpc],
      capture,
      withValue: (key, value, fn) => withContext({ [key]: value }, fn),
      readValue: (key) => contextValue(key),
    }).finally(() => grpc.close());
    const text = formatPropagationReport(report);
    // In CI, the report goes to the summary of the job
    if (process.env["GITHUB_STEP_SUMMARY"]) appendFileSync(process.env["GITHUB_STEP_SUMMARY"], `${text}\n\n`);
    expect(text).not.toMatch(/\| fail \|/);
    expect(report.lines.map((line) => [line.transport, line.verdict, line.faults])).toEqual([
      ["local", "pass", []],
      ["service-http", "pass", []],
      ["service-grpc", "pass", []],
    ]);
    expect(report.ok).toBe(true);
  });
});
