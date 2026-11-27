import { contextOwner } from "@mark1russell7/otel-ts/context";
import { context, isSpanContextValid, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type { Resource } from "@opentelemetry/resources";
import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPS, exited, rig, run } from "./rig.ts";
import { type Load, RUNTIME_METRICS, nodeLoad, startTelemetry } from "./telemetry.ts";

afterEach(() => {
  trace.disable();
  context.disable();
  propagation.disable();
  // a test that leaves the context of otel-ts started fails here, not in the tests after it
  expect(contextOwner(), "a test left a context of otel-ts started").toBeUndefined();
});

/** A loader with the entries of otel-ts as fakes. It records each specifier that it loads. */
const fakeOtel = (owner: string | undefined = undefined) => {
  const loads: string[] = [];
  const starts: unknown[] = [];
  const shutdown = vi.fn(async () => {});
  const load: Load = (specifier) => {
    loads.push(specifier);
    if (specifier === "@mark1russell7/otel-ts/context") return { contextOwner: () => owner };
    if (specifier === "@mark1russell7/otel-ts/node/context")
      return {
        startNodeContext: (options: unknown) => {
          starts.push(options);
          return { shutdown };
        },
      };
    if (specifier === "@mark1russell7/otel-ts/node/export") return { exportSpanProcessors: ({ env }: { env: object }) => [{ exporterOf: env }] };
    throw new Error(`no fake for ${specifier}`);
  };
  return { load, loads, starts, shutdown };
};

const missing = (code: string): Load => () => {
  throw Object.assign(new Error("Cannot find module '@mark1russell7/otel-ts/context'"), { code });
};

describe("startTelemetry", () => {
  it("starts the context with the name of the service, and loads no exporter without an endpoint", () => {
    const otel = fakeOtel();
    expect(startTelemetry("api", { env: {} }, otel.load)).toMatchObject({ shutdown: otel.shutdown });
    expect(otel.loads).toEqual(["@mark1russell7/otel-ts/context", "@mark1russell7/otel-ts/node/context"]);
    expect(otel.starts).toEqual([{ serviceName: "api", env: {}, spanProcessors: [] }]);
    // an empty endpoint is no endpoint
    const empty = fakeOtel();
    startTelemetry("api", { env: { OTEL_EXPORTER_OTLP_ENDPOINT: "" } }, empty.load);
    expect(empty.loads).not.toContain("@mark1russell7/otel-ts/node/export");
  });

  it("exports with the processors of otel-ts when the environment has an endpoint, and gives the version as service.version", () => {
    const otel = fakeOtel();
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" };
    startTelemetry("api", { env, version: "1.2.3" }, otel.load);
    expect(otel.loads.at(-1)).toBe("@mark1russell7/otel-ts/node/export");
    expect(otel.starts).toEqual([{ serviceName: "api", env, spanProcessors: [{ exporterOf: env }], resourceAttributes: { "service.version": "1.2.3" } }]);
  });

  it("starts nothing when a part of the program owns the context, and loads no SDK then", () => {
    for (const owner of ["startNodeContext()", "another SDK"]) {
      const otel = fakeOtel(owner);
      expect(startTelemetry("api", {}, otel.load)).toBe("owned");
      expect(otel.loads).toEqual(["@mark1russell7/otel-ts/context"]);
    }
  });

  it("starts nothing when the option is false, and loads nothing", () => {
    const otel = fakeOtel();
    expect(startTelemetry("api", false, otel.load)).toBe("off");
    expect(otel.loads).toEqual([]);
  });

  it("starts nothing without otel-ts, without a package of its entry, without contextOwner(), or outside Node", () => {
    expect(startTelemetry("api", {}, missing("ERR_MODULE_NOT_FOUND"))).toBe("no otel-ts");
    expect(startTelemetry("api", {}, missing("MODULE_NOT_FOUND"))).toBe("no otel-ts");
    expect(startTelemetry("api", {}, missing("ERR_PACKAGE_PATH_NOT_EXPORTED"))).toBe("no otel-ts");
    // a version of otel-ts before contextOwner()
    expect(startTelemetry("api", {}, () => ({}))).toBe("no otel-ts");
    // outside Node there is no loader: a process with no getBuiltinModule
    expect(nodeLoad({})).toBeUndefined();
    expect(startTelemetry("api", {}, null)).toBe("no otel-ts");
    expect(typeof nodeLoad()).toBe("function");
  });

  it("throws an error of otel-ts that is not a missing package", () => {
    const broken: Load = () => {
      throw new Error("a broken install");
    };
    expect(() => startTelemetry("api", {}, broken)).toThrow(/a broken install/);
  });
});

/** A loader of fakes with a meter provider of otel-ts 0.11.2 and a fake of the runtime metrics. It records the order of the stops. */
const fakeMetrics = (runtime: "ok" | "missing" | "broken" = "ok") => {
  const otel = fakeOtel();
  const stops: string[] = [];
  otel.shutdown.mockImplementation(async () => {
    stops.push("context");
  });
  const load: Load = (specifier) => {
    if (specifier === "@mark1russell7/otel-ts/node/export") return { exportSpanProcessors: () => [], exportMeterProvider: () => "the meter provider" };
    if (specifier === "@opentelemetry/api") return { metrics: { getMeterProvider: () => "the global meter provider" } };
    if (specifier === RUNTIME_METRICS) {
      otel.loads.push(specifier);
      if (runtime === "missing") throw Object.assign(new Error(`Cannot find module '${RUNTIME_METRICS}'`), { code: "MODULE_NOT_FOUND" });
      if (runtime === "broken") throw new Error("a broken runtime package");
      return {
        RuntimeNodeInstrumentation: class {
          setMeterProvider(provider: unknown): void {
            stops.push("meters of " + String(provider));
          }
          disable(): void {
            stops.push("runtime");
          }
        },
      };
    }
    return otel.load(specifier);
  };
  return { ...otel, load, stops };
};

