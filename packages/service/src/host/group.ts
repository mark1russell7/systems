import type { Quantity } from "@mark1russell7/quantity";
import { convertible, isQuantity, valueIn } from "@mark1russell7/quantity";
import type { Backoff } from "../backoff.ts";
import { backoffProblems } from "../backoff.ts";
import type { Cancel } from "../clock.ts";
import type { LogFields, LogLevel } from "../logger.ts";
import type { MessageShape } from "../process.ts";
import { isMessageShape } from "../process.ts";
import type { Retrier } from "../retrier.ts";
import { retrier } from "../retrier.ts";
import { removeDiscovery, writeDiscovery } from "./discovery.ts";
import { parseEnvFile } from "./env.ts";
import type { InstanceLock } from "./lock.ts";
import { acquireInstanceLock } from "./lock.ts";
import type { LogSpec, RotatingLog } from "./logs.ts";
import { rotatingLog } from "./logs.ts";
import type { ChildHandle, HostPorts } from "./ports.ts";
import { joinPath } from "./ports.ts";
import type { ReadyProbe } from "./probes.ts";
import { probeOnce, probeProblems } from "./probes.ts";
import { stopTree } from "./processes.ts";
import { isTime } from "./render.ts";

/** A ready spec tells how the supervisor finds that a program is ready. */
export interface ReadySpec {
  readonly probe: ReadyProbe;
  /** This time is the pause between two uses of the probe. */
  readonly interval: Quantity;
  /** This time is the most that one use of the probe can take. */
  readonly timeout: Quantity;
  /** This time is the most that the program can take to be ready. After it, the supervisor stops the program and starts it again. */
  readonly within: Quantity;
}

/** A program restart tells how the supervisor starts a program again after it stops. */
export interface ProgramRestart {
  /** This backoff gives the wait before each start again, in milliseconds, as `retrier` uses it. */
  readonly backoff: Backoff;
  /** This time is how long a program is ready before its count of tries goes back to 0. */
  readonly resetAfter: Quantity;
}

/** A stop spec tells how the supervisor stops a program. */
export interface StopSpec {
  /** This time is the wait for the staged stop, before the supervisor stops the process tree. */
  readonly grace: Quantity;
  /** This message goes on the IPC channel of a child that has one. The default is `"shutdown"`, which `run()` can match. */
  readonly message?: MessageShape | undefined;
  /** This signal goes to a child without an IPC channel on Linux. The default is `SIGTERM`. */
  readonly signal?: "SIGINT" | "SIGTERM" | undefined;
}

/** A program spec tells one program of a group, and what it needs before it starts. */
export interface ProgramSpec {
  /** This name is the name of the program in the group: letters, digits, `.`, `_` and `-`. */
  readonly name: string;
  readonly program: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  /** These variables go to the program. They replace the variables of the env file and of the host. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** This file gives variables to the program at each start (`parseEnvFile`). They replace the variables of the host. */
  readonly envFile?: string | undefined;
  /** These are the programs that must be ready before this program starts. */
  readonly after?: readonly string[] | undefined;
  /** This spec tells when the program is ready. Without it, the program is ready when it starts. */
  readonly ready?: ReadySpec | undefined;
  /** This policy starts the program again after it stops. The default is `DEFAULT_RESTART`. Null does not start it again. */
  readonly restart?: ProgramRestart | null | undefined;
  /** This spec tells the log file. The default is `<stateDir>/logs/<name>.log`, 10 MB, with 3 old files. Null keeps no log. */
  readonly log?: LogSpec | null | undefined;
  /** True gives the child an IPC channel, for the staged stop of a Node program. The default is false. */
  readonly ipc?: boolean | undefined;
  /** This spec tells the stop. The default is a grace of 10 s. */
  readonly stop?: StopSpec | undefined;
  /** These fields go in the discovery file of the program, `<stateDir>/<name>.json`. */
  readonly listen?: { readonly port?: number | null | undefined; readonly url?: string | null | undefined } | undefined;
}

