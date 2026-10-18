import type { Extent } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { timerOf } from "@mark1russell7/algebra";
import { describe, expect, it } from "vitest";
import type { LifecycleEvent } from "./events.ts";
import type { RequestEnd } from "./index.ts";
import { cooperativeAbortAt, drainMachine } from "./index.ts";
import type { Rig } from "./rig.ts";
import { CAPS, exited, rig, run } from "./rig.ts";
import type { Behavior } from "./testing.ts";

/**
 * The lifecycle by permutation. Each shutdown permutation crosses when the signal comes, the cap of
 * the drain, what is in flight and the cooperative window. It checks the sequence of the phases,
 * each cap, the time of the cooperative abort (against the runtime's rule and the algebra's closed
 * form of the drain's document), the answer of each request and the exit. Each startup permutation
 * crosses the budget, the warm-up of a check, the time of a connection and a late dependency. A
 * failure names its permutation.
 */

const s = (value: number) => ({ value, unit: "s" });

type Signal = "during the startup" | "at rest" | "twice, the second in the sequence";
type Flight =
  | "none"
  | "idempotent, ends in time"
  | "idempotent, outlives the drain"
  | "not idempotent, outlives the drain"
  | "cooperative, idempotent"
  | "cooperative, not idempotent";

const SIGNALS: Signal[] = ["during the startup", "at rest", "twice, the second in the sequence"];
const DRAINS = [2, 6];
const FLIGHTS: Flight[] = [
  "none",
  "idempotent, ends in time",
  "idempotent, outlives the drain",
  "not idempotent, outlives the drain",
  "cooperative, idempotent",
  "cooperative, not idempotent",
];
const WINDOWS: Array<[string, Extent]> = [
  ["0 s", s(0)],
  ["1 s", s(1)],
  ["no bound", { value: "infinite", unit: "s" }],
  ["10 s", s(10)],
];

/** This function starts the request of a flight, or nothing. */
const fly = (
  r: Rig,
  life: Awaited<ReturnType<typeof run>>,
  flight: Flight,
): Promise<{ readonly items: readonly string[]; readonly end: RequestEnd }> | null => {
  const route = flight.includes("not idempotent") ? "POST /things" : "GET /things";
  if (flight === "none") return null;
  if (flight === "idempotent, ends in time")
    return life.request("api", route, () => new Promise<string>((resolve) => r.clock.after(300, () => resolve("ok")))).collect();
  if (flight.startsWith("cooperative"))
    return life
      .request(
        "api",
        route,
        (signal) => new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")))),
      )
      .collect();
  return life.request("api", route, () => new Promise<string>(() => {})).collect();
};

const phaseSpans = (events: readonly LifecycleEvent[]) => {
  const moves = events.filter((event) => event.machine === "drain" && event.from !== event.to);
  return moves.slice(0, -1).map((move, at) => ({ name: move.to, from: move.at, to: moves[at + 1]!.at, end: moves[at + 1]!.on }));
};

describe("the shutdown, by permutation: the signal × the drain's cap × the work in flight × the cooperative window", () => {
  const cases: Array<[string, Signal, number, Flight, string, Extent]> = [];
  for (const signal of SIGNALS)
    for (const drain of DRAINS)
      for (const flight of FLIGHTS)
        for (const [windowName, window] of WINDOWS)
          cases.push([`signal ${signal}, drain ${drain} s, ${flight}, window ${windowName}`, signal, drain, flight, windowName, window]);

  it.each(cases)("%s", async (label, signal, drain, flight, _windowName, window) => {
    const r = rig({ caps: { ...CAPS, drain }, window, connect: signal === "during the startup" ? { db: 2000 } : {} });
    let sent = false;
    const life = await run(r, (at) => {
      if (signal === "during the startup" && at >= 500 && !sent) {
        sent = true;
        r.process.signal("SIGTERM");
      }
    });
    // during the startup the request starts in the readiness hold, which still admits it
    const outcome = fly(r, life, flight);
    if (signal !== "during the startup") r.process.signal("SIGTERM");
    let second = false;
    let readinessInHold: number | null = null;
    const code = await exited(r, life, () => {
      const inHold = r.events.some((event) => event.machine === "drain" && event.to === "fail readiness");
      if (inHold && readinessInHold === null) readinessInHold = life.health.probe("readiness").status;
      if (signal === "twice, the second in the sequence" && inHold && !second) {
        second = true;
        r.process.signal("SIGINT");
      }
    });
    // readiness fails first: the probe answers 503 from the start of the readiness hold
    expect(readinessInHold, `${label}: readiness in the hold`).toBe(503);
    // the parts close in reverse: the transports, then the dependencies in reverse, the health server last
    const closes = r.log.map((line) => line.split(" ").slice(1).join(" ")).filter((line) => line.startsWith("close"));
    expect(closes, `${label}: the teardown`).toEqual(["close http", "close cache", "close db", "close health"]);

    // the phases, in their declared sequence, each one in its cap
    const spans = phaseSpans(r.events);
    expect(spans.map((span) => span.name), label).toEqual([...Object.keys(CAPS)]);
    for (const span of spans) {
      const cap = (span.name === "drain" ? drain : CAPS[span.name as keyof typeof CAPS]) * 1000;
      expect(span.to - span.from, `${label}: ${span.name} in its cap`).toBeLessThanOrEqual(cap);
      expect(span.end, `${label}: ${span.name} ended its work`).toBe("phase.done");
    }
    const hold = spans.find((span) => span.name === "fail readiness")!;
    expect(hold.to - hold.from, `${label}: the readiness hold`).toBe(CAPS["fail readiness"] * 1000);

    // the drain, and its cooperative abort
    const draining = spans.find((span) => span.name === "drain")!;
    const fireAt = cooperativeAbortAt(drain * 1000, window);
    const abort = r.events.find((event) => event.on === "drain.cooperative-abort");
    const long = flight.includes("outlives") || flight.startsWith("cooperative");
    if (!long) {
      expect(draining.to - draining.from, `${label}: an empty drain ends at once`).toBe(0);
      expect(abort, `${label}: no cooperative abort`).toBeUndefined();
    } else {
      expect(abort?.at, `${label}: the cooperative abort`).toBe(draining.from + fireAt);
      const ends = flight.startsWith("cooperative") ? fireAt : drain * 1000;
      expect(draining.to - draining.from, `${label}: the drain ends`).toBe(ends);
      // the algebra's closed form of the drain's document gives the same time, for a bounded window
      if (window.value !== "infinite") {
        const values = (name: string) => (name === "drain_cap" ? s(drain) : name === "cooperative_window" ? window : undefined);
        const closed = timerOf(drainMachine(r.svc.describe()), "cooperative_abort", values as never).duration;
        expect(valueIn(closed as { value: number; unit: string }, "ms"), `${label}: the algebra`).toBe(fireAt);
      }
    }

    // the answer of the request
    if (outcome !== null) {
      const answer = await outcome;
      if (flight === "idempotent, ends in time") expect(answer, label).toEqual({ items: ["ok"], end: { kind: "done", delivered: 1 } });
      else if (flight.includes("not idempotent")) expect(answer.end, label).toMatchObject({ kind: "cut", status: 500, retryable: false, delivered: 0 });
      else expect(answer.end, label).toMatchObject({ kind: "cut", status: 503, retryable: true, delivered: 0 });
    }

    // the exit: one, clean, with no handler and no timer left
    expect(code, label).toBe(0);
    expect(r.process.exits, label).toEqual([0]);
    expect(r.process.handlers, label).toBe(0);
    expect(r.clock.pending, label).toBe(0);
    if (signal === "during the startup") {
      const opened = r.events.find((event) => event.machine === "gate" && event.to === "open")!;
      expect(hold.from, `${label}: the shutdown waits for the startup`).toBeGreaterThanOrEqual(opened.at);
    }
    expect(r.events.filter((event) => event.on === "exit.repeat").length, label).toBe(
      signal === "twice, the second in the sequence" ? 1 : 0,
    );
  });
});

