import { describe, expect, it } from "vitest";
import type { Lifecycle, RequestEvent, RouteRequest, Rule } from "./index.ts";
import { lint, service } from "./index.ts";
import type { Rig } from "./rig.ts";
import { CAPS, exited, rig, run } from "./rig.ts";
import { compilePattern } from "./routes.ts";

/**
 * SYS-6: each request is a stream, and a unary work is a stream of one item. SYS-5: a controller
 * matches a route pattern, and a function gives the operation, thus the idempotency, of each
 * request. Each test uses the fake clock of the rig.
 */

const s = (value: number) => ({ value, unit: "s" });
const wait = (r: Rig, ms: number): Promise<void> => new Promise((resolve) => r.clock.after(ms, resolve));
const drainSpan = (r: Rig) => {
  const moves = r.events.filter((event) => event.machine === "drain" && event.from !== event.to);
  const at = moves.findIndex((move) => move.to === "drain");
  return { from: moves[at]!.at, to: moves[at + 1]!.at };
};
const cooperativeAt = (r: Rig) => r.events.find((event) => event.on === "drain.cooperative-abort")?.at;

describe("each request is a stream (SYS-6)", () => {
  it("gives a unary value as a stream of one item, from a value, a promise or a throw", async () => {
    const r = rig();
    const life = await run(r);
    expect(await life.request("api", "GET /things", () => "now").collect()).toEqual({ items: ["now"], end: { kind: "done", delivered: 1 } });
    expect(await life.request("api", "GET /things", async () => "later").collect()).toEqual({
      items: ["later"],
      end: { kind: "done", delivered: 1 },
    });
    const error = new Error("no such thing");
    const thrown = await life
      .request("api", "GET /things", () => {
        throw error;
      })
      .collect();
    expect(thrown).toEqual({ items: [], end: { kind: "failed", error, delivered: 0 } });
    void life.shutdown();
    await exited(r, life);
  });

  it("gives each item of an async iterable, and keeps the request in flight until the iterator ends", async () => {
    const r = rig();
    const life = await run(r);
    let steps = 0;
    const stream = life.request("api", "GET /things", async function* () {
      for (const item of ["a", "b", "c"]) {
        steps += 1;
        yield item;
      }
    });
    // the work goes forward only when the reader asks for the next item
    const events = stream[Symbol.asyncIterator]();
    expect(steps).toBe(0);
    expect(life.inFlight("api")).toBe(1);
    expect((await events.next()).value).toEqual({ kind: "item", value: "a" });
    expect(steps).toBe(1);
    expect((await events.next()).value).toEqual({ kind: "item", value: "b" });
    expect((await events.next()).value).toEqual({ kind: "item", value: "c" });
    expect(life.inFlight("api")).toBe(1);
    expect((await events.next()).value).toEqual({ kind: "done", delivered: 3 });
    expect(life.inFlight("api")).toBe(0);
    expect(await events.next()).toEqual({ value: undefined, done: true });
    void life.shutdown();
    await exited(r, life);
  });

  it("takes a stream that a promise gives, and reads it with for await", async () => {
    const r = rig();
    const life = await run(r);
    const seen: RequestEvent<number>[] = [];
    for await (const event of life.request("api", "GET /things", async () => {
      await Promise.resolve();
      return (async function* () {
        yield 1;
        yield 2;
      })();
    }))
      seen.push(event);
    expect(seen).toEqual([
      { kind: "item", value: 1 },
      { kind: "item", value: 2 },
      { kind: "done", delivered: 2 },
    ]);
    void life.shutdown();
    await exited(r, life);
  });

  it("ends a failure after the first item in-band, with the count of the items", async () => {
    const r = rig();
    const life = await run(r);
    const error = new Error("the cursor closed");
    const late = await life
      .request("api", "GET /things", async function* () {
        yield "a";
        yield "b";
        throw error;
      })
      .collect();
    expect(late).toEqual({ items: ["a", "b"], end: { kind: "failed", error, delivered: 2 } });
    const early = await life
      .request("api", "GET /things", async function* () {
        throw error;
      })
      .collect();
    expect(early).toEqual({ items: [], end: { kind: "failed", error, delivered: 0 } });
    void life.shutdown();
    await exited(r, life);
  });

  it("makes the drain wait for an open stream until it ends", async () => {
    const r = rig();
    const life = await run(r);
    const stream = life
      .request("api", "GET /things", async function* () {
        for (let at = 0; at < 3; at += 1) {
          await wait(r, 500);
          yield at;
        }
      })
      .collect();
    void life.shutdown();
    expect(await exited(r, life)).toBe(0);
    expect(await stream).toEqual({ items: [0, 1, 2], end: { kind: "done", delivered: 3 } });
    // the readiness hold (1 s) and the stop of the intake come first: the stream ends 0.5 s into the drain
    const span = drainSpan(r);
    expect(span.to - span.from).toBe(500);
    expect(cooperativeAt(r)).toBeUndefined();
  });

  it("ends a stream at the cooperative abort through return(), in-band after its first item", async () => {
    const r = rig({ window: s(1) });
    const life = await run(r);
    let finished: number | null = null;
    const stream = life
      .request("api", "GET /things", async function* () {
        try {
          for (let at = 0; ; at += 1) {
            await wait(r, 400);
            yield at;
          }
        } finally {
          finished = r.clock.now();
        }
      })
      .collect();
    void life.shutdown();
    expect(await exited(r, life)).toBe(0);
    const outcome = await stream;
    const abort = cooperativeAt(r)!;
    expect(abort - drainSpan(r).from).toBe((CAPS.drain - 1) * 1000);
    // return() runs after the pending step: the generator ends at its next yield, and the drain ends with it
    expect(finished).toBe(drainSpan(r).to);
    expect(finished! - abort).toBeLessThanOrEqual(400);
    expect(outcome.end).toMatchObject({ kind: "cut", status: null, retryable: true, delivered: outcome.items.length });
    expect(outcome.items.length).toBeGreaterThan(0);
  });

  it("cuts a stream that ignores the abort at the deadline of the drain, in-band after its first item", async () => {
    const r = rig();
    const life = await run(r);
    const stuck = (route: string) =>
      life
        .request("api", route, async function* () {
          yield "first";
          await new Promise<never>(() => {});
        })
        .collect();
    const get = stuck("GET /things");
    const post = stuck("POST /things");
    void life.shutdown();
    expect(await exited(r, life)).toBe(0);
    const span = drainSpan(r);
    expect(span.to - span.from).toBe(CAPS.drain * 1000);
    expect(await get).toEqual({
      items: ["first"],
      end: { kind: "cut", status: null, retryable: true, cause: "the drain reached its deadline", delivered: 1 },
    });
    expect((await post).end).toMatchObject({ kind: "cut", status: null, retryable: false, delivered: 1 });
  });

  it("cuts a stream before its first item with a status, by the idempotency of the route", async () => {
    const r = rig();
    const life = await run(r);
    const never = (route: string) =>
      life
        .request("api", route, async function* () {
          await new Promise<never>(() => {});
          yield "none";
        })
        .collect();
    const get = never("GET /things");
    const post = never("POST /things");
    void life.shutdown();
    await exited(r, life);
    expect((await get).end).toMatchObject({ kind: "cut", status: 503, retryable: true, delivered: 0 });
    expect((await post).end).toMatchObject({ kind: "cut", status: 500, retryable: false, delivered: 0 });
  });

  it("stops the work when the reader stops before the end: its signal aborts and its iterator returns", async () => {
    const r = rig();
    const life = await run(r);
    let signal: AbortSignal | null = null;
    let closed = false;
    const stream = life.request("api", "GET /things", async function* (given) {
      signal = given;
      try {
        for (let at = 0; ; at += 1) yield at;
      } finally {
        closed = true;
      }
    });
    const read: number[] = [];
    for await (const event of stream) {
      if (event.kind === "item") read.push(event.value);
      if (read.length === 2) break;
    }
    await r.clock.advance(0);
    expect(read).toEqual([0, 1]);
    expect(signal!.aborted).toBe(true);
    expect(closed).toBe(true);
    expect(life.inFlight()).toBe(0);
    void life.shutdown();
    await exited(r, life);
  });

  it("gives a refused request as a stream of its end only, and the work does not start", async () => {
    const r = rig();
    const life = await run(r);
    void life.shutdown();
    await r.clock.advance(1500);
    let started = false;
    const refused = await life
      .request("api", "GET /things", async function* () {
        started = true;
        yield 1;
      })
      .collect();
    expect(refused).toEqual({
      items: [],
      end: { kind: "refused", status: 503, retryable: true, cause: "the service stopped its intake", delivered: 0 },
    });
    expect(started).toBe(false);
    await exited(r, life);
  });
});

