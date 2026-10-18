import { describe, expect, it } from "vitest";
import type { LifecycleEvent } from "./events.ts";
import { STAGES, cooperativeAbortAt, service } from "./index.ts";
import { CAPS, exited, rig, run } from "./rig.ts";

const s = (value: number) => ({ value, unit: "s" });
const drainSteps = (events: readonly LifecycleEvent[]) =>
  events.filter((event) => event.machine === "drain").map((event) => `${event.from} -> ${event.to} on ${event.on}`);
const startedParts = (events: readonly LifecycleEvent[]) =>
  events.filter((event) => event.on === "component.started").map((event) => event.detail);

describe("the startup, in its sequence (A1, A2)", () => {
  it("starts the health server first, then each dependency in order, then each transport, and opens the gate last", async () => {
    const r = rig({ connect: { db: 300, cache: 200 } });
    const life = await run(r);
    expect(life.state).toBe("running");
    expect(startedParts(r.events)).toEqual(["the health server", "dependency db", "dependency cache", "server http"]);
    expect(r.log.map((line) => line.split(" ").slice(1).join(" "))).toEqual([
      "listen health",
      "connect db",
      "connect cache",
      "start http",
    ]);
    const gate = r.events.filter((event) => event.machine === "gate").map((event) => event.to);
    expect(gate.slice(-2)).toEqual(["sweeping", "open"]);
    // the probes answer while the dependencies connect: the health server listens at 0 ms
    expect(r.log[0]).toBe("0 listen health");
    expect(life.health.verdict().ready).toBe(true);
  });

  it("says when the gate is over its budget, and does not stop itself (the platform's probe acts)", async () => {
    const r = rig({ budget: 1, connect: { db: 2000 } });
    const life = await run(r);
    const over = r.events.find((event) => event.on === "startup.over-budget");
    expect(over?.at).toBe(1000);
    expect(over?.from).toBe("starting");
    expect(life.state).toBe("running");
  });

  it("fails the startup when a dependency does not connect, stops what started in reverse, and exits 1", async () => {
    const r = rig({ failConnect: "cache" });
    const life = await run(r);
    const code = await exited(r, life);
    expect(code).toBe(1);
    expect(r.process.exits).toEqual([1]);
    expect(life.errors[0]).toMatch(/the startup failed: cache refused the connection/);
    expect(r.events.find((event) => event.machine === "gate" && event.to === "failed")).toBeDefined();
    // only what started stops: db connected and closes; cache and http never started
    const stops = r.log.filter((line) => /close|stop/.test(line)).map((line) => line.split(" ").slice(1).join(" "));
    expect(stops).toEqual(["close db", "close health"]);
    expect(r.process.handlers).toBe(0);
  });

  it("honours a signal during the startup after the startup ends (A4)", async () => {
    const r = rig({ connect: { db: 2000 } });
    let sent = false;
    const life = await run(r, (at) => {
      if (at >= 500 && !sent) {
        sent = true;
        r.process.signal("SIGTERM");
      }
    });
    const code = await exited(r, life);
    expect(code).toBe(0);
    const opened = r.events.find((event) => event.machine === "gate" && event.to === "open")!;
    const firstDrain = r.events.find((event) => event.machine === "drain")!;
    expect(firstDrain.at).toBeGreaterThanOrEqual(opened.at);
    const request = r.events.find((event) => event.machine === "exit" && event.on === "exit.request")!;
    expect(request.at).toBeLessThan(opened.at);
  });
});

