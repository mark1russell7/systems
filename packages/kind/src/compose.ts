// The composition of the service of a kind cell. The app of the image and `lint()` compose the same
// service from the same declaration: the image copies this file, and Node strips its types. Thus
// this file imports only packages and types.
import type { CheckFn, HealthServer, ServiceBuilder, TransportImpl } from "@mark1russell7/service";
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
  if (parts.health !== undefined) svc.healthServer(parts.health);
  for (const [stage, cap] of declaration.phases) svc.phase(stage, cap);
  return svc;
};
