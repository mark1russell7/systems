import { trace } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import { exited, rig, run } from "./rig.ts";

// a program without otel-ts: each load of a package of otel-ts fails as a missing package does
vi.mock("./telemetry.ts", async (original) => {
  const real = await original<typeof import("./telemetry.ts")>();
  const missing = (): never => {
    throw Object.assign(new Error("Cannot find package '@mark1russell7/otel-ts'"), { code: "ERR_MODULE_NOT_FOUND" });
  };
  return { ...real, startTelemetry: (name: string, options: Parameters<typeof real.startTelemetry>[1]) => real.startTelemetry(name, options, missing) };
});

describe("the telemetry of run(), without otel-ts", () => {
  it("starts the service as before, with the telemetry on by default, and registers no context", async () => {
    const r = rig();
    const life = await run(r);
    expect(life.state).toBe("running");
    expect(trace.getTracerProvider().getTracer("test").startSpan("work").isRecording()).toBe(false);
    void life.shutdown();
    expect(await exited(r, life)).toBe(0);
  });
});