describe("the metrics of startTelemetry", () => {
  const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" };

  it("gives the meter provider of otel-ts to the context, starts the runtime metrics, and stops them before the context", async () => {
    const otel = fakeMetrics();
    const started = startTelemetry("api", { env }, otel.load);
    expect(otel.starts).toEqual([{ serviceName: "api", env, spanProcessors: [], meterProvider: "the meter provider" }]);
    expect(otel.loads.at(-1)).toBe(RUNTIME_METRICS);
    if (typeof started === "string") throw new Error(started);
    await Promise.all([started.shutdown(), started.shutdown()]);
    await started.shutdown();
    expect(otel.stops).toEqual(["meters of the global meter provider", "runtime", "context"]);
  });

  it("starts no runtime metrics without a meter provider: no endpoint, or a version of otel-ts before exportMeterProvider()", () => {
    const none = fakeMetrics();
    startTelemetry("api", { env: {} }, none.load);
    expect(none.loads).not.toContain(RUNTIME_METRICS);
    const old = fakeOtel();
    startTelemetry("api", { env }, old.load);
    expect(old.starts).toEqual([{ serviceName: "api", env, spanProcessors: [{ exporterOf: env }] }]);
    expect(old.loads).not.toContain(RUNTIME_METRICS);
  });

  it("starts the context without the runtime metrics when their package is not installed", async () => {
    const otel = fakeMetrics("missing");
    const started = startTelemetry("api", { env }, otel.load);
    expect(started).toMatchObject({ shutdown: otel.shutdown });
    if (typeof started !== "string") await started.shutdown();
  });

  it("stops the context and throws an error of the runtime package that is not a missing package", () => {
    const otel = fakeMetrics("broken");
    expect(() => startTelemetry("api", { env }, otel.load)).toThrow(/a broken runtime package/);
    expect(otel.shutdown).toHaveBeenCalledTimes(1);
  });

  it("records the metrics of the Node runtime with the real packages, in the meter provider of the service", async () => {
    const real = nodeLoad();
    if (real === undefined) throw new Error("no loader in Node");
    let reader: TestReader | undefined;
    const load: Load = (specifier) =>
      specifier === "@mark1russell7/otel-ts/node/export"
        ? {
            exportSpanProcessors: () => [],
            exportMeterProvider: () => (resource: Resource) => new MeterProvider({ resource, readers: [(reader = new TestReader())] }),
          }
        : real(specifier);
    const started = startTelemetry("api", { env }, load);
    if (typeof started === "string") throw new Error(started);
    try {
      const collected = await reader?.collect();
      const names = collected?.resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics.map((metric) => metric.descriptor.name)) ?? [];
      expect(names.some((name) => name.startsWith("nodejs.eventloop."))).toBe(true);
      expect(collected?.resourceMetrics.resource.attributes["service.name"]).toBe("api");
    } finally {
      await started.shutdown();
    }
  });
});

/** A metric reader that the test collects by hand */
class TestReader extends MetricReader {
  protected override onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
  protected override onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

describe("the telemetry of run(), with otel-ts", () => {
  it("starts the context for the service, so a span has a trace, and stops it in the phase flush the output", async () => {
    const r = rig({ caps: { ...CAPS, "flush the output": 1 } });
    const life = await run(r, () => {}, { telemetry: { env: {} } });
    expect(contextOwner()).toBe("startNodeContext()");
    const span = trace.getTracer("test").startSpan("work");
    expect(isSpanContextValid(span.spanContext())).toBe(true);
    span.end();
    void life.shutdown();
    expect(await exited(r, life)).toBe(0);
    expect(contextOwner()).toBeUndefined();
  });

  it("stops the context after the exit, for a service without the phase flush the output", async () => {
    const r = rig();
    const life = await run(r, () => {}, { telemetry: { env: {} } });
    expect(contextOwner()).toBe("startNodeContext()");
    void life.shutdown();
    await exited(r, life);
    await vi.waitFor(() => expect(contextOwner()).toBeUndefined());
  });

  it("keeps the context of the program: it starts nothing, and the context stays after the exit", async () => {
    expect(context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())).toBe(true);
    const r = rig({ caps: { ...CAPS, "flush the output": 1 } });
    const life = await run(r, () => {}, { telemetry: { env: {} } });
    expect(contextOwner()).toBe("another SDK");
    void life.shutdown();
    await exited(r, life);
    // the manager of the program is still the global manager: a second one is refused
    expect(context.setGlobalContextManager(new AsyncLocalStorageContextManager())).toBe(false);
  });

  it("starts nothing with the option false", async () => {
    const r = rig();
    const life = await run(r, () => {}, { telemetry: false });
    expect(contextOwner()).toBeUndefined();
    void life.shutdown();
    await exited(r, life);
  });
});
