// The entry "@mark1russell7/algebra/schema": the zod schema of a machine document. The root entry
// of the package does not import zod.
import { unitSchema } from "@mark1russell7/quantity/schema";
import { z } from "zod";
import type { Expr, Machine, Realization } from "./machine.ts";

// each time or count that a machine stores is a canonical unit: a jiffy among them, measured by
// the HZ of the kernel
const unit = unitSchema(["time", "count"]);
// a knob can also be a frequency: the HZ of the kernel itself, which the timer wheel counts in
const knobUnit = unitSchema(["time", "count", "frequency"]);

const expr: z.ZodType<Expr> = z.union([
  z.strictObject({ const: z.number(), unit }),
  z.strictObject({ knob: z.string(), unit }),
  z.strictObject({ expr: z.string(), unit }),
  z.strictObject({ model: z.string(), knobs: z.array(z.string()), unit }),
]);

const timer = z.strictObject({
  duration: expr,
  /** This expression is how late the timer can fire, a tolerance on one side. */
  lateness: expr.optional(),
  /** This expression is how early the timer can fire, for example one jiffy. */
  early: expr.optional(),
  /** These are the events, or "enter:<STATE>", that start the timer or start it again. */
  arms: z.array(z.string()),
  cancels: z.array(z.string()).optional(),
  /** This event is the event that the timer raises. */
  fires: z.string(),
  /** A backoff timer starts again after it fires, and its waits read `fired`. */
  backoff: z.strictObject({ resets: z.array(z.string()) }).optional(),
  note: z.string().optional(),
});

const realization: z.ZodType<Realization> = z.union([
  z.strictObject({ timer: z.string() }),
  z.strictObject({
    duration: expr,
    lateness: expr.optional(),
    early: expr.optional(),
    note: z.string().optional(),
  }),
]);

const oneOrMany = z.union([z.string(), z.array(z.string())]);

const transition = z.strictObject({
  id: z.string(),
  /** The state "*" is each state that is not final. */
  from: oneOrMany,
  to: z.string(),
  on: oneOrMany,
  guard: z.string().optional(),
  timer: z.string().optional(),
  emits: z.array(z.string()).optional(),
  errno: z.string().optional(),
  note: z.string().optional(),
  /** This text is the file and line, or the section of a specification, that the transition comes from. */
  source: z.string().optional(),
});

/** These are the layers that a machine is seen from: the vantage layers of a trace. */
const VANTAGES = [
  "wire",
  "kernel",
  "middlebox",
  "proxy",
  "driver",
  "server",
  "canary",
  "injector",
  "self",
] as const;

/** This schema accepts a machine document. */
export const machineSchema: z.ZodType<Machine> = z.strictObject({
  format: z.literal("mark1russell7.machine/1"),
  id: z.string(),
  title: z.string(),
  layer: z.enum(VANTAGES),
  version: z.string(),
  /** These are the conditions where the machine holds: a range of kernels, an architecture. */
  conditions: z.record(z.string(), z.string()).optional(),
  sources: z.array(
    z.strictObject({
      ref: z.string(),
      rung: z.enum(["normative", "implemented", "documented", "observed", "derived"]),
      note: z.string().optional(),
    }),
  ),
  states: z.record(
    z.string(),
    z.strictObject({
      initial: z.boolean().optional(),
      final: z.boolean().optional(),
      pseudo: z.boolean().optional(),
      note: z.string().optional(),
    }),
  ),
  events: z.record(
    z.string(),
    z.strictObject({
      kind: z.enum(["rx", "tx", "app", "timer", "local", "packet", "peer"]),
      note: z.string().optional(),
    }),
  ),
  /**
   * These are the names of the machine for the knobs that its timers and guards read. Each has
   * its key in its system, as a knob in a corpus has.
   */
  knobs: z.record(
    z.string(),
    z.strictObject({
      key: z.string(),
      scope: z.string(),
      /** The unit is null for a switch or a choice (nf_conntrack_tcp_loose), whose default is its code. */
      unit: knobUnit.nullable(),
      default: z.number().nullable(),
      /**
       * This value turns the knob's timers off, in the unit of the knob: Redis's timeout 0 closes no
       * client. A time that reads the knob at that value has no bound, in each expression.
       */
      off: z.number().optional(),
      note: z.string().optional(),
    }),
  ),
  timers: z.record(z.string(), timer),
  realizes: z.record(z.string(), realization).optional(),
  over: z
    .strictObject({
      machine: z.string(),
      states: z.record(z.string(), z.string()),
      sets: z.record(z.string(), expr),
      ends: z.string(),
      note: z.string().optional(),
    })
    .optional(),
  transitions: z.array(transition),
  /** This map tells what a source shows of the machine: its states as the source names them, and what it hides. */
  observe: z
    .record(
      z.string(),
      z.strictObject({
        states: z.record(z.string(), z.string()),
        hides: z.array(z.string()).optional(),
        fidelity: z.enum(["complete", "sampled", "lossy", "derived"]),
        note: z.string().optional(),
      }),
    )
    .optional(),
  generated: z.strictObject({ from: z.string(), by: z.string() }).optional(),
});
