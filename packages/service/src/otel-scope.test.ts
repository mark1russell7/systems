// Law 7 of the scope (SYS-134): inside `runScope`, `currentScope()` gives the scope, and the active context of
// OpenTelemetry has the span and the baggage of the trace of the scope.

import { fakeClock } from "@mark1russell7/algebra/clock";
import { type Context, context, propagation, ROOT_CONTEXT, type SpanContext, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentScope, runScope, scopeHeaders, traceOf } from "./otel.ts";
import { rootScope, type Scope } from "./scope.ts";

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const OTHER = "4bf92f3577b34da6a3ce929d0e0e4736";
const traceparent = (traceId: string, spanId = "b7ad6b7169203331") => `00-${traceId}-${spanId}-01`;

/** This function gives the trace id, the span id and the baggage entry `tenant` of the active context. */
const seen = (): { trace: string | undefined; span: string | undefined; tenant: string | undefined } => ({
  trace: trace.getSpanContext(context.active())?.traceId,
  span: trace.getSpanContext(context.active())?.spanId,
  tenant: propagation.getActiveBaggage()?.getEntry("tenant")?.value,
});

/** This function gives the same facts of a context. */
const facts = (from: Context): ReturnType<typeof seen> => context.with(from, seen);

beforeEach(() => {
  // what a program registers, for example with startNodeTelemetry() of @mark1russell7/otel-ts/node
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }));
});

afterEach(() => {
  context.disable();
  propagation.disable();
});

const service = () => rootScope({ name: "svc", kind: "service", clock: fakeClock() });

describe("law 7: runScope makes a scope the active scope, in its trace", () => {
  it("gives the scope inside runScope, also after await, and nothing outside", async () => {
    const root = service();
    const request = root.entry("request", "r", { trace: traceOf({}, true), identity: undefined });
    expect(currentScope()).toBeUndefined();
    const inside = await runScope(request, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentScope();
    });
    expect(inside).toBe(request);
    expect(currentScope()).toBeUndefined();
  });

  it("gives the active context the span and the baggage of an entry, and none of the context that runs the server", () => {
    const root = service();
    const request = root.entry("request", "r", { trace: traceOf({ traceparent: traceparent(TRACE), baggage: "tenant=acme" }, true), identity: undefined });
    const server = propagation.setBaggage(ROOT_CONTEXT, propagation.createBaggage({ tenant: { value: "server" } }));
    expect(context.with(server, () => runScope(request, seen))).toEqual({ trace: TRACE, span: "b7ad6b7169203331", tenant: "acme" });
    // a request that is not trusted keeps its trace and loses its baggage
    const untrusted = root.entry("request", "u", { trace: traceOf({ traceparent: traceparent(TRACE), baggage: "tenant=acme" }, false), identity: undefined });
    expect(runScope(untrusted, seen)).toEqual({ trace: TRACE, span: "b7ad6b7169203331", tenant: undefined });
  });

  it("keeps each span that started in the scope of a parent, for a child in the same trace", () => {
    const root = service();
    const request = root.entry("request", "r", { trace: traceOf({ traceparent: traceparent(TRACE) }, true), identity: undefined });
    const call = request.child("call", "db");
    const span: SpanContext = { traceId: TRACE, spanId: "00f067aa0ba902b7", traceFlags: 1 };
    const inSpan = runScope(request, () => context.with(trace.setSpanContext(context.active(), span), () => runScope(call, () => [seen().span, currentScope()])));
    expect(inSpan).toEqual(["00f067aa0ba902b7", call]);
    // from outside the line of its parent, the child gets the trace of its scope
    expect(runScope(call, seen).span).toBe("b7ad6b7169203331");
  });

  it("writes the trace and the remaining time of a scope for an outgoing request", () => {
    const root = service();
    const request = root.entry("request", "r", { trace: traceOf({ traceparent: traceparent(TRACE), baggage: "tenant=acme" }, true), identity: undefined, timeout: 250 });
    expect(scopeHeaders(request)).toEqual({ traceparent: traceparent(TRACE), baggage: "tenant=acme", "timeout-ms": "250" });
    expect(scopeHeaders(root)).toEqual({});
  });

  it("holds for random trees of scopes and random nests of runScope", () => {
    const traces = [undefined, traceOf({ traceparent: traceparent(TRACE) }, true), traceOf({ traceparent: traceparent(OTHER), baggage: "tenant=b" }, true)];
    const plan = fc.array(fc.record({ parent: fc.nat(), entry: fc.boolean(), trace: fc.nat({ max: traces.length - 1 }) }), { maxLength: 12 });
    fc.assert(
      fc.property(plan, fc.array(fc.nat(), { minLength: 1, maxLength: 4 }), (steps, nest) => {
        const nodes: Scope[] = [service()];
        for (const { parent, entry, trace: at } of steps) {
          const above = nodes[parent % nodes.length]!;
          // a call under a call keeps each tree legal: an entry needs a parent of rank 2 or less
          if (entry && (above.kind === "service" || above.kind === "process")) nodes.push(above.entry("request", "e", { trace: traces[at], identity: undefined }));
          else nodes.push(above.child("call", "c"));
        }
        const chain = nest.map((index) => nodes[index % nodes.length]!);
        // the expected context of each step: the active one in the line of the scope, or else its trace
        const expected = (scope: Scope, active: Context, current: Scope | undefined): Context => {
          let line = current !== undefined && current.trace === scope.trace;
          if (line) {
            line = false;
            for (let at: Scope | null = scope; at !== null; at = at.parent) if (at === current) line = true;
          }
          return !line && scope.trace !== undefined ? (scope.trace as Context) : active;
        };
        const step = (at: number, active: Context, current: Scope | undefined): void => {
          if (at === chain.length) return;
          const scope = chain[at]!;
          const want = expected(scope, active, current);
          runScope(scope, () => {
            expect(currentScope()).toBe(scope);
            expect(seen()).toEqual(facts(want));
            // a span that starts in the scope: a child in its line keeps it, a scope outside its line does not
            const span: SpanContext = { traceId: seen().trace ?? TRACE, spanId: (at + 1).toString(16).padStart(16, "0"), traceFlags: 1 };
            context.with(trace.setSpanContext(context.active(), span), () => step(at + 1, context.active(), scope));
          });
        };
        step(0, context.active(), undefined);
        expect(currentScope()).toBeUndefined();
      }),
      { numRuns: 200 },
    );
  });
});

describe("runScope without a context manager", () => {
  it("still runs its function, and currentScope() gives nothing: the program registers the manager", () => {
    context.disable();
    const root = service();
    expect(runScope(root, () => [currentScope(), "ran"])).toEqual([undefined, "ran"]);
  });
});
