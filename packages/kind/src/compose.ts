// The composition of the service of a kind cell. The app of the image and `lint()` compose the same
// service from the same declaration: the image copies this file, and Node strips its types. Thus
// this file imports only packages and types.
import type { CheckFn, Coupling, Health, HealthServer, ProbeAnswer, ServiceBuilder, TransportImpl } from "@mark1russell7/service";
import { service } from "@mark1russell7/service";
import type { RedisClient } from "@mark1russell7/service/redis";
import type { Declaration } from "./cell.ts";

/** These are the parts of a running service. A composition for `lint()` gives none of them. */
export interface Parts {
  readonly redis?: RedisClient | undefined;
  readonly flag?: CheckFn | undefined;
  readonly http?: TransportImpl | undefined;
  readonly health?: HealthServer | undefined;
}

/** This name is the controller of the service, and its one route reads Redis when the service has Redis. */
export const CONTROLLER = "work";
export const ROUTE = "GET /work";
/** This name is the check that a flag file fails: the seam of the liveness restart. */
export const FLAG_CHECK = "self.flag";
/** This name is the watchdog of the event loop. */
export const WATCHDOG = "self.event-loop";

/**
 * This function gives the health server of the shared gate (S6, candidate E). Its readiness probe
 * leaves out each check of `dependency`, a dependency that each replica shares. The controller still
 * reads each check, thus the service still refuses each request at once with a 503. The other
 * probes, and the readiness of a controller, answer as before.
 *
 * The probe passes when the service is started and not in the drain, and liveness does not fail
 * readiness through a coupling. Each readiness check of another dependency, or of no dependency,
 * must also be released.
 */
export const sharedGate = (server: HealthServer, dependency: string, couplings: readonly Coupling[]): HealthServer => {
  const gated = (health: Health): Health => ({
    verdict: () => health.verdict(),
    metrics: () => health.metrics(),
    subscribe: (listener) => health.subscribe(listener),
    forceFail: (name, on) => health.forceFail(name, on),
    drain: () => health.drain(),
    stop: () => health.stop(),
    probe(kind, controller): ProbeAnswer {
      const answer = health.probe(kind, controller);
      if (kind !== "readiness" || controller !== undefined) return answer;
      const verdict = health.verdict();
      const coupled = couplings.some((coupling) => coupling.from === "liveness" && coupling.to === "readiness") && !verdict.alive;
      const checks = Object.values(verdict.checks).every((check) => check.gates !== "readiness" || check.dependency === dependency || check.tripped !== true);
      const dependencies = Object.entries(verdict.dependencies).every(([name, up]) => name === dependency || up);
      const pass = verdict.started && !verdict.draining && !coupled && checks && dependencies;
      return { ...answer, status: pass ? 200 : 503, body: { ...answer.body, status: pass ? "pass" : "fail" } };
    },
  });
  return { listen: (health) => server.listen(gated(health)), close: () => server.close() };
};

/**
 * This function composes the service of a declaration: its policies, its couplings, its checks,
 * one server, one controller and each stage of the shutdown. A declaration with Redis needs the
 * client, because the client declares the dependency and its checks.
 */
export const compose = (name: string, declaration: Declaration, parts: Parts = {}): ServiceBuilder => {
  const svc = service(name)
    .readiness(declaration.readiness)
    .liveness(declaration.liveness)
    .startup(declaration.startup)
    .cooperativeWindow(declaration.cooperativeWindow)
    // the kubelet sends SIGTERM one time and SIGKILL at the end of the grace: a repeat signal has no effect
    .onRepeatSignal("ignore");
  for (const coupling of declaration.couplings) svc.couple(coupling);
  if (declaration.redis !== null) {
    if (parts.redis === undefined) throw new Error(`${name} declares Redis, thus its composition needs the client`);
    parts.redis.attach(svc, { poll: declaration.poll, steps: { "round-trip": declaration.redis.gates } });
  }
  if (declaration.flag !== null)
    svc.check(
      {
        name: FLAG_CHECK,
        dependency: null,
        step: "local-state",
        ownConnection: true,
        gates: declaration.flag,
        poll: declaration.poll,
      },
      parts.flag,
    );
  if (declaration.watchdog !== null)
    svc.watchdog({
      name: WATCHDOG,
      tick: declaration.watchdog.tick,
      threshold: declaration.watchdog.threshold,
      gates: "liveness",
      poll: declaration.poll,
    });
  svc.server("http", {}, parts.http);
  const controller = svc.controller(CONTROLLER);
  if (declaration.redis !== null) controller.requires(parts.redis!.name);
  controller.route(ROUTE, { idempotent: true });
  // the shared gate keeps the checks of Redis out of the readiness that the kubelet reads
  if (declaration.sharedGate === true && declaration.redis === null) throw new Error(`${name} has the shared gate, but it declares no Redis`);
  if (parts.health !== undefined)
    svc.healthServer(declaration.sharedGate === true ? sharedGate(parts.health, parts.redis!.name, declaration.couplings) : parts.health);
  for (const [stage, cap] of declaration.phases) svc.phase(stage, cap);
  return svc;
};
