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
import type { StallMark } from "./pressure.ts";
import { readStallMark, stalledShare } from "./pressure.ts";
import { stopTree } from "./processes.ts";
import type { ReadyTime, WindowRule } from "./ready-times.ts";
import { addReadyTime, measuredWindowMs, parseReadyTimes, readyTimesText } from "./ready-times.ts";
import { isTime } from "./render.ts";

/** A ready spec tells how the supervisor finds that a program is ready. */
export interface ReadySpec {
  readonly probe: ReadyProbe;
  /** This time is the pause between two uses of the probe. */
  readonly interval: Quantity;
  /** This time is the most that one use of the probe can take. */
  readonly timeout: Quantity;
  /**
   * This time is the most that the program can take to be ready. After it, the supervisor stops the program and starts it again.
   * With `measured`, it is the window of the starts before the program has measured ready times.
   */
  readonly within: Quantity;
  /**
   * This growth makes the window longer after each start that is not ready in its window. Without it, each start
   * has the window `within`. A slow host can need more time than `within`. Then each start stops at the same time, and
   * the program does not get ready.
   */
  readonly grow?: ReadyGrowth | undefined;
  /**
   * This measure gives the window of each start from the ready times of the starts before it, on this host. A ready spec
   * has `grow` or `measured`, not the two.
   */
  readonly measured?: ReadyMeasure | undefined;
}

/**
 * A ready measure tells how the supervisor makes the window of a start from measured ready times. A ready time goes from
 * the spawn of the child to the first pass of its probe, on the clock of the ports. The supervisor keeps the times in the
 * file `<stateDir>/<name>.ready.json`, thus a new supervisor keeps them.
 * - Before `after` ready times, the window is `within`.
 * - Then the window is the worst of the last `keep` ready times, plus the worst minus the best.
 * - A start that is not ready in its window makes the next window at least two times longer.
 * - The window is not shorter than `floor` and not longer than `cap`.
 */
export interface ReadyMeasure {
  /** This count of ready times gives the first measured window: a whole number of 1 or more. */
  readonly after: number;
  /** This count is the most ready times that the window uses: a whole number of `after` or more. */
  readonly keep: number;
  /** This time is the shortest window. */
  readonly floor: Quantity;
  /** This time is the longest window. It is not shorter than `floor` or `within`. */
  readonly cap: Quantity;
}

/**
 * A ready growth tells how the window of a start grows. The count `missed` is the count of starts in sequence that were not
 * ready in their window. The window of a start is `within` times `factor` to the power of `missed`, and not more than `cap`.
 * A ready start sets the count to 0.
 */
export interface ReadyGrowth {
  /** This number multiplies the window after each start that is not ready in it: a finite number above 1. */
  readonly factor: number;
  /** This time is the longest window. It is not shorter than `within`. */
  readonly cap: Quantity;
}

/**
 * An alive spec tells how the supervisor finds that a ready program still works. A program can hang and not exit:
 * its process stays, and only a probe finds it. After `failures` failures in sequence, the supervisor stops the
 * program in stages and starts it again after its backoff.
 */
export interface AliveSpec {
  readonly probe: ReadyProbe;
  /** This time is the pause between two uses of the probe. The first use is one interval after the program is ready. */
  readonly interval: Quantity;
  /** This time is the most that one use of the probe can take. */
  readonly timeout: Quantity;
  /** This count of failures in sequence stops the program: a whole number of 1 or more. A pass sets the count to 0. */
  readonly failures: number;
  /** This excuse lets a failure in a full stall of the host not count. Without it, each failure counts. */
  readonly stall?: AliveStall | undefined;
}

/**
 * A stall excuse tells when a failure of the liveness probe does not count. In a full stall of memory or IO, each task of
 * the host waits. A program in such a stall does not answer, but it does not hang. The supervisor reads the full stall times of
 * a Linux host (`/proc/pressure`) at each use of the probe. On other hosts, each failure counts. The log record of each
 * failure has the measured share in the field `stalledShare`, also for a failure that counts.
 */
