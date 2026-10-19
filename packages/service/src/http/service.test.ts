import { describe, expect, it } from "vitest";
import { service } from "../builder.ts";
import type { LifecycleEvent } from "../events.ts";
import type { FakeClock } from "../fakes.ts";
import { fakeClock, fakeProcess, seeded } from "../fakes.ts";
import { handle, httpTransport, ndjson, pathOf, probeHandler, probeServer, writeOutcome } from "../http.ts";
import type { HttpKnobs } from "../http.ts";
import type { Lifecycle, TransportImpl } from "../lifecycle.ts";
import type { RequestEvent, RequestStream } from "../requests.ts";
import { scriptedCheck } from "../testing.ts";
import { FakeServer, pushedSource } from "./fake-server.ts";

/**
 * The ./http entry under run(), on fake servers and the fake clock: the stages of the shutdown with
 * the transport, the probes on the port of the application and on their own port, and handle() over
 * life.request, unary and as a stream. The same service on real sockets runs in CI only (HTTP_IT=1).
 */

const s = (value: number) => ({ value, unit: "s" });
/** This function lets the events of the fake servers come: they come on the next tick, as in Node. */
const turns = async (count = 4): Promise<void> => {
  for (let at = 0; at < count; at += 1) await new Promise((resolve) => setImmediate(resolve));
};
const KNOBS: HttpKnobs = { server_idle_close: s(65), server_idle_sweep_interval: s(1), server_retry_after: s(1) };

/**
 * This clock reads a later time at each read, by 1 µs, as a real monotonic clock does. Its timers
 * are the timers of a fake clock. Thus of two timers for one deadline, the timer that starts later
 * comes first, as with setTimeout: the drain of the transport reaches its deadline before the cut.
 */
const drifting = (base: FakeClock): FakeClock => {
  let drift = 0;
  return {
    now: () => base.now() + (drift += 0.001),
    after: (ms, run) => base.after(ms, run),
    advance: (ms) => base.advance(ms),
    block: (ms) => base.block(ms),
    get pending() {
      return base.pending;
    },
  };
};

/** This stream gives one row at once, and then nothing: it ignores the abort and its return(). Only the cut ends it. */
const tail = (): AsyncIterable<{ row: number }> => ({
  [Symbol.asyncIterator]: () => {
    let first = true;
    return {
      next: (): Promise<IteratorResult<{ row: number }>> => {
        if (!first) return new Promise(() => {});
        first = false;
        return Promise.resolve({ value: { row: 1 }, done: false });
      },
      return: (): Promise<IteratorResult<{ row: number }>> => new Promise(() => {}),
    };
  },
});

/** This stream comes from no lifecycle, thus no cut ends it: a stream outside the lifecycle, whose end never comes. */
const endless = (): RequestStream<string> => ({
  [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<RequestEvent<string>>>(() => {}) }),
  collect: () => new Promise(() => {}),
});

