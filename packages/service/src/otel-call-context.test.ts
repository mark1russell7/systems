import { context, propagation, ROOT_CONTEXT, trace, type SpanContext } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeClock } from "./fakes.ts";
import { httpTransport } from "./http.ts";
import { FakeServer } from "./http/fake-server.ts";
import { callContext } from "./otel.ts";
import { detachedLifecycle } from "./testing.ts";

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const TRACEPARENT = `00-${TRACE}-b7ad6b7169203331-01`;
const SPAN: SpanContext = { traceId: TRACE, spanId: "b7ad6b7169203331", traceFlags: 1 };

/** This function gives the trace id and the baggage entry `tenant` of the active context. */
const seen = (): { trace: string | undefined; tenant: string | undefined } => ({
  trace: trace.getSpanContext(context.active())?.traceId,
  tenant: propagation.getActiveBaggage()?.getEntry("tenant")?.value,
});

beforeEach(() => {
  // what a program registers, for example with startNodeTelemetry() of @mark1russell7/otel-ts/node
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }));
});

afterEach(() => {
  context.disable();
  propagation.disable();
});

describe("callContext of the entry /otel (C11)", () => {
  it("runs a trusted call in its trace and its baggage", () => {
    expect(callContext.run({ traceparent: TRACEPARENT, baggage: "tenant=acme" }, true, seen)).toEqual({ trace: TRACE, tenant: "acme" });
  });

  it("keeps the trace of a call that is not trusted, and drops its baggage", () => {
    expect(callContext.run({ traceparent: TRACEPARENT, baggage: "tenant=acme" }, false, seen)).toEqual({ trace: TRACE, tenant: undefined });
  });

  it("starts from the root context, so a call gets no value of the context that runs the server", () => {
    const server = propagation.setBaggage(ROOT_CONTEXT, propagation.createBaggage({ tenant: { value: "server" } }));
    expect(context.with(server, () => callContext.run({}, true, seen))).toEqual({ trace: undefined, tenant: undefined });
  });

  it("gives the headers of the active context for an outgoing call", () => {
    const active = propagation.setBaggage(trace.setSpanContext(ROOT_CONTEXT, SPAN), propagation.createBaggage({ tenant: { value: "acme" } }));
    expect(context.with(active, () => callContext.headers())).toEqual({ traceparent: TRACEPARENT, baggage: "tenant=acme" });
    expect(callContext.headers()).toEqual({});
  });

  it("keeps the context of the request in a handler of the HTTP transport, also after await", async () => {
    const server = new FakeServer();
    const transport = httpTransport(
      server.asServer,
      { server_idle_close: { value: 65, unit: "s" }, server_idle_sweep_interval: { value: 1, unit: "s" }, server_retry_after: { value: 2, unit: "s" } },
      { listen: { port: 8080 }, clock: fakeClock(), callContext, trustBaggage: (req) => req.headers["authorization"] === "Bearer t" },
    );
    await transport.start(new AbortController().signal, detachedLifecycle());
    transport.mount(async (_req, res) => {
      await new Promise((resolve) => setImmediate(resolve));
      res.end(JSON.stringify(seen()));
      return true;
    });

    const trusted = await server.request("/a", "GET", { traceparent: TRACEPARENT, baggage: "tenant=acme", authorization: "Bearer t" });
    const other = await server.request("/a", "GET", { traceparent: TRACEPARENT, baggage: "tenant=acme" });
    expect(JSON.parse(trusted.body)).toEqual({ trace: TRACE, tenant: "acme" });
    expect(JSON.parse(other.body)).toEqual({ trace: TRACE });
  });
});
