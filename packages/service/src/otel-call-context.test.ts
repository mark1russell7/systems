import { context, propagation, ROOT_CONTEXT, trace, type SpanContext } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeClock } from "./fakes.ts";
import { GRPC_CLIENT_STARTING_KNOBS, grpcClient, grpcOperations } from "./grpc.ts";
import { fakeGrpcServer } from "./grpc/fake.ts";
import { HTTP_CLIENT_STARTING_KNOBS, httpClient } from "./http-client.ts";
import { fakeServer } from "./http-client/fake.ts";
import type { MountContext } from "./http.ts";
import { httpTransport } from "./http.ts";
import { FakeServer } from "./http/fake-server.ts";
import { callContext, currentScope } from "./otel.ts";
import { rootScope, type Scope } from "./scope.ts";
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

/** This function makes the scope of an incoming request with the trace of its headers, under a service scope. */
const requestOf = (headers: Record<string, string>, trusted: boolean, timeout?: number): Scope =>
  rootScope({ name: "svc", kind: "service", clock: fakeClock() }).entry("request", "GET /a", {
    trace: callContext.trace(headers, trusted),
    identity: undefined,
    timeout,
  });

describe("callContext of the entry /otel (C11)", () => {
  it("runs a trusted call in its trace and its baggage, with its scope as the active scope", () => {
    const scope = requestOf({ traceparent: TRACEPARENT, baggage: "tenant=acme" }, true);
    expect(callContext.run(scope, () => ({ ...seen(), current: callContext.current() === scope }))).toEqual({ trace: TRACE, tenant: "acme", current: true });
    expect(callContext.current()).toBeUndefined();
  });

  it("keeps the trace of a call that is not trusted, and drops its baggage", () => {
    const scope = requestOf({ traceparent: TRACEPARENT, baggage: "tenant=acme" }, false);
    expect(callContext.run(scope, seen)).toEqual({ trace: TRACE, tenant: undefined });
  });

  it("starts from the root context, thus a call gets no value of the context that operates the server", () => {
    const server = propagation.setBaggage(ROOT_CONTEXT, propagation.createBaggage({ tenant: { value: "server" } }));
    expect(context.with(server, () => callContext.run(requestOf({}, true), seen))).toEqual({ trace: undefined, tenant: undefined });
  });

  it("gives the trace headers of the active context, or of a scope, for an outgoing call, and no time", () => {
    const active = propagation.setBaggage(trace.setSpanContext(ROOT_CONTEXT, SPAN), propagation.createBaggage({ tenant: { value: "acme" } }));
    expect(context.with(active, () => callContext.headers())).toEqual({ traceparent: TRACEPARENT, baggage: "tenant=acme" });
    expect(callContext.headers()).toEqual({});
    // the headers of a scope with a deadline have its trace only: the clients add the remaining time themselves
    expect(callContext.headers(requestOf({ traceparent: TRACEPARENT, baggage: "tenant=acme" }, true, 500))).toEqual({ traceparent: TRACEPARENT, baggage: "tenant=acme" });
  });

  it("keeps the scope and the trace of the request in a handler of the HTTP transport, also after await", async () => {
    const server = new FakeServer();
    const clock = fakeClock();
    const transport = httpTransport(
      server.asServer,
      { server_idle_close: { value: 65, unit: "s" }, server_idle_sweep_interval: { value: 1, unit: "s" }, server_retry_after: { value: 2, unit: "s" } },
      { listen: { port: 8080 }, clock, callContext, trustBaggage: (req) => req.headers["authorization"] === "Bearer t" },
    );
    await transport.start(new AbortController().signal, detachedLifecycle(clock));
    const scopes: boolean[] = [];
    transport.mount(async (_req, res, given: MountContext) => {
      await new Promise((resolve) => setImmediate(resolve));
      scopes.push(currentScope() === given);
      res.end(JSON.stringify(seen()));
      return true;
    });

    const trusted = await server.request("/a", "GET", { traceparent: TRACEPARENT, baggage: "tenant=acme", authorization: "Bearer t" });
    const other = await server.request("/a", "GET", { traceparent: TRACEPARENT, baggage: "tenant=acme" });
    expect(JSON.parse(trusted.body)).toEqual({ trace: TRACE, tenant: "acme" });
    expect(JSON.parse(other.body)).toEqual({ trace: TRACE });
    expect(scopes).toEqual([true, true]);
  });

  it("sends the trace and the remaining time of the active scope from the HTTP client (SYS-134)", async () => {
    const clock = fakeClock(1000);
    const server = fakeServer(clock);
    const client = httpClient(
      "api",
      { host: "api", port: 8080, system: "systems.component.http", knobs: HTTP_CLIENT_STARTING_KNOBS, pool: { max: 1 }, operations: {} },
      { clock, dial: async () => {}, create: server.create, callContext },
    );
    await client.handle.connect(new AbortController().signal);
    const scope = requestOf({ traceparent: TRACEPARENT }, false, 400);
    await callContext.run(scope, () => client.request({ method: "GET", path: "/b" }));
    expect(server.calls.at(-1)?.headers).toEqual({ traceparent: TRACEPARENT, "timeout-ms": "400" });
    await client.handle.close();
  });

  it("bounds the deadline of a gRPC call by the remaining time of the active scope (SYS-134)", async () => {
    const clock = fakeClock(1000);
    const server = fakeGrpcServer(clock);
    const client = grpcClient(
      "rpc",
      {
        host: "rpc",
        port: 50051,
        system: "systems.component.grpc",
        knobs: GRPC_CLIENT_STARTING_KNOBS,
        keepaliveWithoutCalls: false,
        operations: grpcOperations({ "/kv.KV/Get": "NO_SIDE_EFFECTS" }),
      },
      { clock, dial: async () => {}, create: server.create, callContext },
    );
    await client.handle.connect(new AbortController().signal);
    const scope = requestOf({ traceparent: TRACEPARENT }, false, 250);
    expect(await callContext.run(scope, () => client.call("/kv.KV/Get", Buffer.from("k")))).toMatchObject({ outcome: "ok" });
    expect(server.latest().calls.at(-1)).toMatchObject({ timeout: 250, metadata: { traceparent: TRACEPARENT } });
    await client.handle.close();
  });
});