const rigged = (options: { readonly slowWarmUp?: boolean; readonly drift?: boolean; readonly stuckDrainStep?: boolean } = {}) => {
  const clock = options.drift === true ? drifting(fakeClock()) : fakeClock();
  const process = fakeProcess();
  const events: LifecycleEvent[] = [];
  const app = new FakeServer();
  const probesPort = new FakeServer();
  // the transport gets the lifecycle at its start: keep-alive and the requests come from it
  const http = httpTransport(app.asServer, KNOBS, { listen: { port: 8080 }, clock });
  const probes = probeServer({ server_retry_after: s(1), port: 9090, server: probesPort.asServer });
  // the transport of the service: http, and a call of each function of `drained` when its drain ends
  const drained: Array<() => void> = [];
  const impl: TransportImpl = {
    start: (signal, life) => http.start(signal, life),
    stopIntake: () => http.stopIntake(),
    drain: async (deadline, signal) => {
      await http.drain(deadline, signal);
      for (const each of drained) each();
    },
    inFlight: () => http.inFlight(),
    close: () => http.close(),
  };
  const svc = service("app")
    .server("http", http.knobs, impl)
    .healthServer(probes)
    .readiness({ type: "debounce", interval: s(1), failAfter: 3, recoverAfter: 1 })
    .liveness({ type: "window", failAfter: s(5) })
    .startup(s(10))
    .phase("fail readiness", s(1))
    .phase("stop intake", s(1))
    .phase("drain", s(4))
    .phase("close transports", s(1))
    .phase("stop the poller", s(1))
    .phase("close the health server", s(1))
    .cooperativeWindow(s(1))
    .onRepeatSignal("ignore");
  // a check that reports only, and whose first poll ends at its timeout: the warm-up takes 400 ms
  if (options.slowWarmUp === true)
    svc.check(
      { name: "slow", dependency: null, step: "local-state", ownConnection: true, gates: null, poll: { interval: s(1), jitter: 0, timeout: s(0.4) } },
      scriptedCheck("timeout").run,
    );
  svc
    .controller("api")
    .route("GET /work", { idempotent: true })
    .route("POST /once", { idempotent: false })
    .route("GET /rows", { idempotent: true })
    .route("GET /tail", { idempotent: true });
  // a window between the close of the transports and the close of the health server
  svc.onPhase("stop the poller", ({ clock: phaseClock }) => new Promise((resolve) => phaseClock.after(500, resolve)));
  // a step of the drain of an owner that never ends
  if (options.stuckDrainStep === true) svc.onPhase("drain", () => new Promise<void>(() => {}));
  const releases: Array<() => void> = [];
  http.mount(probeHandler(() => svc.health, { prefix: "/health" }));
  const rows = pushedSource<{ row: number }>();
  http.mount(
    handle(
      "api",
      (req) => ({ "/work": "GET /work", "/once": "POST /once" })[pathOf(req.url)] ?? null,
      (req, signal) => {
        // a stuck work ignores its abort: only the cut at the deadline of the drain ends it
        if (req.url?.includes("stuck") === true) return new Promise<string>(() => {});
        return req.url?.includes("hold") === true
          ? new Promise<string>((resolve, reject) => {
              releases.push(() => resolve("held"));
              signal.addEventListener("abort", () => reject(new Error("aborted")));
            })
          : "done";
      },
    ),
  );
  http.mount(handle("api", "GET /rows", () => rows.iterable, { stream: ndjson }));
  http.mount(handle("api", "GET /tail", () => tail(), { stream: ndjson }));
  http.mount((req, res) => {
    if (pathOf(req.url) !== "/endless") return false;
    void writeOutcome(res, endless(), { keepAlive: true, retryAfter: s(1) });
    return true;
  });
  const start = async (during: () => Promise<void> = async () => {}): Promise<Lifecycle> => {
    let ended = false;
    const running = svc.run({ clock, random: seeded(1), process, record: (event) => events.push(event) }).finally(() => (ended = true));
    for (let step = 0; step < 100 && !ended; step += 1) {
      await turns(1);
      await clock.advance(10);
      if (!ended) await during();
    }
    return await running;
  };
  /** This function moves the fake clock in steps of 10 ms, and lets the events of the fake servers come between them. */
  const step = async (ms: number): Promise<void> => {
    for (let left = ms; ; left -= 10) {
      await turns();
      await clock.advance(Math.min(10, Math.max(0, left)));
      if (left <= 10) break;
    }
    await turns();
    await clock.advance(0);
  };
  return { clock, process, events, app, probesPort, http, start, releases, step, rows, drained };
};

const stage = (events: readonly LifecycleEvent[]): string | undefined => events.filter((event) => event.machine === "drain").at(-1)?.to;

