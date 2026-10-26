import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConsoleTarget, LogFields, LogLevel, Logger } from "./index.ts";
import { LOG_LEVELS, atLeast, consoleLogger, logEvents } from "./index.ts";
import { exited, rig, run } from "./rig.ts";
import { testLogger } from "./testing.ts";

const s = (value: number) => ({ value, unit: "s" });

/** This target keeps each call of the console, by its level. */
const fakeConsole = (): ConsoleTarget & { calls: Array<[LogLevel, unknown[]]> } => {
  const calls: Array<[LogLevel, unknown[]]> = [];
  const at = (level: LogLevel) => (...data: unknown[]) => {
    calls.push([level, data]);
  };
  return { calls, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("run() logs its stages through the logger (SYS-37)", () => {
  it("logs each startup step, each phase with its cap and its outcome, and the exit code", async () => {
    const r = rig();
    const life = await run(r);
    r.process.signal("SIGTERM");
    expect(await exited(r, life)).toBe(0);
    expect(r.logger.messages("info")).toEqual([
      "the startup of svc begins",
      "the health server started",
      "dependency db started",
      "dependency cache started",
      "server http started",
      "the warm-up sweep begins",
      "the check db.round-trip released its latch",
      "the check cache.round-trip released its latch",
      "svc is ready: the startup gate is open",
      "the shutdown of svc begins",
      "the phase fail readiness starts, with a cap of 1 s",
      "the phase fail readiness ended in its cap",
      "the phase stop intake starts, with a cap of 1 s",
      "the phase stop intake ended in its cap",
      "the phase drain starts, with a cap of 4 s",
      "the phase drain ended in its cap",
      "the phase close transports starts, with a cap of 1 s",
      "the phase close transports ended in its cap",
      "the phase stop the poller starts, with a cap of 1 s",
      "the phase stop the poller ended in its cap",
      // the signal of the service aborts after the poller stops, at the start of the next phase
      "the phase tear down dependencies starts, with a cap of 1 s",
      "the signal of svc aborts",
      "the phase tear down dependencies ended in its cap",
      "the phase close the health server starts, with a cap of 1 s",
      "the phase close the health server ended in its cap",
      "the shutdown of svc ended its phases",
      "svc exited with the code 0",
    ]);
    expect(r.logger.messages("warn")).toEqual([]);
    expect(r.logger.messages("error")).toEqual([]);
    // the polls of the checks are at the debug level, thus a console logger at info does not write them
    expect(r.logger.entries.some((entry) => entry.level === "debug" && entry.fields["machine"] === "poller")).toBe(true);
    const held = r.logger.entries.find((entry) => entry.message === "the phase fail readiness ended in its cap")!;
    expect(held.fields).toMatchObject({ machine: "drain", phase: "fail readiness", outcome: "done", cap: s(1), took: { value: 1000, unit: "ms" } });
    const exit = r.logger.entries.find((entry) => entry.message === "svc exited with the code 0")!;
    expect(exit.fields).toMatchObject({ machine: "exit", to: "exited", on: "shutdown.done", code: 0 });
  });

  it("logs a phase at its cap as a warning, and its failure as an error", async () => {
    const r = rig();
    r.svc.onPhase("close transports", () => new Promise<void>(() => {}));
    const life = await run(r);
    r.process.signal("SIGTERM");
    expect(await exited(r, life)).toBe(1);
    expect(r.logger.messages("warn")).toEqual(["the phase close transports reached its cap of 1 s"]);
    expect(r.logger.entries.find((entry) => entry.level === "warn")!.fields).toMatchObject({
      phase: "close transports",
      outcome: "cap",
      cap: s(1),
    });
    expect(r.logger.messages("error")).toEqual(["the phase close transports did not end in its cap of 1 s"]);
    expect(r.logger.messages("info").at(-1)).toBe("svc exited with the code 1");
  });

  it("logs a failed startup as a warning, and its cause as an error", async () => {
    const r = rig({ failConnect: "cache" });
    const life = await run(r);
    expect(await exited(r, life)).toBe(1);
    expect(r.logger.messages("warn")).toEqual(["the startup of svc failed"]);
    expect(r.logger.messages("error")).toEqual(["the startup failed: cache refused the connection"]);
    expect(r.logger.messages("info")).toContain("dependency db started");
    expect(r.logger.messages("info")).not.toContain("dependency cache started");
  });

  it("gives each event to the recorder too, and a logger that throws does not stop the lifecycle", async () => {
    const r = rig();
    const thrower: Logger = {
      log: () => {
        throw new Error("the logger failed");
      },
    };
    const life = await run(r, () => {}, { logger: thrower });
    expect(life.state).toBe("running");
    r.process.signal("SIGTERM");
    expect(await exited(r, life)).toBe(0);
    expect(r.events.some((event) => event.on === "shutdown.done")).toBe(true);
    expect(r.logger.entries).toEqual([]);
  });

  it("writes nothing to the console without a logger, as before", async () => {
    const spies = LOG_LEVELS.map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const r = rig({ failConnect: "db" });
    const life = await run(r, () => {}, { logger: undefined });
    expect(await exited(r, life)).toBe(1);
    expect(r.logger.entries).toEqual([]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("the console logger", () => {
  it("writes info and above by default, with the fields after the message", () => {
    const target = fakeConsole();
    const logger = consoleLogger({ console: target });
    logger.log("debug", "a poll", { machine: "poller" });
    logger.log("info", "the phase drain starts", { phase: "drain", cap: s(4) });
    logger.log("warn", "a cap", {});
    logger.log("error", "an error", { detail: "x" });
    expect(target.calls).toEqual([
      ["info", ["the phase drain starts", { phase: "drain", cap: s(4) }]],
      ["warn", ["a cap"]],
      ["error", ["an error", { detail: "x" }]],
    ]);
  });

  it("writes the debug level when its level is debug, and only errors at error", () => {
    const all = fakeConsole();
    consoleLogger({ level: "debug", console: all }).log("debug", "a poll", {});
    expect(all.calls).toEqual([["debug", ["a poll"]]]);
    const errors = fakeConsole();
    const quiet = consoleLogger({ level: "error", console: errors });
    for (const level of LOG_LEVELS) quiet.log(level, level, {});
    expect(errors.calls).toEqual([["error", ["error"]]]);
  });

  it("writes to the global console when no target is given", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleLogger().log("info", "svc exited with the code 0", { code: 0 });
    expect(info).toHaveBeenCalledWith("svc exited with the code 0", { code: 0 });
  });

  it("orders the levels from debug to error", () => {
    expect(atLeast("warn", "info")).toBe(true);
    expect(atLeast("debug", "info")).toBe(false);
    expect(atLeast("error", "error")).toBe(true);
  });
});

describe("a custom logger", () => {
  it("gets the levels and the fields of each event, through an adapter of a few lines", () => {
    // an app logger with one method for each level, and the fields first, as many loggers have
    const got: Array<{ level: LogLevel; fields: LogFields; message: string }> = [];
    const at = (level: LogLevel) => (fields: LogFields, message: string) => {
      got.push({ level, fields, message });
    };
    const app = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
    const adapter: Logger = { log: (level, message, fields) => app[level](fields, message) };
    const record = logEvents(adapter);
    record({ at: 5, machine: "latch", instance: "db.round-trip", from: "released", to: "tripped", on: "poll.fail" });
    record({ at: 6, machine: "watchdog", instance: "process.event-loop", from: "watching", to: "blocked", on: "tick" });
    record({ at: 7, machine: "client", instance: "cache", from: "ready", to: "failing", on: "connect.failed", detail: "refused" });
    expect(got.map((each) => [each.level, each.message])).toEqual([
      ["warn", "the check db.round-trip tripped its latch"],
      ["warn", "the event loop is blocked"],
      ["debug", "client cache: ready -> failing on connect.failed"],
    ]);
    expect(got[2]!.fields).toEqual({ machine: "client", instance: "cache", from: "ready", to: "failing", on: "connect.failed", at: 7, detail: "refused" });
  });

  it("gets the entries of run() from the option of the builder, beside the recorder", async () => {
    const logger = testLogger();
    const r = rig();
    const life = await run(r, () => {}, { logger });
    expect(life.state).toBe("running");
    expect(r.events.length).toBeGreaterThan(0);
    expect(logger.messages("info")).toContain("svc is ready: the startup gate is open");
    expect(r.logger.entries).toEqual([]);
    logger.clear();
    expect(logger.entries).toEqual([]);
  });
});
