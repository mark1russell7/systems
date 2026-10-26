import { describe, expect, it } from "vitest";
import type { Check, Rule, StopWay, TimerMarks } from "./index.ts";
import {
  PLATFORM_MARKS,
  STOP_RULE,
  STOPS,
  lintStop,
  asDebounce,
  asWindow,
  compress,
  compression,
  compressionOf,
  evaluate,
  failSpan,
  lint,
  mayReissue,
  recoverSpan,
  service,
  serviceBindings,
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
    .onRepeatSignal("ignore")
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
      /bare does not declare readiness .*liveness .*a startup budget .*shutdown phases .*cooperative window.*what a repeat signal does, "ignore" or "exit" \(svc.onRepeatSignal\)/,
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
      .onRepeatSignal("ignore")
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

  it("is unbounded, not violated, when absent timers leave the two sides no order", () => {
    const side = (knob: string, at: string, coef = 1) => ({ knob, coef, at });
    const O01: Rule = {
      id: "O01",
      rule: "a client pool's idle expiry is shorter than the server's idle close",
      expr: { lhs: { terms: [side("expiry", "client")] }, op: "<", rhs: { terms: [side("close", "server")] } },
    };
    const O16: Rule = {
      id: "O16",
      rule: "the drain ends before the grace that the preStop sleep leaves",
      expr: { lhs: { terms: [side("drain", "process")] }, op: "<", rhs: { terms: [side("grace", "pod"), side("prestop", "pod", -1)] } },
    };
    const of = (rule: Rule, bind: Record<string, number | "inf" | "off">) => verdictOf(rule, bind, evaluate(rule, bind));
    // no idle timer on either side: inf < inf, as inf <= inf already did
    expect(of(O01, { "expiry@client": "inf", "close@server": "inf" })).toBe("unbounded");
    expect(of({ ...O01, expr: { ...O01.expr, op: "<=" } }, { "expiry@client": "inf", "close@server": "off" })).toBe("unbounded");
    // both signs of infinity on one side give it no value
    expect(of(O16, { "drain@process": 10, "grace@pod": "inf", "prestop@pod": "inf" })).toBe("unbounded");
    // a number against an infinity still has an order
    expect(of(O16, { "drain@process": 10, "grace@pod": 30, "prestop@pod": "inf" })).toBe("violated");
    expect(of(O01, { "expiry@client": "inf", "close@server": 60 })).toBe("violated");
    // a binding that is not a number is not an absent timer
    expect(of(O01, { "expiry@client": Number.NaN, "close@server": 60 })).toBe("violated");
  });

  // O04 with the service's own hold: the preStop sleep and the hold of "fail readiness" both keep the
  // listener open while the endpoints update
  const O04: Rule = {
    id: "O04",
    rule: "the preStop sleep plus the hold of fail readiness is at least the endpoint propagation",
    expr: {
      lhs: {
        terms: [
          { knob: "prestop_sleep", coef: 1, at: "pod" },
          { knob: "readiness_hold", coef: 1, at: "process" },
        ],
      },
      op: ">=",
      rhs: { terms: [{ knob: "propagation_bound", coef: 1, at: "cluster" }] },
    },
  };
  const drained = (hold: number | null) => {
    const svc = service("svc")
      .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
      .liveness({ type: "window", failAfter: s(45) })
      .startup(s(60))
      .onRepeatSignal("ignore")
      .cooperativeWindow(s(1));
    if (hold !== null) svc.phase("fail readiness", s(hold));
    return svc.phase("stop the poller", s(1)).describe();
  };
  const platform = (prestop: number) => ({
    platform: { "prestop_sleep@pod": s(prestop), "propagation_bound@cluster": s(1) },
    probes: { readiness: s(30), liveness: s(30) },
  });
  it("binds the hold of fail readiness for O04, and a service without that phase holds for zero", () => {
    expect(serviceBindings(drained(2), platform(0)).bind["readiness_hold@process"]).toBe(2);
    expect(serviceBindings(drained(null), platform(0)).bind["readiness_hold@process"]).toBe(0);
    expect(lint(drained(2), platform(0), [O04])[0]?.verdict).toBe("holds");
    expect(lint(drained(0), platform(0), [O04])[0]?.verdict).toBe("violated");
    expect(lint(drained(0), platform(1), [O04])[0]?.verdict).toBe("holds");
  });

  describe("the marks of the timers, for a compression (E10)", () => {
    const marks: TimerMarks = {
      ready: { kind: "scalable" },
      "live@pod": { kind: "scalable" },
      "prestop@pod": { kind: "stepped", step: 1 },
      "propagation@cluster": { kind: "fixed" },
      rto: { kind: "floored", floor: 0.2, by: "the kernel" },
    };
    it("scales each timer by its mark, and keeps absent timers, chains, margins and unmarked symbols apart", () => {
      const { bind, unmarked } = compress(
        { "ready@pod": 6, "live@pod": "inf", "prestop@pod": 2, "propagation@cluster": 15, "rto@client": [1, 0.5], "idle@server": 60, margin: 1 },
        0.1,
        marks,
      );
      expect(bind["ready@pod"]).toBeCloseTo(0.6);
      expect(bind["live@pod"]).toBe("inf");
      // a stepped timer rounds up to its step: 0.2 s becomes 1 s
      expect(bind["prestop@pod"]).toBe(1);
      expect(bind["propagation@cluster"]).toBe(15);
      expect(bind["rto@client"]).toEqual([0.2, 0.2]);
      expect(bind["idle@server"]).toBe(60);
      expect(bind.margin).toBe(1);
      expect(unmarked).toEqual(["idle@server"]);
      expect(compress({ "prestop@pod": 0.3 }, 10, marks).bind["prestop@pod"]).toBe(3);
      expect(() => compress({}, 0, marks)).toThrow(RangeError);
      expect(() => compress({}, Infinity, marks)).toThrow(RangeError);
    });

    it("keeps each ordering when each timer scales, and names the rule whose verdict a fixed timer changes", () => {
      const bind = { "ready@pod": 6, "propagation@cluster": 15, "live@pod": 30, "prestop@pod": 20 };
      const all: TimerMarks = { ready: { kind: "scalable" }, live: { kind: "scalable" }, prestop: { kind: "scalable" }, propagation: { kind: "scalable" } };
      expect(compression([W8], bind, 0.1, all)).toEqual({ changed: [], unmarked: [] });
      // the cluster does not get faster: 0.6 + 15 > 3 + 1
      expect(compression([W8], bind, 0.1, marks)).toEqual({ changed: [{ rule: "O09", before: "holds", after: "violated" }], unmarked: [] });
      expect(compression([W8], bind, 0.1, {}).unmarked).toEqual(["ready@pod", "propagation@cluster", "live@pod", "prestop@pod"]);
    });

    it("compresses each scope of a service with the marks of the platform", () => {
      const own: TimerMarks = { ...PLATFORM_MARKS, "readiness_hold@process": { kind: "scalable" } };
      expect(compressionOf(drained(2), platform(0), [O04], 1, own)).toEqual({ changed: [], unmarked: [] });
      // the hold scales to 0.2 s, but the propagation of the endpoints stays 1 s
      expect(compressionOf(drained(2), platform(0), [O04], 0.1, own)).toEqual({
        changed: [{ rule: "O04", scope: "svc", before: "holds", after: "violated" }],
        unmarked: [],
      });
      expect(compressionOf(drained(2), platform(0), [O04], 0.1, PLATFORM_MARKS)).toEqual({ changed: [], unmarked: ["readiness_hold@process"] });
    });
  });

  describe("the four ways that a pod stops (B11)", () => {
    // a rule that is not a rule of the drain applies to each way
    const other: Rule = { ...O04, id: "O11" };
    const rulesOf = (way: StopWay) => lintStop(drained(0), platform(0), [O04, W8, other], way).map((finding) => [finding.rule, finding.verdict]);
    it("applies O04 to a deletion and O09 to a liveness restart, each with the other rules", () => {
      expect(rulesOf("deletion")).toEqual([["O04", "violated"], ["O11", "violated"]]);
      expect(rulesOf("liveness-restart")).toEqual([["O09", "depends"], ["O11", "violated"]]);
    });

    it("gives a crash and an OOM kill no rule of the drain, and a finding that depends on the time to find the exit", () => {
      for (const way of ["crash", "oom"] as const) {
        expect(rulesOf(way)).toEqual([["O11", "violated"], [STOP_RULE, "depends"]]);
        expect(STOPS[way]).toMatchObject({ preStop: false, drain: false, leaves: "exit" });
      }
      expect(lintStop(drained(0), platform(0), [], "oom").at(-1)?.unbound).toEqual(["exit_detection@pod"]);
      expect(STOPS.deletion.leaves).toBe("deletion");
      expect(STOPS["liveness-restart"].leaves).toBe("readiness");
    });
  });

  describe("the values of a scenario as claims for a version (E2)", () => {
    const probes = { readiness: s(30), liveness: s(30) };
    it("binds a claim, and each finding names the epoch of each value that its rule reads", () => {
      const scenario = { platform: { "prestop_sleep@pod": { epoch: "kubernetes@1.34", value: s(2) }, "propagation_bound@cluster": s(1) }, probes };
      const [finding] = lint(drained(0), scenario, [O04]);
      expect(finding?.verdict).toBe("holds");
      expect(finding?.epochs).toEqual({ "prestop_sleep@pod": "kubernetes@1.34", "propagation_bound@cluster": null });
      expect(serviceBindings(drained(0), scenario).from["prestop_sleep@pod"]).toBe("the scenario, for kubernetes@1.34");
      // a scenario of plain amounts names no epoch, and its findings stay as they were
      expect(lint(drained(2), platform(0), [O04])[0]).not.toHaveProperty("epochs");
    });

    it("binds the p99 of a distribution, and a distribution without a p99 binds nothing", () => {
      const measured = (distribution: Record<string, { value: number; unit: string }>) => ({
        platform: { "prestop_sleep@pod": s(2), "propagation_bound@cluster": { epoch: "kind@0.30", distribution } },
        probes,
      });
      // the p50 would hold: 2 s >= 0.3 s, but the p99 does not
      expect(lint(drained(0), measured({ p50: s(0.3), p99: s(3) }), [O04])[0]?.verdict).toBe("violated");
      const [unbound] = lint(drained(0), measured({ p50: s(0.3) }), [O04]);
      expect(unbound?.verdict).toBe("depends");
      expect(unbound?.unbound).toEqual(["propagation_bound@cluster"]);
      expect(unbound?.epochs).toEqual({ "prestop_sleep@pod": null, "propagation_bound@cluster": "kind@0.30" });
    });
  });
});
