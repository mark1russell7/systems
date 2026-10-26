import { valueIn } from "@mark1russell7/quantity";
import type { Cancel, Clock } from "./clock.ts";
import { realClock } from "./clock.ts";
import type { Check, Gate, ServiceDescription } from "./description.ts";
import type { MachineName, Recorder } from "./events.ts";
import type { Latch, Result, Trace } from "./latch.ts";
import type { Logger } from "./logger.ts";
import { latch } from "./latch.ts";
import type { HealthMetrics } from "./metrics.ts";
import { meter } from "./metrics.ts";
import type { CheckFn, Poller } from "./poller.ts";
import { poller } from "./poller.ts";

/** These options start the runtime. Without them, it uses the real clock and `Math.random`. */
export interface StartOptions {
  readonly clock?: Clock | undefined;
  /** This function gives a number in [0, 1) for the jitter of each poll. */
  readonly random?: (() => number) | undefined;
  /** This list names the checks or dependencies whose polls fail at once (a seam for tests). */
  readonly forceFail?: readonly string[] | undefined;
  /** This function receives each transition of each machine of the runtime. */
  readonly record?: Recorder | undefined;
  /**
   * This logger receives each transition too, as a log entry with a level and fields (`logEvents`).
   * Without it, the runtime writes no log, as before. For the console, give `consoleLogger()`.
   */
  readonly logger?: Logger | undefined;
  /**
   * This function can replace the function of a check, for example to add a delay to each call
   * (a seam for tests: a degraded dependency). It gives the function to use.
   */
  readonly wrapCheck?: ((check: Check, run: CheckFn) => CheckFn) | undefined;
}

/** A check verdict is the cached state of one check, for the probes and the report. */
export interface CheckVerdict {
  readonly gates: Gate | null;
  readonly dependency: string | null;
  /** This flag tells if the latch of the check is tripped, or it is null for a check that only reports. */
  readonly tripped: boolean | null;
  readonly streak: number;
  /** This time is when the latch last changed, in milliseconds on the monotonic clock. */
  readonly since: number | null;
  readonly last: Result | null;
}

/** A verdict is the state of the service, from its cache. Nothing in it starts a check. */
export interface HealthVerdict {
  /** This flag becomes true one time, after the warm-up sweep. */
  readonly started: boolean;
  readonly draining: boolean;
  /** This flag tells if the service can take new work: started, not draining, and each readiness latch released. */
  readonly ready: boolean;
  /** This flag tells if each liveness latch is released. */
  readonly alive: boolean;
  /** These flags tell if each controller can take new work, from the dependencies that it needs. */
  readonly controllers: Readonly<Record<string, boolean>>;
  readonly dependencies: Readonly<Record<string, boolean>>;
  readonly checks: Readonly<Record<string, CheckVerdict>>;
  readonly startup: { readonly budget: number; readonly elapsed: number; readonly overBudget: boolean };
}

/** A probe kind is the question that a probe asks: the startup, the readiness, the liveness, or the whole report. */
export type ProbeKind = "startup" | "readiness" | "liveness" | "report";

/** A probe answer is a status and a body, for any HTTP framework or none. */
export interface ProbeAnswer {
  readonly status: 200 | 503;
  readonly contentType: "application/health+json";
  readonly body: {
    readonly status: "pass" | "fail";
    readonly service: string;
    readonly probe: ProbeKind;
    readonly controller?: string | undefined;
    readonly verdict?: HealthVerdict | undefined;
  };
}

/** The health runtime of a started service. It reads its timing and its checks from the declaration. */
export interface Health {
  verdict(): HealthVerdict;
  /**
   * This method answers a probe from the cache, in constant time, and it starts no check. A
   * readiness probe with a controller asks about that controller. The report always answers 200.
   */
  probe(kind: ProbeKind, controller?: string): ProbeAnswer;
  /**
   * This method gives the counts of the runtime (B18). They are the outcomes, the durations and the
   * episodes of failure of each check, and the transitions of its machines. It starts no check.
   */
  metrics(): HealthMetrics;
  /** This method gives each change of the verdict to `listener`, and gives the function that stops it. */
  subscribe(listener: (verdict: HealthVerdict) => void): () => void;
  /** This method adds a name to the force-fail list, or removes it. */
  forceFail(name: string, on: boolean): void;
  /** This method fails readiness for good. The drain of the lifecycle starts with it. */
  drain(): void;
  /** This method stops each poller and each timer of the runtime. */
  stop(): void;
}