describe("the ./http entry under run()", () => {
  it("starts the probe server first, then the transport, and serves work with keep-alive while ready", async () => {
    const r = rigged();
    const life = await r.start();
    expect(life.state).toBe("running");
    expect(r.probesPort.listens).toEqual([{ port: 9090 }]);
    expect(r.app.listens).toEqual([{ port: 8080 }]);
    const started = r.events.filter((event) => event.on === "component.started").map((event) => event.detail);
    expect(started).toEqual(["the health server", "server http"]);
    const answer = await r.app.request("/work");
    expect([answer.status, answer.body, answer.headers.get("connection")]).toEqual([200, "done", undefined]);
    expect((await r.app.request("/health/readiness")).status).toBe(200);
  });

  it("answers the mounted probes through the drain, stops them at close transports, and closes the probe server last", async () => {
    const r = rigged();
    const life = await r.start();
    const held = r.app.request("/work?hold");
    await r.step(0);
    expect(life.inFlight()).toBe(1);
    r.process.signal("SIGTERM");
    await r.step(0);

    // fail readiness: the listener is open, readiness fails, and new work still comes, with Connection: close
    expect(stage(r.events)).toBe("fail readiness");
    const failing = await r.app.request("/health/readiness");
    expect([failing.status, failing.headers.get("retry-after")]).toEqual([503, "1"]);
    expect((await r.app.request("/health/liveness")).status).toBe(200);
    const during = await r.app.request("/work");
    expect([during.status, during.headers.get("connection")]).toEqual([200, "close"]);

    // stop intake and the drain: the mounted probes answer, and each other request gets a retryable 503
    await r.step(1000);
    expect(stage(r.events)).toBe("drain");
    expect(r.http.intakeStopped).toBe(true);
    expect((await r.app.request("/health/liveness")).status).toBe(200);
    const refused = await r.app.request("/work");
    expect([refused.status, refused.headers.get("retry-after"), refused.headers.get("connection")]).toEqual([503, "1", "close"]);
    const own = await r.probesPort.request("/readiness");
    expect([own.status, own.headers.get("retry-after")]).toEqual([503, "1"]);

    // the held work ends in the drain, and its answer closes its connection
    r.releases[0]!();
    const answer = await held;
    expect([answer.status, answer.body, answer.headers.get("connection")]).toEqual([200, "held", "close"]);
    await r.step(0);

    // close transports: the port of the application refuses connections, and the probe server answers
    expect(stage(r.events)).toBe("stop the poller");
    expect(() => r.app.connect()).toThrow(/ECONNREFUSED/);
    expect((await r.probesPort.request("/liveness")).status).toBe(200);

    // the probe server closes last
    await r.step(500);
    expect(() => r.probesPort.connect()).toThrow(/ECONNREFUSED/);
    expect(await life.done).toBe(0);
    expect(r.process.exits).toEqual([0]);
  });

  it("gives a held request the cooperative abort, and the drain answers it as a retryable cut", async () => {
    const r = rigged();
    const life = await r.start();
    const held = r.app.request("/work?hold");
    await r.step(0);
    r.process.signal("SIGTERM");
    // fail readiness (1 s), stop intake, then the cooperative abort at 3 s of the drain of 4 s
    await r.step(1000);
    await r.step(3000);
    const answer = await held;
    // each 503 gets Retry-After: the cut of an idempotent route can go again
    expect([answer.status, answer.headers.get("retry-after")]).toEqual([503, "1"]);
    expect(JSON.parse(answer.body)).toMatchObject({ end: "cut", retryable: true });
    await r.step(2000);
    expect(await life.done, life.errors.join("; ")).toBe(0);
  });

  it("answers the cut of a route that is not idempotent with 500 and no Retry-After", async () => {
    const r = rigged();
    const life = await r.start();
    const held = r.app.request("/once?hold", "POST");
    await r.step(0);
    r.process.signal("SIGTERM");
    await r.step(1000);
    await r.step(3000);
    const answer = await held;
    expect([answer.status, answer.headers.get("retry-after")]).toEqual([500, undefined]);
    expect(JSON.parse(answer.body)).toMatchObject({ end: "cut", retryable: false });
    await r.step(2000);
    expect(await life.done, life.errors.join("; ")).toBe(0);
  });

  it("refuses a request while the warm-up runs with a retryable 503, because the transport has the lifecycle from its start", async () => {
    const r = rigged({ slowWarmUp: true });
    const answers: Array<[number, string | undefined, string | undefined]> = [];
    const life = await r.start(async () => {
      if (answers.length > 0 || !r.app.listening) return;
      const answer = await r.app.request("/work");
      answers.push([answer.status, answer.headers.get("retry-after"), answer.headers.get("connection")]);
    });
    expect(answers).toEqual([[503, "1", "close"]]);
    expect(life.state).toBe("running");
    expect((await r.app.request("/work")).status).toBe(200);
  });

  it("streams rows as they come, and the cooperative abort ends the stream after its first row in-band", async () => {
    const r = rigged();
    const life = await r.start();
    const connection = r.app.connect();
    const answer = connection.request("/rows");
    r.rows.push({ row: 1 });
    await r.step(0);
    // the status and the first row went before the end of the stream
    expect([connection.response?.statusCode, connection.response?.chunks]).toEqual([200, ['{"row":1}\n']]);
    r.process.signal("SIGTERM");
    // fail readiness (1 s), stop intake, then the cooperative abort at 3 s of the drain of 4 s
    await r.step(1000);
    await r.step(3000);
    const whole = await answer;
    expect([whole.status, whole.headers.get("retry-after"), whole.headers.get("content-type")]).toEqual([200, undefined, "application/x-ndjson; charset=utf-8"]);
    const lines = whole.body.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([{ row: 1 }, { end: "cut", delivered: 1, retryable: true, cause: "the shutdown ended the stream" }]);
    expect(r.rows.returned).toBe(true);
    await r.step(2000);
    expect(await life.done, life.errors.join("; ")).toBe(0);
  });
});

