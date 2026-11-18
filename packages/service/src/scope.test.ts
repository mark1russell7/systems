import { getEventListeners } from "node:events";
import { fakeClock } from "@mark1russell7/algebra/clock";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  bind,
  DEADLINE,
  readTimeout,
  rootScope,
  type Scope,
  ScopeCloseError,
  ScopeError,
  type ScopeKey,
  scopeKey,
  TIMEOUT_HEADER,
  timeoutHeaders,
} from "./scope.ts";

const service = (clock = fakeClock()) => rootScope({ name: "svc", kind: "service", clock, identity: { id: "svc", via: "token" }, trace: "root" });

describe("the nest of the scopes", () => {
  it("refuses a child of a lower or equal rank, except a call in a call", () => {
    const root = service();
    const request = root.child("request", "r");
    expect(() => request.child("job", "j")).toThrow(ScopeError);
    expect(() => request.child("phase", "p")).toThrow(/cannot be a child/);
    expect(() => root.child("service", "s")).toThrow(ScopeError);
    const call = request.child("call", "c");
    expect(call.child("call", "nested").kind).toBe("call");
    expect(() => call.entry("request", "e", { trace: undefined, identity: undefined })).toThrow(ScopeError);
  });

  it("gives a child the trace and the identity of its parent, and an entry only its own", () => {
    const root = service();
    const child = root.child("phase", "start");
    expect(child.identity).toBe(root.identity);
    expect(child.trace).toBe("root");
    const entry = root.entry("request", "GET /", { trace: "incoming", identity: undefined });
    // a request without authentication does not keep the identity of the service
    expect(entry.identity).toBeUndefined();
    expect(entry.trace).toBe("incoming");
    expect(entry.child("call", "c").trace).toBe("incoming");
  });

  it("takes the earliest deadline of the timeout, the header, the bound deadline and the parent", () => {
    const clock = fakeClock(100);
    const root = rootScope({ name: "p", clock, timeout: 1000 });
    expect(root.deadline).toBe(1100);
    expect(root.get(DEADLINE)).toBe(1100);
    expect(root.child("service", "s", { timeout: 5000 }).deadline).toBe(1100);
    expect(root.child("service", "s", { timeout: 50 }).deadline).toBe(150);
    expect(root.child("service", "s", { bind: [bind(DEADLINE, 120)] }).deadline).toBe(120);
    expect(root.entry("request", "r", { trace: undefined, identity: undefined, headers: { [TIMEOUT_HEADER]: "30" }, timeout: 40 }).deadline).toBe(130);
    expect(rootScope({ name: "p", clock }).remaining()).toBe(Infinity);
  });

  it("aborts at the deadline with a TimeoutError, and at an abort with the reason of the abort", async () => {
    const clock = fakeClock();
    const root = service(clock);
    const request = root.child("request", "r", { timeout: 100 });
    const call = request.child("call", "c");
    await clock.advance(99);
    expect(call.signal.aborted).toBe(false);
    await clock.advance(1);
    expect(call.signal.reason).toBeInstanceOf(DOMException);
    expect((call.signal.reason as DOMException).name).toBe("TimeoutError");
    expect(root.signal.aborted).toBe(false);
    const other = root.child("request", "r2");
    other.abort();
    expect((other.signal.reason as DOMException).name).toBe("AbortError");
    const cause = new Error("cancel");
    root.abort(cause);
    expect(root.children().every((child) => child.signal.reason === cause || child.signal.aborted)).toBe(true);
    // a child of an aborted scope starts aborted, with the reason of its parent
    expect(root.child("request", "late").signal.reason).toBe(cause);
  });

  it("binds a key without a meet again in a child, and narrows a key with a meet", () => {
    const client = scopeKey<string>("client");
    const clearance = scopeKey<number>("clearance", (a, b) => Math.min(a, b));
    const root = rootScope({ name: "p", clock: fakeClock(), bind: [bind(client, "root client"), bind(clearance, 3)] });
    const child = root.child("service", "s", { bind: [bind(client, "service client"), bind(clearance, 5)] });
    expect(child.get(client)).toBe("service client");
    expect(child.get(clearance)).toBe(3);
    expect(child.child("phase", "p").get(client)).toBe("service client");
    expect(root.get(scopeKey("other"))).toBeUndefined();
  });
});

