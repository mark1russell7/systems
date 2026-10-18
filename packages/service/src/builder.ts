import type { Extent, Quantity } from "@mark1russell7/quantity";
import { convertible, valueIn } from "@mark1russell7/quantity";
import type {
  Check,
  Controller,
  CooperativeFloor,
  Coupling,
  Dependency,
  ExitCodes,
  Gate,
  Phase,
  RepeatSignal,
  ServiceDescription,
  Transport,
} from "./description.ts";
import { FORMAT } from "./description.ts";
import { realClock } from "./clock.ts";
import type { Health, Runtime, StartOptions } from "./health.ts";
import { healthRuntime } from "./health.ts";
import type {
  Components,
  DependencyHandle,
  HealthServer,
  Lifecycle,
  PhaseWork,
  RunOptions,
  TransportImpl,
} from "./lifecycle.ts";
import { STAGES, lifecycle, lifecycleProblems, stageRank } from "./lifecycle.ts";
import type { Operation } from "./operation.ts";
import { operationProblems } from "./operation.ts";
import type { CheckFn } from "./poller.ts";
import type { ExitTrigger, ProcessTrigger } from "./process.ts";
import { EXIT_SIGNALS, PROCESS_TRIGGERS, isExitCode } from "./process.ts";
import type { Profile } from "./profiles.ts";
import type { Timing } from "./timing.ts";
import type { Watchdog, WatchdogSpec } from "./watchdog.ts";
import { watchdog } from "./watchdog.ts";

/**
 * A service is composed with plain method uses before it starts. The builder is imperative, and
 * it holds static knowledge. The service does not use an `init` function that gives registrations.
 *
 *     const svc = service("app");
 *     svc.dependency("weather", {
 *       system: null,
 *       knobs: { request_timeout },
 *       operations: { "GET /v1/forecast": { idempotent: true } },
 *     });
 *     svc.controller("forecast").requires("weather").route("GET /api/forecast", { idempotent: true });
 *     svc.check({ name: "weather.round-trip", dependency: "weather", … }, roundTrip);
 *     svc.describe(); // the whole graph as data, with nothing started
 *     const health = await svc.start();
 *
 * The graph has one source, thus its parts cannot disagree. A dependency or a check can join
 * after the start. It starts tripped, and the export is partial. The runtime has no defaults of
 * its own. Thus `describe()` refuses a service that does not declare a policy, its startup budget
 * or its shutdown, and it tells which.
 *
 * `start()` starts only the health runtime. `run()` starts the whole lifecycle: the startup in its
 * sequence, the exit signals, the capped phases of the shutdown, and the exit of the process.
 */
export interface ControllerBuilder {
  /** This method declares the dependencies that its routes need. The controller is ready only while they are ready. */
  requires(...dependencies: string[]): ControllerBuilder;
  /** This method declares a route that the controller serves, and if its callers can send it again. */
  route(route: string, operation: Operation): ControllerBuilder;
}

