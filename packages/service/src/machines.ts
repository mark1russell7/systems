import type { Machine, TransitionDef } from "@mark1russell7/algebra";
import { arr, fromStates } from "@mark1russell7/algebra";
import type { ServiceDescription } from "./description.ts";
import type { LifecycleEvent, MachineName } from "./events.ts";

/**
 * The machines of the runtime as `mark1russell7.machine/1` documents. The documents are the
 * specification, and TypeScript implements them. A test records the transitions of the runtime
 * and replays them against each document, thus the code and the documents cannot disagree.
 */

const SOURCE = [{ ref: "packages/service/src (the runtime implements this document)", rung: "implemented" as const }];
const base = (id: string, title: string): Pick<Machine, "format" | "id" | "title" | "layer" | "version" | "sources"> => ({
  format: "mark1russell7.machine/1",
  id: `service.machine.${id}`,
  title,
  layer: "self",
  version: "0.2.0",
  sources: SOURCE,
});
const t = (
  id: string,
  from: string | readonly string[],
  on: string | readonly string[],
  to: string,
  extra: Partial<TransitionDef> = {},
): TransitionDef => ({ id, from, on, to, ...extra });

/**
 * The startup gate opens one time. The lifecycle moves it from `closed` to `starting` while its
 * components start. Then one warm-up sweep of each check opens it. A component that does not start
 * fails it for good.
 */
export const GATE_MACHINE: Machine = {
  ...base("gate", "The startup gate"),
  states: {
    closed: { initial: true },
    starting: { note: "the health server, then the dependencies, then the transports" },
    sweeping: { note: "one bounded warm-up sweep of each check" },
    open: { final: true },
    failed: { final: true },
  },
  events: {
    "startup.begin": { kind: "local" },
    "component.started": { kind: "local" },
    "mark-ready": { kind: "local" },
    "sweep.done": { kind: "local" },
    "startup.fail": { kind: "local" },
    "startup.over-budget": { kind: "timer" },
  },
  knobs: { startup: { key: "policies.startup", scope: "service", unit: "s", default: null } },
  timers: {
    startup_budget: {
      duration: { knob: "startup", unit: "s" },
      arms: ["enter:closed"],
      cancels: ["sweep.done", "startup.fail"],
      fires: "startup.over-budget",
      note: "the gate says that it is over its budget, and the startup probe of the platform acts on it",
    },
  },
  transitions: [
    t("begin", "closed", "startup.begin", "starting"),
    t("component", "starting", "component.started", "starting"),
    t("mark-ready", ["closed", "starting"], "mark-ready", "sweeping"),
    t("open", "sweeping", "sweep.done", "open"),
    t("fail", ["closed", "starting", "sweeping"], "startup.fail", "failed"),
    // the budget timer leaves each state where it is
    t("over-budget-closed", "closed", "startup.over-budget", "closed", { timer: "startup_budget" }),
    t("over-budget-starting", "starting", "startup.over-budget", "starting", { timer: "startup_budget" }),
    t("over-budget-sweeping", "sweeping", "startup.over-budget", "sweeping", { timer: "startup_budget" }),
  ],
};

/** A debounce latch counts the polls of its check in sequence. A readiness latch starts tripped. */
export const LATCH_MACHINE: Machine = {
  ...base("latch", "The latch of a policy, as a debounce"),
  states: {
    tripped: { initial: true, note: "a readiness latch starts here; a liveness latch starts released" },
    released: {},
  },
  events: { "poll.ok": { kind: "local" }, "poll.fail": { kind: "local" } },
  knobs: {
    fail_after: { key: "policies.<gate>.failAfter", scope: "check", unit: "count", default: null },
    recover_after: { key: "policies.<gate>.recoverAfter", scope: "check", unit: "count", default: null },
  },
  timers: {},
  transitions: [
    t("pass", "released", "poll.ok", "released"),
    t("fail-count", "released", "poll.fail", "released", { guard: "failures in sequence < fail_after" }),
    t("trip", "released", "poll.fail", "tripped", { guard: "failures in sequence >= fail_after" }),
    t("fail", "tripped", "poll.fail", "tripped"),
    t("pass-count", "tripped", "poll.ok", "tripped", { guard: "passes in sequence < recover_after" }),
    t("release", "tripped", "poll.ok", "released", { guard: "passes in sequence >= recover_after" }),
  ],
};

