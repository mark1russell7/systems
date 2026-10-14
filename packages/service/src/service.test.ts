import { describe, expect, it } from "vitest";
import type { Check, Rule } from "./index.ts";
import {
  asDebounce,
  asWindow,
  evaluate,
  failSpan,
  mayReissue,
  recoverSpan,
  service,
  verdictOf,
} from "./index.ts";
import { fakeClock } from "./testing.ts";

const s = (value: number) => ({ value, unit: "s" });
const POLL = { interval: s(5), jitter: 0.2, timeout: s(4) };

describe("one timing shape for every policy", () => {
  it("gives the detection times: a latch of 3 polls trips in 8–18 s, or 12–22 s on a timeout", () => {
    const latch = { type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 } as const;
    expect(failSpan(latch, POLL)).toEqual({ min: s(8), max: s(18) });
    expect(failSpan(latch, POLL, "timeout")).toEqual({ min: s(12), max: s(22) });
    // and recovers on its first pass, within one jittered interval
    expect(recoverSpan(latch, POLL)).toEqual({ min: s(0), max: s(6) });
  });

  it("takes a window's duration plus up to one interval, and converts either way", () => {
    const window = { type: "window", failAfter: s(45) } as const;
    expect(failSpan(window, POLL)).toEqual({ min: s(45), max: s(51) });
    expect(asWindow({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })).toEqual({
      type: "window",
      failAfter: s(15),
      recoverAfter: s(5),
    });
    expect(asDebounce(window, POLL)).toEqual({
      type: "debounce",
      interval: s(5),
      failAfter: 9,
      recoverAfter: 1,
    });
  });
});

const CHECK: Check = {
  name: "world.local-state",
  dependency: null,
  step: "local-state",
  ownConnection: true,
  gates: "readiness",
  poll: POLL,
};

/** a service with everything the runtime needs declared */
const declared = () =>
  service("svc")
    .dependency("db", {
      system: null,
      knobs: { request_timeout: s(10) },
      operations: { SELECT: { idempotent: true }, INSERT: { idempotent: false } },
    })
    .check(CHECK)
    .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
    .liveness({ type: "window", failAfter: s(45) })
    .startup(s(60))
    .phase("fail readiness", s(2))
    .phase("drain", s(15))
    .cooperativeWindow(s(5));

describe("composed with plain calls, exported as data with nothing started", () => {
  it("exports the whole graph, and controllers declare the dependencies their routes need", () => {
    const svc = declared();
    svc.controller("api").requires("db").route("GET /api/things", { idempotent: true });
    const description = svc.describe();
    expect(description).toMatchObject({
      format: "mark1russell7.service/1",
      name: "svc",
      partial: false,
      controllers: [
        { name: "api", requires: ["db"], routes: { "GET /api/things": { idempotent: true } } },
      ],
      shutdown: { phases: [{ name: "fail readiness" }, { name: "drain" }] },
    });
  });

  it("refuses a service that leaves something to a default, and names it", () => {
    expect(() => service("bare").describe()).toThrow(
      /bare does not declare readiness .*liveness .*a startup budget .*shutdown phases .*cooperative window/,
    );
    expect(() =>
      declared()
        .check({ ...CHECK, name: "x", dependency: "cache" })
        .describe(),
    ).toThrow(/check x exercises cache, which is not a dependency/);
    const svc = declared();
    svc.controller("api").requires("queue");
    expect(() => svc.describe()).toThrow(
      /controller api requires queue, which is not a dependency/,
    );
  });

  it("closes composition at the start: a late dependency is partial, a late shape is refused", async () => {
    // the runtime has no defaults: a check without its function cannot start
    await expect(declared().start()).rejects.toThrow(/check world.local-state has no function/);
    const svc = service("svc")
      .dependency("db", { system: null, knobs: {}, operations: {} })
      .check(CHECK, () => "ok")
      .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
      .liveness({ type: "window", failAfter: s(45) })
      .startup(s(60))
      .phase("fail readiness", s(2))
      .cooperativeWindow(s(5));
    const health = await svc.start({ clock: fakeClock() });
    svc.dependency("late", { system: null, knobs: {}, operations: {} });
    expect(svc.describe().partial).toBe(true);
    expect(() => svc.controller("late")).toThrow(
      /svc has started: a controller is declared before svc.start\(\)/,
    );
    expect(() => svc.phase("late", s(1))).toThrow(/has started/);
    health.stop();
  });
});