/** A group spec tells a group of programs that one supervisor starts in sequence and keeps alive. */
export interface GroupSpec {
  readonly name: string;
  /** This folder keeps the lock, the discovery file and the log of each program. */
  readonly stateDir: string;
  readonly programs: readonly ProgramSpec[];
}

/** These options go with a supervisor. */
export interface GroupOptions {
  /** This function gives a number in [0, 1) for the jitter of the backoff. The default is `Math.random`. */
  readonly random?: (() => number) | undefined;
}

/**
 * A program phase tells where a program of a group is.
 * - `waiting`: a program that it needs is not ready.
 * - `starting`: it runs, and its probe did not pass.
 * - `ready`: it runs, and its probe passed.
 * - `backoff`: it stopped, and it starts again after its backoff.
 * - `held`: another instance holds its lock. The supervisor tries again after the backoff.
 * - `exited`: it stopped, and it has no restart.
 * - `stopping`, `stopped`: the stop of the group.
 */
export type ProgramPhase = "waiting" | "starting" | "ready" | "backoff" | "held" | "exited" | "stopping" | "stopped";

/** A program state is the state of one program of a group, for a status. */
export interface ProgramState {
  readonly name: string;
  readonly phase: ProgramPhase;
  /** This number is the process ID of the child, or null. */
  readonly pid: number | null;
  /** This count is the number of starts again since the start of the group. */
  readonly restarts: number;
  /** This text tells the last problem, for example why the probe failed, or it is null. */
  readonly detail: string | null;
}

/** A group supervisor starts the programs of a group in sequence, starts each again after it stops, and stops them in stages. */
export interface GroupSupervisor {
  /** This method starts each program whose programs are ready. A second use does nothing. */
  start(): void;
  /** This method stops each program in the reverse sequence of the start. A second use gives the same promise. */
  stop(): Promise<void>;
  /** This method gives the state of each program, in the sequence of the spec. */
  states(): readonly ProgramState[];
}

/**
 * This restart is the default. The first wait is 1 s, and each wait after it is two times longer, to 1 min.
 * The jitter subtracts up to half of each wait. The count of tries goes back to 0 after 1 min ready.
 */
export const DEFAULT_RESTART: ProgramRestart = {
  backoff: { base: 1000, factor: 2, cap: 60_000, jitter: { kind: "subtract", fraction: 0.5 } },
  resetAfter: { value: 60, unit: "s" },
};

const DEFAULT_GRACE: Quantity = { value: 10, unit: "s" };
const DEFAULT_LOG_SIZE: Quantity = { value: 10, unit: "MB" };
const DEFAULT_LOG_KEEP = 3;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const ms = (time: Quantity): number => valueIn(time, "ms");

/**
 * This function gives the start sequence of a group, as layers of names. Each program of a layer needs only programs of the
 * layers before it. A program in a cycle, or after an unknown program, is in no layer. `groupProblems` names it.
 */
export const startOrder = (spec: GroupSpec): string[][] => {
  const names = new Set(spec.programs.map((program) => program.name));
  const placed = new Set<string>();
  const layers: string[][] = [];
  for (;;) {
    const layer = spec.programs
      .filter((program) => !placed.has(program.name))
      .filter((program) => (program.after ?? []).every((name) => names.has(name) && placed.has(name)))
      .map((program) => program.name);
    if (layer.length === 0) return layers;
    for (const name of layer) placed.add(name);
    layers.push([...new Set(layer)]);
  }
};

const isTimeAtLeast = (value: unknown, floor: number, strict: boolean): boolean =>
  isTime(value) && (strict ? ms(value) > floor : ms(value) >= floor);

