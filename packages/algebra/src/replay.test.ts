import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as root from "./index.ts";
import type { Machine } from "./machine.ts";
import { machineProblems, machineSchema } from "./machine.ts";
import type { Transition } from "./replay.ts";
import { replay } from "./replay.ts";

/** A machine of another program, with its own names: a door, with "*" for each state that is not final. */
const DOOR: Machine = {
  format: "mark1russell7.machine/1",
  id: "example.machine.door",
  title: "A door",
  layer: "self",
  version: "1.0.0",
  sources: [{ ref: "a test", rung: "derived" }],
  states: { CLOSED: { initial: true }, OPEN: {}, LOCKED: {}, GONE: { final: true } },
  events: { open: { kind: "app" }, close: { kind: "app" }, lock: { kind: "app" }, unlock: { kind: "app" }, burn: { kind: "local" } },
  knobs: {},
  timers: {},
  transitions: [
    { id: "open", from: "CLOSED", on: "open", to: "OPEN" },
    { id: "close", from: "OPEN", on: ["close", "lock"], to: "CLOSED" },
    { id: "lock", from: "CLOSED", on: "lock", to: "LOCKED" },
    { id: "unlock", from: "LOCKED", on: "unlock", to: "CLOSED" },
    { id: "burn", from: "*", on: "burn", to: "GONE" },
  ],
};

const step = (instance: string, from: string, on: string, to: string, machine = DOOR.id): Transition => ({ machine, instance, from, on, to });

describe("replay: a trace against a machine document with its own names", () => {
  it("is a valid document", () => {
    expect(machineSchema.safeParse(DOOR).success).toBe(true);
    expect(machineProblems(DOOR)).toEqual([]);
  });

  it("accepts a trace that the document permits, each instance on its own, with the state * and a list of events", () => {
    const trace = [
      step("front", "CLOSED", "open", "OPEN"),
      step("back", "CLOSED", "lock", "LOCKED"),
      step("front", "OPEN", "lock", "CLOSED"),
      step("back", "LOCKED", "burn", "GONE"),
      step("front", "CLOSED", "burn", "GONE"),
    ];
    expect(replay(DOOR, trace)).toEqual([]);
  });

  it("gives each disagreement: a transition that the document does not have, a jump, and a state that is not in it", () => {
    expect(replay(DOOR, [step("front", "CLOSED", "unlock", "OPEN")])).toEqual([
      "front: example.machine.door has no transition from CLOSED on unlock to OPEN",
    ]);
    expect(replay(DOOR, [step("front", "CLOSED", "open", "OPEN"), step("front", "CLOSED", "open", "OPEN")])).toEqual([
      "front: the runtime left CLOSED on open, but the replay is in OPEN",
    ]);
    expect(replay(DOOR, [step("front", "AJAR", "close", "CLOSED")])).toEqual([
      "front: the state AJAR is not in example.machine.door",
      "front: example.machine.door has no transition from AJAR on close to CLOSED",
    ]);
    // a final state leaves on nothing, not even on "*"
    expect(replay(DOOR, [step("front", "GONE", "burn", "GONE")])).toEqual([
      "front: example.machine.door has no transition from GONE on burn to GONE",
    ]);
  });

  it("replays only the transitions of one machine, by its name, when the options name it", () => {
    const trace = [step("front", "CLOSED", "open", "OPEN"), step("front", "UP", "go", "DOWN", "example.machine.lift")];
    expect(replay(DOOR, trace)).toHaveLength(2);
    expect(replay(DOOR, trace, { machine: DOOR.id })).toEqual([]);
    expect(replay(DOOR, trace, { machine: "nothing" })).toEqual([]);
  });

  it("takes a document with only the parts that it reads, and a trace without names or times", () => {
    const doc = { id: "tiny", states: { A: {}, B: {} }, transitions: [{ id: "go", from: "A", on: "go", to: "B" }] };
    expect(replay(doc, [{ instance: "x", from: "A", on: "go", to: "B" }])).toEqual([]);
  });

  it("is in the root of the package too", () => {
    expect(root.replay).toBe(replay);
  });
});

const here = dirname(fileURLToPath(import.meta.url));

/** This function follows the imports of a module that load code at run time, and gives the packages that it reaches. */
const packagesOf = (entry: string): string[] => {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(/^(import|export)\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gms)) {
      if (match[2] !== undefined) continue;
      if (match[3]!.startsWith(".")) visit(resolve(dirname(file), match[3]!));
      else packages.add(match[3]!);
    }
  };
  visit(join(here, entry));
  return [...packages].sort();
};

describe("the entry @mark1russell7/algebra/replay", () => {
  it("loads no other package: no zod, no quantity", () => {
    expect(packagesOf("replay.ts")).toEqual([]);
    expect(packagesOf("index.ts")).toContain("zod");
  });
});