/** A service builder composes a service, gives it as data, and starts it. */
export interface ServiceBuilder {
  readonly name: string;
  /** This method declares a dependency, and the handle that connects to it and closes it, if it has one. */
  dependency(name: string, spec: Omit<Dependency, "name">, handle?: DependencyHandle): ServiceBuilder;
  /** This method declares a server, and its implementation. `run()` needs the implementation. */
  server(name: string, knobs: Readonly<Record<string, Extent>>, impl?: TransportImpl): ServiceBuilder;
  consumer(name: string, knobs: Readonly<Record<string, Extent>>, impl?: TransportImpl): ServiceBuilder;
  worker(name: string, knobs: Readonly<Record<string, Extent>>, impl?: TransportImpl): ServiceBuilder;
  /** This method gives the server of the probes. It starts first and closes last. */
  healthServer(server: HealthServer): ServiceBuilder;
  /** This method adds work to a declared phase of the shutdown: the owner of the work registers it. */
  onPhase(phase: string, work: PhaseWork): ServiceBuilder;
  /** This method declares a watchdog of the event loop, as a check on the state of the process. */
  watchdog(spec: WatchdogSpec): ServiceBuilder;
  controller(name: string): ControllerBuilder;
  /** This method declares a check, and the function that measures its step. `start()` needs the function. */
  check(check: Check, run?: CheckFn): ServiceBuilder;
  readiness(timing: Timing): ServiceBuilder;
  liveness(timing: Timing): ServiceBuilder;
  startup(budget: Quantity): ServiceBuilder;
  couple(coupling: Coupling): ServiceBuilder;
  phase(name: string, cap: Quantity): ServiceBuilder;
  cooperativeWindow(window: Extent): ServiceBuilder;
  /** This method declares the earliest time of the cooperative abort: half the cap of the drain, or no floor. */
  cooperativeFloor(floor: CooperativeFloor): ServiceBuilder;
  /** This method declares what an exit signal does while the shutdown runs: nothing, or an exit at once. */
  onRepeatSignal(policy: RepeatSignal): ServiceBuilder;
  /** This method declares process triggers that start the shutdown, in addition to the exit signals. */
  trigger(...triggers: ProcessTrigger[]): ServiceBuilder;
  /** This method declares the exit code of a clean shutdown that a trigger starts, in place of 0. */
  exitCode(trigger: ExitTrigger, code: number): ServiceBuilder;
  /** This method declares each field of a profile, as the method of that field does. */
  profile(profile: Profile): ServiceBuilder;
  /** This method gives the service as data, and it starts nothing. */
  describe(): ServiceDescription;
  /**
   * This method closes the composition, starts the health runtime, and gives it after one warm-up
   * sweep of each check. A part that joins after it starts tripped, and it makes the export
   * partial. A second use gives the same runtime.
   */
  start(options?: StartOptions): Promise<Health>;
  /**
   * This method starts the whole lifecycle and gives it when its startup ends: the service operates,
   * or its startup failed and it shuts down. It refuses a declaration that it cannot start: a transport
   * without its implementation, or a stage with work and no declared phase.
   */
  run(options?: RunOptions): Promise<Lifecycle>;
  /**
   * This value is the health runtime from the time that `start()` begins, or null before. Thus the
   * probes can answer during the warm-up sweep: the startup probe fails until the sweep ends.
   */
  readonly health: Health | null;
  /**
   * This value is the lifecycle from the time that `run()` begins, or null before. Its request
   * tracking operates while the transports start, before `run()` gives it.
   */
  readonly lifecycle: Lifecycle | null;
}

const isTime = (amount: Extent): boolean => convertible(amount.unit, "s");
const above = (amount: Extent): boolean =>
  amount.value === "infinite" || (isTime(amount) && valueIn(amount as Quantity, "s") > 0);
const whole = (count: number): boolean => Number.isInteger(count) && count >= 1;

/** This function gives the problems of a timing: a zero interval or count fails decoding. */
const timingProblems = (policy: Gate, timing: Timing): string[] => {
  if (timing.type === "debounce") {
    const problems: string[] = [];
    if (!above(timing.interval)) problems.push(`the ${policy} debounce polls at an interval that is not above zero`);
    if (!whole(timing.failAfter)) problems.push(`the ${policy} debounce fails after ${timing.failAfter} polls, not a whole number above zero`);
    if (!whole(timing.recoverAfter)) problems.push(`the ${policy} debounce recovers after ${timing.recoverAfter} polls, not a whole number above zero`);
    return problems;
  }
  const negative = (amount: Quantity | undefined): boolean =>
    amount !== undefined && (!isTime(amount) || valueIn(amount, "s") < 0);
  return negative(timing.failAfter) || negative(timing.recoverAfter)
    ? [`the ${policy} window is not a time of zero or more`]
    : [];
};

