import { describe, expect, it } from "vitest";
import type { Machine } from "./machine.ts";
import { exprKnobs, fromStates, machineProblems, readsFired } from "./machine.ts";
import { machineSchema } from "./schema.ts";

// The schema and the consistency checks on a small machine that this file writes. The real
// documents, and their checks, are in @mark1russell7/machines.

/** a link: it comes up, a timer of a backoff tries it again, and a driver on it sets its knobs */
const LINK: Machine = {
  format: "mark1russell7.machine/1",
  id: "test.machine.link",
  title: "A link",
  layer: "kernel",
  version: "1",
  sources: [{ ref: "this test", rung: "derived" }],
  states: { DOWN: { initial: true }, UP: {}, GONE: { final: true } },
  events: { "rx.hello": { kind: "rx" }, "timer.retry": { kind: "timer" }, "timer.idle": { kind: "timer" }, "app.close": { kind: "app" } },
  knobs: {
    base: { key: "retry_base", scope: "socket", unit: "ms", default: 100 },
    idle: { key: "idle_time", scope: "socket", unit: "s", default: 60 },
    loose: { key: "loose", scope: "netns", unit: null, default: 1, note: "a switch: no amount" },
  },
  timers: {
    retry: {
      duration: { expr: "base * pow(2, fired)", unit: "ms" },
      arms: ["enter:DOWN"],
      fires: "timer.retry",
      backoff: { resets: ["rx.hello"] },
    },
    idle: { duration: { knob: "idle", unit: "s" }, arms: ["enter:UP", "rx.hello"], fires: "timer.idle" },
  },
  realizes: { "test.mechanism.idle": { timer: "idle" } },
  transitions: [
    { id: "retry", from: "DOWN", on: "timer.retry", to: "DOWN" },
    { id: "up", from: "DOWN", on: "rx.hello", to: "UP" },
    { id: "idle", from: "UP", on: "timer.idle", to: "DOWN", timer: "idle" },
    { id: "close", from: "*", on: "app.close", to: "GONE" },
  ],
  observe: { trace: { states: { down: "DOWN", up: "UP" }, fidelity: "complete" } },
};

/** a driver on the link: each state of the driver is on a state of the link */
const DRIVER: Machine = {
  format: "mark1russell7.machine/1",
  id: "test.machine.driver",
  title: "A driver",
  layer: "driver",
  version: "1",
  sources: [{ ref: "this test", rung: "derived" }],
  states: { waiting: { initial: true }, ready: {} },
  events: { "link.end": { kind: "local" }, "link.up": { kind: "local" } },
  knobs: { delay: { key: "delay", scope: "client", unit: "ms", default: 250 } },
  timers: {},
  over: { machine: LINK.id, states: { waiting: "DOWN", ready: "UP" }, sets: { base: { knob: "delay", unit: "ms" } }, ends: "link.end" },
  transitions: [
    { id: "up", from: "waiting", on: "link.up", to: "ready" },
    { id: "end", from: "ready", on: "link.end", to: "waiting" },
  ],
};

describe("a machine document", () => {
  it("is a consistent mark1russell7.machine/1 document, and the schema refuses another format", () => {
    for (const doc of [LINK, DRIVER]) {
      expect(machineSchema.safeParse(doc).success, doc.id).toBe(true);
      expect(machineProblems(doc), doc.id).toEqual([]);
    }
    // the format is a contract: a document in another format is refused
    expect(machineSchema.safeParse({ ...LINK, format: "another.machine/1" }).success).toBe(false);
    // and so is a part that the format does not have
    expect(machineSchema.safeParse({ ...LINK, colour: "red" }).success).toBe(false);
    expect(machineSchema.safeParse({ ...LINK, layer: "planet" }).success).toBe(false);
  });

  it("reads the states of a transition, and the knobs of a duration", () => {
    expect(fromStates(LINK, "*")).toEqual(["DOWN", "UP"]);
    expect(fromStates(LINK, ["UP", "GONE"])).toEqual(["UP", "GONE"]);
    expect(exprKnobs({ expr: "base * pow(2, fired) + max(idle, 1)", unit: "ms" })).toEqual(["base", "idle"]);
    expect(exprKnobs({ model: "linux.wheel", knobs: ["idle", "hz"], unit: "s" })).toEqual(["idle", "hz"]);
    expect(readsFired({ expr: "base * pow(2, fired)", unit: "ms" })).toBe(true);
    expect(readsFired({ knob: "base", unit: "ms" })).toBe(false);
  });

  it("finds each state, event, timer and knob that the document names and does not have", () => {
    const wrong: Machine = {
      ...LINK,
      states: { ...LINK.states, DOWN: {} },
      timers: {
        ...LINK.timers,
        stray: { duration: { knob: "loose", unit: "s" }, arms: [], fires: "timer.nonesuch" },
        lost: { duration: { knob: "nonesuch", unit: "s" }, arms: [], fires: "timer.idle" },
      },
      realizes: { "test.mechanism.gone": { timer: "nonesuch" }, "test.mechanism.wait": { duration: { expr: "fired", unit: "s" } } },
      transitions: [
        ...LINK.transitions,
        { id: "jump", from: "NOWHERE", on: "rx.nonesuch", to: "LIMBO", timer: "nonesuch" },
        { id: "up", from: "DOWN", on: "rx.hello", to: "UP" },
      ],
      observe: { trace: { states: { lost: "LIMBO" }, fidelity: "lossy" } },
    };
    expect(machineProblems(wrong)).toEqual([
      "no initial state",
      "jump: from NOWHERE",
      "jump: to LIMBO",
      "jump: event rx.nonesuch",
      "jump: timer nonesuch",
      "timer stray: fires timer.nonesuch",
      "timer stray: knob loose is not an amount",
      "timer lost: knob nonesuch",
      "realizes test.mechanism.gone: timer nonesuch",
      "realizes test.mechanism.wait: reads fired, which only a backoff timer counts",
      "observe trace: LIMBO",
      "transition up twice",
    ]);
  });

  it("checks what a machine says of the machine it runs on: its states, its end, what it sets", () => {
    const wrong: Machine = {
      ...DRIVER,
      over: {
        machine: LINK.id,
        states: { asleep: "UP" },
        sets: { base: { knob: "nonesuch", unit: "ms" }, idle: { expr: "fired", unit: "s" } },
        ends: "link.vanished",
      },
    };
    expect(machineProblems(wrong)).toEqual([
      "over: state asleep",
      "over: ends link.vanished",
      "over: sets base from knob nonesuch",
      "over: sets idle from fired, which is no knob",
    ]);
  });

  it("lets only a timer with a backoff read how many times it has fired", () => {
    expect(LINK.timers["retry"]?.backoff).toEqual({ resets: ["rx.hello"] });
    const wrong: Machine = {
      ...LINK,
      knobs: { ...LINK.knobs, fired: { key: "fired", scope: "socket", unit: "count", default: 0 } },
      timers: {
        ...LINK.timers,
        retry: { ...LINK.timers["retry"]!, backoff: undefined },
        idle: { ...LINK.timers["idle"]!, backoff: { resets: ["rx.nonesuch"] } },
      },
    };
    expect(machineProblems(wrong)).toEqual([
      "knob fired: the name is a backoff timer's count of its firings",
      "timer retry: reads fired, but has no backoff",
      "timer idle: backoff resets on rx.nonesuch",
    ]);
  });
});