/**
 * A window latch measures time on the monotonic clock from the first failure of a sequence, and
 * from the first pass after a trip.
 */
export const WINDOW_MACHINE: Machine = {
  ...base("window", "The latch of a policy, as a window"),
  states: {
    released: { initial: true, note: "a liveness latch starts here; a readiness latch starts tripped" },
    failing: { note: "the fail window runs" },
    tripped: {},
    recovering: { note: "the recover window runs" },
  },
  events: {
    "poll.ok": { kind: "local" },
    "poll.fail": { kind: "local" },
    "window.failed": { kind: "timer" },
    "window.recovered": { kind: "timer" },
  },
  knobs: {
    fail_after: { key: "policies.<gate>.failAfter", scope: "check", unit: "s", default: null },
    recover_after: { key: "policies.<gate>.recoverAfter", scope: "check", unit: "s", default: null },
  },
  timers: {
    fail_window: {
      duration: { knob: "fail_after", unit: "s" },
      arms: ["enter:failing"],
      cancels: ["poll.ok"],
      fires: "window.failed",
    },
    recover_window: {
      duration: { knob: "recover_after", unit: "s" },
      arms: ["enter:recovering"],
      cancels: ["poll.fail"],
      fires: "window.recovered",
    },
  },
  transitions: [
    t("pass", "released", "poll.ok", "released"),
    t("start-failing", "released", "poll.fail", "failing", { guard: "fail_after > 0" }),
    t("trip-at-once", "released", "poll.fail", "tripped", { guard: "fail_after = 0" }),
    t("still-failing", "failing", "poll.fail", "failing"),
    t("stop-failing", "failing", "poll.ok", "released"),
    t("trip", "failing", "window.failed", "tripped", { timer: "fail_window" }),
    t("fail", "tripped", "poll.fail", "tripped"),
    t("release-at-once", "tripped", "poll.ok", "released", { guard: "recover_after is absent or 0" }),
    t("start-recovering", "tripped", "poll.ok", "recovering", { guard: "recover_after > 0" }),
    t("still-recovering", "recovering", "poll.ok", "recovering"),
    t("stop-recovering", "recovering", "poll.fail", "tripped"),
    t("release", "recovering", "window.recovered", "released", { timer: "recover_window" }),
  ],
};

/**
 * A poller starts one check on a jittered loop with a fixed delay. A call that outlives its timeout
 * stays pending (`hung`), and the poller does not start the check again until the call settles.
 */
export const POLLER_MACHINE: Machine = {
  ...base("poller", "The poller of a check"),
  states: {
    idle: { initial: true, note: "before the loop starts" },
    waiting: { note: "the loop timer runs, and no call is pending" },
    calling: { note: "a call runs, in its timeout" },
    hung: { note: "a call outlived its timeout, and it is still pending" },
    stopped: { final: true },
  },
  events: {
    start: { kind: "local" },
    sweep: { kind: "local" },
    tick: { kind: "timer" },
    answer: { kind: "local" },
    timeout: { kind: "timer" },
    "late-answer": { kind: "local" },
    stop: { kind: "local" },
  },
  knobs: {
    interval: { key: "checks.<name>.poll.interval", scope: "check", unit: "s", default: null },
    timeout: { key: "checks.<name>.poll.timeout", scope: "check", unit: "s", default: null },
  },
  timers: {
    loop: {
      duration: { knob: "interval", unit: "s" },
      arms: ["start", "tick"],
      cancels: ["stop"],
      fires: "tick",
      note: "the interval, with its jitter: a fixed delay from the start of each poll",
    },
    poll_timeout: {
      duration: { knob: "timeout", unit: "s" },
      arms: ["enter:calling"],
      cancels: ["answer", "stop"],
      fires: "timeout",
    },
  },
  transitions: [
    t("sweep", "idle", "sweep", "calling"),
    t("start", "idle", "start", "waiting"),
    t("start-while-calling", "calling", "start", "calling", { note: "a late check polls at once, then starts its loop" }),
    t("start-while-hung", "hung", "start", "hung"),
    t("tick", "waiting", "tick", "calling", { guard: "the force-fail list does not name the check" }),
    t("tick-forced", "waiting", "tick", "waiting", { guard: "the force-fail list names the check" }),
    t("tick-pending", "calling", "tick", "calling", { note: "the poll fails at once: its call is pending" }),
    t("tick-hung", "hung", "tick", "hung", { note: "the poll fails at once: its call is pending" }),
    t("answer-loop", "calling", "answer", "waiting", { guard: "the loop runs" }),
    t("answer-sweep", "calling", "answer", "idle", { guard: "the loop has not started" }),
    t("timeout", "calling", "timeout", "hung", { timer: "poll_timeout" }),
    t("late-answer-loop", "hung", "late-answer", "waiting", { guard: "the loop runs" }),
    t("late-answer-sweep", "hung", "late-answer", "idle", { guard: "the loop has not started" }),
    t("stop", ["idle", "waiting", "calling", "hung"], "stop", "stopped"),
    t("settle-after-stop", "stopped", ["answer", "late-answer", "timeout"], "stopped"),
  ],
};

