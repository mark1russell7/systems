import type { CheckVerdict, Health, HealthServer, HealthVerdict, ProbeKind } from "@mark1russell7/service";
import { describe, expect, it } from "vitest";
import { sharedGate } from "./compose.ts";

const check = (dependency: string | null, tripped: boolean): CheckVerdict => ({ gates: "readiness", dependency, tripped, streak: 0, since: null, last: null });

/** This function gives a health runtime with a fixed verdict. Its own probe reads only `ready`. */
const healthOf = (verdict: Partial<HealthVerdict>): Health => {
  const full: HealthVerdict = {
    started: true,
    draining: false,
    ready: false,
    alive: true,
    controllers: {},
    dependencies: {},
    checks: {},
    startup: { budget: 0, elapsed: 0, overBudget: false },
    ...verdict,
  };
  const probe = (kind: ProbeKind, controller?: string) => {
    const pass = kind === "liveness" ? full.alive : full.ready;
    return {
      status: pass ? (200 as const) : (503 as const),
      contentType: "application/health+json" as const,
      body: { status: pass ? ("pass" as const) : ("fail" as const), service: "lab", probe: kind, ...(controller === undefined ? {} : { controller }) },
    };
  };
  return {
    verdict: () => full,
    probe,
    metrics: () => ({}) as never,
    subscribe: () => () => undefined,
    forceFail: () => undefined,
    drain: () => undefined,
    stop: () => undefined,
  };
};

/** This function gives the health that a server of the gate gets at its start. */
const listened = (health: Health): Health => {
  let got: Health | null = null;
  const server: HealthServer = { listen: (runtime) => void (got = runtime), close: () => undefined };
  void sharedGate(server, "redis", [{ from: "liveness", to: "readiness", effect: "fails" }]).listen(health);
  return got!;
};

describe("the shared gate of a kind cell", () => {
  it("passes the readiness probe while only the checks of the shared dependency fail", () => {
    const health = listened(healthOf({ checks: { "redis.round-trip": check("redis", true), "self.flag": check(null, false) }, dependencies: { redis: false } }));
    expect(health.probe("readiness").status).toBe(200);
    expect(health.probe("readiness").body.status).toBe("pass");
  });

  it("fails the readiness probe when a check of no dependency fails: a failure of one replica", () => {
    const health = listened(healthOf({ checks: { "redis.round-trip": check("redis", false), "self.flag": check(null, true) }, dependencies: { redis: true } }));
    expect(health.probe("readiness").status).toBe(503);
  });

  it("fails the readiness probe before the start, in the drain, and when liveness fails through the coupling", () => {
    expect(listened(healthOf({ started: false })).probe("readiness").status).toBe(503);
    expect(listened(healthOf({ draining: true })).probe("readiness").status).toBe(503);
    expect(listened(healthOf({ alive: false })).probe("readiness").status).toBe(503);
  });

  it("fails the readiness probe when another dependency is not ready", () => {
    expect(listened(healthOf({ dependencies: { redis: false, queue: false } })).probe("readiness").status).toBe(503);
  });

  it("answers the other probes, and the readiness of a controller, from the runtime as before", () => {
    const health = listened(healthOf({ checks: { "redis.round-trip": check("redis", true) }, dependencies: { redis: false } }));
    expect(health.probe("readiness", "work").status).toBe(503);
    expect(health.probe("liveness").status).toBe(200);
  });
});