describe("idempotency is declared per operation, never for a whole dependency", () => {
  const day = { value: 24, unit: "h" };
  const cache = () =>
    declared().dependency("cache", {
      system: "systems.component.redis",
      knobs: {},
      operations: {
        GET: { idempotent: true },
        // resent after a timeout, it counts twice
        INCR: { idempotent: false },
        // the server keeps an Idempotency-Key for a day
        "POST /v1/charges": { idempotent: { key: "Idempotency-Key", window: day } },
      },
    });

  it("lets one dependency take both kinds, and re-issues a keyed one only while its key is held", () => {
    const [, redis] = cache().describe().dependencies;
    const ops = redis!.operations;
    expect(mayReissue(ops["GET"]!, s(30))).toBe(true);
    expect(mayReissue(ops["INCR"]!, s(0))).toBe(false);
    expect(mayReissue(ops["POST /v1/charges"]!, { value: 23, unit: "h" })).toBe(true);
    // a re-issue after the window would be a second charge
    expect(mayReissue(ops["POST /v1/charges"]!, { value: 25, unit: "h" })).toBe(false);
  });

  it("refuses a key nobody names, or one held for a span that is not a time", () => {
    const keyed = (key: string, window: { value: number; unit: string }) =>
      declared()
        .dependency("payments", {
          system: null,
          knobs: {},
          operations: { "POST /v1/charges": { idempotent: { key, window } } },
        })
        .describe();
    expect(() => keyed(" ", day)).toThrow(/dependency payments's POST \/v1\/charges names no key/);
    expect(() => keyed("Idempotency-Key", { value: 3, unit: "count" })).toThrow(
      /holds its key for a span that is not a time/,
    );
  });

  it("declares each route a controller serves, for what a shutdown abort answers", () => {
    const svc = declared();
    const api = svc.controller("api").requires("db");
    api
      .route("GET /api/things", { idempotent: true })
      .route("POST /api/things", { idempotent: false });
    expect(svc.describe().controllers[0]!.routes).toEqual({
      "GET /api/things": { idempotent: true },
      "POST /api/things": { idempotent: false },
    });
    expect(() => api.route("GET /api/things", { idempotent: false })).toThrow(
      /api already serves GET \/api\/things/,
    );
  });
});

describe("the ordering law's evaluator", () => {
  const W8: Rule = {
    id: "O09",
    rule: "readiness detection plus propagation is no longer than liveness detection plus preStop",
    expr: {
      lhs: {
        terms: [
          { knob: "ready", coef: 1, at: "pod" },
          { knob: "propagation", coef: 1, at: "cluster" },
        ],
      },
      op: "<=",
      rhs: {
        terms: [
          { knob: "live", coef: 1, at: "pod" },
          { knob: "prestop", coef: 1, at: "pod" },
        ],
      },
      margin: 0,
    },
  };
  const verdict = (bind: Record<string, number | "inf">) => verdictOf(W8, bind, evaluate(W8, bind));
  it("holds, is violated, is unbounded only through an absent timer, or depends", () => {
    expect(
      verdict({ "ready@pod": 6, "propagation@cluster": 15, "live@pod": 30, "prestop@pod": 20 }),
    ).toBe("holds");
    expect(
      verdict({ "ready@pod": 30, "propagation@cluster": 1, "live@pod": 30, "prestop@pod": 0 }),
    ).toBe("violated");
    expect(
      verdict({ "ready@pod": 30, "propagation@cluster": 1, "live@pod": "inf", "prestop@pod": 0 }),
    ).toBe("unbounded");
    expect(verdict({ "ready@pod": 30 })).toBe("depends");
  });
});
