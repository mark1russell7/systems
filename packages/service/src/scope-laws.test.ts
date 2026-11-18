// The laws 1, 2, 4 and 5 of the scope, as a model test: random trees of scopes, aborts and steps of the clock
// against a plain model. The law of the close runs on random trees too, with aborts, deadlines and closes during
// the close. The laws 3 and 6 and the law of the hop are in `scope.test.ts`.

import { fakeClock, type SyncFakeClock } from "@mark1russell7/algebra/clock";
import { runModel, step, type Step } from "@mark1russell7/rigor-testkit/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bind, DEADLINE, type Principal, rootScope, SCOPE_RANK, type Scope, ScopeError, type ScopeKind } from "./scope.ts";

type Reason = { readonly explicit: object } | { readonly timeout: true } | undefined;

interface ModelNode {
  readonly parent: number;
  readonly kind: ScopeKind;
  readonly deadline: number;
  readonly trace: unknown;
  readonly identity: Principal | undefined;
  /** This flag is true for a node with a timer of its own. */
  readonly timer: boolean;
  reason: Reason;
}

interface Model {
  now: number;
  readonly nodes: ModelNode[];
}

interface Sut {
  readonly clock: SyncFakeClock;
  readonly nodes: Scope[];
}

const ROOT_TRACE = { trace: "root" };
const ROOT_IDENTITY: Principal = { id: "service", via: "token" };
const TRACES = [undefined, { trace: "a" }, { trace: "b" }] as const;
const IDENTITIES: ReadonlyArray<Principal | undefined> = [undefined, { id: "ada", via: "token" }, { id: "bo", via: "oidc", claims: { role: "reader" } }];
const KINDS: readonly ScopeKind[] = ["process", "service", "phase", "request", "job", "round", "call"];

const rankOk = (parent: ScopeKind, child: ScopeKind): boolean => SCOPE_RANK[child] > SCOPE_RANK[parent] || (child === "call" && parent === "call");