/** The runtime parts that the builder and the lifecycle use. */
export interface Runtime extends Health {
  /**
   * This method opens the startup gate: one bounded warm-up sweep of each check, then the loops of
   * the pollers. It is idempotent, and it does nothing after `failStartup()` or `stop()`.
   */
  warmUp(): Promise<void>;
  /** This method moves the gate from `closed` to `starting`: the lifecycle starts its components. */
  beginStartup(): void;
  /** This method moves the gate to `failed` for good: a component did not start. */
  failStartup(cause: string): void;
  addCheck(check: Check, run: CheckFn): void;
  addDependency(name: string): void;
}

interface Entry {
  readonly check: Check;
  readonly poller: Poller;
  readonly latch: Latch | null;
}

/**
 * This function makes the runtime of a declaration. The service has no defaults of its own: each
 * timing, poll and coupling comes from the description.
 */
export const healthRuntime = (
  description: ServiceDescription,
  runs: ReadonlyMap<string, CheckFn>,
  options: StartOptions = {},
): Runtime => {
  const clock = options.clock ?? realClock;
  const random = options.random ?? Math.random;
  const forced = new Set(options.forceFail ?? []);
  const startedAt = clock.now();
  const budget = valueIn(description.policies.startup, "ms");
  const entries = new Map<string, Entry>();
  const dependencies = new Set(description.dependencies.map((dependency) => dependency.name));
  // a dependency that joined after the start is tripped until a check on it passes one time
  const lateDependencies = new Set<string>();
  const listeners = new Set<(verdict: HealthVerdict) => void>();
  let started = false;
  let draining = false;
  let stopped = false;
  // the startup gate: closed, starting (components start), sweeping (the warm-up), open or failed
  let gate = "closed";

  const counts = meter();
  // each transition goes to the meter, and then to the recorder of the options
  const record: Recorder = (event) => {
    counts.event(event);
    options.record?.(event);
  };
  const tracer =
    (machine: MachineName, instance: string): Trace =>
    (from, to, on) =>
      record({ at: clock.now(), machine, instance, from, to, on });
  const gateTrace = tracer("gate", description.name);
  const moveGate = (to: string, on: string, detail?: string): void => {
    const from = gate;
    gate = to;
    record({
      at: clock.now(),
      machine: "gate",
      instance: description.name,
      from,
      to,
      on,
      ...(detail === undefined ? {} : { detail }),
    });
  };
  // the startup budget: a gate that is not open at its end says so. The platform's startup probe
  // acts on it, and the runtime does not stop itself
  let budgetTimer: Cancel | null = clock.after(budget, () => {
    budgetTimer = null;
    if (gate !== "open" && gate !== "failed") gateTrace(gate, gate, "startup.over-budget");
  });

  const changed = (): void => {
    if (listeners.size === 0) return;
    const now = verdict();
    for (const listener of listeners) listener(now);
  };

  const add = (check: Check, given: CheckFn, late: boolean): void => {
    const run = options.wrapCheck?.(check, given) ?? given;
    const timing = check.gates === null ? null : description.policies[check.gates];
    // readiness is earned: its latch starts tripped. Liveness passes from the start (and a late
    // liveness check starts released too, or one late registration could restart the process)
    const made =
      timing === null
        ? null
        : latch(
            timing,
            clock,
            check.gates === "readiness",
            changed,
            tracer(timing.type === "window" ? "window" : "latch", check.name),
          );
    const entry: Entry = {
      check,
      latch: made,
      poller: poller({
        name: check.name,
        poll: check.poll,
        run,
        clock,
        random,
        forced: () =>
          forced.has(check.name) || (check.dependency !== null && forced.has(check.dependency)),
        record: (result) => {
          counts.poll(check, result);
          made?.record(result);
          // a late dependency is released by the first pass of a check on it
          if (result.outcome === "ok" && check.dependency !== null)
            if (lateDependencies.delete(check.dependency)) changed();
        },
        trace: tracer("poller", check.name),
      }),
    };
    entries.set(check.name, entry);
    counts.add(check);
    if (late && !stopped) {
      // a late registration pulls readiness until its first pass: it polls at once, then on its loop
      void entry.poller.pollNow();
      entry.poller.start(entry.poller.jittered());
    }
  };

  for (const check of description.checks) {
    const run = runs.get(check.name);
    if (run === undefined) throw new Error(`check ${check.name} has no function: the runtime has no defaults`);
    add(check, run, false);
  }

  const latchesOf = (gateOf: Gate, keep: (check: Check) => boolean = () => true): Latch[] =>
    [...entries.values()].flatMap((entry) =>
      entry.check.gates === gateOf && entry.latch !== null && keep(entry.check) ? [entry.latch] : [],
    );
  const released = (latches: readonly Latch[]): boolean => latches.every((each) => !each.tripped);
  /** This function tells if a policy fails through a declared coupling from another policy. */
  const coupledOff = (to: Gate, base: Record<Gate, boolean>): boolean =>
    description.couplings.some((coupling) => coupling.to === to && !base[coupling.from]);

  const verdict = (): HealthVerdict => {
    const base: Record<Gate, boolean> = {
      readiness: released(latchesOf("readiness")) && lateDependencies.size === 0,
      liveness: released(latchesOf("liveness")),
    };
    const alive = base.liveness && !coupledOff("liveness", base);
    const open = started && !draining && !coupledOff("readiness", base);
    const ready = open && base.readiness;
    const dependencyReady = (name: string): boolean =>
      !lateDependencies.has(name) &&
      released(latchesOf("readiness", (check) => check.dependency === name));
    const own = released(latchesOf("readiness", (check) => check.dependency === null));
    const dependenciesOut: Record<string, boolean> = {};
    for (const name of dependencies) dependenciesOut[name] = dependencyReady(name);
    const controllers: Record<string, boolean> = {};
    for (const controller of description.controllers)
      controllers[controller.name] = open && own && controller.requires.every(dependencyReady);
    const checks: Record<string, CheckVerdict> = {};
    for (const [name, entry] of entries) {
      checks[name] = {
        gates: entry.check.gates,
        dependency: entry.check.dependency,
        tripped: entry.latch?.tripped ?? null,
        streak: entry.latch?.streak ?? 0,
        since: entry.latch?.since ?? null,
        last: entry.poller.last,
      };
    }
    const elapsed = clock.now() - startedAt;
    return {
      started,
      draining,
      ready,
      alive,
      controllers,
      dependencies: dependenciesOut,
      checks,
      startup: { budget, elapsed, overBudget: !started && elapsed > budget },
    };
  };

  const answer = (kind: ProbeKind, pass: boolean, controller?: string): ProbeAnswer => ({
    status: pass || kind === "report" ? 200 : 503,
    contentType: "application/health+json",
    body: {
      status: pass ? "pass" : "fail",
      service: description.name,
      probe: kind,
      ...(controller === undefined ? {} : { controller }),
      ...(kind === "report" ? { verdict: verdict() } : {}),
    },
  });

  return {
    verdict,
    metrics: counts.metrics,
    probe(kind, controller) {
      const now = verdict();
      if (kind === "startup") return answer(kind, now.started);
      if (kind === "liveness") return answer(kind, now.alive);
      if (kind === "report") return answer(kind, now.ready && now.alive);
      if (controller === undefined) return answer(kind, now.ready);
      // only an own key is a controller: a name such as "constructor" is not one
      const known = Object.hasOwn(now.controllers, controller) ? now.controllers[controller] : undefined;
      if (known === undefined) throw new Error(`${description.name} has no controller ${controller}`);
      return answer(kind, known, controller);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    forceFail(name, on) {
      if (on) forced.add(name);
      else forced.delete(name);
    },
    drain() {
      if (draining) return;
      draining = true;
      changed();
    },
    stop() {
      stopped = true;
      budgetTimer?.();
      budgetTimer = null;
      for (const entry of entries.values()) {
        entry.poller.stop();
        entry.latch?.stop();
      }
    },
    beginStartup() {
      if (gate === "closed") moveGate("starting", "startup.begin");
    },
    failStartup(cause) {
      if (gate === "open" || gate === "failed") return;
      moveGate("failed", "startup.fail", cause);
      budgetTimer?.();
      budgetTimer = null;
    },
    async warmUp() {
      if (started || stopped || gate === "failed" || gate === "sweeping") return;
      moveGate("sweeping", "mark-ready");
      // one bounded sweep of each check: each poll ends at its timeout at the latest
      const sweep = clock.now();
      await Promise.all([...entries.values()].map((entry) => entry.poller.pollNow()));
      if (stopped || gate !== "sweeping") return;
      for (const entry of entries.values())
        entry.poller.start(entry.poller.jittered() - (clock.now() - sweep));
      started = true;
      budgetTimer?.();
      budgetTimer = null;
      moveGate("open", "sweep.done");
      changed();
    },
    addCheck(check, run) {
      if (entries.has(check.name)) throw new Error(`${description.name} already has a check named ${check.name}`);
      add(check, run, true);
      changed();
    },
    addDependency(name) {
      if (dependencies.has(name)) return;
      dependencies.add(name);
      lateDependencies.add(name);
      changed();
    },
  };
};
