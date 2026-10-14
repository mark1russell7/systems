import { unitSchema } from "@mark1russell7/quantity";
import { z } from "zod";

/**
 * `mark1russell7.machine/1` is a state machine as data.
 *
 * One document describes one machine, and three readers share it: the conformance checker
 * (states, transitions, observer mappings), the algebra (the closed forms of timers over knobs)
 * and the simulator (the arm, cancel and fire events of timers). The format is small on purpose:
 * no hierarchy, no actions other than `emits`, and guards as documented text.
 */

/** A unit is a unit that @mark1russell7/quantity stores: a time or a count, which is all that the timers of a machine read. */
export type Unit = string;

/** An expression is a duration: a constant, a knob, arithmetic over knobs, or a named model of them. */
export type Expr =
  | { readonly const: number; readonly unit: Unit }
  | { readonly knob: string; readonly unit: Unit }
  /** This text is arithmetic over knob names: + - * / min max floor ceil ( ) */
  | { readonly expr: string; readonly unit: Unit }
  /** This name is a named model of the algebra over these knobs, for example the retransmission ladder. */
  | { readonly model: string; readonly knobs: readonly string[]; readonly unit: Unit };

/** A timer has a duration, the events that arm and cancel it, and the event that it fires. */
export interface Timer {
  readonly duration: Expr;
  readonly lateness?: Expr | undefined;
  readonly early?: Expr | undefined;
  readonly arms: readonly string[];
  readonly cancels?: readonly string[] | undefined;
  readonly fires: string;
  /**
   * A backoff timer starts again after it fires, and each wait is longer than the last. Examples
   * are the retransmission timer of the kernel and the reconnect of a driver. Its duration, lateness and
   * early bound are those of one wait. They can read `fired`: the number of times that it fired
   * after the last of its `resets`.
   */
  readonly backoff?: { readonly resets: readonly string[] } | undefined;
  readonly note?: string | undefined;
}

/**
 * This name is what the waits of a backoff timer read for the number of times that it fired after
 * a reset, from 0. It is not a knob, because nothing sets it. It is the count of the timer itself.
 */
export const FIRED = "fired";

/**
 * A realization tells how long a mechanism takes where the machine operates. It is one of the
 * timers of the machine, whole, or a time of its own over the knobs of the machine. It has a
 * lateness and an early bound, as a timer has. The idle refresh of the Redis server is the idle
 * time of its keepalive, rounded on the timer wheel of the kernel. That is the first firing of its
 * keepalive timer, not the whole timer.
 */
export type Realization =
  | { readonly timer: string }
  | {
      readonly duration: Expr;
      readonly lateness?: Expr | undefined;
      readonly early?: Expr | undefined;
      readonly note?: string | undefined;
    };

/**
 * An over tells the machine that this machine operates on, and how: a driver on its kernel socket.
 * Each state of this machine is on a state of the lower machine. Some knobs of this machine set
 * knobs of the lower machine. The end of the lower machine arrives as an event of this machine.
 *
 * The driver ioredis 6 sets the keepalive idle time of the kernel from its keepAlive option,
 * through setKeepAlive of Node. That function also sets the probe interval and count. The driver
 * learns of the end of the socket as stream.close.
 */
export interface Over {
  /** This identifier is the machine below, as a graph identifies its document. */
  readonly machine: string;
  /** This map gives the state of the lower machine that each state of this machine is on. */
  readonly states: Readonly<Record<string, string>>;
  /** These are the knobs of the lower machine that this machine sets, by their lower names, over its own knobs. */
  readonly sets: Readonly<Record<string, Expr>>;
  /** This event is the event of this machine that the end of the lower machine arrives as. */
  readonly ends: string;
  readonly note?: string | undefined;
}

/** A transition goes from one or more states to a state, on one or more events. */
export interface TransitionDef {
  readonly id: string;
  readonly from: string | readonly string[];
  readonly to: string;
  readonly on: string | readonly string[];
  readonly guard?: string | undefined;
  readonly timer?: string | undefined;
  readonly emits?: readonly string[] | undefined;
  readonly errno?: string | undefined;
  readonly note?: string | undefined;
  readonly source?: string | undefined;
}

