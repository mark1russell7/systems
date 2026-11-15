import { describe, expect, it } from "vitest";
import { fakeClock } from "./clock.ts";
import * as root from "./index.ts";
import type { Machine } from "./machine.ts";
import { machineProblems } from "./machine.ts";
import type { Transition } from "./replay.ts";
import { replay } from "./replay.ts";
import { runMachine } from "./run.ts";
import { machineSchema } from "./schema.ts";

const SOURCES = [{ ref: "a test", rung: "derived" as const }];

/**
 * A lock of an app: it arms after a quiet time with no load of a page. Each `stop` of a load starts
 * the quiet time again, and `start`, `press` and `reload` cancel it.
 */
const LOCK: Machine = {
  format: "mark1russell7.machine/1",
  id: "example.machine.lock",
  title: "A lock that arms after a quiet time",
  layer: "self",
  version: "1.0.0",
  sources: SOURCES,
  states: { loading: { initial: true }, armed: {} },
  events: {
    start: { kind: "app", note: "a load starts" },
    stop: { kind: "app", note: "a load stops" },
    press: { kind: "app" },
    settled: { kind: "timer" },
    reload: { kind: "app" },
  },
  knobs: { settle: { key: "settle", scope: "lock", unit: "ms", default: 2000 } },
  timers: {
    settle: { duration: { knob: "settle", unit: "ms" }, arms: ["stop"], cancels: ["start", "press", "reload"], fires: "settled" },
  },
  transitions: [
    { id: "lock.arm", from: "loading", to: "armed", on: ["press", "settled"] },
    { id: "lock.reload", from: "armed", to: "loading", on: "reload" },
  ],
};

/** A call with retries: each wait of the backoff is double the wait before it, and a reply resets the count. */
const RETRY: Machine = {
  format: "mark1russell7.machine/1",
  id: "example.machine.retry",
  title: "A call with retries",
  layer: "self",
  version: "1.0.0",
  sources: SOURCES,
  states: { idle: { initial: true }, trying: {}, done: { final: true } },
  events: { begin: { kind: "app" }, retry: { kind: "timer" }, ok: { kind: "rx" }, end: { kind: "app" } },
  knobs: { base: { key: "base", scope: "call", unit: "ms", default: 100 } },
  timers: {
    retry: {
      duration: { expr: "base * pow(2, fired)", unit: "ms" },
      arms: ["begin"],
      cancels: ["ok"],
      fires: "retry",
      backoff: { resets: ["ok"] },
    },
  },
  transitions: [
    { id: "retry.begin", from: "idle", to: "trying", on: "begin" },
    { id: "retry.again", from: "trying", to: "trying", on: "retry" },
    { id: "retry.ok", from: "trying", to: "idle", on: "ok" },
    { id: "retry.end", from: "*", to: "done", on: "end" },
  ],
};

/** A connection with a keepalive in seconds: the entry to `waiting` arms it, and its ping arms a timeout in milliseconds. */
const PING: Machine = {
  format: "mark1russell7.machine/1",
  id: "example.machine.ping",
  title: "A connection with a keepalive ping",
  layer: "self",
  version: "1.0.0",
  sources: SOURCES,
  states: { idle: { initial: true }, waiting: {}, closed: { final: true } },
  events: {
    open: { kind: "app" },
    "timer.keepalive": { kind: "timer" },
    "tx.ping": { kind: "tx" },
    "rx.ack": { kind: "rx" },
    "timer.ping-timeout": { kind: "timer" },
  },
  knobs: {
    interval: { key: "interval", scope: "connection", unit: "s", default: 10 },
    timeout: { key: "timeout", scope: "connection", unit: "ms", default: 500 },
  },
  timers: {
    keepalive: { duration: { knob: "interval", unit: "s" }, arms: ["enter:waiting", "rx.ack"], fires: "timer.keepalive" },
    ping: { duration: { knob: "timeout", unit: "ms" }, arms: ["tx.ping"], cancels: ["rx.ack"], fires: "timer.ping-timeout" },
  },
  transitions: [
    { id: "ping.open", from: "idle", to: "waiting", on: "open" },
    { id: "ping.send", from: "waiting", to: "waiting", on: "timer.keepalive", emits: ["tx.ping"] },
    { id: "ping.dead", from: "waiting", to: "closed", on: "timer.ping-timeout" },
  ],
};

/** This function starts a run on a fake clock, and keeps each transition that it takes. */
const started = (doc: Machine, options: { state?: string; instance?: string } = {}) => {
  const clock = fakeClock();
  const records: Transition[] = [];
  const run = runMachine(doc, { clock, ...options, onTransition: (transition) => records.push(transition) });
  return { clock, records, run };
};

describe("runMachine: the documents of the tests", () => {
  it("are valid documents", () => {
    for (const doc of [LOCK, RETRY, PING]) {
      expect(machineSchema.safeParse(doc).success).toBe(true);
      expect(machineProblems(doc)).toEqual([]);
    }
  });
});

