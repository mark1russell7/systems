import type { Extent } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Cancel, Clock } from "./clock.ts";
import { realClock } from "./clock.ts";
import type { CooperativeFloor, Phase, ServiceDescription } from "./description.ts";
import type { MachineName } from "./events.ts";
import type { Health, Runtime, StartOptions } from "./health.ts";
import type { ExitTrigger, ProcessPort } from "./process.ts";
import { EXIT_SIGNALS, isExitCode, isExitSignal, matchesMessage, nodeProcess } from "./process.ts";
import type { RequestFn, RequestOptions, RequestStream } from "./requests.ts";
import { tracker } from "./requests.ts";
import type { OperationOf } from "./routes.ts";

/**
 * A transport is a source of work: a server, a consumer or a worker. Each has one contract. It
 * starts, stops its intake, and drains to a deadline without a throw. It counts its work in flight,
 * and it closes. A second close has no effect.
 */
export interface TransportImpl {
  /**
   * This method starts the transport. The lifecycle is the object that `run()` gives at the end of
   * the startup. Its request tracking operates from the start: a request before the startup ends
   * gets a retryable refusal, and `keepAlive()` is false. Do not wait for `life.started` here,
   * because the startup waits for this method.
   */
  start(signal: AbortSignal, life: Lifecycle): Promise<void> | void;
  stopIntake(): Promise<void> | void;
  /**
   * This method lets the work in flight end until `deadline` (milliseconds on the monotonic
   * clock). The signal is the cooperative abort, which comes before the deadline.
   */
  drain(deadline: number, signal: AbortSignal): Promise<void> | void;
  inFlight(): number;
  close(): Promise<void> | void;
}

/** A dependency handle connects to a dependency at the start, and closes the connection at the end. */
export interface DependencyHandle {
  connect(signal: AbortSignal): Promise<void> | void;
  close(): Promise<void> | void;
}

/**
 * A health server answers the probes, on its own port. It starts first, thus the probes answer
 * while the dependencies connect, and it closes last.
 */
export interface HealthServer {
  listen(health: Health): Promise<void> | void;
  close(): Promise<void> | void;
}

/** A phase context is what a phase gives its work: its deadline, its signal and the clock. */
export interface PhaseContext {
  /** This time is the end of the cap of the phase, in milliseconds on the monotonic clock. */
  readonly deadline: number;
  /** This signal aborts at the end of the cap of the phase. */
  readonly signal: AbortSignal;
  readonly clock: Clock;
}

/** A phase work is a step of the shutdown that an owner adds to a phase. */
export type PhaseWork = (context: PhaseContext) => Promise<void> | void;

/**
 * These are the stages of the shutdown, in their sequence. A declared phase with one of these
 * names gets the work of the runtime for its stage. A phase with another name gets only the work of
 * its owners.
 * - `fail readiness`: readiness fails at the start of the shutdown. This phase then holds for its
 *   cap, while the endpoints of the platform remove the service.
 * - `stop intake`: each transport stops its intake, and new requests get a retryable 503.
 * - `drain`: the transports and the requests in flight end, until the cap. The cooperative abort
 *   comes before the end of the cap, by the cooperative window.
 * - `close transports`: each transport closes.
 * - `stop the poller`: each check and watchdog stops. Then the signal of the service aborts.
 * - `tear down dependencies`: each dependency closes, in the reverse sequence of its connection.
 * - `close the health server`: the probes stop.
 * - `flush the output`: the work of the owners of this phase ends, and then the process port
 *   writes the buffered output. Without this phase, the process exits without a wait.
 */
export const STAGES = [
  "fail readiness",
  "stop intake",
  "drain",
  "close transports",
  "stop the poller",
  "tear down dependencies",
  "close the health server",
  "flush the output",
] as const;

export type Stage = (typeof STAGES)[number];

/** This function gives the place of a stage in the sequence, or -1 for a phase of another name. */
export const stageRank = (name: string): number => (STAGES as readonly string[]).indexOf(name);

/** The signal of the service aborts after the poller stops, and before the dependencies close. */
const ABORT_AFTER = stageRank("stop the poller");