/** This function gives the problems of the rules of the shutdown: an unknown name, or an exit code that a process cannot give. */
const shutdownProblems = (
  floor: CooperativeFloor | undefined,
  repeat: RepeatSignal | undefined,
  triggers: readonly ProcessTrigger[],
  exitCodes: ExitCodes,
): string[] => {
  const problems: string[] = [];
  if (floor !== undefined && floor !== "half" && floor !== "none")
    problems.push(`the cooperative floor ${String(floor)} is not "half" or "none"`);
  if (repeat !== undefined && repeat !== "ignore" && repeat !== "exit")
    problems.push(`the policy of a repeat signal ${String(repeat)} is not "ignore" or "exit"`);
  for (const trigger of triggers)
    if (!PROCESS_TRIGGERS.includes(trigger))
      problems.push(`the trigger ${String(trigger)} is not a process trigger (${PROCESS_TRIGGERS.join(", ")})`);
  for (const [trigger, code] of Object.entries(exitCodes)) {
    const known = (EXIT_SIGNALS as readonly string[]).includes(trigger) || triggers.includes(trigger as ProcessTrigger);
    if (!known) problems.push(`the exit code of ${trigger} names no exit signal and no declared trigger`);
    if (code === undefined || !isExitCode(code))
      problems.push(`the exit code of ${trigger} is ${String(code)}, not a whole number from 0 to 255`);
  }
  return problems;
};