describe("dynamic routes: a pattern, and the idempotency of each request from a function (SYS-5)", () => {
  /** This function adds the controller of a registry of procedures that changes while the service runs. */
  const procedures = (r: Rig, seen: RouteRequest[] = []) =>
    r.svc
      .controller("procedures")
      .requires("db")
      .route("POST /rpc/host.info", { idempotent: true })
      .pattern(
        "POST /rpc/:procedure",
        {
          read: { idempotent: true },
          write: { idempotent: false },
          keyed: { idempotent: { key: "Idempotency-Key", window: s(60) } },
        },
        (request) => {
          seen.push(request);
          const effects = (request.detail as { effects?: string } | undefined)?.effects;
          return effects === "none" ? "read" : effects === "keyed" ? "keyed" : "write";
        },
      )
      .pattern("*", { other: { idempotent: false } });

  it("tracks requests on routes that nobody declared before the start", async () => {
    const r = rig();
    const seen: RouteRequest[] = [];
    procedures(r, seen);
    const life = await run(r);
    // a procedure that joins the registry after the start
    const pending = life.request("procedures", "POST /rpc/git.status", () => new Promise<string>(() => {}), { detail: { effects: "none" } });
    expect(life.inFlight("procedures")).toBe(1);
    expect(seen).toEqual([
      { controller: "procedures", route: "POST /rpc/git.status", params: { procedure: "git.status" }, wildcards: [], detail: { effects: "none" } },
    ]);
    // the exact route comes before each pattern, and the pattern "*" takes each other route
    expect(await life.request("procedures", "POST /rpc/host.info", () => "info").collect()).toMatchObject({ items: ["info"] });
    expect(seen).toHaveLength(1);
    expect(await life.request("procedures", "GET /anything/else", () => 1).collect()).toMatchObject({ items: [1] });
    void pending.collect();
    void life.shutdown();
    await exited(r, life);
  });

  it("lets the function decide the answer of each request that the drain cuts", async () => {
    const r = rig();
    procedures(r);
    const life = await run(r);
    const forever = () => new Promise<string>(() => {});
    const read = life.request("procedures", "POST /rpc/fs.read", forever, { detail: { effects: "none" } }).collect();
    const write = life.request("procedures", "POST /rpc/fs.write", forever, { detail: { effects: "write" } }).collect();
    const keyed = life.request("procedures", "POST /rpc/pay", forever, { detail: { effects: "keyed" } }).collect();
    void life.shutdown();
    await exited(r, life);
    expect((await read).end).toMatchObject({ kind: "cut", status: 503, retryable: true });
    expect((await write).end).toMatchObject({ kind: "cut", status: 500, retryable: false });
    // the server keeps the key for 60 s, and the drain took less
    expect((await keyed).end).toMatchObject({ kind: "cut", status: 503, retryable: true });
  });

  it("throws for a route that no route and no pattern matches, and for an operation that the pattern does not declare", async () => {
    const r = rig();
    r.svc
      .controller("strict")
      .pattern("GET /files/*", { read: { idempotent: true } })
      .pattern("POST /jobs/:id", { a: { idempotent: true }, b: { idempotent: false } }, () => "c");
    const life = await run(r);
    expect(() => life.request("strict", "DELETE /files/a", () => 1)).toThrow(/does not declare the route DELETE \/files\/a/);
    expect(() => life.request("strict", "POST /jobs/7", () => 1)).toThrow(/declares no operation c for POST \/jobs\/7/);
    expect(await life.request("strict", "GET /files/a/b.txt", () => "file").collect()).toMatchObject({ items: ["file"] });
    void life.shutdown();
    await exited(r, life);
  });

  it("exports each pattern and its operations as data, and the law and lint() still read the declaration", () => {
    const r = rig();
    procedures(r);
    const description = r.svc.describe();
    expect(description.controllers.find((each) => each.name === "procedures")?.patterns).toEqual([
      {
        pattern: "POST /rpc/:procedure",
        operations: {
          read: { idempotent: true },
          write: { idempotent: false },
          keyed: { idempotent: { key: "Idempotency-Key", window: s(60) } },
        },
      },
      { pattern: "*", operations: { other: { idempotent: false } } },
    ]);
    // a controller without patterns exports none, as 0.4 did
    expect(description.controllers.find((each) => each.name === "api")).not.toHaveProperty("patterns");
    const O16: Rule = {
      id: "O16",
      rule: "the cooperative-cancel window is shorter than the process's drain deadline",
      expr: {
        lhs: { terms: [{ knob: "cooperative_window", coef: 1, at: "process" }] },
        op: "<",
        rhs: { terms: [{ knob: "process_drain_time", coef: 1, at: "process" }] },
      },
    };
    const scenario = { platform: {}, probes: { readiness: s(10), liveness: s(30) } };
    expect(lint(description, scenario, [O16])).toEqual(lint(rig().svc.describe(), scenario, [O16]));
  });

  it("refuses a pattern that it cannot match, an operation that it cannot use, and a choice without its function", () => {
    const declared = (pattern: string, operations: Record<string, { idempotent: boolean | { key: string; window: { value: number; unit: string } } }>) => {
      const svc = service("svc")
        .readiness({ type: "window", failAfter: s(0) })
        .liveness({ type: "window", failAfter: s(0) })
        .startup(s(1))
        .phase("drain", s(1))
        .onRepeatSignal("ignore")
        .cooperativeWindow(s(1));
      svc.controller("c").pattern(pattern, operations, () => Object.keys(operations)[0]!);
      return () => svc.describe();
    };
    expect(declared("", { a: { idempotent: true } })).toThrow(/has an empty route pattern/);
    expect(declared("GET /:", { a: { idempotent: true } })).toThrow(/has a ":" without a name/);
    expect(declared("GET /:id/:id", { a: { idempotent: true } })).toThrow(/names :id two times/);
    expect(declared("GET /*", {})).toThrow(/declares no operation/);
    expect(declared("POST /*", { pay: { idempotent: { key: " ", window: s(1) } } })).toThrow(/names no key/);
    const svc = service("svc");
    const controller = svc.controller("c").pattern("GET /*", { a: { idempotent: true } });
    expect(() => controller.pattern("GET /*", { a: { idempotent: true } })).toThrow(/already has the route pattern GET \/\*/);
    expect(() => controller.pattern("POST /*", { a: { idempotent: true }, b: { idempotent: false } })).toThrow(/needs the function that picks one/);
  });

  it("matches the whole route, with each other character as itself", () => {
    const dotted = compilePattern("GET /a.b/:name");
    expect(dotted.match("GET /a.b/x")).toEqual({ params: { name: "x" }, wildcards: [] });
    expect(dotted.match("GET /aXb/x")).toBeNull();
    expect(dotted.match("GET /a.b/x/y")).toBeNull();
    expect(dotted.match("xGET /a.b/x")).toBeNull();
    expect(compilePattern("*").match("")).toEqual({ params: {}, wildcards: [""] });
    expect(compilePattern("GET /files/*/raw").match("GET /files/a/b/raw")).toEqual({ params: {}, wildcards: ["a/b"] });
    expect(compilePattern("(GET|POST) [x]+").match("(GET|POST) [x]+")).toEqual({ params: {}, wildcards: [] });
  });
});

/** This type check holds the type of the work: a stream gives its item type, not the type of the iterable. */
export const typed = (life: Lifecycle) =>
  life.request("api", "GET /things", async function* () {
    yield 1;
  }) satisfies AsyncIterable<RequestEvent<number>>;
