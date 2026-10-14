import { describe, expect, it } from "vitest";
import type { Check, CheckFn, ServiceBuilder } from "./index.ts";
import { service } from "./index.ts";
import { contractCases } from "./testing.ts";

/**
 * F3: the contract test that each declaration generates. It passes on a sound declaration, and it
 * finds what a declaration or a runtime gets wrong.
 */

const s = (value: number) => ({ value, unit: "s" });
const poll = { interval: s(1), jitter: 0.2, timeout: s(0.4) };
const passes: CheckFn = () => "ok";

const check = (name: string, dependency: string | null, gates: Check["gates"], timeout = 0.4): Check => ({
  name,
  dependency,
  step: dependency === null ? "local-state" : "round-trip",
  ownConnection: true,
  gates,
  poll: { ...poll, timeout: s(timeout) },
});

/** This function declares the sample: two dependencies, a controller for each, and a liveness check of its own. */
const sample = (
  extra: (svc: ServiceBuilder) => ServiceBuilder = (svc) => svc,
  timeout = 0.4,
): (() => ServiceBuilder) => () => {
  const svc = service("shop")
    .dependency("db", { system: null, knobs: {}, operations: {} })
    .dependency("cache", { system: null, knobs: {}, operations: {} })
    .check(check("db.round-trip", "db", "readiness", timeout), passes)
    .check(check("cache.round-trip", "cache", "readiness"), passes)
    .check(check("self.state", null, "liveness"), passes)
    .readiness({ type: "debounce", interval: s(1), failAfter: 3, recoverAfter: 1 })
    .liveness({ type: "window", failAfter: s(5) })
    .startup(s(10))
    .phase("drain", s(4))
    .cooperativeWindow(s(1));
  svc.controller("orders").requires("db").route("POST /orders", { idempotent: false });
  svc.controller("catalog").requires("cache").route("GET /items", { idempotent: true });
  return extra(svc);
};

describe("the contract test of a declaration (F3)", () => {
  const cases = contractCases(sample());

  it("generates the cases: at rest, and each dependency unavailable, degraded and recovered, and the negative control", () => {
    expect(cases.map((each) => each.name)).toEqual([
      "shop: at rest, each controller and each dependency is ready, and the service is alive",
      "shop: db unavailable",
      "shop: db degraded by 100 ms, and nothing fails",
      "shop: db recovers",
      "shop: cache unavailable",
      "shop: cache degraded by 100 ms, and nothing fails",
      "shop: cache recovers",
      "shop: a client never registered fails, and nothing changes (the negative control)",
    ]);
  });

  it.each(cases.map((each) => [each.name, each] as const))("%s", async (_name, each) => {
    await each.run();
  });

  it("finds a dependency that no check exercises: the service cannot see it fail", async () => {
    const blind = contractCases(sample((svc) => svc.dependency("queue", { system: null, knobs: {}, operations: {} })));
    const unavailable = blind.find((each) => each.name === "shop: queue unavailable")!;
    await expect(unavailable.run()).rejects.toThrow(/no check that gates a policy exercises queue/);
  });

  it("finds a check whose timeout a latency of 100 ms fails", async () => {
    const tight = contractCases(sample(undefined, 0.05));
    const degraded = tight.find((each) => each.name === "shop: db degraded by 100 ms, and nothing fails")!;
    await expect(degraded.run()).rejects.toThrow(/db.round-trip times out in 50 ms: a latency of 100 ms fails it/);
  });

  it("finds a check that names the wrong dependency: the forced failure of db misses it", async () => {
    const crossed = contractCases(() =>
      service("shop")
        .dependency("db", { system: null, knobs: {}, operations: {} })
        .dependency("cache", { system: null, knobs: {}, operations: {} })
        // the check says it exercises db, but it is the cache's: the forced failure of db misses it
        .check(check("db.round-trip", "cache", "readiness"), passes)
        .check(check("cache.round-trip", "cache", "readiness"), passes)
        .readiness({ type: "debounce", interval: s(1), failAfter: 3, recoverAfter: 1 })
        .liveness({ type: "window", failAfter: s(5) })
        .startup(s(10))
        .phase("drain", s(4))
        .cooperativeWindow(s(1)),
    );
    const blind = crossed.find((each) => each.name === "shop: db unavailable")!;
    await expect(blind.run()).rejects.toThrow(/no check that gates a policy exercises db/);
  });
});