/**
 * This function gives the time of the cooperative abort, in milliseconds after the drain starts. It
 * is the cap less the cooperative window. With the floor `half`, it is not less than half the cap,
 * and a window without a bound gives half the cap. With the floor `none`, it is not less than 0.
 */
export const cooperativeAbortAt = (cap: number, window: Extent, floor: CooperativeFloor = "half"): number => {
  const before = window.value === "infinite" ? Number.POSITIVE_INFINITY : valueIn(window, "ms");
  return Math.max(cap - before, floor === "none" ? 0 : cap / 2);
};

/** These options run the lifecycle. Without them, it uses the real clock and the process of Node. */
export interface RunOptions extends StartOptions {
  readonly process?: ProcessPort | undefined;
}

/** These options go with a request for the shutdown. */
export interface ShutdownOptions {
  /**
   * This code is the exit code that the work of the process gives, a whole number from 0 to 255. The
   * first exit request with a code sets it. A code of 0 lets an error make the exit code 1.
   */
  readonly code?: number | undefined;
}

/** A lifecycle state tells where the service is in its life. */
export type LifecycleState = "starting" | "running" | "draining" | "exited";

/** The lifecycle of a running service. */
export interface Lifecycle {
  readonly health: Health;
  readonly state: LifecycleState;
  /** This code is the exit code, or null before the exit. */
  readonly exitCode: number | null;
  /** These texts are the errors of the lifecycle. An error makes the exit code 1, unless an exit request gives another code. */
  readonly errors: readonly string[];
  /** This promise ends when the startup ends: the service runs, or its startup failed. */
  readonly started: Promise<void>;
  /** This promise gives the exit code when the shutdown ends. */
  readonly done: Promise<number>;
  /** This signal aborts after the poller stops: the background work of the service stops with it. */
  readonly signal: AbortSignal;
  /**
   * This method asks for the shutdown, as an exit signal does. A second request does not start a
   * second shutdown. It can give the exit code, when no request gave one before.
   */
  shutdown(cause?: string, options?: ShutdownOptions): Promise<number>;
  /**
   * This method does one request of a controller, on a route or a route pattern that the controller
   * declares. It gives the stream of the request: each item of the work, then one end. The service
   * refuses the request while it cannot take new work, and the shutdown can cut it. An undeclared
   * route throws, because it has no idempotency.
   */
  request<T>(controller: string, route: string, work: RequestFn<T>, options?: RequestOptions): RequestStream<T>;
  inFlight(controller?: string): number;
  /**
   * This method tells if a response can keep its connection open. It is false while the service is
   * not ready, thus each response then closes its connection.
   */
  keepAlive(): boolean;
}