describe("the header timeout-ms", () => {
  it("reads a whole number of milliseconds, and nothing else", () => {
    expect(readTimeout({ "timeout-ms": "250" })).toBe(250);
    expect(readTimeout({ "timeout-ms": [" 7 ", "9"] })).toBe(7);
    for (const bad of ["-1", "1.5", "1e3", "", "abc", "1234567890123456"]) expect(readTimeout({ "timeout-ms": bad }), bad).toBeUndefined();
    expect(readTimeout(undefined)).toBeUndefined();
    expect(readTimeout({})).toBeUndefined();
  });

  it("writes the remaining time rounded down, and no header without a deadline", () => {
    const clock = fakeClock(10);
    expect(timeoutHeaders(rootScope({ name: "p", clock }))).toEqual({});
    expect(timeoutHeaders(rootScope({ name: "p", clock, timeout: 99.9 }))).toEqual({ "timeout-ms": "99" });
  });

  it("law 2 across a hop: the deadline does not become later, for each skew of the two clocks", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e9, max: 1e9 }), fc.integer({ min: -1e9, max: 1e9 }), fc.double({ min: 0, max: 1e7, noNaN: true }), fc.nat({ max: 1e6 }), (sent, received, left, transit) => {
        const sender = rootScope({ name: "out", clock: fakeClock(sent), timeout: left });
        const headers = timeoutHeaders(sender);
        const receiver = rootScope({ name: "in", kind: "service", clock: fakeClock(received + transit) });
        const entry = receiver.entry("request", "r", { trace: undefined, identity: undefined, headers });
        expect(entry.remaining()).toBeLessThanOrEqual(sender.remaining());
        expect(entry.deadline).toBeLessThanOrEqual(receiver.clock.now() + sender.remaining());
      }),
    );
  });
});

describe("law 3: each resource closes once, in the reverse order of its open, also after a throw", () => {
  type Leaf = { readonly kind: "defer"; readonly fails: boolean; readonly late: boolean } | { readonly kind: "use"; readonly openFails: boolean; readonly fails: boolean };
  type Op = Leaf | { readonly kind: "child"; readonly ops: readonly Leaf[] };
  const leaf: fc.Arbitrary<Leaf> = fc.oneof(
    fc.record({ kind: fc.constant("defer" as const), fails: fc.boolean(), late: fc.boolean() }),
    fc.record({ kind: fc.constant("use" as const), openFails: fc.boolean(), fails: fc.boolean() }),
  );
  const op: fc.Arbitrary<Op> = fc.oneof({ arbitrary: leaf, weight: 3 }, { arbitrary: fc.record({ kind: fc.constant("child" as const), ops: fc.array(leaf, { maxLength: 4 }) }), weight: 1 });

  it("closes the children first, the last first, then the resources of the scope, and gives each error", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 8 }), async (ops) => {
        const log: string[] = [];
        const expected: string[] = [];
        const errors: Error[] = [];
        const root = rootScope({ name: "p", kind: "service", clock: fakeClock() });
        // the expected order of each scope, and the errors in the same order
        const open = async (scope: Scope, leaves: readonly Leaf[], prefix: string): Promise<Array<{ label: string; fails: boolean }>> => {
          const closes: Array<{ label: string; fails: boolean }> = [];
          for (const [index, item] of leaves.entries()) {
            const label = `${prefix}${index}`;
            const close = async () => {
              if (item.kind === "defer" && item.late) await Promise.resolve();
              log.push(label);
              if (item.fails) throw new Error(label);
            };
            if (item.kind === "defer") scope.defer(close);
            else {
              const opened = scope.use(() => (item.openFails ? Promise.reject(new Error(`open ${label}`)) : label), close);
              if (item.openFails) {
                await expect(opened).rejects.toThrow(`open ${label}`);
                continue;
              }
              await opened;
            }
            closes.push({ label, fails: item.fails });
          }
          return closes.reverse();
        };
        const own: Leaf[] = [];
        const children: Array<Array<{ label: string; fails: boolean }>> = [];
        for (const [index, item] of ops.entries()) {
          if (item.kind === "child") children.push(await open(root.child("request", `c${index}`), item.ops, `c${index}.`));
          else own.push(item);
        }
        const mine = await open(root, own, "r.");
        for (const closes of [...children.reverse(), mine])
          for (const { label, fails } of closes) {
            expected.push(label);
            if (fails) errors.push(new Error(label));
          }
        const closed = root.close();
        expect(root.close()).toBe(closed);
        if (errors.length === 0) await expect(closed).resolves.toBeUndefined();
        else {
          const error = await closed.then(
            () => undefined,
            (thrown: unknown) => thrown,
          );
          expect(error).toBeInstanceOf(ScopeCloseError);
          expect((error as ScopeCloseError).errors.map((each: Error) => each.message)).toEqual(errors.map((each) => each.message));
        }
        expect(log).toEqual(expected);
        expect(() => root.defer(() => undefined)).toThrow(ScopeError);
        expect(root.signal.aborted).toBe(true);
        expect(root.children()).toEqual([]);
      }),
      { numRuns: 150 },
    );
  });

  it("closes a resource at once when the scope closes during its open", async () => {
    const root = rootScope({ name: "p", clock: fakeClock() });
    const closed: string[] = [];
    let opened!: () => void;
    const gate = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const using = root.use(
      async () => {
        await gate;
        return "db";
      },
      (value) => void closed.push(value),
    );
    await root.close();
    opened();
    await expect(using).rejects.toThrow(ScopeError);
    expect(closed).toEqual(["db"]);
  });
});