describe("SYS-29: the drain waits for the answers of the calls that its deadline cuts", () => {
  /** This function gives the state of the response of each connection: open, ended, or gone to the client. */
  const statesOf = (connections: ReadonlyArray<{ readonly response: { readonly writableEnded: boolean; readonly writableFinished: boolean } | null }>) =>
    connections.map((each) => (each.response?.writableFinished === true ? "gone" : each.response?.writableEnded === true ? "ended" : "open"));
  const enter = (events: readonly LifecycleEvent[], to: string) => events.find((event) => event.machine === "drain" && event.to === to)!;

  // the fake clock starts the cut first. On the drifting clock, as on setTimeout, the transport reaches the deadline first
  for (const [order, drift] of [["the cut first", false], ["the transport first", true]] as const)
    it(`gives each cut call its answer before its socket closes: 503 and 500 before the first item, and an in-band end after it (${order})`, async () => {
      const r = rigged({ drift });
      const life = await r.start();
      const get = r.app.connect();
      const post = r.app.connect();
      const stream = r.app.connect();
      const answers = [get.request("/work?stuck"), post.request("/once?stuck", "POST"), stream.request("/tail")];
      await r.step(0);
      expect(life.inFlight()).toBe(3);
      // the status and the first row of the stream went before the shutdown
      expect([stream.response?.statusCode, stream.response?.chunks]).toEqual([200, ['{"row":1}\n']]);
      const states: string[][] = [];
      r.drained.push(() => states.push(statesOf([get, post, stream])));
      r.process.signal("SIGTERM");
      // fail readiness (1 s), then the drain of 4 s: the work ignores the cooperative abort at 3 s, and the cut comes at 4 s
      await r.step(1000);
      await r.step(4000);
      const [unary, once, rows] = await Promise.all(answers);
      expect([unary!.status, unary!.headers.get("retry-after")]).toEqual([503, "1"]);
      expect(JSON.parse(unary!.body)).toEqual({ end: "cut", delivered: 0, retryable: true, cause: "the drain reached its deadline" });
      expect([once!.status, once!.headers.get("retry-after")]).toEqual([500, undefined]);
      expect(JSON.parse(once!.body)).toEqual({ end: "cut", delivered: 0, retryable: false, cause: "the drain reached its deadline" });
      expect([rows!.status, rows!.headers.get("retry-after")]).toEqual([200, undefined]);
      expect(rows!.body.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
        { row: 1 },
        { end: "cut", delivered: 1, retryable: true, cause: "the drain reached its deadline" },
      ]);
      // the drain of the transport ended after each answer went out, and the drain ended in its cap
      expect(states).toEqual([["gone", "gone", "gone"]]);
      expect(enter(r.events, "close transports").on).toBe("phase.done");
      await r.step(2000);
      expect(await life.done, life.errors.join("; ")).toBe(0);
    });

  it("ends the drain at its cap with exit 0 when only answers that do not go out are left, and the cap event gives their count", async () => {
    const r = rigged();
    const life = await r.start();
    const get = r.app.connect();
    const post = r.app.connect();
    const lost = [get.request("/work?stuck"), post.request("/once?stuck", "POST")].map((answer) =>
      answer.then(
        () => "answered",
        (error: Error) => error.message,
      ),
    );
    await r.step(0);
    // two clients that stopped reading
    get.socket.pause();
    post.socket.pause();
    r.process.signal("SIGTERM");
    await r.step(1000);
    const drainAt = enter(r.events, "drain").at;
    await r.step(4000);
    // the cut ended each response, and its bytes did not go
    expect(statesOf([get, post])).toEqual(["ended", "ended"]);
    expect([get.response?.statusCode, post.response?.statusCode]).toEqual([503, 500]);
    // the drain did its work: its cap is not a failure, and its event gives the answers that did not go
    const closing = enter(r.events, "close transports");
    expect([closing.on, closing.detail, closing.at - drainAt]).toEqual(["phase.cap", "answers not flushed: 2", 4000]);
    expect(life.errors).toEqual([]);
    // the close of the transports destroyed the sockets: the clients did not get the answers
    expect(await Promise.all(lost)).toEqual([expect.stringMatching(/ECONNRESET/), expect.stringMatching(/ECONNRESET/)]);
    await r.step(2000);
    expect(await life.done).toBe(0);
    expect(r.process.exits).toEqual([0]);
  });

  it("fails the drain at its cap with exit 1 when work is still running there, as before: a step of the drain that never ends", async () => {
    const r = rigged({ stuckDrainStep: true });
    const life = await r.start();
    const stalled = r.app.connect();
    void stalled.request("/once?stuck", "POST").catch(() => {});
    void r.app.connect().request("/work?stuck").catch(() => {});
    await r.step(0);
    stalled.socket.pause();
    r.process.signal("SIGTERM");
    await r.step(1000);
    const drainAt = enter(r.events, "drain").at;
    await r.step(4000);
    // an answer did not go out too, but the work that is left fails the phase
    expect(statesOf([stalled])).toEqual(["ended"]);
    const closing = enter(r.events, "close transports");
    expect([closing.on, closing.detail, closing.at - drainAt]).toEqual(["phase.cap", undefined, 4000]);
    expect(life.errors).toEqual(["the phase drain did not end in its cap of 4 s"]);
    await r.step(2000);
    expect(await life.done).toBe(1);
    expect(r.process.exits).toEqual([1]);
  });

  it("ends the drain at its deadline with exit 0 for a stream outside the lifecycle, as 0.5.4 did, and its record gives their count", async () => {
    const r = rigged();
    const life = await r.start();
    // writeOutcome over a stream that no life.request of this lifecycle made: no cut ends it
    const outside = r.app.connect().request("/endless").then(
      () => "answered",
      (error: Error) => error.message,
    );
    await r.step(0);
    expect(r.http.inFlight()).toBe(1);
    r.process.signal("SIGTERM");
    await r.step(1000);
    const drainAt = enter(r.events, "drain").at;
    await r.step(4000);
    // the drain did not wait for it: the phase ended at its deadline, in time, and its record counts the stream
    const closing = enter(r.events, "close transports");
    expect([closing.on, closing.detail, closing.at - drainAt]).toEqual(["phase.done", "streams outside the lifecycle: 1", 4000]);
    expect(life.errors).toEqual([]);
    // the close of the transports destroyed its socket, as in 0.5.4
    expect(await outside).toMatch(/ECONNRESET/);
    await r.step(2000);
    expect(await life.done).toBe(0);
    expect(r.process.exits).toEqual([0]);
  });

  it("changes nothing for a drain whose calls end before its deadline: it ends with the last answer", async () => {
    const r = rigged();
    const life = await r.start();
    const connection = r.app.connect();
    const held = connection.request("/work?hold");
    await r.step(0);
    const states: string[][] = [];
    r.drained.push(() => states.push(statesOf([connection])));
    r.process.signal("SIGTERM");
    await r.step(1000);
    const drainAt = enter(r.events, "drain").at;
    await r.step(500);
    r.releases[0]!();
    const answer = await held;
    expect([answer.status, answer.body, answer.headers.get("connection")]).toEqual([200, "held", "close"]);
    await r.step(0);
    // the drain ended with the last answer, 500 ms after its start and before its deadline at 4 s
    const closing = enter(r.events, "close transports");
    expect([closing.on, closing.at - drainAt]).toEqual(["phase.done", 500]);
    expect(states).toEqual([["gone"]]);
    await r.step(2000);
    expect(await life.done, life.errors.join("; ")).toBe(0);
  });
});