describe("runMachine: the lock", () => {
  it("stays in loading for two loads 1500 ms apart, and arms after 2000 ms of quiet", async () => {
    const { clock, records, run } = started(LOCK);
    expect(run.state).toBe("loading");
    run.send("start");
    run.send("stop");
    await clock.advance(1500);
    run.send("start");
    run.send("stop");
    await clock.advance(1999);
    expect(run.state).toBe("loading");
    await clock.advance(1);
    expect(run.state).toBe("armed");
    expect(records).toEqual([{ machine: LOCK.id, instance: LOCK.id, from: "loading", on: "settled", to: "armed", at: 3500 }]);
    expect(clock.pending).toBe(0);
    expect(replay(LOCK, records, { machine: LOCK.id })).toEqual([]);
  });

  it("starts the timer again on a second arm event: the quiet time counts from the last stop", async () => {
    const { clock, run } = started(LOCK);
    run.send("stop");
    await clock.advance(1500);
    run.send("stop");
    expect(clock.pending).toBe(1);
    await clock.advance(1999);
    expect(run.state).toBe("loading");
    await clock.advance(1);
    expect(run.state).toBe("armed");
  });

  it("stops the timer on a cancel event: a load that does not stop keeps the lock in loading", async () => {
    const { clock, run } = started(LOCK);
    run.send("stop");
    await clock.advance(1000);
    run.send("start");
    expect(clock.pending).toBe(0);
    await clock.advance(10_000);
    expect(run.state).toBe("loading");
  });

  it("gives the taken transition, or undefined, and an event without a transition still operates the timers", async () => {
    const { clock, records, run } = started(LOCK, { instance: "tab-1" });
    expect(run.send("stop")).toBeUndefined();
    expect(clock.pending).toBe(1);
    expect(run.send("press")).toBe(LOCK.transitions[0]);
    expect(run.state).toBe("armed");
    expect(clock.pending).toBe(0);
    await clock.advance(500);
    expect(run.send("reload")).toBe(LOCK.transitions[1]);
    expect(run.send("reload")).toBeUndefined();
    expect(records).toEqual([
      { machine: LOCK.id, instance: "tab-1", from: "loading", on: "press", to: "armed", at: 0 },
      { machine: LOCK.id, instance: "tab-1", from: "armed", on: "reload", to: "loading", at: 500 },
    ]);
    expect(replay(LOCK, records)).toEqual([]);
  });

  it("reads the knob values of the options, and a knob at its off value starts no timer", async () => {
    const quick = started(LOCK);
    const fast = runMachine(LOCK, { clock: quick.clock, values: () => ({ value: 1, unit: "s" }) });
    fast.send("stop");
    await quick.clock.advance(1000);
    expect(fast.state).toBe("armed");

    const OFF: Machine = { ...LOCK, knobs: { settle: { key: "settle", scope: "lock", unit: "ms", default: 0, off: 0 } } };
    const off = started(OFF);
    off.run.send("stop");
    expect(off.clock.pending).toBe(0);
    const never = runMachine(LOCK, { clock: off.clock, values: () => ({ value: "infinite", unit: "ms" }) });
    never.send("stop");
    expect(off.clock.pending).toBe(0);
    await off.clock.advance(1e9);
    expect([off.run.state, never.state]).toEqual(["loading", "loading"]);
  });

  it("stops each timer on stop(), and later sends do nothing", async () => {
    const { clock, records, run } = started(LOCK);
    run.send("stop");
    run.stop();
    expect(clock.pending).toBe(0);
    expect(run.send("press")).toBeUndefined();
    await clock.advance(5000);
    expect(run.state).toBe("loading");
    expect(records).toEqual([]);
  });
});

describe("runMachine: a backoff timer", () => {
  it("waits longer after each firing, resets its count on a reset event, and stops in a final state", async () => {
    const { clock, records, run } = started(RETRY);
    run.send("begin");
    await clock.advance(1500);
    // the waits are 100, 200, 400 and 800 ms
    expect(records.filter((record) => record.on === "retry").map((record) => record.at)).toEqual([100, 300, 700, 1500]);
    run.send("ok");
    expect(run.state).toBe("idle");
    expect(clock.pending).toBe(0);
    // the count is 0 again, thus the first wait is 100 ms again
    run.send("begin");
    await clock.advance(100);
    expect(records.at(-1)).toMatchObject({ on: "retry", at: 1600 });
    expect(clock.pending).toBe(1);
    expect(run.send("end")).toBe(RETRY.transitions[3]);
    expect(run.state).toBe("done");
    expect(clock.pending).toBe(0);
    expect(run.send("begin")).toBeUndefined();
    expect(replay(RETRY, records)).toEqual([]);
  });
});