describe("the shutdown, in its declared phases (A6, A8, A9, A12, A14)", () => {
  it("fails readiness first, then runs each phase in order, aborts the signal after the poller, and exits 0", async () => {
    const r = rig();
    const life = await run(r);
    r.process.signal("SIGTERM");
    await r.clock.advance(0);
    expect(life.health.probe("readiness").status).toBe(503);
    expect(life.state).toBe("draining");
    const code = await exited(r, life);
    expect(code).toBe(0);
    expect(drainSteps(r.events)).toEqual([
      "running -> fail readiness on exit.request",
      "fail readiness -> stop intake on phase.done",
      "stop intake -> drain on phase.done",
      "drain -> close transports on phase.done",
      "close transports -> stop the poller on phase.done",
      "stop the poller -> tear down dependencies on phase.done",
      "tear down dependencies -> tear down dependencies on signal.abort",
      "tear down dependencies -> close the health server on phase.done",
      "close the health server -> done on phase.done",
    ]);
    const after = r.log.map((line) => line.split(" ").slice(1).join(" ")).slice(4);
    expect(after).toEqual(["stop intake http", "drain http", "close http", "close cache", "close db", "close health"]);
    expect(life.signal.aborted).toBe(true);
    expect(r.process.exits).toEqual([0]);
    expect(r.process.handlers).toBe(0);
    // no timer of the runtime is left: a leaked handle cannot hold the exit (A14)
    expect(r.clock.pending).toBe(0);
  });

  it("holds the readiness phase for its cap, while the platform removes the endpoints", async () => {
    const r = rig();
    const life = await run(r);
    void life.shutdown();
    await exited(r, life);
    const enter = r.events.find((event) => event.machine === "drain" && event.to === "fail readiness")!;
    const leave = r.events.find((event) => event.machine === "drain" && event.from === "fail readiness")!;
    expect(leave.at - enter.at).toBe(CAPS["fail readiness"] * 1000);
  });

  it("counts a second signal and does nothing more: one shutdown, one exit", async () => {
    const r = rig();
    const life = await run(r);
    r.process.signal("SIGINT");
    // during the readiness hold: the first shutdown still runs
    await r.clock.advance(500);
    r.process.signal("SIGQUIT");
    await exited(r, life);
    expect(r.events.filter((event) => event.on === "exit.repeat")).toHaveLength(1);
    expect(r.process.exits).toEqual([0]);
  });

  it("serves requests until the intake stops, then refuses new ones as retryable", async () => {
    const r = rig();
    const life = await run(r);
    void life.shutdown();
    await r.clock.advance(500);
    // during the readiness hold, the platform can still route a request here: it is served
    const during = await life.request("api", "GET /things", () => "ok").collect();
    expect(during).toEqual({ items: ["ok"], end: { kind: "done", delivered: 1 } });
    await r.clock.advance(1000);
    const after = await life.request("api", "GET /things", () => "ok").collect();
    expect(after).toEqual({ items: [], end: { kind: "refused", status: 503, retryable: true, cause: "the service stopped its intake", delivered: 0 } });
    await exited(r, life);
  });

  it("answers a request that the drain's deadline cuts: 503 on an idempotent route, 500 on another (A12)", async () => {
    const r = rig();
    const life = await run(r);
    const forever = () => new Promise<string>(() => {});
    const get = life.request("api", "GET /things", forever).collect();
    const post = life.request("api", "POST /things", forever).collect();
    const charge = life.request("api", "POST /charges", forever).collect();
    void life.shutdown();
    await exited(r, life);
    expect((await get).end).toMatchObject({ kind: "cut", status: 503, retryable: true, delivered: 0 });
    expect((await post).end).toMatchObject({ kind: "cut", status: 500, retryable: false, delivered: 0 });
    // a keyed route can go again only while the server keeps its key: 1 s, and the drain took longer
    expect((await charge).end).toMatchObject({ kind: "cut", status: 500, retryable: false });
  });

  it("aborts the requests in flight at the cooperative abort, the cap less the window", async () => {
    const r = rig({ window: s(1) });
    const life = await run(r);
    let abortedAt: number | null = null;
    const cooperative = life
      .request(
        "api",
        "GET /things",
        (signal) =>
          new Promise<string>((_, reject) =>
            signal.addEventListener("abort", () => {
              abortedAt = r.clock.now();
              reject(new Error("aborted"));
            }),
          ),
      )
      .collect();
    void life.shutdown();
    await exited(r, life);
    const enter = r.events.find((event) => event.machine === "drain" && event.to === "drain")!;
    expect(abortedAt! - enter.at).toBe(cooperativeAbortAt(CAPS.drain * 1000, s(1)));
    expect((await cooperative).end).toMatchObject({ kind: "cut", status: 503, retryable: true });
  });

  it("refuses a request on a route that its controller does not declare, or on an unknown controller", async () => {
    const r = rig();
    const life = await run(r);
    expect(() => life.request("api", "DELETE /things", () => 1)).toThrow(/does not declare the route/);
    expect(() => life.request("nope", "GET /things", () => 1)).toThrow(/no controller nope/);
    void life.shutdown();
    await exited(r, life);
  });

  it("sheds the routes of a controller whose dependency fails, and keeps the others (per route)", async () => {
    const r = rig();
    const life = await run(r);
    r.checks.cache.behavior = "error";
    await r.clock.advance(4000);
    expect((await life.request("stats", "GET /stats", () => 1).collect()).end).toMatchObject({ kind: "refused", status: 503 });
    expect(await life.request("api", "GET /things", () => 1).collect()).toEqual({ items: [1], end: { kind: "done", delivered: 1 } });
    void life.shutdown();
    await exited(r, life);
  });

  it("gives keep-alive only while the service is ready (A13)", async () => {
    const r = rig();
    const life = await run(r);
    expect(life.keepAlive()).toBe(true);
    void life.shutdown();
    await r.clock.advance(0);
    expect(life.keepAlive()).toBe(false);
    await exited(r, life);
  });

  it("exits 1 when the work of a phase does not end in its cap, and goes on with the next phase", async () => {
    const r = rig();
    r.svc.onPhase("close transports", () => new Promise<void>(() => {}));
    const life = await run(r);
    void life.shutdown();
    const code = await exited(r, life);
    expect(code).toBe(1);
    expect(life.errors).toEqual(["the phase close transports did not end in its cap of 1 s"]);
    expect(drainSteps(r.events)).toContain("close transports -> stop the poller on phase.cap");
    expect(r.log.some((line) => line.endsWith("close health"))).toBe(true);
  });

  it("exits 1 when the work of a phase throws, and still closes each part", async () => {
    const r = rig();
    r.svc.onPhase("drain", () => {
      throw new Error("the consumer could not drain");
    });
    const life = await run(r);
    void life.shutdown();
    expect(await exited(r, life)).toBe(1);
    expect(life.errors).toEqual(["the phase drain failed: the consumer could not drain"]);
    expect(r.log.some((line) => line.endsWith("close db"))).toBe(true);
  });
});

