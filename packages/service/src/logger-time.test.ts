import { fakeWallClock } from "@mark1russell7/algebra/clock";
import { describe, expect, it } from "vitest";
import type { ConsoleTarget, LogLevel } from "./index.ts";
import { consoleLogger } from "./index.ts";

/** SYS-149: with a wall clock, each line of the console logger starts with its time. */

/** This target keeps each call of the console, by its level. */
const fakeConsole = (): ConsoleTarget & { calls: Array<[LogLevel, unknown[]]> } => {
  const calls: Array<[LogLevel, unknown[]]> = [];
  const at = (level: LogLevel) => (...data: unknown[]) => {
    calls.push([level, data]);
  };
  return { calls, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
};

const T0 = Date.UTC(2026, 10, 22, 12, 0, 0, 5);

describe("consoleLogger({ wall }): a time on each line (SYS-149)", () => {
  it("writes the time before the message in text, and a step of the clock moves it", () => {
    const target = fakeConsole();
    const wall = fakeWallClock(T0);
    const logger = consoleLogger({ console: target, wall });
    logger.log("info", "the startup begins", {});
    wall.set(T0 - 60_000);
    logger.log("warn", "the phase drain reached its cap", { phase: "drain" });
    expect(target.calls).toEqual([
      ["info", ["2026-11-22T12:00:00.005Z the startup begins"]],
      ["warn", ["2026-11-22T11:59:00.005Z the phase drain reached its cap", { phase: "drain" }]],
    ]);
  });

  it("writes the field time first in json, and a field of the entry named time does not replace it", () => {
    const target = fakeConsole();
    const logger = consoleLogger({ console: target, format: "json", wall: fakeWallClock(T0) });
    logger.log("error", "a fault", { time: "a field", code: 1 });
    const line = target.calls[0]![1][0] as string;
    expect(line.startsWith('{"time":"2026-11-22T12:00:00.005Z","level":"error"')).toBe(true);
    expect(JSON.parse(line)).toEqual({ time: "2026-11-22T12:00:00.005Z", level: "error", message: "a fault", code: 1 });
  });

  it("writes the old lines with no clock, also an entry with a field named time", () => {
    const target = fakeConsole();
    const text = consoleLogger({ console: target });
    const json = consoleLogger({ console: target, format: "json" });
    text.log("info", "no time", {});
    json.log("info", "a field", { time: "kept", code: 2 });
    expect(target.calls[0]).toEqual(["info", ["no time"]]);
    expect(target.calls[1]![1][0]).toBe('{"level":"info","message":"a field","time":"kept","code":2}');
  });
});
