import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { ServiceDescription } from "./description.ts";
import type { LifecycleEvent, Recorder } from "./events.ts";

/** These are the levels of a log entry, from the least to the most severe. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** These fields are the structured data of a log entry, for example the machine and the cap of a phase. */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * A logger is the port that receives the log entries of the runtime. It has one method, thus an
 * adapter to another logger is a few lines. For example, `{ log: (level, message, fields) => app[level](message, fields) }`.
 */
export interface Logger {
  log(level: LogLevel, message: string, fields: LogFields): void;
}

/** A log entry is one call of a logger, as a test logger keeps it. */
export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/** This function tells if `level` is at `least` or more severe. */
export const atLeast = (level: LogLevel, least: LogLevel): boolean => LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(least);

/** A console target has one method for each level, as the console of Node and of a browser has. */
export type ConsoleTarget = Readonly<Record<LogLevel, (...data: unknown[]) => void>>;

/** These options make the console logger. */
export interface ConsoleLoggerOptions {
  /** This level is the least severe level that the logger writes. The default is `info`. */
  readonly level?: LogLevel | undefined;
  /** This target receives each entry. The default is the global console. */
  readonly console?: ConsoleTarget | undefined;
}

/**
 * This function makes the console logger. It writes each entry at its level or more severe to the
 * method of that level, with the message first and then the fields.
 */
export const consoleLogger = (options: ConsoleLoggerOptions = {}): Logger => {
  const least = options.level ?? "info";
  return {
    log(level, message, fields) {
      if (!atLeast(level, least)) return;
      const target = options.console ?? globalThis.console;
      if (Object.keys(fields).length === 0) target[level](message);
      else target[level](message, fields);
    },
  };
};

const seconds = (cap: Quantity): string => `${valueIn(cap, "s")} s`;

/** This function gives the exit code from the detail of an exit event, for example `exit 1`. */
const exitCodeOf = (detail: string | undefined): number | null => {
  const found = /^exit (\d+)$/.exec(detail ?? "");
  return found === null ? null : Number(found[1]);
};

/**
 * This function makes a recorder that writes each lifecycle event to a logger. Thus the logger is
 * one sink of the same stream as the recorder, not a second set of calls. The levels are these:
 * - `error`: each error of the lifecycle, and an exit at once on a repeat signal.
 * - `warn`: a phase at its cap, a failed startup, a startup over its budget, a tripped latch and a blocked event loop.
 * - `info`: each step of the startup, the start and the end of each phase, the exit, and each recovery.
 * - `debug`: each other transition, for example each poll of a check.
 * With the description, the entry of a phase also gives its cap. A failure of the logger does not stop the lifecycle.
 */
export const logEvents = (logger: Logger, description?: ServiceDescription): Recorder => {
  const caps = new Map((description?.shutdown.phases ?? []).map((phase) => [phase.name, phase.cap] as const));
  // the time that each phase started, for the duration in the entry of its end
  const startedAt = new Map<string, number>();
  const write = (level: LogLevel, message: string, fields: LogFields): void => {
    try {
      logger.log(level, message, fields);
    } catch {
      // the lifecycle does not depend on its logger
    }
  };
  const phaseEnd = (event: LifecycleEvent, base: LogFields): void => {
    const phase = event.from;
    const cap = caps.get(phase);
    const begun = startedAt.get(phase);
    const reached = event.on === "phase.cap";
    const fields: LogFields = {
      ...base,
      phase,
      outcome: reached ? "cap" : "done",
      ...(cap === undefined ? {} : { cap }),
      ...(begun === undefined ? {} : { took: { value: event.at - begun, unit: "ms" } }),
    };
    if (reached) write("warn", `the phase ${phase} reached its cap${cap === undefined ? "" : ` of ${seconds(cap)}`}`, fields);
    else write("info", `the phase ${phase} ended in its cap`, fields);
  };
  const phaseStart = (event: LifecycleEvent, base: LogFields): void => {
    const phase = event.to;
    const cap = caps.get(phase);
    startedAt.set(phase, event.at);
    write("info", `the phase ${phase} starts${cap === undefined ? "" : `, with a cap of ${seconds(cap)}`}`, {
      ...base,
      phase,
      ...(cap === undefined ? {} : { cap }),
    });
  };
  return (event) => {
    const { machine, instance, from, to, on, at, detail } = event;
    const base: LogFields = { machine, instance, from, to, on, at, ...(detail === undefined ? {} : { detail }) };
    switch (machine) {
      case "gate":
        if (on === "component.started") return write("info", `${detail ?? "a component"} started`, { ...base, component: detail });
        if (on === "startup.begin") return write("info", `the startup of ${instance} begins`, base);
        if (on === "mark-ready") return write("info", "the warm-up sweep begins", base);
        if (on === "sweep.done") return write("info", `${instance} is ready: the startup gate is open`, base);
        if (on === "startup.fail") return write("warn", `the startup of ${instance} failed`, base);
        if (on === "startup.over-budget") return write("warn", `the startup of ${instance} is over its budget`, base);
        break;
      case "exit":
        if (on === "error") return write("error", detail ?? "an error of the lifecycle", base);
        if (to === "exited") {
          const code = exitCodeOf(detail);
          const fields = { ...base, code };
          if (on === "exit.repeat") return write("error", `a signal came again, and ${instance} exits at once with the code ${code}`, fields);
          return write("info", `${instance} exited with the code ${code}`, fields);
        }
        if (from === "running" && to === "stopping") return write("info", `the shutdown of ${instance} begins`, { ...base, cause: detail });
        if (on === "exit.repeat") return write("info", "a trigger came again while the shutdown runs", base);
        break;
      case "drain":
        if (on === "signal.abort") return write("info", `the signal of ${instance} aborts`, base);
        if (on === "drain.cooperative-abort") return write("info", "the cooperative abort of the drain", base);
        if (on === "phase.done" || on === "phase.cap") phaseEnd(event, base);
        if (to !== "done" && from !== to) phaseStart(event, base);
        else if (to === "done") write("info", `the shutdown of ${instance} ended its phases`, base);
        return;
      case "latch":
      case "window":
        if (to === "tripped" && from !== "tripped") return write("warn", `the check ${instance} tripped its latch`, base);
        if (to === "released" && (from === "tripped" || from === "recovering")) return write("info", `the check ${instance} released its latch`, base);
        break;
      case "watchdog":
        if (to === "blocked" && from !== "blocked") return write("warn", "the event loop is blocked", base);
        if (to === "watching" && from === "blocked") return write("info", "the event loop is no longer blocked", base);
        break;
      default:
        break;
    }
    write("debug", `${machine} ${instance}: ${from} -> ${to} on ${on}`, base);
  };
};
