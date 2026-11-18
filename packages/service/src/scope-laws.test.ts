// The laws 1, 2, 4 and 5 of the scope, as a model test: random trees of scopes, aborts and steps of the clock
// against a plain model. The laws 3 and 6 and the law of the hop are in `scope.test.ts`.

import { runModel, step, type Step } from "@mark1russell7/rigor-testkit/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Cancel, Clock } from "@mark1russell7/algebra/clock";
import { type Principal, rootScope, SCOPE_RANK, type Scope, ScopeError, type ScopeKind } from "./scope.ts";

/** A clock whose timers start inside `tick`, in sequence. Each step of a model test is synchronous. */
interface StepClock extends Clock {
  tick(ms: number): void;
  readonly live: number;
}

const stepClock = (): StepClock => {
  let now = 0;
  let order = 0;
  const timers: Array<{ at: number; order: number; run: () => void; live: boolean }> = [];
  return {
    now: () => now,
    after(ms, run): Cancel {
      const timer = { at: now + Math.max(0, ms), order: order++, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    tick(ms) {
      const end = now + ms;
      for (;;) {
        let next: (typeof timers)[number] | undefined;
        for (const timer of timers) if (timer.live && timer.at <= end && (next === undefined || timer.at < next.at || (timer.at === next.at && timer.order < next.order))) next = timer;
        if (next === undefined) break;
        next.live = false;
        now = Math.max(now, next.at);
        next.run();
      }
      now = end;
    },
    get live() {
      return timers.filter((timer) => timer.live).length;
    },
  };
};

type Reason = { readonly explicit: object } | { readonly timeout: true } | undefined;

interface ModelNode {
  readonly parent: number;
  readonly kind: ScopeKind;
  readonly deadline: number;
  readonly trace: unknown;
  readonly identity: Principal | undefined;
  /** This flag is true for a node that started live: its parent keeps it. */
  readonly live: boolean;
  /** This flag is true for a node with a timer of its own. */
  readonly timer: boolean;
  reason: Reason;
}

interface Model {
  now: number;
  readonly nodes: ModelNode[];
}

interface Sut {
  readonly clock: StepClock;
  readonly nodes: Scope[];
}

const ROOT_TRACE = { trace: "root" };
const ROOT_IDENTITY: Principal = { id: "service", via: "token" };
const TRACES = [undefined, { trace: "a" }, { trace: "b" }] as const;
const IDENTITIES: ReadonlyArray<Principal | undefined> = [undefined, { id: "ada", via: "token" }, { id: "bo", via: "oidc", claims: { role: "reader" } }];
const KINDS: readonly ScopeKind[] = ["process", "service", "phase", "request", "job", "round", "call"];

const rankOk = (parent: ScopeKind, child: ScopeKind): boolean => SCOPE_RANK[child] > SCOPE_RANK[parent] || (child === "call" && parent === "call");

/** This function adds a node to the model, after the start of its scope. */
const added = (model: Model, sut: Sut, parent: number, scope: Scope, own: number, trace: unknown, identity: Principal | undefined): void => {
  const above = model.nodes[parent]!;
  const deadline = Math.min(above.deadline, own);
  let reason: Reason;
  if (above.reason !== undefined) {
    reason = above.reason;
    // a child of an aborted parent gets the reason of the parent itself
    expect(scope.signal.reason).toBe(sut.nodes[parent]!.signal.reason);
  } else if (deadline <= model.now) reason = { timeout: true };
  const live = above.reason === undefined;
  const timer = live && Number.isFinite(deadline) && deadline < above.deadline && deadline > model.now;
  model.nodes.push({ parent, kind: scope.kind, deadline, trace, identity, live, timer, reason });
  sut.nodes.push(scope);
};

const childStep = fc
  .record({ at: fc.nat(), kind: fc.constantFrom(...KINDS), timeout: fc.option(fc.nat({ max: 40 }), { nil: undefined }) })
  .map(({ at, kind, timeout }): Step<Sut, Model> =>
    step(`child of ${at} ${kind} timeout ${String(timeout)}`, (sut, model) => {
      const parent = at % sut.nodes.length;
      const above = sut.nodes[parent]!;
      if (!rankOk(above.kind, kind)) return void expect(() => above.child(kind, "c", { timeout })).toThrow(ScopeError);
      const own = timeout === undefined ? Infinity : model.now + timeout;
      added(model, sut, parent, above.child(kind, "c", { timeout }), own, model.nodes[parent]!.trace, model.nodes[parent]!.identity);
    }),
  );

const entryStep = fc
  .record({
    at: fc.nat(),
    kind: fc.constantFrom("request", "job", "round" as const),
    timeout: fc.option(fc.nat({ max: 40 }), { nil: undefined }),
    header: fc.option(fc.nat({ max: 40 }), { nil: undefined }),
    trace: fc.nat({ max: TRACES.length - 1 }),
    identity: fc.nat({ max: IDENTITIES.length - 1 }),
  })
  .map(({ at, kind, timeout, header, trace, identity }): Step<Sut, Model> =>
    step(`entry of ${at} ${kind} timeout ${String(timeout)} header ${String(header)} trace ${trace} identity ${identity}`, (sut, model) => {
      const parent = at % sut.nodes.length;
      const above = sut.nodes[parent]!;
      const options = { timeout, trace: TRACES[trace], identity: IDENTITIES[identity], headers: header === undefined ? {} : { "timeout-ms": String(header) } };
      if (!rankOk(above.kind, kind)) return void expect(() => above.entry(kind, "e", options)).toThrow(ScopeError);
      const own = Math.min(timeout === undefined ? Infinity : model.now + timeout, header === undefined ? Infinity : model.now + header);
      added(model, sut, parent, above.entry(kind, "e", options), own, TRACES[trace], IDENTITIES[identity]);
    }),
  );

const abortStep = fc.nat().map(
  (at): Step<Sut, Model> =>
    step(`abort ${at}`, (sut, model) => {
      const target = at % sut.nodes.length;
      const reason = { abort: target };
      sut.nodes[target]!.abort(reason);
      // the subtree of the target, and no other node
      const inside = new Set([target]);
      model.nodes.forEach((node, index) => {
        if (inside.has(node.parent)) inside.add(index);
      });
      for (const index of inside) model.nodes[index]!.reason ??= { explicit: reason };
    }),
);

const tickStep = fc.nat({ max: 25 }).map(
  (ms): Step<Sut, Model> =>
    step(`tick ${ms}`, (sut, model) => {
      sut.clock.tick(ms);
      model.now += ms;
      for (const node of model.nodes) if (node.reason === undefined && node.deadline <= model.now) node.reason = { timeout: true };
    }),
);

const check = (sut: Sut, model: Model): void => {
  model.nodes.forEach((node, index) => {
    const scope = sut.nodes[index]!;
    const where = `node ${index}`;
    // law 1 and law 2: the signal aborts with the model, with the reason of the abort or a TimeoutError
    expect(scope.signal.aborted, where).toBe(node.reason !== undefined);
    if (node.reason !== undefined && "explicit" in node.reason) expect(scope.signal.reason, where).toBe(node.reason.explicit);
    if (node.reason !== undefined && "timeout" in node.reason) {
      expect(scope.signal.reason, where).toBeInstanceOf(DOMException);
      expect((scope.signal.reason as DOMException).name, where).toBe("TimeoutError");
    }
    // law 2: the deadline of a child is not later than the deadline of its parent
    expect(scope.deadline, where).toBe(node.deadline);
    if (node.parent >= 0) expect(scope.deadline, where).toBeLessThanOrEqual(sut.nodes[node.parent]!.deadline);
    // law 4: the clock, the trace and the identity of the parent, except at an entry
    expect(scope.clock, where).toBe(sut.clock);
    expect(scope.trace, where).toBe(node.trace);
    expect(scope.identity, where).toBe(node.identity);
    // law 5: a parent keeps only its live children
    expect(scope.children().length, where).toBe(model.nodes.filter((other) => other.parent === index && other.live).length);
  });
  // law 5: a timer for each live scope whose deadline is earlier than the deadline of its parent, and no other timer
  expect(sut.clock.live).toBe(model.nodes.filter((node) => node.timer && node.reason === undefined).length);
};

describe("the laws of the scope, as a model test", () => {
  it("an abort reaches its subtree only, a deadline aborts with a TimeoutError, and a child keeps the trace and the identity of its parent", () => {
    runModel<Sut, Model>({
      create: () => {
        const clock = stepClock();
        const root = rootScope({ name: "root", clock, trace: ROOT_TRACE, identity: ROOT_IDENTITY });
        return {
          sut: { clock, nodes: [root] },
          model: { now: 0, nodes: [{ parent: -1, kind: "process", deadline: Infinity, trace: ROOT_TRACE, identity: ROOT_IDENTITY, live: true, timer: false, reason: undefined }] },
        };
      },
      steps: fc.oneof({ arbitrary: childStep, weight: 4 }, { arbitrary: entryStep, weight: 3 }, { arbitrary: abortStep, weight: 1 }, { arbitrary: tickStep, weight: 2 }),
      check,
      maxSteps: 60,
    });
  });
});