/** This function starts the composition of a service. */
export const service = (name: string): ServiceBuilder => {
  if (name.trim().length === 0) throw new Error("a service needs a name");
  const transports: Transport[] = [];
  const dependencies: Dependency[] = [];
  const controllers: Array<{
    name: string;
    requires: string[];
    routes: Record<string, Operation>;
  }> = [];
  const checks: Check[] = [];
  const runs = new Map<string, CheckFn>();
  const couplings: Coupling[] = [];
  const phases: Phase[] = [];
  let readiness: Timing | undefined;
  let liveness: Timing | undefined;
  let startup: Quantity | undefined;
  let cooperative: Extent | undefined;
  let floor: CooperativeFloor | undefined;
  let repeat: RepeatSignal | undefined;
  const triggers: ProcessTrigger[] = [];
  const exitCodes: Partial<Record<ExitTrigger, number>> = {};
  let started = false;
  let partial = false;
  let runtime: Promise<Health> | undefined;
  let live: Runtime | undefined;
  let running: Promise<Lifecycle> | undefined;
  let life: Lifecycle | undefined;
  const transportImpls = new Map<string, TransportImpl>();
  const handles = new Map<string, DependencyHandle>();
  const phaseWork = new Map<string, PhaseWork[]>();
  const watchdogs: WatchdogSpec[] = [];
  let probes: HealthServer | null = null;

  /** This function stops a change to the shape of the service after the start. */
  const composing = (what: string): void => {
    if (started) throw new Error(`${name} has started: ${what} is declared before svc.start()`);
  };
  const once = (list: ReadonlyArray<{ name: string }>, entry: string, what: string): void => {
    if (list.some((held) => held.name === entry))
      throw new Error(`${name} already has a ${what} named ${entry}`);
  };
  const transport =
    (kind: Transport["kind"]) =>
    (entry: string, knobs: Readonly<Record<string, Extent>>, impl?: TransportImpl) => {
      composing(`a ${kind}`);
      once(transports, entry, "transport");
      transports.push({ name: entry, kind, knobs: { ...knobs } });
      if (impl !== undefined) transportImpls.set(entry, impl);
      return builder;
    };

  /** This function makes the runtime of the declaration: its checks, and a watchdog for each spec. */
  const makeRuntime = (
    options: StartOptions,
  ): { runtime: Runtime; description: ServiceDescription; stopPollers: () => void } => {
    const description = builder.describe();
    const clock = options.clock ?? realClock;
    const dogs: Watchdog[] = [];
    const all = new Map(runs);
    for (const spec of watchdogs) {
      const dog = watchdog(clock, spec, (from, to, on) =>
        options.record?.({ at: clock.now(), machine: "watchdog", instance: spec.name, from, to, on }),
      );
      dogs.push(dog);
      all.set(spec.name, () => dog.check());
    }
    const stopPollers = (): void => {
      for (const dog of dogs) dog.stop();
    };
    let made: Runtime;
    try {
      made = healthRuntime(description, all, options);
    } catch (error) {
      stopPollers();
      throw error;
    }
    // the stop of the health runtime also stops the watchdogs
    const runtime: Runtime = {
      ...made,
      stop: () => {
        made.stop();
        stopPollers();
      },
    };
    return { runtime, description, stopPollers };
  };

  const builder: ServiceBuilder = {
    name,
    get health() {
      return live ?? null;
    },
    get lifecycle() {
      return life ?? null;
    },
    dependency(entry, spec, handle) {
      once(dependencies, entry, "dependency");
      // a dependency that joins after the start has no connection that the lifecycle opens
      if (handle !== undefined && !started) handles.set(entry, handle);
      dependencies.push({
        name: entry,
        ...spec,
        knobs: { ...spec.knobs },
        operations: { ...spec.operations },
      });
      if (started) {
        partial = true;
        live?.addDependency(entry);
      }
      return builder;
    },
    server: transport("server"),
    consumer: transport("consumer"),
    worker: transport("worker"),
    controller(entry) {
      composing("a controller");
      once(controllers, entry, "controller");
      const held = {
        name: entry,
        requires: [] as string[],
        routes: {} as Record<string, Operation>,
      };
      controllers.push(held);
      const handle: ControllerBuilder = {
        requires(...needed) {
          composing(`what ${entry} requires`);
          held.requires.push(...needed);
          return handle;
        },
        route(served, operation) {
          composing(`${entry}'s routes`);
          if (held.routes[served] !== undefined)
            throw new Error(`${entry} already serves ${served}`);
          held.routes[served] = { ...operation };
          return handle;
        },
      };
      return handle;
    },
    check(check, run) {
      once(checks, check.name, "check");
      if (started && run === undefined)
        throw new Error(`check ${check.name} joins after the start, thus it needs its function`);
      checks.push({ ...check });
      if (run !== undefined) runs.set(check.name, run);
      if (started) {
        partial = true;
        live?.addCheck({ ...check, poll: { ...check.poll } }, run!);
      }
      return builder;
    },
    healthServer(server) {
      composing("the health server");
      if (probes !== null) throw new Error(`${name} already has a health server`);
      probes = server;
      return builder;
    },
    onPhase(phase, work) {
      composing(`work for the phase ${phase}`);
      phaseWork.set(phase, [...(phaseWork.get(phase) ?? []), work]);
      return builder;
    },
    watchdog(spec) {
      composing(`the watchdog ${spec.name}`);
      once(checks, spec.name, "check");
      // the watchdog is a check on the state of the process itself, on its own connection
      checks.push({
        name: spec.name,
        dependency: null,
        step: "local-state",
        ownConnection: true,
        gates: spec.gates,
        poll: { ...spec.poll },
      });
      watchdogs.push(spec);
      return builder;
    },
    readiness(timing) {
      composing("readiness");
      readiness = timing;
      return builder;
    },
    liveness(timing) {
      composing("liveness");
      liveness = timing;
      return builder;
    },
    startup(budget) {
      composing("the startup budget");
      startup = budget;
      return builder;
    },
    couple(coupling) {
      composing("a coupling");
      couplings.push({ ...coupling });
      return builder;
    },
    phase(entry, cap) {
      composing("a shutdown phase");
      once(phases, entry, "shutdown phase");
      phases.push({ name: entry, cap });
      return builder;
    },
    cooperativeWindow(window) {
      composing("the cooperative window");
      cooperative = window;
      return builder;
    },
    cooperativeFloor(given) {
      composing("the cooperative floor");
      floor = given;
      return builder;
    },
    onRepeatSignal(policy) {
      composing("the policy of a repeat signal");
      repeat = policy;
      return builder;
    },
    trigger(...given) {
      composing("a trigger");
      for (const each of given) if (!triggers.includes(each)) triggers.push(each);
      return builder;
    },
    exitCode(trigger, code) {
      composing(`the exit code of ${trigger}`);
      exitCodes[trigger] = code;
      return builder;
    },
    profile(given) {
      composing("a profile");
      if (given.readiness !== undefined) builder.readiness(given.readiness);
      if (given.liveness !== undefined) builder.liveness(given.liveness);
      if (given.startup !== undefined) builder.startup(given.startup);
      for (const coupling of given.couplings ?? []) builder.couple(coupling);
      for (const each of given.phases ?? []) builder.phase(each.name, each.cap);
      if (given.cooperativeWindow !== undefined) builder.cooperativeWindow(given.cooperativeWindow);
      if (given.cooperativeFloor !== undefined) builder.cooperativeFloor(given.cooperativeFloor);
      if (given.onRepeatSignal !== undefined) builder.onRepeatSignal(given.onRepeatSignal);
      if (given.triggers !== undefined) builder.trigger(...given.triggers);
      for (const [trigger, code] of Object.entries(given.exitCodes ?? {}))
        if (code !== undefined) builder.exitCode(trigger as ExitTrigger, code);
      return builder;
    },
    describe() {
      const missing: string[] = [];
      if (readiness === undefined) missing.push("readiness (svc.readiness)");
      if (liveness === undefined) missing.push("liveness (svc.liveness)");
      if (startup === undefined) missing.push("a startup budget (svc.startup)");
      if (phases.length === 0) missing.push("its shutdown phases (svc.phase)");
      if (cooperative === undefined)
        missing.push("a cooperative window, or no bound (svc.cooperativeWindow)");
      if (missing.length > 0)
        throw new Error(
          `${name} does not declare ${missing.join("; ")}: the runtime has no defaults`,
        );
      const known = new Set(dependencies.map((entry) => entry.name));
      const problems: string[] = [];
      const policies: Record<Gate, Timing> = { readiness: readiness!, liveness: liveness! };
      for (const gate of ["readiness", "liveness"] as const)
        problems.push(...timingProblems(gate, policies[gate]));
      for (const check of checks) {
        if (check.dependency !== null && !known.has(check.dependency)) {
          problems.push(
            `check ${check.name} exercises ${check.dependency}, which is not a dependency`,
          );
        }
        if (!isTime(check.poll.interval) || !isTime(check.poll.timeout)) {
          problems.push(`check ${check.name} polls in a unit that is not a time`);
        } else if (!above(check.poll.interval) || !above(check.poll.timeout)) {
          problems.push(`check ${check.name} polls with an interval or a timeout that is not above zero`);
        }
        if (!(check.poll.jitter >= 0 && check.poll.jitter < 1))
          problems.push(`check ${check.name} has a jitter of ${check.poll.jitter}, not a fraction below 1`);
        // a debounce counts the polls of each check that it gates, thus they poll at its interval
        const timing = check.gates === null ? null : policies[check.gates];
        if (
          timing?.type === "debounce" &&
          isTime(check.poll.interval) &&
          above(timing.interval) &&
          valueIn(check.poll.interval, "s") !== valueIn(timing.interval, "s")
        )
          problems.push(
            `check ${check.name} polls every ${valueIn(check.poll.interval, "s")} s, but the ${check.gates} debounce counts polls every ${valueIn(timing.interval, "s")} s`,
          );
      }
      for (const controller of controllers) {
        for (const needed of controller.requires) {
          if (!known.has(needed))
            problems.push(
              `controller ${controller.name} requires ${needed}, which is not a dependency`,
            );
        }
        for (const [route, operation] of Object.entries(controller.routes))
          problems.push(...operationProblems(`controller ${controller.name}`, route, operation));
      }
      for (const dependency of dependencies)
        for (const [name, operation] of Object.entries(dependency.operations))
          problems.push(...operationProblems(`dependency ${dependency.name}`, name, operation));
      for (const phase of phases)
        if (!isTime(phase.cap)) problems.push(`phase ${phase.name}'s cap is not a time`);
      problems.push(...shutdownProblems(floor, repeat, triggers, exitCodes));
      // the stages of the shutdown keep their sequence: readiness fails first, the health server closes last
      const ranked = phases.map((phase) => phase.name).filter((each) => stageRank(each) >= 0);
      for (let at = 1; at < ranked.length; at += 1)
        if (stageRank(ranked[at]!) < stageRank(ranked[at - 1]!))
          problems.push(
            `the phase "${ranked[at]!}" comes after "${ranked[at - 1]!}", but the stages go ${STAGES.join(", ")}`,
          );
      if (problems.length > 0) throw new Error(`${name}: ${problems.join("; ")}`);
      const controllersOut: Controller[] = controllers.map((entry) => ({
        name: entry.name,
        requires: [...entry.requires],
        routes: { ...entry.routes },
      }));
      return {
        format: FORMAT,
        name,
        partial,
        transports: transports.map((entry) => ({ ...entry, knobs: { ...entry.knobs } })),
        dependencies: dependencies.map((entry) => ({
          ...entry,
          knobs: { ...entry.knobs },
          operations: { ...entry.operations },
        })),
        controllers: controllersOut,
        checks: checks.map((entry) => ({ ...entry, poll: { ...entry.poll } })),
        policies: { readiness: readiness!, liveness: liveness!, startup: startup! },
        couplings: couplings.map((entry) => ({ ...entry })),
        shutdown: {
          phases: phases.map((entry) => ({ ...entry })),
          cooperativeWindow: cooperative!,
          ...(floor === undefined ? {} : { cooperativeFloor: floor }),
          ...(repeat === undefined ? {} : { onRepeatSignal: repeat }),
          ...(triggers.length === 0 ? {} : { triggers: [...triggers] }),
          ...(Object.keys(exitCodes).length === 0 ? {} : { exitCodes: { ...exitCodes } }),
        },
      };
    },
    start(options = {}) {
      // the start needs the whole graph: describe() is the check, and the runtime reads it
      if (runtime !== undefined) return runtime;
      if (running !== undefined) return Promise.reject(new Error(`${name} runs its lifecycle: use its health`));
      let made: Runtime;
      try {
        made = makeRuntime(options).runtime;
      } catch (error) {
        return Promise.reject(error);
      }
      started = true;
      live = made;
      runtime = made.warmUp().then(() => made);
      return runtime;
    },
    run(options = {}) {
      if (running !== undefined) return running;
      if (runtime !== undefined) return Promise.reject(new Error(`${name} started its health only: run() starts the whole lifecycle`));
      try {
        const description = builder.describe();
        const components: Components = {
          transports: transportImpls,
          dependencies: handles,
          healthServer: probes,
          phaseWork,
          stopPollers: () => {},
        };
        const problems = lifecycleProblems(description, components);
        if (problems.length > 0) throw new Error(`${name}: ${problems.join("; ")}`);
        const made = makeRuntime(options);
        started = true;
        live = made.runtime;
        // the builder holds the lifecycle before the first transport starts
        const ran = lifecycle(made.description, made.runtime, { ...components, stopPollers: made.stopPollers }, options, (given) => {
          life = given;
        });
        running = ran.started.then(() => ran);
      } catch (error) {
        return Promise.reject(error);
      }
      return running;
    },
  };
  return builder;
};