/** A vantage is the layer that a machine is seen from. */
export type Vantage =
  "wire" | "kernel" | "middlebox" | "proxy" | "driver" | "server" | "canary" | "injector" | "self";

/** A machine is one state machine document. */
export interface Machine {
  readonly format: "mark1russell7.machine/1";
  readonly id: string;
  readonly title: string;
  readonly layer: Vantage;
  readonly version: string;
  readonly conditions?: Readonly<Record<string, string>> | undefined;
  readonly sources: ReadonlyArray<{
    readonly ref: string;
    readonly rung: "normative" | "implemented" | "documented" | "observed" | "derived";
    readonly note?: string | undefined;
  }>;
  readonly states: Readonly<
    Record<
      string,
      {
        readonly initial?: boolean | undefined;
        readonly final?: boolean | undefined;
        readonly pseudo?: boolean | undefined;
        readonly note?: string | undefined;
      }
    >
  >;
  readonly events: Readonly<
    Record<
      string,
      {
        readonly kind: "rx" | "tx" | "app" | "timer" | "local" | "packet" | "peer";
        readonly note?: string | undefined;
      }
    >
  >;
  readonly knobs: Readonly<
    Record<
      string,
      {
        readonly key: string;
        readonly scope: string;
        readonly unit: Unit | null;
        readonly default: number | null;
        readonly note?: string | undefined;
      }
    >
  >;
  readonly timers: Readonly<Record<string, Timer>>;
  /** These are the mechanisms whose time this machine gives, by the identifier of each mechanism. */
  readonly realizes?: Readonly<Record<string, Realization>> | undefined;
  /** This is the machine that this machine operates on, for a machine on another machine. */
  readonly over?: Over | undefined;
  readonly transitions: readonly TransitionDef[];
  readonly observe?:
    | Readonly<
        Record<
          string,
          {
            readonly states: Readonly<Record<string, string>>;
            readonly hides?: readonly string[] | undefined;
            readonly fidelity: "complete" | "sampled" | "lossy" | "derived";
            readonly note?: string | undefined;
          }
        >
      >
    | undefined;
  readonly generated?: { readonly from: string; readonly by: string } | undefined;
}

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

/** This function gives one value or many values as an array. */
export const arr = <T>(value: T | readonly T[]): readonly T[] =>
  Array.isArray(value) ? (value as readonly T[]) : [value as T];

/** This function gives the names that a duration reads: its knobs, by the names of the machine, and `fired`. */
const exprNames = (e: Expr): string[] => {
  if ("knob" in e) return [e.knob];
  if ("model" in e) return [...e.knobs];
  if ("expr" in e) {
    return (e.expr.match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? []).filter(
      (word) => !["min", "max", "floor", "ceil"].includes(word),
    );
  }
  return [];
};

/** This function gives the knobs that a duration reads, by the names of the machine for them. */
export const exprKnobs = (e: Expr): string[] => exprNames(e).filter((name) => name !== FIRED);

/** This function tells if a duration reads the number of times that its timer fired, as the waits of a backoff do. */
export const readsFired = (e: Expr): boolean => exprNames(e).includes(FIRED);

/** This function gives the states that a transition leaves. The state "*" is each state that is not final. */
export const fromStates = (m: Machine, from: string | readonly string[]): string[] => {
  const out = new Set<string>();
  for (const state of arr(from)) {
    if (state !== "*") out.add(state);
    else for (const [name, def] of Object.entries(m.states)) if (def.final !== true) out.add(name);
  }
  return [...out];
};

/**
 * This function gives the problems in the consistency of a document. Each state, event, timer and
 * knob that it refers to must exist, and it must have an initial state. A reader refuses a
 * machine with problems, and does not draw half of it.
 */
