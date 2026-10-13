import type { Extent, Quantity } from "@mark1russell7/quantity";
import { convertible } from "@mark1russell7/quantity";
import type {
  Check,
  Controller,
  Coupling,
  Dependency,
  Phase,
  ServiceDescription,
  Transport,
} from "./description.ts";
import { FORMAT } from "./description.ts";
import type { Operation } from "./operation.ts";
import { operationProblems } from "./operation.ts";
import type { Timing } from "./timing.ts";

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
 *     svc.check({ name: "weather.round-trip", dependency: "weather", … });
 *     svc.describe(); // the whole graph as data, with nothing started
 *     await svc.start();
 *
 * The graph has one source, thus its parts cannot disagree. A dependency or a check can join
 * after the start. It starts tripped, and the export is partial. The runtime has no defaults of
 * its own. Thus `describe()` refuses a service that does not declare a policy, its startup budget
 * or its shutdown, and it tells which.
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
  dependency(name: string, spec: Omit<Dependency, "name">): ServiceBuilder;
  server(name: string, knobs: Readonly<Record<string, Extent>>): ServiceBuilder;
  consumer(name: string, knobs: Readonly<Record<string, Extent>>): ServiceBuilder;
  worker(name: string, knobs: Readonly<Record<string, Extent>>): ServiceBuilder;
  controller(name: string): ControllerBuilder;
  check(check: Check): ServiceBuilder;
  readiness(timing: Timing): ServiceBuilder;
  liveness(timing: Timing): ServiceBuilder;
  startup(budget: Quantity): ServiceBuilder;
  couple(coupling: Coupling): ServiceBuilder;
  phase(name: string, cap: Quantity): ServiceBuilder;
  cooperativeWindow(window: Extent): ServiceBuilder;
  /** This method gives the service as data, and it starts nothing. */
  describe(): ServiceDescription;
  /** This method closes the composition. A part that joins after it starts tripped, and it makes the export partial. */
  start(): Promise<void>;
}

const isTime = (amount: Extent): boolean => convertible(amount.unit, "s");

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
  const couplings: Coupling[] = [];
  const phases: Phase[] = [];
  let readiness: Timing | undefined;
  let liveness: Timing | undefined;
  let startup: Quantity | undefined;
  let cooperative: Extent | undefined;
  let started = false;
  let partial = false;

  /** This function stops a change to the shape of the service after the start. */
  const composing = (what: string): void => {
    if (started) throw new Error(`${name} has started: ${what} is declared before svc.start()`);
  };
  const once = (list: ReadonlyArray<{ name: string }>, entry: string, what: string): void => {
    if (list.some((held) => held.name === entry))
      throw new Error(`${name} already has a ${what} named ${entry}`);
  };
  const transport =
    (kind: Transport["kind"]) => (entry: string, knobs: Readonly<Record<string, Extent>>) => {
      composing(`a ${kind}`);
      once(transports, entry, "transport");
      transports.push({ name: entry, kind, knobs: { ...knobs } });
      return builder;
    };

  const builder: ServiceBuilder = {
    name,
    dependency(entry, spec) {
      once(dependencies, entry, "dependency");
      dependencies.push({
        name: entry,
        ...spec,
        knobs: { ...spec.knobs },
        operations: { ...spec.operations },
      });
      if (started) partial = true;
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
    check(check) {
      once(checks, check.name, "check");
      checks.push({ ...check });
      if (started) partial = true;
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
      for (const check of checks) {
        if (check.dependency !== null && !known.has(check.dependency)) {
          problems.push(
            `check ${check.name} exercises ${check.dependency}, which is not a dependency`,
          );
        }
        if (!isTime(check.poll.interval) || !isTime(check.poll.timeout)) {
          problems.push(`check ${check.name} polls in a unit that is not a time`);
        }
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
        },
      };
    },
    start() {
      // the start needs the whole graph: describe() is the check
      builder.describe();
      started = true;
      return Promise.resolve();
    },
  };
  return builder;
};