describe("runMachine: entries, emitted events and units", () => {
  it("arms on the entry to a state, arms on an emitted event, and converts seconds to milliseconds exactly", async () => {
    const { clock, records, run } = started(PING);
    run.send("open");
    await clock.advance(10_000);
    // the keepalive fired at 10 s: its ping arms the timeout of 500 ms, and the entry to waiting arms the next keepalive
    expect(records.at(-1)).toMatchObject({ from: "waiting", on: "timer.keepalive", to: "waiting", at: 10_000 });
    expect(clock.pending).toBe(2);
    await clock.advance(200);
    run.send("rx.ack");
    expect(clock.pending).toBe(1);
    await clock.advance(10_000);
    expect(records.at(-1)).toMatchObject({ on: "timer.keepalive", at: 20_200 });
    await clock.advance(500);
    expect(run.state).toBe("closed");
    expect(records.at(-1)).toMatchObject({ on: "timer.ping-timeout", to: "closed", at: 20_700 });
    expect(clock.pending).toBe(0);
    expect(replay(PING, records)).toEqual([]);
  });

  it("enters its start state at the start: a timer that the entry arms starts at once", () => {
    const { clock, run } = started(PING, { state: "waiting" });
    expect(run.state).toBe("waiting");
    expect(clock.pending).toBe(1);
    expect(started(PING).clock.pending).toBe(0);
  });

  it("stops a timer on an event that both arms and cancels it, as detection does", () => {
    const BOTH: Machine = {
      ...LOCK,
      timers: { settle: { duration: { knob: "settle", unit: "ms" }, arms: ["stop", "start"], cancels: ["start"], fires: "settled" } },
    };
    const { clock, run } = started(BOTH);
    run.send("stop");
    run.send("start");
    expect(clock.pending).toBe(0);
  });
});

describe("runMachine: the start and the errors", () => {
  it("starts in the state of the options, and refuses a state that the document does not have", () => {
    expect(started(LOCK, { state: "armed" }).run.state).toBe("armed");
    expect(() => started(LOCK, { state: "open" })).toThrow("A lock that arms after a quiet time has no state open");
  });

  it("needs the state of the options for a document with no initial state or two", () => {
    const NONE: Machine = { ...LOCK, states: { loading: {}, armed: {} } };
    const TWO: Machine = { ...LOCK, states: { loading: { initial: true }, armed: { initial: true } } };
    expect(() => started(NONE)).toThrow("no initial state");
    expect(() => started(TWO)).toThrow("has 2 initial states");
    expect(started(NONE, { state: "armed" }).run.state).toBe("armed");
    expect(started(TWO, { state: "loading" }).run.state).toBe("loading");
  });

  it("throws on an event that the document does not name, also after stop()", () => {
    const { run } = started(LOCK);
    expect(() => run.send("unlock")).toThrow("A lock that arms after a quiet time has no event unlock");
    // an own key only: a name of Object.prototype is not an event
    expect(() => run.send("toString")).toThrow("has no event toString");
    run.stop();
    expect(() => run.send("unlock")).toThrow("has no event unlock");
  });

  it("refuses a document with problems, and a timer whose first duration is not known", () => {
    const BROKEN: Machine = { ...LOCK, transitions: [{ id: "lock.arm", from: "loading", to: "open", on: "press" }] };
    expect(() => started(BROKEN)).toThrow("has problems: lock.arm: to open");
    expect(() => runMachine(LOCK, { clock: fakeClock(), values: () => undefined })).toThrow(
      "A lock that arms after a quiet time's settle has no known duration: nothing gives settle's value",
    );
  });

  it("is in the root of the package too", () => {
    expect(root.runMachine).toBe(runMachine);
  });
});

describe("runMachine: each run of the lock replays against its document", () => {
  type Step = { readonly send: string } | { readonly wait: number };
  const STEPS: readonly Step[] = [
    { send: "start" },
    { send: "stop" },
    { send: "press" },
    { send: "reload" },
    { wait: 1000 },
    { wait: 2500 },
  ];
  /** This function gives each sequence of steps of the length `length`. */
  const sequences = (length: number): Step[][] =>
    length === 0 ? [[]] : sequences(length - 1).flatMap((head) => STEPS.map((step) => [...head, step]));

  it("gives no problem of the replay, and keeps at most one timer, for each sequence of 4 steps or fewer", async () => {
    let runs = 0;
    for (let length = 1; length <= 4; length += 1) {
      for (const sequence of sequences(length)) {
        const { clock, records, run } = started(LOCK);
        for (const step of sequence) {
          if ("send" in step) run.send(step.send);
          else await clock.advance(step.wait);
          expect(clock.pending).toBeLessThanOrEqual(1);
        }
        expect(replay(LOCK, records)).toEqual([]);
        expect(run.state).toBe(records.at(-1)?.to ?? "loading");
        run.stop();
        expect(clock.pending).toBe(0);
        runs += 1;
      }
    }
    expect(runs).toBe(6 + 36 + 216 + 1296);
  });
});
