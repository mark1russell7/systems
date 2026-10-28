import { describe, expect, it } from "vitest";
import type { ConsoleTarget, LogFormat, LogLevel } from "./index.ts";
import { consoleLogger } from "./index.ts";

/** SYS-46: the console logger can write one line of JSON for each entry. */

/** This target keeps each call of the console, by its level. */
const fakeConsole = (): ConsoleTarget & { calls: Array<[LogLevel, unknown[]]> } => {
  const calls: Array<[LogLevel, unknown[]]> = [];
  const at = (level: LogLevel) => (...data: unknown[]) => {
    calls.push([level, data]);
  };
  return { calls, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
};

describe("consoleLogger({ format: 'json' }): one JSON object for each line (SYS-46)", () => {
  it("writes one line of JSON with the level, the message and each field, to the method of the level", () => {
    const target = fakeConsole();
    const logger = consoleLogger({ level: "info", format: "json", console: target });
    logger.log("debug", "a poll", { machine: "poller" });
    logger.log("info", "svc exited with the code 0", { machine: "exit", code: 0, took: { value: 5, unit: "ms" } });
    logger.log("error", "no fields", {});
    expect(target.calls.map(([level, data]) => [level, data.length])).toEqual([
      ["info", 1],
      ["error", 1],
    ]);
    const [line] = target.calls[0]![1] as [string];
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({ level: "info", message: "svc exited with the code 0", machine: "exit", code: 0, took: { value: 5, unit: "ms" } });
    expect(JSON.parse(target.calls[1]![1][0] as string)).toEqual({ level: "error", message: "no fields" });
  });

  it("writes an error with its stack on one line, a bigint as text, and keeps its own level and message", () => {
    const target = fakeConsole();
    const logger = consoleLogger({ format: "json", console: target });
    logger.log("warn", "skipped", { error: new Error("read ECONNRESET"), count: 10n, level: "debug", message: "a field" });
    const line = target.calls[0]![1][0] as string;
    expect(line.split("\n")).toHaveLength(1);
    const entry = JSON.parse(line) as { level: string; message: string; count: string; error: { name: string; message: string; stack: string } };
    expect([entry.level, entry.message, entry.count]).toEqual(["warn", "skipped", "10"]);
    expect(entry.error).toMatchObject({ name: "Error", message: "read ECONNRESET" });
    expect(entry.error.stack).toMatch(/^Error: read ECONNRESET\n/);
  });

  it("writes a line with the failure when JSON cannot write a field, for example a cycle", () => {
    const target = fakeConsole();
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    consoleLogger({ format: "json", console: target }).log("info", "a cycle", { cycle });
    const entry = JSON.parse(target.calls[0]![1][0] as string) as Record<string, unknown>;
    expect(entry).toMatchObject({ level: "info", message: "a cycle" });
    expect(typeof entry["unwritten"]).toBe("string");
  });

  it("keeps the text format by default, and refuses an unknown format", () => {
    const target = fakeConsole();
    consoleLogger({ console: target }).log("info", "hello", { a: 1 });
    consoleLogger({ console: target, format: "text" }).log("info", "plain", {});
    expect(target.calls).toEqual([
      ["info", ["hello", { a: 1 }]],
      ["info", ["plain"]],
    ]);
    expect(() => consoleLogger({ format: "yaml" as LogFormat })).toThrow('the log format "yaml" is not "text" or "json"');
  });
});