/** This function adds a node to the model, after the start of its scope. The model has no close: a parent keeps each child. */
const added = (model: Model, sut: Sut, parent: number, scope: Scope, own: number, trace: unknown, identity: Principal | undefined): void => {
  const above = model.nodes[parent]!;
  const deadline = Math.min(above.deadline, own);
  let reason: Reason;
  if (above.reason !== undefined) {
    reason = above.reason;
    // a child of an aborted parent gets the reason of the parent itself
    expect(scope.signal.reason).toBe(sut.nodes[parent]!.signal.reason);
  } else if (deadline <= model.now) reason = { timeout: true };
  // a child of an aborted parent starts aborted, thus it needs no timer
  const timer = above.reason === undefined && Number.isFinite(deadline) && deadline < above.deadline && deadline > model.now;
  model.nodes.push({ parent, kind: scope.kind, deadline, trace, identity, timer, reason });
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

/** A `NaN` timeout or deadline throws a `RangeError`, and it changes no node: a `NaN` can erase each deadline below it. */
const nanStep = fc
  .record({ at: fc.nat(), how: fc.constantFrom("timeout", "deadline", "entry") })
  .map(({ at, how }): Step<Sut, Model> =>
    step(`NaN ${how} under ${at}`, (sut) => {
      const above = sut.nodes[at % sut.nodes.length]!;
      const before = above.children().length;
      if (how === "timeout") expect(() => above.child("call", "c", { timeout: Number.NaN })).toThrow(RangeError);
      else if (how === "deadline") expect(() => above.child("call", "c", { bind: [bind(DEADLINE, Number.NaN)] })).toThrow(RangeError);
      else if (rankOk(above.kind, "request")) expect(() => above.entry("request", "e", { trace: undefined, identity: undefined, timeout: Number.NaN })).toThrow(RangeError);
      expect(above.children().length).toBe(before);
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
    // law 5: a parent keeps each child until the close of the child, also an aborted child
    expect(scope.children().length, where).toBe(model.nodes.filter((other) => other.parent === index).length);
  });
  // law 5: a timer for each live scope whose deadline is earlier than the deadline of its parent, and no other timer
  expect(sut.clock.pending).toBe(model.nodes.filter((node) => node.timer && node.reason === undefined).length);
};

describe("the laws of the scope, as a model test", () => {
  it("an abort reaches its subtree only, a deadline aborts with a TimeoutError, and a child keeps the trace and the identity of its parent", () => {
    runModel<Sut, Model>({
      create: () => {
        const clock = fakeClock();
        const root = rootScope({ name: "root", clock, trace: ROOT_TRACE, identity: ROOT_IDENTITY });
        return {
          sut: { clock, nodes: [root] },
          model: { now: 0, nodes: [{ parent: -1, kind: "process", deadline: Infinity, trace: ROOT_TRACE, identity: ROOT_IDENTITY, timer: false, reason: undefined }] },
        };
      },
      steps: fc.oneof(
        { arbitrary: childStep, weight: 4 },
        { arbitrary: entryStep, weight: 3 },
        { arbitrary: abortStep, weight: 1 },
        { arbitrary: tickStep, weight: 2 },
        { arbitrary: nanStep, weight: 1 },
      ),
      check,
      maxSteps: 60,
    });
  });

  it("refuses a NaN timeout or deadline of a root", () => {
    expect(() => rootScope({ name: "root", clock: fakeClock(), timeout: Number.NaN })).toThrow(RangeError);
    expect(() => rootScope({ name: "root", clock: fakeClock(), bind: [bind(DEADLINE, Number.NaN)] })).toThrow(RangeError);
  });
});

/** The kind of a child under each kind: the next rank, and a call under a call. */
const NEXT: Readonly<Record<ScopeKind, ScopeKind>> = { process: "service", service: "phase", phase: "request", request: "call", job: "call", round: "call", call: "call" };

type Op =
  | { readonly op: "child"; readonly at: number; readonly timeout: number | undefined }
  | { readonly op: "defer"; readonly at: number; readonly throws: boolean }
  | { readonly op: "use"; readonly at: number }
  | { readonly op: "abort"; readonly at: number }
  | { readonly op: "tick"; readonly ms: number }
  | { readonly op: "close"; readonly at: number }
  | { readonly op: "reenter"; readonly at: number }
  | { readonly op: "turn" };

const opOf: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: fc.record({ op: fc.constant("child" as const), at: fc.nat(), timeout: fc.option(fc.nat({ max: 40 }), { nil: undefined }) }), weight: 5 },
  { arbitrary: fc.record({ op: fc.constant("defer" as const), at: fc.nat(), throws: fc.boolean() }), weight: 4 },
  { arbitrary: fc.record({ op: fc.constant("use" as const), at: fc.nat() }), weight: 1 },
  { arbitrary: fc.record({ op: fc.constant("abort" as const), at: fc.nat() }), weight: 2 },
  { arbitrary: fc.record({ op: fc.constant("tick" as const), ms: fc.nat({ max: 25 }) }), weight: 2 },
  { arbitrary: fc.record({ op: fc.constant("close" as const), at: fc.nat() }), weight: 1 },
  { arbitrary: fc.record({ op: fc.constant("reenter" as const), at: fc.nat() }), weight: 1 },
  { arbitrary: fc.constant({ op: "turn" as const }), weight: 1 },
);

/** This function lets the closes that wait on a promise go on, as the event loop does between two events. */
const turn = async (): Promise<void> => {
  for (let at = 0; at < 8; at += 1) await Promise.resolve();
};

