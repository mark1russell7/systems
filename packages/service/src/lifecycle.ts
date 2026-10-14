import type { Extent } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Cancel, Clock } from "./clock.ts";
import { realClock } from "./clock.ts";
import type { Phase, ServiceDescription } from "./description.ts";
import type { MachineName } from "./events.ts";
import type { Health, Runtime, StartOptions } from "./health.ts";
import type { ExitSignal, ProcessPort } from "./process.ts";
import { EXIT_SIGNALS, nodeProcess } from "./process.ts";
import type { RequestFn, RequestOutcome } from "./requests.ts";
import { tracker } from "./requests.ts";

/**
 * A transport is a source of work: a server, a consumer or a worker. Each has one contract. It
 * starts, stops its intake, and drains to a deadline without a throw. It counts its work in flight,
 * and it closes. A second close has no effect.
 */
export interface TransportImpl {
  start(signal: AbortSignal): Promise<void> | void;
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
 * - `close the health server`: the probes stop last.
 */
export const STAGES = [
  "fail readiness",
  "stop intake",
  "drain",
  "close transports",
  "stop the poller",
  "tear down dependencies",
  "close the health server",
] as const;

export type Stage = (typeof STAGES)[number];

/** This function gives the place of a stage in the sequence, or -1 for a phase of another name. */
export const stageRank = (name: string): number => (STAGES as readonly string[]).indexOf(name);

/** The signal of the service aborts after the poller stops, and before the dependencies close. */
const ABORT_AFTER = stageRank("stop the poller");

/**
 * This function gives the time of the cooperative abort, in milliseconds after the drain starts. It
 * is the cap less the cooperative window, and not less than half the cap. A window without a bound
 * gives half the cap.
 */
export const cooperativeAbortAt = (cap: number, window: Extent): number => {
  const before = window.value === "infinite" ? Number.POSITIVE_INFINITY : valueIn(window, "ms");
  return Math.max(cap - before, cap / 2);
};

/** These options run the lifecycle. Without them, it uses the real clock and the process of Node. */
export interface RunOptions extends StartOptions {
  readonly process?: ProcessPort | undefined;
}

/** A lifecycle state tells where the service is in its life. */
export type LifecycleState = "starting" | "running" | "draining" | "exited";

/** The lifecycle of a running service. */
export interface Lifecycle {
  readonly health: Health;
  readonly state: LifecycleState;
  /** This code is the exit code, or null before the exit. */
  readonly exitCode: number | null;
  /** These texts are the errors that make the exit code 1. */
  readonly errors: readonly string[];
  /** This promise ends when the startup ends: the service runs, or its startup failed. */
  readonly started: Promise<void>;
  /** This promise gives the exit code when the shutdown ends. */
  readonly done: Promise<number>;
  /** This signal aborts after the poller stops: the background work of the service stops with it. */
  readonly signal: AbortSignal;
  /** This method asks for the shutdown, as an exit signal does. A second request has no effect. */
  shutdown(cause?: string): Promise<number>;
  /**
   * This method does one request of a controller, on a route that the controller declares. The
   * service refuses it while it cannot take new work, and the shutdown can cut it.
   */
  request<T>(controller: string, route: string, work: RequestFn<T>): Promise<RequestOutcome<T>>;
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
 * first, then each dependency, then each transport, and the startup gate last. A signal during the
 * startup gets its shutdown after the startup ends. The shutdown does the declared phases in their
 * sequence, each one capped. Only the lifecycle ends the process: 0 after a clean shutdown, and 1
 * after an error.
 */
export const lifecycle = (
  description: ServiceDescription,
  runtime: Runtime,
  components: Components,
  options: RunOptions = {},
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
  let state: LifecycleState = "starting";
  let exitCode: number | null = null;
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
    record("exit", exitState, exitState, "error", cause);
  };

  const requests = tracker(description.controllers, clock, (controller) => {
    if (state === "starting") return "the service has not started";
    if (state === "exited") return "the service has exited";
    // while it drains and before its intake stops, the service still serves: the platform can
    // still route a request to it until its endpoints update
    if (state === "draining") return null;
    return runtime.verdict().controllers[controller] === true ? null : `controller ${controller} is not ready`;
  });

  let finish: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });
  // what started, thus what the shutdown stops
  let healthListening = false;
  const connected: Array<[string, DependencyHandle]> = [];
  const startedTransports: Array<[string, TransportImpl]> = [];

  const offs = EXIT_SIGNALS.map((signal: ExitSignal) =>
    port.on(signal, () => {
      void shutdown(signal);
    }),
  );

  const startup = (async (): Promise<void> => {
    runtime.beginStartup();
    const started = (what: string): void => record("gate", "starting", "starting", "component.started", what);
    try {
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
        await impl.start(service.signal);
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
      else record("exit", exitState, exitState, "startup.fail", cause);
    }
  })();
  // a failed startup shuts down what started. An exit request during the startup waits for it
  void startup.then(() => {
    if (failedStartup && !shutdownStarted) void shutdown("the startup failed");
  });

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

  async function shutdown(cause = "the service asked for it"): Promise<number> {
    if (shutdownStarted || exitState === "exited") {
      if (exitState === "stopping") record("exit", exitState, exitState, "exit.repeat", cause);
      return done;
    }
    shutdownStarted = true;
    if (exitState === "running") moveExit("stopping", "exit.request", cause);
    // a signal during the startup gets its shutdown after the startup ends
    await startup;
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
      const rank = stageRank(phase.name);
      moveDrain(phase.name, on);
      if (rank > ABORT_AFTER) abortService();
      const work: Array<(context: PhaseContext) => Promise<void> | void> = [];
      if (phase.name === "stop intake") {
        work.push(() => {
          intakeStopped = true;
          requests.stopIntake();
        });
        for (const [, impl] of startedTransports) work.push(() => impl.stopIntake());
      }
      // the cooperative abort of the drain: the cap less the window, and half the cap at the least.
      // It ends with the phase, thus a drain that ends before it does not abort anything
      let cancelAbort: Cancel = () => {};
      if (phase.name === "drain") {
        const cap = valueIn(phase.cap, "ms");
        const cooperative = new AbortController();
        const fireAt = cooperativeAbortAt(cap, description.shutdown.cooperativeWindow);
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
      for (const owned of components.phaseWork.get(phase.name) ?? []) work.push(owned);
      const inTime = await runPhase(phase, phase.name === "fail readiness", work);
      cancelAbort();
      if (!inTime) fail(`the phase ${phase.name} did not end in its cap of ${valueIn(phase.cap, "s")} s`);
      on = inTime ? "phase.done" : "phase.cap";
    }
    moveDrain("done", on);
    abortService();
    // a stage that the declaration does not name still stops: the checks, at the end
    runtime.stop();
    components.stopPollers();
    if (!intakeStopped) requests.stopIntake();
    for (const off of offs) off();
    state = "exited";
    exitCode = errors.length > 0 ? 1 : 0;
    moveExit("exited", "shutdown.done", `exit ${exitCode}`);
    finish(exitCode);
    port.exit(exitCode);
    return exitCode;
  }

  return {
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
    request: (controller, route, work) => requests.request(controller, route, work),
    inFlight: (controller) => requests.inFlight(controller),
    keepAlive: () => state === "running" && runtime.verdict().ready,
  };
};