export const machineProblems = (m: Machine): string[] => {
  const problems: string[] = [];
  const states = new Set(Object.keys(m.states));
  if (!Object.values(m.states).some((state) => state.initial === true)) {
    problems.push("no initial state");
  }
  for (const t of m.transitions) {
    for (const from of arr(t.from)) {
      if (from !== "*" && !states.has(from)) problems.push(`${t.id}: from ${from}`);
    }
    if (!states.has(t.to)) problems.push(`${t.id}: to ${t.to}`);
    for (const event of arr(t.on))
      if (m.events[event] === undefined) problems.push(`${t.id}: event ${event}`);
    if (t.timer !== undefined && m.timers[t.timer] === undefined) {
      problems.push(`${t.id}: timer ${t.timer}`);
    }
  }
  if (m.knobs[FIRED] !== undefined)
    problems.push(`knob ${FIRED}: the name is a backoff timer's count of its firings`);
  for (const [id, tm] of Object.entries(m.timers)) {
    if (m.events[tm.fires] === undefined) problems.push(`timer ${id}: fires ${tm.fires}`);
    for (const knob of exprKnobs(tm.duration)) {
      const def = m.knobs[knob];
      if (def === undefined) problems.push(`timer ${id}: knob ${knob}`);
      // a duration is an amount, thus a switch or a choice cannot give it
      else if (def.unit === null) problems.push(`timer ${id}: knob ${knob} is not an amount`);
    }
    // only a timer that starts again has a count of its firings to read
    const reads = [tm.duration, tm.lateness, tm.early].some(
      (e) => e !== undefined && readsFired(e),
    );
    if (reads && tm.backoff === undefined)
      problems.push(`timer ${id}: reads ${FIRED}, but has no backoff`);
    for (const event of tm.backoff?.resets ?? [])
      if (!event.startsWith("enter:") && m.events[event] === undefined)
        problems.push(`timer ${id}: backoff resets on ${event}`);
  }
  for (const [mechanism, how] of Object.entries(m.realizes ?? {})) {
    if ("timer" in how) {
      // a machine on another machine can realize a timer of the machine below. Only a reader of
      // the two documents can examine that
      if (m.timers[how.timer] === undefined && m.over === undefined)
        problems.push(`realizes ${mechanism}: timer ${how.timer}`);
      continue;
    }
    if ([how.duration, how.lateness, how.early].some((e) => e !== undefined && readsFired(e)))
      problems.push(`realizes ${mechanism}: reads ${FIRED}, which only a backoff timer counts`);
    for (const knob of exprKnobs(how.duration)) {
      const def = m.knobs[knob];
      if (def === undefined) problems.push(`realizes ${mechanism}: knob ${knob}`);
      else if (def.unit === null)
        problems.push(`realizes ${mechanism}: knob ${knob} is not an amount`);
    }
  }
  if (m.over !== undefined) {
    for (const state of Object.keys(m.over.states)) {
      if (!states.has(state)) problems.push(`over: state ${state}`);
    }
    if (m.events[m.over.ends] === undefined) problems.push(`over: ends ${m.over.ends}`);
    for (const [lower, set] of Object.entries(m.over.sets)) {
      if (readsFired(set)) problems.push(`over: sets ${lower} from ${FIRED}, which is no knob`);
      for (const knob of exprKnobs(set)) {
        const def = m.knobs[knob];
        if (def === undefined) problems.push(`over: sets ${lower} from knob ${knob}`);
        else if (def.unit === null) problems.push(`over: sets ${lower} from ${knob}, no amount`);
      }
    }
  }
  for (const [source, view] of Object.entries(m.observe ?? {})) {
    for (const state of Object.values(view.states)) {
      if (!states.has(state)) problems.push(`observe ${source}: ${state}`);
    }
  }
  const ids = m.transitions.map((t) => t.id);
  for (const id of new Set(ids)) {
    if (ids.filter((other) => other === id).length > 1) problems.push(`transition ${id} twice`);
  }
  return problems;
};