describe("the declaration of a lifecycle has no defaults", () => {
  const base = () =>
    service("svc")
      .readiness({ type: "debounce", interval: s(1), failAfter: 3, recoverAfter: 1 })
      .liveness({ type: "window", failAfter: s(5) })
      .startup(s(10))
      .cooperativeWindow(s(1));

  it("refuses the stages of the shutdown out of their sequence", () => {
    expect(() => base().phase("drain", s(4)).phase("fail readiness", s(1)).describe()).toThrow(
      /the phase "fail readiness" comes after "drain", but the stages go fail readiness, stop intake, drain/,
    );
    // a phase of another name can go anywhere
    expect(() => base().phase("flush the log", s(1)).phase("drain", s(4)).describe()).not.toThrow();
    expect(STAGES).toHaveLength(8);
    expect(STAGES.at(-1)).toBe("flush the output");
  });

  it("refuses to run a transport without its implementation, or a stage with work and no phase", async () => {
    const noImpl = base().phase("drain", s(1));
    noImpl.server("http", {});
    await expect(noImpl.run()).rejects.toThrow(/transport http has no implementation/);
    const noDrain = base().phase("stop intake", s(1)).phase("close transports", s(1));
    noDrain.server("http", {}, { start() {}, stopIntake() {}, drain() {}, inFlight: () => 0, close() {} });
    await expect(noDrain.run()).rejects.toThrow(/thus it declares the phase "drain"/);
  });

  it("keeps start() and run() apart: one service runs one of them", async () => {
    const r = rig();
    const life = await run(r);
    await expect(r.svc.start()).rejects.toThrow(/runs its lifecycle/);
    void life.shutdown();
    await exited(r, life);
  });
});

describe("the watchdog of the event loop (F9: a 21 s block)", () => {
  it("fails its check after a block longer than its threshold, and the liveness window then trips", async () => {
    const r = rig({ watchdog: true });
    const life = await run(r);
    expect(life.health.verdict().alive).toBe(true);
    // the loop blocks for 21 s: no timer runs, and each comes late after it
    r.clock.block(21_000);
    await r.clock.advance(100);
    const blocked = r.events.find((event) => event.machine === "watchdog" && event.to === "blocked");
    expect(blocked).toBeDefined();
    // the liveness window (5 s) counts from the first failing poll
    await r.clock.advance(7000);
    const window = r.events.filter((event) => event.machine === "window" && event.instance === "process.event-loop");
    expect(window.map((event) => event.to)).toContain("failing");
    void life.shutdown();
    await exited(r, life);
    expect(r.events.some((event) => event.machine === "watchdog" && event.to === "stopped")).toBe(true);
  });

  it("stays watching when the loop is only a little late", async () => {
    const r = rig({ watchdog: true });
    const life = await run(r);
    r.clock.block(500);
    await r.clock.advance(5000);
    expect(r.events.some((event) => event.machine === "watchdog" && event.to === "blocked")).toBe(false);
    expect(life.health.verdict().alive).toBe(true);
    void life.shutdown();
    await exited(r, life);
  });
});