/**
 * The exit manager is the only part that ends the process. The first exit request starts the
 * shutdown, and a later one has no effect. An error makes the exit code 1.
 */
export const EXIT_MACHINE: Machine = {
  ...base("exit", "The exit manager"),
  states: { running: { initial: true }, stopping: {}, exited: { final: true } },
  events: {
    "exit.request": { kind: "app", note: "SIGINT, SIGTERM, SIGQUIT or shutdown()" },
    "exit.repeat": { kind: "app" },
    "startup.fail": { kind: "local" },
    error: { kind: "local" },
    "shutdown.done": { kind: "local" },
  },
  knobs: {},
  timers: {},
  transitions: [
    t("request", "running", "exit.request", "stopping"),
    t("startup-fail", "running", "startup.fail", "stopping"),
    t("error-running", "running", "error", "running"),
    t("repeat", "stopping", "exit.repeat", "stopping"),
    t("startup-fail-stopping", "stopping", "startup.fail", "stopping"),
    t("error", "stopping", "error", "stopping"),
    t("exit", "stopping", "shutdown.done", "exited", { note: "the exit code is 1 after an error, else 0" }),
  ],
};

/** A watchdog measures how late its own tick comes, and a late tick shows a blocked event loop. */
export const WATCHDOG_MACHINE: Machine = {
  ...base("watchdog", "The watchdog of the event loop"),
  states: { watching: { initial: true }, blocked: {}, stopped: { final: true } },
  events: { tick: { kind: "timer" }, stop: { kind: "local" } },
  knobs: {
    tick: { key: "watchdog.tick", scope: "process", unit: "s", default: null },
    threshold: { key: "watchdog.threshold", scope: "process", unit: "s", default: null },
  },
  timers: {
    tick: { duration: { knob: "tick", unit: "s" }, arms: ["enter:watching", "tick"], cancels: ["stop"], fires: "tick" },
  },
  transitions: [
    t("on-time", "watching", "tick", "watching", { guard: "lateness <= threshold" }),
    t("block", "watching", "tick", "blocked", { guard: "lateness > threshold" }),
    t("still-blocked", "blocked", "tick", "blocked", { guard: "lateness > threshold" }),
    t("unblock", "blocked", "tick", "watching", { guard: "lateness <= threshold" }),
    t("stop", ["watching", "blocked"], "stop", "stopped"),
  ],
};

/** This function gives the name of a knob for the cap of a phase: `drain` gives `drain_cap`. */
export const capKnob = (phase: string): string => `${phase.replace(/[^A-Za-z0-9]+/g, "_")}_cap`;

/**
 * This function gives the drain of a declaration as a machine. It has one state for each declared
 * phase, in its sequence, and each state has a timer at its cap. The drain also has the cooperative abort: the
 * cap of the drain less the cooperative window, and half that cap at the least.
 */