/** The parts that the builder gives the lifecycle, beside the declaration. */
export interface Components {
  readonly transports: ReadonlyMap<string, TransportImpl>;
  readonly dependencies: ReadonlyMap<string, DependencyHandle>;
  readonly healthServer: HealthServer | null;
  readonly phaseWork: ReadonlyMap<string, readonly PhaseWork[]>;
  /** These are the functions of the route patterns, by controller and by pattern. */
  readonly choices?: ReadonlyMap<string, ReadonlyMap<string, OperationOf>> | undefined;
  /** This function stops the parts that the poller stage stops beside the checks: the watchdogs. */
  readonly stopPollers: () => void;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * This function gives the problems of a declaration that the lifecycle cannot start: a stage with
 * work and no declared phase. The runtime has no defaults, thus a transport without a drain phase
 * has no time to drain.
 */
export const lifecycleProblems = (description: ServiceDescription, components: Components): string[] => {
  const declared = new Set(description.shutdown.phases.map((phase) => phase.name));
  const needs = (stage: Stage, why: string): string[] =>
    declared.has(stage) ? [] : [`${description.name} has ${why}, thus it declares the phase "${stage}"`];
  const problems: string[] = [];
  for (const transport of description.transports)
    if (!components.transports.has(transport.name))
      problems.push(`transport ${transport.name} has no implementation: the runtime has no defaults`);
  if (components.transports.size > 0 || description.controllers.length > 0) {
    problems.push(...needs("stop intake", "transports or controllers"));
    problems.push(...needs("drain", "transports or controllers"));
  }
  if (components.transports.size > 0) problems.push(...needs("close transports", "transports"));
  if (description.checks.length > 0) problems.push(...needs("stop the poller", "checks"));
  if (components.dependencies.size > 0) problems.push(...needs("tear down dependencies", "dependency handles"));
  if (components.healthServer !== null) problems.push(...needs("close the health server", "a health server"));
  return problems;
};

/**
 * This function starts the lifecycle of a service. The startup has a sequence: the health server
 * first, then each dependency, then each transport, and the startup gate last. A trigger during the
 * startup gets its shutdown after the startup ends. The shutdown does the declared phases in their
 * sequence, each one capped. Only the lifecycle ends the process. Its exit code is the code of the
 * exit request, else 1 after an error, else 0.
 */
export const lifecycle = (
  description: ServiceDescription,
  runtime: Runtime,
  components: Components,
  options: RunOptions = {},
  /** This function receives the lifecycle before the startup begins. */
  bind: (life: Lifecycle) => void = () => {},
): Lifecycle => {
  const clock = options.clock ?? realClock;
  const port = options.process ?? nodeProcess;
  const record = (machine: MachineName, from: string, to: string, on: string, detail?: string): void =>
    options.record?.({
      at: clock.now(),
      machine,
      instance: description.name,
      from,
      to,
      on,
      ...(detail === undefined ? {} : { detail }),
    });
  const service = new AbortController();
  const errors: string[] = [];
  const exitCodes = description.shutdown.exitCodes ?? {};
  const repeatPolicy = description.shutdown.onRepeatSignal;
  let state: LifecycleState = "starting";
  let exitCode: number | null = null;
  // the code of the first exit request that gives one
  let requested: number | undefined;
  let intakeStopped = false;
  let shutdownStarted = false;
  let failedStartup = false;
  // the exit manager: running, stopping, exited
  let exitState = "running";
  const moveExit = (to: string, on: string, detail?: string): void => {
    record("exit", exitState, to, on, detail);
    exitState = to;
  };
  const fail = (cause: string): void => {
    errors.push(cause);
    // after an exit, the process has ended: the exit manager does not move again
    if (exitState !== "exited") record("exit", exitState, exitState, "error", cause);
  };

  const requests = tracker(description.controllers, clock, (controller) => {
    if (state === "starting") return "the service has not started";
    if (state === "exited") return "the service has exited";
    // while it drains and before its intake stops, the service still serves: the platform can
    // still route a request to it until its endpoints update
    if (state === "draining") return null;
    return runtime.verdict().controllers[controller] === true ? null : `controller ${controller} is not ready`;
  }, components.choices);

  let finish: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });
  // what started, thus what the shutdown stops
  let healthListening = false;
  const connected: Array<[string, DependencyHandle]> = [];
  const startedTransports: Array<[string, TransportImpl]> = [];
  // the startup exists before any part starts: a transport that asks for the shutdown in its start waits for it
  let startupEnded: () => void = () => {};
  const startup = new Promise<void>((resolve) => {
    startupEnded = resolve;
  });
  let offs: Array<() => void> = [];

  /** This function ends the process with a code, one time, and removes each handler of a trigger. */
  const end = (code: number, on: string): void => {
    state = "exited";
    exitCode = code;
    for (const off of offs) off();
    offs = [];
    moveExit("exited", on, `exit ${code}`);
    finish(code);
    port.exit(code);
  };

  /**
   * This function receives a trigger of the process: the first one starts the shutdown. The cause
   * names the trigger, and a message that stands for a signal tells it.
   */
  const triggered = (trigger: ExitTrigger, cause: string = trigger): void => {
    if (exitState === "exited") return;
    if (shutdownStarted || exitState === "stopping") {
      // a signal while the shutdown runs obeys the declared policy. Another trigger, for example the
      // end of stdin after a SIGTERM, has no effect
      if (isExitSignal(trigger) && repeatPolicy === "exit") {
        fail(`${cause} came again while the shutdown ran, and the declaration exits at once`);
        end(1, "exit.repeat");
        return;
      }
      record("exit", exitState, exitState, "exit.repeat", cause);
      return;
    }
    const code = exitCodes[trigger];
    void shutdown(cause, code === undefined ? {} : { code });
  };
  const messages = description.shutdown.messages ?? [];
  /** This function receives a message of the IPC channel. The first declared shape that it matches gives its trigger. */
  const received = (message: unknown): void => {
    const found = messages.find((each) => matchesMessage(each.match, message));
    if (found === undefined) return;
    if (found.as === undefined) triggered("ipc-message");
    else triggered(found.as, `${found.as} (a message of the IPC channel)`);
  };

  /** This function does the work of one phase, until its cap. It gives true when the work ended in time. */
  const runPhase = async (phase: Phase, hold: boolean, work: ReadonlyArray<(context: PhaseContext) => Promise<void> | void>): Promise<boolean> => {
    const cap = valueIn(phase.cap, "ms");
    const deadline = clock.now() + cap;
    const capped = new AbortController();
    const context: PhaseContext = { deadline, signal: capped.signal, clock };
    let pending = work.length;
    const all = Promise.all(
      work.map(async (each) => {
        try {
          await each(context);
        } catch (error) {
          fail(`the phase ${phase.name} failed: ${message(error)}`);
        } finally {
          pending -= 1;
        }
      }),
    );
    let cancelCap: Cancel = () => {};
    const end = new Promise<"cap">((resolve) => {
      cancelCap = clock.after(cap, () => resolve("cap"));
    });
    const first = await Promise.race([all.then(() => "work" as const), end]);
    if (first === "work" && hold) await end;
    cancelCap();
    capped.abort(new Error(`the phase ${phase.name} reached its cap`));
    return pending === 0;
  };

  async function shutdown(cause = "the service asked for it", request: ShutdownOptions = {}): Promise<number> {
    if (request.code !== undefined && !isExitCode(request.code))
      throw new Error(`${description.name}: the exit code ${request.code} is not a whole number from 0 to 255`);
    if (exitState === "exited") return done;
    if (request.code !== undefined && requested === undefined) requested = request.code;
    if (shutdownStarted) {
      if (exitState === "stopping") record("exit", exitState, exitState, "exit.repeat", cause);
      return done;
    }
    shutdownStarted = true;
    if (exitState === "running") moveExit("stopping", "exit.request", cause);
    // a trigger during the startup gets its shutdown after the startup ends
    await startup;
    // a repeat signal can end the process while the startup ends: then only the timers stop
    if (exitState === "exited") {
      runtime.stop();
      components.stopPollers();
      return exitCode!;
    }
    state = "draining";
    runtime.drain();
    let drainState = "running";
    const moveDrain = (to: string, on: string, detail?: string): void => {
      record("drain", drainState, to, on, detail);
      drainState = to;
    };
    const abortService = (): void => {
      if (service.signal.aborted) return;
      service.abort(new Error("the service stopped"));
      record("drain", drainState, drainState, "signal.abort");
    };
    const phases = description.shutdown.phases;
    let on = "exit.request";
    for (const phase of phases) {
      // after a repeat signal ends the process, no phase starts
      if (exitState === "exited") break;
      const rank = stageRank(phase.name);
      moveDrain(phase.name, on);
      if (rank > ABORT_AFTER) abortService();
      const work: Array<(context: PhaseContext) => Promise<void> | void> = [];
      const owned = components.phaseWork.get(phase.name) ?? [];
      if (phase.name === "stop intake") {
        work.push(() => {
          intakeStopped = true;
          requests.stopIntake();
        });
        for (const [, impl] of startedTransports) work.push(() => impl.stopIntake());
      }
      // the cooperative abort of the drain: the cap less the window, not before the floor. It ends
      // with the phase, thus a drain that ends before it does not abort anything
      let cancelAbort: Cancel = () => {};
      if (phase.name === "drain") {
        const cap = valueIn(phase.cap, "ms");
        const cooperative = new AbortController();
        const fireAt = cooperativeAbortAt(cap, description.shutdown.cooperativeWindow, description.shutdown.cooperativeFloor);
        cancelAbort = clock.after(fireAt, () => {
          cooperative.abort(new Error("the cooperative abort of the drain"));
          requests.cooperativeAbort();
          record("drain", drainState, drainState, "drain.cooperative-abort");
        });
        work.push(({ deadline }) => requests.drain(deadline));
        for (const [, impl] of startedTransports)
          work.push(({ deadline }) => impl.drain(deadline, cooperative.signal));
      }
      if (phase.name === "close transports")
        for (const [, impl] of startedTransports) work.push(() => impl.close());
      if (phase.name === "stop the poller")
        work.push(() => {
          runtime.stop();
          components.stopPollers();
        });
      if (phase.name === "tear down dependencies")
        work.push(async () => {
          for (const [, handle] of [...connected].reverse()) await handle.close();
        });
      if (phase.name === "close the health server" && healthListening && components.healthServer !== null) {
        const server = components.healthServer;
        work.push(() => server.close());
      }
      if (phase.name === "flush the output")
        // the owners write their last output first (a log or a trace exporter), then the port writes it
        work.push(async (context) => {
          await Promise.all(
            owned.map(async (each) => {
              try {
                await each(context);
              } catch (error) {
                fail(`the phase ${phase.name} failed: ${message(error)}`);
              }
            }),
          );
          await port.flush?.();
        });
      else for (const each of owned) work.push(each);
      const inTime = await runPhase(phase, phase.name === "fail readiness", work);
      cancelAbort();
      if (!inTime) fail(`the phase ${phase.name} did not end in its cap of ${valueIn(phase.cap, "s")} s`);
      on = inTime ? "phase.done" : "phase.cap";
    }
    if (exitState !== "exited") moveDrain("done", on);
    abortService();
    // a stage that the declaration does not name still stops: the checks, at the end
    runtime.stop();
    components.stopPollers();
    if (!intakeStopped) requests.stopIntake();
    // a repeat signal can end the process during the sequence: then it ended already
    if (exitState === "exited") return exitCode!;
    const code = requested !== undefined && requested !== 0 ? requested : errors.length > 0 ? 1 : 0;
    end(code, "shutdown.done");
    return code;
  }

  const life: Lifecycle = {
    health: runtime,
    get state() {
      return state;
    },
    get exitCode() {
      return exitCode;
    },
    get errors() {
      return [...errors];
    },
    started: startup,
    done,
    signal: service.signal,
    shutdown,
    request: (controller, route, work, request) => requests.request(controller, route, work, request),
    inFlight: (controller) => requests.inFlight(controller),
    keepAlive: () => state === "running" && runtime.verdict().ready,
  };

  bind(life);
  offs = [...EXIT_SIGNALS, ...(description.shutdown.triggers ?? [])].map((trigger: ExitTrigger) =>
    port.on(trigger, trigger === "ipc-message" ? received : () => triggered(trigger)),
  );

  void (async (): Promise<void> => {
    const started = (what: string): void => record("gate", "starting", "starting", "component.started", what);
    try {
      runtime.beginStartup();
      if (components.healthServer !== null) {
        await components.healthServer.listen(runtime);
        healthListening = true;
        started("the health server");
      }
      for (const dependency of description.dependencies) {
        const handle = components.dependencies.get(dependency.name);
        if (handle === undefined) continue;
        await handle.connect(service.signal);
        connected.push([dependency.name, handle]);
        started(`dependency ${dependency.name}`);
      }
      for (const transport of description.transports) {
        const impl = components.transports.get(transport.name)!;
        await impl.start(service.signal, life);
        startedTransports.push([transport.name, impl]);
        started(`${transport.kind} ${transport.name}`);
      }
      await runtime.warmUp();
      if (state === "starting") state = "running";
    } catch (error) {
      const cause = `the startup failed: ${message(error)}`;
      failedStartup = true;
      runtime.failStartup(cause);
      fail(cause);
      if (exitState === "running") moveExit("stopping", "startup.fail", cause);
      else if (exitState === "stopping") record("exit", exitState, exitState, "startup.fail", cause);
    } finally {
      startupEnded();
    }
  })();
  // a failed startup shuts down what started. An exit request during the startup waits for it
  void startup.then(() => {
    if (failedStartup && !shutdownStarted && exitState !== "exited") void shutdown("the startup failed");
  });

  return life;
};
