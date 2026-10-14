import type { Extent } from "@mark1russell7/quantity";
import type { ServiceBuilder } from "./builder.ts";
import { service } from "./builder.ts";
import type { LifecycleEvent } from "./events.ts";
import type { FakeClock, FakeProcess } from "./fakes.ts";
import { fakeClock, fakeProcess, seeded } from "./fakes.ts";
import type { DependencyHandle, HealthServer, Lifecycle, Stage, TransportImpl } from "./lifecycle.ts";
import type { ScriptedCheck } from "./testing.ts";
import { scriptedCheck } from "./testing.ts";

/**
 * The rig of the lifecycle tests: one service with two dependencies, one server and a health
 * server. Each part writes each use to the log, with the time of the fake clock. The rig is for
 * the tests of this package, and the package does not export it.
 */

const s = (value: number) => ({ value, unit: "s" });

/** These options shape the service of the rig. */
export interface RigOptions {
  /** These are the caps of the phases, in seconds. A phase without a cap here is not declared. */
  readonly caps?: Partial<Record<Stage, number>> | undefined;
  readonly window?: Extent | undefined;
  /** This time is the startup budget, in seconds. */
  readonly budget?: number | undefined;
  /** These are the times that the connection of each dependency takes, in milliseconds. */
  readonly connect?: Partial<Record<"db" | "cache", number>> | undefined;
  /** This name is the dependency whose connection fails. */
  readonly failConnect?: "db" | "cache" | undefined;
  /** This flag adds a watchdog of the event loop, as a liveness check: a tick of 100 ms, a threshold of 1 s. */
  readonly watchdog?: boolean | undefined;
  /** This time is added to each call of the check of db, in milliseconds. */
  readonly checkDelay?: number | undefined;
}

/** A rig is the service, its clock and process, and what its parts recorded. */
export interface Rig {
  readonly svc: ServiceBuilder;
  readonly clock: FakeClock;
  readonly process: FakeProcess;
  readonly events: LifecycleEvent[];
  readonly log: string[];
  readonly checks: Readonly<Record<"db" | "cache", ScriptedCheck>>;
}

/** These are the caps of the phases when a test does not give its own, in seconds. */
export const CAPS: Readonly<Record<Stage, number>> = {
  "fail readiness": 1,
  "stop intake": 1,
  drain: 4,
  "close transports": 1,
  "stop the poller": 1,
  "tear down dependencies": 1,
  "close the health server": 1,
};

/** This function makes a rig. */
export const rig = (options: RigOptions = {}): Rig => {
  const clock = fakeClock();
  const process = fakeProcess();
  const events: LifecycleEvent[] = [];
  const log: string[] = [];
  const write = (what: string): void => {
    log.push(`${clock.now()} ${what}`);
  };
  const wait = (ms: number): Promise<void> =>
    ms <= 0 ? Promise.resolve() : new Promise((resolve) => clock.after(ms, resolve));
  const checks = { db: scriptedCheck("ok"), cache: scriptedCheck("ok") };
  const handle = (name: "db" | "cache"): DependencyHandle => ({
    connect: async () => {
      await wait(options.connect?.[name] ?? 0);
      if (options.failConnect === name) throw new Error(`${name} refused the connection`);
      write(`connect ${name}`);
    },
    close: () => write(`close ${name}`),
  });
  const http: TransportImpl = {
    start: () => write("start http"),
    stopIntake: () => write("stop intake http"),
    drain: () => write("drain http"),
    inFlight: () => 0,
    close: () => write("close http"),
  };
  const probes: HealthServer = {
    listen: () => write("listen health"),
    close: () => write("close health"),
  };
  const poll = { interval: s(1), jitter: 0.2, timeout: s(0.4) };
  const svc = service("svc")
    .dependency(
      "db",
      { system: null, knobs: {}, operations: { SELECT: { idempotent: true }, INSERT: { idempotent: false } } },
      handle("db"),
    )
    .dependency("cache", { system: null, knobs: {}, operations: { GET: { idempotent: true } } }, handle("cache"))
    .server("http", {}, http)
    .healthServer(probes)
    .check(
      { name: "db.round-trip", dependency: "db", step: "round-trip", ownConnection: true, gates: "readiness", poll },
      options.checkDelay === undefined
        ? checks.db.run
        : async (signal) => {
            await wait(options.checkDelay!);
            return checks.db.run(signal);
          },
    )
    .check(
      { name: "cache.round-trip", dependency: "cache", step: "round-trip", ownConnection: true, gates: "readiness", poll },
      checks.cache.run,
    )
    .readiness({ type: "debounce", interval: s(1), failAfter: 3, recoverAfter: 1 })
    .liveness({ type: "window", failAfter: s(5) })
    .startup(s(options.budget ?? 10))
    .cooperativeWindow(options.window ?? s(1));
  svc
    .controller("api")
    .requires("db")
    .route("GET /things", { idempotent: true })
    .route("POST /things", { idempotent: false })
    .route("POST /charges", { idempotent: { key: "Idempotency-Key", window: s(1) } });
  svc.controller("stats").requires("cache").route("GET /stats", { idempotent: true });
  if (options.watchdog === true)
    svc.watchdog({
      name: "process.event-loop",
      tick: s(0.1),
      threshold: s(1),
      gates: "liveness",
      poll: { interval: s(1), jitter: 0, timeout: s(0.4) },
    });
  const caps = options.caps ?? CAPS;
  for (const [stage, cap] of Object.entries(caps)) if (cap !== undefined) svc.phase(stage, s(cap));
  return { svc, clock, process, events, log, checks };
};

/**
 * This function starts the lifecycle of a rig, and moves the clock until the startup ends. The
 * function `during` operates at each step of 100 ms of the startup, for example to send a signal.
 */
export const run = async (
  rigged: Rig,
  during: (at: number) => void = () => {},
): Promise<Lifecycle> => {
  let ended = false;
  const life = rigged.svc
    .run({
      clock: rigged.clock,
      random: seeded(1),
      process: rigged.process,
      record: (event) => rigged.events.push(event),
    })
    .finally(() => {
      ended = true;
    });
  for (let step = 0; step < 600 && !ended; step += 1) {
    during(rigged.clock.now());
    await rigged.clock.advance(100);
  }
  return life;
};

/** This function moves the clock until the lifecycle exits, and gives the exit code. */
export const exited = async (rigged: Rig, life: Lifecycle, during: (at: number) => void = () => {}): Promise<number> => {
  let code: number | null = null;
  void life.done.then((value) => {
    code = value;
  });
  for (let step = 0; step < 1200 && code === null; step += 1) {
    during(rigged.clock.now());
    await rigged.clock.advance(50);
  }
  if (code === null) throw new Error("the lifecycle did not exit in 60 s of the fake clock");
  return code;
};