export const drainMachine = (description: ServiceDescription): Machine => {
  const phases = description.shutdown.phases;
  const states: Record<string, { initial?: boolean; final?: boolean; note?: string }> = {
    running: { initial: true },
  };
  for (const phase of phases) states[phase.name] = {};
  states["done"] = { final: true };
  const knobs: Machine["knobs"] = Object.fromEntries([
    ...phases.map((phase) => [
      capKnob(phase.name),
      { key: `shutdown.phases.${phase.name}.cap`, scope: "service", unit: "s", default: null },
    ]),
    ["cooperative_window", { key: "shutdown.cooperativeWindow", scope: "service", unit: "s", default: null }],
  ]);
  const timers: Record<string, Machine["timers"][string]> = {};
  for (const phase of phases)
    timers[`${capKnob(phase.name)}_timer`] = {
      duration: { knob: capKnob(phase.name), unit: "s" },
      arms: [`enter:${phase.name}`],
      cancels: ["phase.done"],
      fires: "phase.cap",
    };
  if (phases.some((phase) => phase.name === "drain"))
    timers["cooperative_abort"] = {
      duration: { expr: "max(drain_cap - cooperative_window, drain_cap / 2)", unit: "s" },
      arms: ["enter:drain"],
      cancels: ["phase.done", "phase.cap"],
      fires: "drain.cooperative-abort",
    };
  const transitions: TransitionDef[] = [];
  const order = ["running", ...phases.map((phase) => phase.name), "done"];
  for (let at = 0; at + 1 < order.length; at += 1) {
    const from = order[at]!;
    const to = order[at + 1]!;
    transitions.push(
      at === 0
        ? t(`begin`, from, "exit.request", to)
        : t(`after-${from}`, from, ["phase.done", "phase.cap"], to, {
            timer: `${capKnob(from)}_timer`,
            note: "phase.cap: the work of the phase did not end in its cap, and the exit code is 1",
          }),
    );
  }
  if (phases.some((phase) => phase.name === "drain"))
    transitions.push(t("cooperative-abort", "drain", "drain.cooperative-abort", "drain", { timer: "cooperative_abort" }));
  // the signal of the service aborts when the sequence passes the poller, or at the end: it leaves
  // the drain where it is
  for (const state of [...phases.map((phase) => phase.name), "done"])
    transitions.push(t(`signal-abort-${state}`, state, "signal.abort", state));
  return {
    ...base("drain", `The drain of ${description.name}`),
    states,
    events: {
      "exit.request": { kind: "app" },
      "phase.done": { kind: "local" },
      "phase.cap": { kind: "timer" },
      "drain.cooperative-abort": { kind: "timer" },
      "signal.abort": { kind: "local" },
    },
    knobs,
    timers,
    transitions,
  };
};

/** These are the static machines of the runtime, by the name that their events carry. */
export const MACHINES: Readonly<Record<Exclude<MachineName, "drain" | "client">, Machine>> = {
  gate: GATE_MACHINE,
  latch: LATCH_MACHINE,
  window: WINDOW_MACHINE,
  poller: POLLER_MACHINE,
  exit: EXIT_MACHINE,
  watchdog: WATCHDOG_MACHINE,
};

/**
 * This function replays the transitions of one machine of the runtime against its document. Each
 * instance starts in the state that its first transition leaves. Each transition must leave the
 * state where the replay is. The document must have a transition from that state, on that event,
 * to that state. The function gives each disagreement.
 */
export const replay = (doc: Machine, events: readonly LifecycleEvent[]): string[] => {
  const problems: string[] = [];
  const at = new Map<string, string>();
  for (const event of events) {
    const where = at.get(event.instance) ?? event.from;
    if (doc.states[where] === undefined) problems.push(`${event.instance}: the state ${where} is not in ${doc.id}`);
    if (event.from !== where)
      problems.push(`${event.instance}: the runtime left ${event.from} on ${event.on}, but the replay is in ${where}`);
    const allowed = doc.transitions.some(
      (each) => fromStates(doc, each.from).includes(event.from) && arr(each.on).includes(event.on) && each.to === event.to,
    );
    if (!allowed) problems.push(`${event.instance}: ${doc.id} has no transition from ${event.from} on ${event.on} to ${event.to}`);
    at.set(event.instance, event.to);
  }
  return problems;
};
