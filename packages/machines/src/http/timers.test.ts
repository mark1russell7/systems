import { describe, expect, it } from "vitest";
import {
  NODE_EARLY_MS,
  NODE_TIMER_EARLY,
  goLateSeconds,
  nodeEarlySeconds,
  nodeLateMs,
  nodeLateSeconds,
  nodeTimerLateness,
} from "./timers.ts";

describe("the bounds of a user timer", () => {
  it("gives the arithmetic of a Node timer as an expression and as a text", () => {
    expect(nodeTimerLateness("ping_interval")).toEqual({ expr: nodeLateMs("ping_interval"), unit: "ms" });
    expect(NODE_TIMER_EARLY).toEqual({ expr: NODE_EARLY_MS, unit: "ms" });
  });

  it("adds the step of the coarse clock only at HZ 1000", () => {
    expect(nodeLateSeconds(6, 250)).toBeCloseTo(0.007, 12);
    expect(nodeLateSeconds(6, 1000)).toBeCloseTo(0.008, 12);
    expect(nodeEarlySeconds(250)).toBeCloseTo(0.001, 12);
    expect(nodeEarlySeconds(1000)).toBeCloseTo(0.002, 12);
  });

  it("holds the slack of a Node timer from 0.05 ms to 100 ms", () => {
    expect(nodeLateSeconds(0.01, 250)).toBeCloseTo(0.00105, 12);
    expect(nodeLateSeconds(500, 250)).toBeCloseTo(0.101, 12);
  });

  it("holds the slack of a Go timer from 50 µs to 100 ms", () => {
    expect(goLateSeconds(0.01)).toBeCloseTo(0.00105, 12);
    expect(goLateSeconds(1)).toBeCloseTo(0.002, 12);
    expect(goLateSeconds(1000)).toBeCloseTo(0.101, 12);
  });
});