describe("the startup, by permutation: the budget × the warm-up of a check × the time of a connection × a late dependency", () => {
  type Late = "none" | "with a check that passes" | "with no check";
  const WARMUPS: Array<[string, Behavior, number | undefined]> = [
    ["passes", "ok", undefined],
    ["passes slowly (300 ms)", "ok", 300],
    ["times out", "timeout", undefined],
    ["hangs", "hang", undefined],
  ];
  const cases: Array<[string, number, string, Behavior, number | undefined, number, Late]> = [];
  for (const budget of [1, 5])
    for (const [warmName, behavior, delay] of WARMUPS)
      for (const connect of [0, 2000])
        for (const late of ["none", "with a check that passes", "with no check"] as Late[])
          cases.push([
            `budget ${budget} s, the db check ${warmName}, db connects in ${connect} ms, late dependency ${late}`,
            budget,
            warmName,
            behavior,
            delay,
            connect,
            late,
          ]);

  it.each(cases)("%s", async (label, budget, _warmName, behavior, delay, connect, late) => {
    const r = rig({ budget, connect: { db: connect }, checkDelay: delay });
    r.checks.db.behavior = behavior;
    const life = await run(r);
    const parts = r.events.filter((event) => event.on === "component.started").map((event) => event.detail);
    expect(parts, label).toEqual(["the health server", "dependency db", "dependency cache", "server http"]);
    const opened = r.events.find((event) => event.machine === "gate" && event.to === "open")!;
    const sweep = behavior === "ok" ? (delay ?? 0) : 400;
    expect(opened.at, `${label}: the gate opens after the connections and one sweep`).toBe(connect + sweep);
    const over = r.events.find((event) => event.on === "startup.over-budget");
    if (opened.at > budget * 1000) expect(over?.at, `${label}: over the budget`).toBe(budget * 1000);
    else expect(over, `${label}: in the budget`).toBeUndefined();
    expect(life.health.probe("startup").status, label).toBe(200);

    const passes = behavior === "ok";
    expect(life.health.verdict().controllers["api"], `${label}: api needs db`).toBe(passes);
    expect(life.health.verdict().controllers["stats"], `${label}: stats needs only cache`).toBe(true);

    if (late !== "none") {
      r.svc.dependency("queue", { system: null, knobs: {}, operations: {} });
      expect(life.health.verdict().ready, `${label}: a late dependency pulls readiness`).toBe(false);
      if (late === "with a check that passes")
        r.svc.check(
          {
            name: "queue.round-trip",
            dependency: "queue",
            step: "round-trip",
            ownConnection: true,
            gates: "readiness",
            poll: { interval: s(1), jitter: 0.2, timeout: s(0.4) },
          },
          () => "ok",
        );
      await r.clock.advance(1500);
      expect(life.health.verdict().dependencies["queue"], `${label}: the late dependency`).toBe(late === "with a check that passes");
    }
    await r.clock.advance(1500);
    expect(life.health.verdict().ready, `${label}: ready`).toBe(passes && late !== "with no check");

    void life.shutdown();
    r.checks.db.heal();
    expect(await exited(r, life), label).toBe(0);
  });
});