export interface AliveStall {
  /** This share of the span of a failure in a full stall excuses the failure: a number above 0 and not above 1. */
  readonly share: number;
  /** This count is the most excused failures in sequence: a whole number of 1 or more. A pass sets the count to 0. */
  readonly most: number;
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
  /** This spec tells how the supervisor finds that the ready program still works. Without it, only an exit starts the program again. */
  readonly alive?: AliveSpec | undefined;
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

/** This function gives the window of a start in milliseconds, after `missed` starts in sequence that were not ready in their window. */
const readyWindowMs = (ready: ReadySpec, missed: number): number => {
  const within = ms(ready.within);
  if (ready.grow === undefined || missed === 0) return within;
  return Math.min(ms(ready.grow.cap), Math.round(within * ready.grow.factor ** missed));
};

/** This function gives the problems of the measure of a ready spec. */
const measureProblems = (ready: ReadySpec): string[] => {
  const measure = ready.measured;
  if (measure === undefined) return [];
  const problems: string[] = [];
  if (ready.grow !== undefined) problems.push("the ready spec has a growth and a measure, but it can have only one of them");
  if (!(Number.isInteger(measure.after) && measure.after >= 1)) problems.push("the after of the ready measure is not a whole number of 1 or more");
  if (!(Number.isInteger(measure.keep) && measure.keep >= 1)) problems.push("the keep of the ready measure is not a whole number of 1 or more");
  else if (Number.isInteger(measure.after) && measure.keep < measure.after) problems.push("the keep of the ready measure is less than its after");
  for (const field of ["floor", "cap"] as const)
    if (!isTimeAtLeast(measure[field], 0, true)) problems.push(`the ${field} of the ready measure is not a time above zero`);
  if (isTime(measure.cap)) {
    if (isTime(measure.floor) && ms(measure.cap) < ms(measure.floor)) problems.push("the cap of the ready measure is shorter than its floor");
    if (isTime(ready.within) && ms(measure.cap) < ms(ready.within)) problems.push("the cap of the ready measure is shorter than the within of the probe");
  }
  return problems;
};

/** This function gives the window rule of a ready measure in milliseconds. */
const windowRule = (ready: ReadySpec, measure: ReadyMeasure): WindowRule => ({
  firstMs: ms(ready.within),
  after: measure.after,
  keep: measure.keep,
  floorMs: ms(measure.floor),
  capMs: ms(measure.cap),
});

/** A ready window is the window of the next start of a program, with the times that gave it. */
export interface ReadyWindow {
  /** This number is the window in milliseconds. */
  readonly ms: number;
  /** This count is the ready times that the window uses. It is 0 without a measure. */
  readonly measured: number;
  /** This count is the missed starts after the last ready start. It is 0 without a measure. */
  readonly missed: number;
  /** This text tells why the supervisor cannot use the file of the ready times, or it is null. */
  readonly problem: string | null;
}

/** This function gives the path of the file of the ready times of a program: `<stateDir>/<name>.ready.json`. */
export const readyTimesPath = (platform: string, stateDir: string, name: string): string => joinPath(platform, stateDir, `${name}.ready.json`);

/**
 * This function gives the window of the next start of a program. It gets the ready spec and the text of the file of the
 * ready times, or null when the file does not exist. A spec without a measure gives `within`. An app can use it to tell how
 * long the next start can take.
 */
export const nextReadyWindow = (ready: ReadySpec, text: string | null): ReadyWindow => {
  if (ready.measured === undefined) return { ms: ms(ready.within), measured: 0, missed: 0, problem: null };
  const read = parseReadyTimes(text);
  return { ...measuredWindowMs(read.times, windowRule(ready, ready.measured)), problem: read.problem };
};

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
      const grow = program.ready.grow;
      if (grow !== undefined) {
        if (!(Number.isFinite(grow.factor) && grow.factor > 1)) problems.push(`${of}: the factor of the ready growth is not a finite number above 1`);
        if (!isTimeAtLeast(grow.cap, 0, true)) problems.push(`${of}: the cap of the ready growth is not a time above zero`);
        else if (isTime(program.ready.within) && ms(grow.cap) < ms(program.ready.within)) problems.push(`${of}: the cap of the ready growth is shorter than the within of the probe`);
      }
      problems.push(...measureProblems(program.ready).map((problem) => `${of}: ${problem}`));
    }
    if (program.alive !== undefined) {
      problems.push(...probeProblems(program.alive.probe).map((problem) => `${of}: the liveness probe: ${problem}`));
      for (const field of ["interval", "timeout"] as const)
        if (!isTimeAtLeast(program.alive[field], 0, true)) problems.push(`${of}: the ${field} of the liveness probe is not a time above zero`);
      if (!(Number.isInteger(program.alive.failures) && program.alive.failures >= 1))
        problems.push(`${of}: the failures of the liveness probe is not a whole number of 1 or more`);
      const stall = program.alive.stall;
      if (stall !== undefined) {
        if (!(typeof stall.share === "number" && stall.share > 0 && stall.share <= 1))
          problems.push(`${of}: the share of the stall excuse is not a number above 0 and not above 1`);
        if (!(Number.isInteger(stall.most) && stall.most >= 1)) problems.push(`${of}: the most of the stall excuse is not a whole number of 1 or more`);
      }
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
  /** This file keeps the measured ready times of the program. */
  readonly readyPath: string;
  readonly log: RotatingLog | null;
  readonly retry: Retrier | null;
  phase: ProgramPhase;
  child: ChildHandle | null;
  lock: InstanceLock | null;
  timers: Cancel[];
  /** This cancel stops the next use of the liveness probe. It is one timer, thus a long life adds no timers. */
  watch: Cancel | null;
  restarts: number;
  /** This count tells the starts in sequence that were not ready in their window. A ready start sets it to 0. */
  missed: number;
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
      readyPath: readyTimesPath(ports.platform, spec.stateDir, program.name),
      log: logSpec === null ? null : rotatingLog(logSpec, ports.files),
      retry:
        restart === null
          ? null
          : retrier({ ...restart.backoff, clock: ports.clock, signal: abort.signal, ...(options.random === undefined ? {} : { random: options.random }) }),
      phase: "waiting",
      child: null,
      lock: null,
      timers: [],
      watch: null,
      restarts: 0,
      missed: 0,
      detail: null,
      reason: null,
      waiters: [],
    });
  }
  const unitOf = (name: string): Unit => units.get(name)!;

  const clearTimers = (unit: Unit): void => {
    for (const cancel of unit.timers.splice(0)) cancel();
    unit.watch?.();
    unit.watch = null;
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
    unit.missed = 0;
    say("info", `${unit.spec.name} is ready`, { program: unit.spec.name, pid: child.pid });
    const restart = unit.spec.restart === undefined ? DEFAULT_RESTART : unit.spec.restart;
    if (unit.retry !== null && restart !== null) {
      const reset = ports.clock.after(ms(restart.resetAfter), () => {
        if (unit.child === child && unit.phase === "ready") unit.retry?.reset();
      });
      // the child keeps the supervisor alive, thus this timer does not (SYS-126)
      reset.unref?.();
      unit.timers.push(reset);
    }
    if (unit.spec.alive !== undefined) watch(unit, child, unit.spec.alive);
    considerAll();
  };

  /** This function uses the liveness probe of a ready program each interval, and stops the program after `failures` failures in sequence. */
  const watch = (unit: Unit, child: ChildHandle, alive: AliveSpec): void => {
    let failures = 0;
    let excused = 0;
    let mark: StallMark | null = null;
    const markNow = async (): Promise<StallMark | null> => (alive.stall === undefined ? null : readStallMark(ports));
    const current = (): boolean => unit.child === child && unit.phase === "ready" && !stopping;
    const next = (): void => {
      unit.watch = ports.clock.after(ms(alive.interval), () => {
        unit.watch = null;
        void check();
      });
      // the child keeps the supervisor alive, thus the watch does not (SYS-126)
      unit.watch.unref?.();
    };
    const check = async (): Promise<void> => {
      if (!current()) return;
      const result = await probeOnce(alive.probe, ms(alive.timeout), ports);
      const before = mark;
      mark = await markNow();
      if (!current()) return;
      if (result.ok) {
        if (failures > 0 || excused > 0) say("info", `${unit.spec.name} is alive again`, { program: unit.spec.name, pid: child.pid, failures, excused });
        failures = 0;
        excused = 0;
        unit.detail = null;
        next();
        return;
      }
      const share = alive.stall === undefined || before === null || mark === null ? null : stalledShare(before, mark);
      if (alive.stall !== undefined && share !== null && share >= alive.stall.share && excused < alive.stall.most) {
        excused += 1;
        const percent = Math.round(share * 100);
        unit.detail = `the liveness probe failed in a full stall of the host for ${percent}% of its span, thus the failure does not count (${excused} of ${alive.stall.most} excused, ${result.why})`;
        say("warn", `${unit.spec.name}: ${unit.detail}`, { program: unit.spec.name, pid: child.pid, why: result.why, stalledShare: share });
        next();
        return;
      }
      failures += 1;
      // A counted failure also logs its measured share of the stall, thus a fit can set the share of the excuse.
      const measured = share === null ? {} : { stalledShare: share };
      unit.detail = `the liveness probe failed ${failures} of ${alive.failures} times in sequence (${result.why})`;
      if (failures < alive.failures) {
        say("warn", `${unit.spec.name}: ${unit.detail}`, { program: unit.spec.name, pid: child.pid, why: result.why, ...measured });
        next();
        return;
      }
      unit.reason = `its liveness probe failed ${failures} times in sequence (${result.why})`;
      unit.detail = unit.reason;
      say("warn", `${unit.spec.name} is not alive, thus it stops`, { program: unit.spec.name, pid: child.pid, why: result.why, ...measured });
      void stagedStop(unit, child);
    };
    if (alive.stall === undefined) next();
    else
      void markNow().then((first) => {
        mark = first;
        if (current()) next();
      });
  };

  /**
   * This function reads the measured ready times of a program. A file that does not exist gives no times. A file that the
   * supervisor cannot read or use gives no times and one warning.
   */
  const readyTimes = async (unit: Unit): Promise<readonly ReadyTime[]> => {
    const name = unit.spec.name;
    let text: string | null = null;
    try {
      text = await ports.files.read(unit.readyPath);
    } catch (error) {
      say("warn", `the read of the ready times of ${name} failed, thus the window uses no times`, { program: name, file: unit.readyPath, error });
      return [];
    }
    const read = parseReadyTimes(text);
    if (read.problem !== null) say("warn", `the ready times of ${name} are not used: ${read.problem}`, { program: name, file: unit.readyPath });
    return read.times;
  };

  /** This function adds one ready time to the file of a program. A failed write gives a warning, and the program continues. */
  const recordTime = async (unit: Unit, times: readonly ReadyTime[], time: ReadyTime, keep: number): Promise<void> => {
    try {
      await ports.files.write(unit.readyPath, readyTimesText(addReadyTime(times, time, keep)));
    } catch (error) {
      say("warn", `the ready time of ${unit.spec.name} was not written`, { program: unit.spec.name, file: unit.readyPath, error });
    }
  };

  const probe = async (unit: Unit, child: ChildHandle, ready: ReadySpec, spawnedAt: number): Promise<void> => {
    const measure = ready.measured;
    const rule = measure === undefined ? null : windowRule(ready, measure);
    const times = rule === null ? [] : await readyTimes(unit);
    if (unit.child !== child || stopping) return;
    let windowMs = readyWindowMs(ready, unit.missed);
    if (rule !== null) {
      const window = measuredWindowMs(times, rule);
      windowMs = window.ms;
      say("info", `${unit.spec.name} has a ready window of ${windowMs} ms, from ${window.measured} ready times and ${window.missed} missed starts`, {
        program: unit.spec.name,
        pid: child.pid,
        window: { value: windowMs, unit: "ms" },
        measured: window.measured,
        missed: window.missed,
      });
    }
    const deadline = ports.clock.now() + windowMs;
    const attempt = async (): Promise<void> => {
      if (unit.child !== child || stopping) return;
      const result = await probeOnce(ready.probe, ms(ready.timeout), ports);
      if (unit.child !== child || stopping) return;
      if (result.ok) {
        if (rule !== null) void recordTime(unit, times, { at: new Date(ports.wall()).toISOString(), ms: ports.clock.now() - spawnedAt }, rule.keep);
        markReady(unit, child);
        return;
      }
      unit.detail = result.why;
      if (ports.clock.now() >= deadline) {
        unit.missed += 1;
        let next = readyWindowMs(ready, unit.missed);
        if (rule !== null) {
          // the start needed more time than its window, thus its time is its window or more
          const missed: ReadyTime = { at: new Date(ports.wall()).toISOString(), ms: Math.max(windowMs, ports.clock.now() - spawnedAt), missed: true };
          next = measuredWindowMs(addReadyTime(times, missed, rule.keep), rule).ms;
          void recordTime(unit, times, missed, rule.keep);
        }
        unit.reason = `it was not ready in ${windowMs} ms (${result.why})`;
        unit.detail = unit.reason;
        say("warn", `${unit.spec.name} is not ready in its time, thus it stops`, {
          program: unit.spec.name,
          pid: child.pid,
          why: result.why,
          window: { value: windowMs, unit: "ms" },
          next: { value: next, unit: "ms" },
        });
        void stagedStop(unit, child);
        return;
      }
      const again = ports.clock.after(ms(ready.interval), () => void attempt());
      // the child keeps the supervisor alive, thus the poll of its readiness does not (SYS-126)
      again.unref?.();
      unit.timers.push(again);
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
    const spawnedAt = ports.clock.now();
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
    else await probe(unit, child, unit.spec.ready, spawnedAt);
  };

  /** This function waits for the end of a child, for at most `wait` milliseconds. It tells if the child ended. */
  const ended = (unit: Unit, child: ChildHandle, wait: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (unit.child !== child) {
        resolve(true);
        return;
      }
      // the stop awaits this wait, thus it keeps the process alive (SYS-126)
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