/** This function gives the problems of a group spec: each value that the supervisor cannot use. */
export const groupProblems = (spec: GroupSpec): string[] => {
  const problems: string[] = [];
  if (!NAME.test(spec.name)) problems.push(`the group name ${JSON.stringify(spec.name)} is not letters, digits, ".", "_" and "-"`);
  if (spec.stateDir === "") problems.push("the stateDir is empty");
  if (spec.programs.length === 0) problems.push("the group has no programs");
  const seen = new Set<string>();
  const names = new Set(spec.programs.map((program) => program.name));
  for (const program of spec.programs) {
    const name = program.name;
    const of = `the program ${JSON.stringify(name)}`;
    if (!NAME.test(name)) problems.push(`${of}: the name is not letters, digits, ".", "_" and "-"`);
    if (seen.has(name)) problems.push(`${of} comes two times`);
    seen.add(name);
    if (program.program === "") problems.push(`${of}: the program is empty`);
    for (const need of program.after ?? []) {
      if (need === name) problems.push(`${of} is after itself`);
      else if (!names.has(need)) problems.push(`${of} is after ${JSON.stringify(need)}, which is not in the group`);
    }
    if (program.ready !== undefined) {
      problems.push(...probeProblems(program.ready.probe).map((problem) => `${of}: ${problem}`));
      for (const field of ["interval", "timeout", "within"] as const)
        if (!isTimeAtLeast(program.ready[field], 0, true)) problems.push(`${of}: the ${field} of the probe is not a time above zero`);
    }
    if (program.restart !== undefined && program.restart !== null) {
      problems.push(...backoffProblems(program.restart.backoff).map((problem) => `${of}: ${problem}`));
      if (!isTimeAtLeast(program.restart.resetAfter, 0, false)) problems.push(`${of}: the resetAfter is not a time of zero or more`);
    }
    if (program.log !== undefined && program.log !== null) {
      const size = program.log.maxSize;
      if (!(isQuantity(size) && convertible(size.unit, "B") && valueIn(size, "B") > 0)) problems.push(`${of}: the maxSize of the log is not a size above zero`);
      if (!(Number.isInteger(program.log.keep) && program.log.keep >= 0)) problems.push(`${of}: the keep of the log is not a whole number of zero or more`);
      if (program.log.path === "") problems.push(`${of}: the path of the log is empty`);
    }
    if (program.stop !== undefined) {
      if (!isTimeAtLeast(program.stop.grace, 0, false)) problems.push(`${of}: the grace of the stop is not a time of zero or more`);
      if (program.stop.message !== undefined && !isMessageShape(program.stop.message)) problems.push(`${of}: the stop message is not a value of JSON`);
      const signal = program.stop.signal;
      if (signal !== undefined && signal !== "SIGINT" && signal !== "SIGTERM") problems.push(`${of}: the stop signal ${JSON.stringify(signal)} is not SIGINT or SIGTERM`);
    }
    const port = program.listen?.port;
    if (port !== undefined && port !== null && !(Number.isInteger(port) && port >= 1 && port <= 65_535))
      problems.push(`${of}: the port ${port} is not a port from 1 to 65535`);
  }
  const placed = new Set(startOrder(spec).flat());
  const left = spec.programs.filter((program) => !placed.has(program.name) && (program.after ?? []).every((need) => names.has(need) && need !== program.name));
  if (left.length > 0) problems.push(`the programs ${left.map((program) => JSON.stringify(program.name)).join(", ")} are in a cycle of "after", or after a program in one`);
  return problems;
};

/** The supervisor keeps one unit for each program: its spec, its files and its state. */
interface Unit {
  readonly spec: ProgramSpec;
  readonly lockPath: string;
  readonly discoveryPath: string;
  readonly log: RotatingLog | null;
  readonly retry: Retrier | null;
  phase: ProgramPhase;
  child: ChildHandle | null;
  lock: InstanceLock | null;
  timers: Cancel[];
  restarts: number;
  detail: string | null;
  /** This text tells why the supervisor stopped the child, or it is null. */
  reason: string | null;
  waiters: Array<() => void>;
}

/**
 * This function makes the supervisor of a group. It refuses a spec with problems. Each effect goes
 * through the ports, thus a test gives `fakeHost()` and starts no process.
 * - A program starts when each program of its `after` is ready. It takes its lock first, thus a second instance does not start.
 * - A program with a probe is ready when its probe passes. A program that is not ready in `within` stops, and starts again.
 * - A program that stops starts again after the backoff of its `retrier`, when its programs are ready.
 * - Its output goes to its rotating log. Its environment is the host, then its env file, then its `env`.
 * - The stop goes in the reverse sequence: the staged stop first, and after the grace, the stop of the process tree by its ID.
 */