describe("the law of the close, on random trees", () => {
  it("closes each scope and each resource once, the children first and each list the last first, and leaves no timer", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opOf, { maxLength: 40 }), async (ops) => {
        const clock = fakeClock();
        const root = rootScope({ name: "root", clock });
        const nodes: Scope[] = [root];
        const parents: number[] = [-1];
        /** The resources: the node of each, its count of closes, and true for a resource in the order of the list of its node. */
        const resources: Array<{ readonly node: number; readonly ordered: boolean; closes: number }> = [];
        const log: number[] = [];
        const thrown = new Set<unknown>();
        const reported: unknown[] = [];
        const pending: Array<Promise<void>> = [];
        const report = (error: unknown): void => void reported.push(...(error instanceof AggregateError ? error.errors : [error]));
        const late: Scope[] = [];

        const resource = (node: number, throws: boolean, ordered = true): (() => void) => {
          const id = resources.length;
          resources.push({ node, ordered, closes: 0 });
          return () => {
            resources[id]!.closes += 1;
            log.push(id);
            if (throws) {
              const error = new Error(`resource ${id}`);
              thrown.add(error);
              throw error;
            }
          };
        };

        for (const op of ops) {
          if (op.op === "tick") clock.tick(op.ms);
          else if (op.op === "turn") await turn();
          else {
            const at = op.at % nodes.length;
            const scope = nodes[at]!;
            if (op.op === "child") {
              const child = scope.child(NEXT[scope.kind], `c${nodes.length}`, { timeout: op.timeout });
              // law 1 of the close: a child of a closed or closing scope starts closed and aborted, and its parent does not keep it
              if (scope.closed) {
                expect(child.closed).toBe(true);
                expect(child.signal.aborted).toBe(true);
                expect(scope.children()).not.toContain(child);
              } else expect(scope.children()).toContain(child);
              nodes.push(child);
              parents.push(at);
            } else if (op.op === "defer") {
              if (scope.closed) expect(() => scope.defer(() => {})).toThrow(ScopeError);
              else scope.defer(resource(at, op.throws));
            } else if (op.op === "use") {
              // a scope that closes during the open closes the resource at once: that resource is outside the order of its list
              if (scope.closed) await expect(scope.use(() => "value", () => {})).rejects.toThrow(ScopeError);
              else await scope.use(() => "value", resource(at, false, false)).catch(() => undefined);
            } else if (op.op === "abort") scope.abort(new Error(`abort ${at}`));
            else if (op.op === "close") pending.push(scope.close().catch(report));
            else {
              // a listener of the signal closes the parent during its own close, and makes a child of the closing parent
              scope.signal.addEventListener("abort", () => {
                const parent = scope.parent;
                if (parent === null) return;
                const closed = parent.close();
                expect(parent.close()).toBe(closed);
                pending.push(closed.catch(report));
                const child = parent.child(NEXT[parent.kind], "late");
                expect(child.closed).toBe(true);
                late.push(child);
              });
            }
          }
        }

        await root.close().catch(report);
        await Promise.all(pending);

        // each scope closed and aborted, and no parent keeps a child
        for (const scope of [...nodes, ...late]) {
          expect(scope.closed).toBe(true);
          expect(scope.signal.aborted).toBe(true);
          expect(scope.children()).toEqual([]);
        }
        // each resource closed once, also under an aborted parent and under closes during the close
        for (const [id, entry] of resources.entries()) expect(entry.closes, `resource ${id}`).toBe(1);
        // each error of a close reached a caller of close()
        for (const error of thrown) expect(reported).toContain(error);
        // the order: in each node the last resource first, and each resource of a descendant before each resource of the node
        const place = new Map(log.map((id, index) => [id, index]));
        const inside = (node: number, above: number): boolean => {
          for (let at = parents[node]!; at >= 0; at = parents[at]!) if (at === above) return true;
          return false;
        };
        for (const [a, first] of resources.entries())
          for (const [b, second] of resources.entries()) {
            if (a >= b || !first.ordered || !second.ordered) continue;
            if (first.node === second.node) expect(place.get(b)!, `resources ${a} and ${b}`).toBeLessThan(place.get(a)!);
            if (inside(second.node, first.node)) expect(place.get(b)!, `resources ${a} and ${b}`).toBeLessThan(place.get(a)!);
            if (inside(first.node, second.node)) expect(place.get(a)!, `resources ${a} and ${b}`).toBeLessThan(place.get(b)!);
          }
        // no timer of a deadline stays after the close
        expect(clock.pending).toBe(0);
      }),
      { numRuns: 200 },
    );
  });

  it("closes the resources of a child of an aborted parent at the close of the parent", async () => {
    const root = rootScope({ name: "root", clock: fakeClock() });
    root.abort();
    const child = root.child("service", "late");
    const closed: string[] = [];
    child.defer(() => void closed.push("db"));
    expect(root.children()).toEqual([child]);
    await root.close();
    expect(closed).toEqual(["db"]);
    expect(child.closed).toBe(true);
  });

  it("gives one close to a close of the same scope from a listener of a child, and its resources close once", async () => {
    const root = rootScope({ name: "root", clock: fakeClock() });
    const child = root.child("service", "s");
    let closes = 0;
    root.defer(() => void (closes += 1));
    let again: Promise<void> | undefined;
    child.signal.addEventListener("abort", () => (again = root.close()));
    const first = root.close();
    expect(again).toBe(first);
    await first;
    expect(closes).toBe(1);
  });
});