describe("law 5: a closed child keeps no listener on its parent and no timer", () => {
  it("keeps the parent bounded after 100,000 requests", async () => {
    const clock = fakeClock();
    const root = service(clock);
    for (let index = 0; index < 100_000; index += 1) {
      const request = root.child("request", "r", { timeout: 1000 });
      request.child("call", "c", { timeout: 10 }).defer(() => undefined);
      await request.close();
    }
    expect(root.children()).toEqual([]);
    expect(clock.pending).toBe(0);
    expect(getEventListeners(root.signal, "abort")).toEqual([]);
  });
});

describe("law 6: the meet of each key is idempotent, commutative and associative, and a child is not wider than its parent", () => {
  /** Each key with a meet, its values and its equality. */
  const keys: Array<{ key: ScopeKey<unknown>; values: fc.Arbitrary<unknown>; same: (a: unknown, b: unknown) => boolean }> = [
    { key: DEADLINE as ScopeKey<unknown>, values: fc.oneof(fc.double({ min: -1e12, max: 1e12, noNaN: true }), fc.constant(Infinity)), same: (a, b) => Object.is(a, b) },
    {
      // a set of rights, as a sorted list: the meet is the intersection
      key: scopeKey<readonly string[]>("rights", (a, b) => a.filter((right) => b.includes(right))) as ScopeKey<unknown>,
      values: fc.uniqueArray(fc.constantFrom("read", "write", "admin", "net"), { maxLength: 4 }).map((rights) => [...rights].sort()),
      same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    },
  ];

  for (const { key, values, same } of keys)
    it(`holds for the key ${key.name}`, () => {
      const meet = key.meet!;
      fc.assert(
        fc.property(values, values, values, (a, b, c) => {
          expect(same(meet(a, a), a)).toBe(true);
          expect(same(meet(a, b), meet(b, a))).toBe(true);
          expect(same(meet(meet(a, b), c), meet(a, meet(b, c)))).toBe(true);
          // down the nest, in two orders of the binds
          const value = (first: unknown, second: unknown, third: unknown) => {
            const root = rootScope({ name: "p", clock: fakeClock(), bind: [bind(key, first)] });
            const child = root.child("service", "s", { bind: [bind(key, second)] });
            const grandchild = child.child("phase", "q", { bind: [bind(key, third)] });
            expect(same(meet(child.get(key), root.get(key)), child.get(key))).toBe(true);
            expect(same(meet(grandchild.get(key), child.get(key)), grandchild.get(key))).toBe(true);
            return grandchild.get(key);
          };
          expect(same(value(a, b, c), value(c, a, b))).toBe(true);
        }),
      );
    });
});