export const superviseGroup = (spec: GroupSpec, ports: HostPorts, options: GroupOptions = {}): GroupSupervisor => {
  const problems = groupProblems(spec);
  if (problems.length > 0) throw new Error(`the group ${spec.name} has problems: ${problems.join("; ")}`);
  const abort = new AbortController();
  const layers = startOrder(spec);
  let started = false;
  let stopping = false;
  let stopped: Promise<void> | null = null;

  const say = (level: LogLevel, message: string, fields: LogFields): void => {
    try {
      ports.logger?.log(level, message, { group: spec.name, ...fields });
    } catch {
      // the supervisor does not depend on its logger
    }
  };

  const units = new Map<string, Unit>();
  for (const program of spec.programs) {
    const restart = program.restart === undefined ? DEFAULT_RESTART : program.restart;
    const logSpec =
      program.log === undefined
        ? { path: joinPath(ports.platform, spec.stateDir, "logs", `${program.name}.log`), maxSize: DEFAULT_LOG_SIZE, keep: DEFAULT_LOG_KEEP }
        : program.log;
    units.set(program.name, {
      spec: program,
      lockPath: joinPath(ports.platform, spec.stateDir, `${program.name}.lock`),
      discoveryPath: joinPath(ports.platform, spec.stateDir, `${program.name}.json`),
      log: logSpec === null ? null : rotatingLog(logSpec, ports.files),
      retry:
        restart === null
          ? null
          : retrier({ ...restart.backoff, clock: ports.clock, signal: abort.signal, ...(options.random === undefined ? {} : { random: options.random }) }),
      phase: "waiting",
      child: null,
      lock: null,
      timers: [],
      restarts: 0,
      detail: null,
      reason: null,
      waiters: [],
    });
  }
  const unitOf = (name: string): Unit => units.get(name)!;

  const clearTimers = (unit: Unit): void => {
    for (const cancel of unit.timers.splice(0)) cancel();
  };

  const environment = async (unit: Unit): Promise<Record<string, string>> => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(ports.env)) if (value !== undefined) env[key] = value;
    const file = unit.spec.envFile;
    if (file !== undefined) {
      try {
        const text = await ports.files.read(file);
        if (text === null) say("warn", `the env file ${file} of ${unit.spec.name} does not exist`, { program: unit.spec.name, file });
        else {
          const parsed = parseEnvFile(text);
          Object.assign(env, parsed.env);
          for (const problem of parsed.problems) say("warn", `the env file ${file} of ${unit.spec.name}: ${problem}`, { program: unit.spec.name, file });
        }
      } catch (error) {
        say("warn", `the read of the env file ${file} of ${unit.spec.name} failed`, { program: unit.spec.name, file, error });
      }
    }
    return Object.assign(env, unit.spec.env ?? {});
  };

  const consider = (unit: Unit): void => {
    if (!started || stopping || unit.phase !== "waiting") return;
    if (!(unit.spec.after ?? []).every((name) => unitOf(name).phase === "ready")) return;
    void launch(unit);
  };
  const considerAll = (): void => {
    for (const layer of layers) for (const name of layer) consider(unitOf(name));
  };

  /** This function starts the program again after the backoff, or ends it when it has no restart. */
  const later = (unit: Unit, phase: "backoff" | "held"): void => {
    const delay = unit.retry?.schedule(() => {
      if (stopping) return;
      unit.phase = "waiting";
      unit.restarts += 1;
      consider(unit);
    });
    if (delay === undefined || delay === null) {
      unit.phase = phase === "held" ? "held" : "exited";
      void unit.lock?.release();
      unit.lock = null;
      return;
    }
    unit.phase = phase;
    say("info", `${unit.spec.name} starts again in ${delay} ms`, { program: unit.spec.name, delay: { value: delay, unit: "ms" }, attempt: unit.retry?.attempts });
  };

  const markReady = (unit: Unit, child: ChildHandle): void => {
    if (unit.child !== child || stopping) return;
    unit.phase = "ready";
    unit.detail = null;
    say("info", `${unit.spec.name} is ready`, { program: unit.spec.name, pid: child.pid });
    const restart = unit.spec.restart === undefined ? DEFAULT_RESTART : unit.spec.restart;
    if (unit.retry !== null && restart !== null)
      unit.timers.push(
        ports.clock.after(ms(restart.resetAfter), () => {
          if (unit.child === child && unit.phase === "ready") unit.retry?.reset();
        }),
      );
    considerAll();
  };

  const probe = (unit: Unit, child: ChildHandle, ready: ReadySpec): void => {
    const deadline = ports.clock.now() + ms(ready.within);
    const attempt = async (): Promise<void> => {
      if (unit.child !== child || stopping) return;
      const result = await probeOnce(ready.probe, ms(ready.timeout), ports);
      if (unit.child !== child || stopping) return;
      if (result.ok) {
        markReady(unit, child);
        return;
      }
      unit.detail = result.why;
      if (ports.clock.now() >= deadline) {
        unit.reason = `it was not ready in ${ms(ready.within)} ms (${result.why})`;
        unit.detail = unit.reason;
        say("warn", `${unit.spec.name} is not ready in its time, thus it stops`, { program: unit.spec.name, pid: child.pid, why: result.why });
        void stagedStop(unit, child);
        return;
      }
      unit.timers.push(ports.clock.after(ms(ready.interval), () => void attempt()));
    };
    void attempt();
  };

  const exited = (unit: Unit, child: ChildHandle, code: number | null, signal: string | null): void => {
    if (unit.child !== child) return;
    clearTimers(unit);
    unit.child = null;
    for (const waiter of unit.waiters.splice(0)) waiter();
    if (child.pid !== null) void removeDiscovery(unit.discoveryPath, ports, child.pid);
    void unit.lock?.update(null).catch(() => {});
    if (stopping || unit.phase === "stopping") {
      unit.phase = "stopped";
      return;
    }
    const end = child.pid === null ? `${unit.spec.program} did not start` : `it exited with ${code === null ? `the signal ${signal ?? "unknown"}` : `the code ${code}`}`;
    unit.detail = unit.reason === null ? end : `${unit.reason}, then ${end}`;
    unit.reason = null;
    say("warn", `${unit.spec.name} stopped: ${unit.detail}`, { program: unit.spec.name, pid: child.pid, code, signal });
    later(unit, "backoff");
  };

  const launch = async (unit: Unit): Promise<void> => {
    unit.phase = "starting";
    unit.detail = null;
    const name = unit.spec.name;
    if (unit.lock === null) {
      const taken = await acquireInstanceLock(unit.lockPath, ports);
      if (stopping) {
        if (taken.kind === "acquired") await taken.lock.release();
        return;
      }
      if (taken.kind !== "acquired") {
        unit.detail = taken.kind === "held" ? `the process ${taken.owner.child?.pid ?? taken.owner.pid} holds the lock ${unit.lockPath}` : taken.problem;
        say("warn", `${name} does not start: ${unit.detail}`, { program: name, lock: unit.lockPath });
        later(unit, "held");
        return;
      }
      unit.lock = taken.lock;
    }
    const lock = unit.lock;
    const env = await environment(unit);
    if (stopping) {
      await lock.release();
      unit.lock = null;
      return;
    }
    const child = ports.processes.spawn({ program: unit.spec.program, args: unit.spec.args ?? [], cwd: unit.spec.cwd, env, ipc: unit.spec.ipc ?? false });
    const startedAt = ports.wall();
    unit.child = child;
    child.onOutput((_stream, chunk) => unit.log?.write(chunk));
    child.onExit((code, signal) => exited(unit, child, code, signal));
    const pid = child.pid;
    if (pid === null) return;
    say("info", `${name} started`, { program: name, pid });
    const mark = { pid, startedAt };
    try {
      await lock.update(mark);
      await writeDiscovery(
        unit.discoveryPath,
        { pid, startedAt: new Date(startedAt).toISOString(), port: unit.spec.listen?.port ?? null, url: unit.spec.listen?.url ?? null, extra: { group: spec.name, program: name } },
        ports,
      );
    } catch (error) {
      say("warn", `the files of ${name} were not written`, { program: name, error });
    }
    // a child that ended during the writes leaves no discovery file
    if (unit.child !== child) await removeDiscovery(unit.discoveryPath, ports, pid);
    if (unit.child !== child || stopping) return;
    if (unit.spec.ready === undefined) markReady(unit, child);
    else probe(unit, child, unit.spec.ready);
  };

  /** This function waits for the end of a child, for at most `wait` milliseconds. It tells if the child ended. */
  const ended = (unit: Unit, child: ChildHandle, wait: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (unit.child !== child) {
        resolve(true);
        return;
      }
      const cancel = ports.clock.after(wait, () => resolve(unit.child !== child));
      unit.waiters.push(() => {
        cancel();
        resolve(true);
      });
    });

  /**
   * This function stops a child in stages. The message goes on its IPC channel when it has one. Else
   * Linux gets SIGTERM, and Windows gets `taskkill /T` without `/F`. After the grace, the process tree stops by its ID.
   */
  const stagedStop = async (unit: Unit, child: ChildHandle): Promise<void> => {
    const pid = child.pid;
    if (pid === null || unit.child !== child) return;
    const grace = ms(unit.spec.stop?.grace ?? DEFAULT_GRACE);
    const gone = ended(unit, child, grace);
    let asked: string | null = null;
    if (child.ipc && child.send(unit.spec.stop?.message ?? "shutdown")) asked = "the IPC message";
    else if (ports.platform === "win32") {
      const result = await ports.commands.run("taskkill", ["/T", "/PID", String(pid)]).catch(() => null);
      if (result?.code === 0) asked = "taskkill";
    } else {
      const signal = unit.spec.stop?.signal ?? "SIGTERM";
      if (ports.processes.signal(pid, signal)) asked = signal;
    }
    say("info", `${unit.spec.name} stops${asked === null ? "" : ` through ${asked}`}`, { program: unit.spec.name, pid, grace: { value: grace, unit: "ms" } });
    if (asked !== null && (await gone)) return;
    const tree = await stopTree(pid, ports);
    const why = asked === null ? "the staged stop did not go" : "it did not stop in its grace";
    say(tree.kind === "failed" ? "error" : "warn", `${unit.spec.name}: ${why}, thus its process tree stops: ${tree.kind}`, {
      program: unit.spec.name,
      pid,
      outcome: tree.kind,
    });
    if (!(await ended(unit, child, grace))) say("error", `${unit.spec.name} did not end after the stop of its process tree`, { program: unit.spec.name, pid });
  };

  const stopUnit = async (unit: Unit): Promise<void> => {
    clearTimers(unit);
    const child = unit.child;
    const pid = child?.pid ?? null;
    if (child !== null && pid !== null) {
      unit.phase = "stopping";
      await stagedStop(unit, child);
      await removeDiscovery(unit.discoveryPath, ports, pid);
    }
    unit.phase = "stopped";
    await unit.lock?.release();
    unit.lock = null;
  };

  return {
    start() {
      if (started || stopping) return;
      started = true;
      say("info", `the group ${spec.name} starts`, { layers });
      considerAll();
    },
    stop() {
      if (stopped !== null) return stopped;
      stopping = true;
      abort.abort();
      stopped = (async () => {
        for (const layer of [...layers].reverse()) await Promise.all(layer.map((name) => stopUnit(unitOf(name))));
        await Promise.all([...units.values()].map((unit) => unit.log?.flush()));
        say("info", `the group ${spec.name} stopped`, {});
      })();
      return stopped;
    },
    states() {
      return spec.programs.map((program) => {
        const unit = unitOf(program.name);
        return { name: program.name, phase: unit.phase, pid: unit.child?.pid ?? null, restarts: unit.restarts, detail: unit.detail };
      });
    },
  };
};
