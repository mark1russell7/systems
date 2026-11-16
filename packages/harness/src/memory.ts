import type { Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { MemoryLimits, MemoryOomPrediction, MemoryPrediction, MemoryStep, MemoryThrottlePrediction, ProbeEvent, QueueBand, Run } from "./cell.ts";
import type { Measured } from "./observe.ts";
import { bandWords, inside } from "./queue.ts";

/** This record is one step of the growth of a throttle cell, as the memory client wrote it. */
export interface MemoryStepReading {
  /** This usage is the pages of the cgroup after the step. */
  readonly usage: number;
  readonly time: Quantity;
  /** This count is the rise of the event `high` in the step. */
  readonly high: number;
  /** This choice says that the judge read the step: its usage rose by one batch. */
  readonly read: boolean;
}

/** This record is one task of an OOM cell at the end of its run. */
export interface MemoryTaskReading {
  readonly name: string;
  readonly outcome: string;
  readonly signal: number | null;
}

/** This record is what a run of a memory cell measured. */
export interface MemoryReading {
  /** These are the limits as the cgroup printed them at the `ready` line. */
  readonly limits: { readonly high: string; readonly max: string; readonly swap: string };
  /** This usage is the pages of the cgroup at the `ready` line. */
  readonly start: number;
  readonly steps: readonly MemoryStepReading[];
  readonly tasks: readonly MemoryTaskReading[];
  /** These are the counts of `memory.events` at the end of the run. */
  readonly events: Readonly<Record<string, number>>;
  /** This time is the total stall of `memory.pressure` (`some`), or null when the kernel has no pressure file. */
  readonly stall: Quantity | null;
}

const numberOr = (line: ProbeEvent | undefined, field: string): number | null => {
  const value = line?.[field];
  return typeof value === "number" ? value : null;
};

const countsOf = (value: unknown): Record<string, number> => {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
};

/** This function gives the words of a limit in pages as the cgroup prints it: its bytes, or `max`. */
const printed = (pages: number | null, page: number): string => (pages === null ? "max" : String(pages * page));

/** This function tells where the limits that the cgroup printed differ from the limits of the cell. */
const limitsDiffer = (ready: ProbeEvent, limits: MemoryLimits): string | null => {
  if (ready["page"] !== limits.page) return `the page is ${String(ready["page"])} bytes, not ${limits.page}`;
  const each: readonly [string, number | null][] = [
    ["high", limits.high],
    ["max", limits.max],
    ["swap", limits.swap],
  ];
  for (const [name, pages] of each) {
    const want = printed(pages, limits.page);
    if (ready[name] !== want) return `memory.${name === "swap" ? "swap.max" : name} reads ${String(ready[name])}, not ${want}`;
  }
  return null;
};

/** This function gives the entry of the table at or below a usage, and the entry at or above it. A usage below the table gives the quiet band. */
const around = (expected: MemoryThrottlePrediction, usage: number): { readonly below: MemoryStep | null; readonly above: MemoryStep | null } => {
  const { steps } = expected;
  let below: MemoryStep | null = null;
  let above: MemoryStep | null = null;
  for (const step of steps) {
    if (step.usage <= usage) below = step;
    if (above === null && step.usage >= usage) above = step;
  }
  // above the last entry: the cap holds
  return { below, above: above ?? steps.at(-1) ?? null };
};

/** This function gives the band of a step whose charge left the usage from `usage` to `usage + drift`, and the bounds of its events `high`. */
export const stepBand = (
  expected: MemoryThrottlePrediction,
  usage: number,
): { readonly band: QueueBand; readonly high: { readonly low: number; readonly high: number } } => {
  const low = around(expected, usage);
  const high = around(expected, usage + expected.drift);
  const lowStep = low.below;
  const highStep = high.above;
  const quietHigh = expected.limits.high === null || usage + expected.drift <= expected.limits.high;
  return {
    band: {
      low: lowStep === null ? expected.quiet.low : lowStep.band.low,
      high: highStep === null || quietHigh ? expected.quiet.high : highStep.band.high,
    },
    high: {
      low: lowStep === null ? 0 : lowStep.high,
      high: highStep === null || quietHigh ? 0 : highStep.high,
    },
  };
};

const seconds = (time: Quantity): number => valueIn(time, "s");

/** This function reads each step of a growth: its usage, its time, and the rise of its events `high`. */
const stepsOf = (events: readonly ProbeEvent[], start: number, startHigh: number, batch: number, drift: number): MemoryStepReading[] => {
  let usage = start;
  let high = startHigh;
  const out: MemoryStepReading[] = [];
  for (const line of events) {
    if (line.ev !== "step") continue;
    const now = numberOr(line, "current") ?? usage;
    const events = numberOr(line, "high") ?? high;
    const rise = now - usage;
    out.push({
      usage: now,
      time: quantity(Math.round((numberOr(line, "ns") ?? 0) / 1e3) / 1e6, "s"),
      high: events - high,
      read: Math.abs(rise - batch) <= drift,
    });
    usage = now;
    high = events;
  }
  return out;
};

/** These are the first findings of a run that the words of its finding name, one for each step. */
const NAMED = 5;

const throttleFindings = (read: MemoryReading, expected: MemoryThrottlePrediction): string[] => {
  const found: string[] = [];
  const off: string[] = [];
  let least = 0;
  for (const step of read.steps) {
    if (!step.read) continue;
    const { band, high } = stepBand(expected, step.usage);
    if (!inside(step.time, band)) off.push(`the step to ${step.usage} pages took ${seconds(step.time)} s, outside ${bandWords(band)}`);
    if (step.high < high.low || step.high > high.high)
      off.push(`the step to ${step.usage} pages added ${step.high} events high, not ${high.low === high.high ? high.low : `${high.low} to ${high.high}`}`);
    least += seconds(band.low);
  }
  if (off.length > 0) found.push(`${off.length} terms of the steps are outside the law: ${off.slice(0, NAMED).join("; ")}`);
  // each sleep is a stall of the task, thus the pressure of the cgroup counts each one
  if (read.stall !== null && seconds(read.stall) < least)
    found.push(`memory.pressure counts a stall of ${seconds(read.stall)} s, less than the ${Math.round(least * 1e6) / 1e6} s of the sleeps`);
  return found;
};

const oomFindings = (read: MemoryReading, expected: MemoryOomPrediction): string[] => {
  const found: string[] = [];
  for (const task of expected.tasks) {
    const seen = read.tasks.find((each) => each.name === task.name);
    if (seen === undefined) found.push(`the task ${task.name} wrote no end`);
    else if (seen.outcome !== task.outcome) found.push(`the task ${task.name} was ${seen.outcome}, not ${task.outcome}`);
    else if (task.outcome === "killed" && seen.signal !== 9) found.push(`the task ${task.name} ended by the signal ${seen.signal ?? "none"}, not SIGKILL`);
  }
  const kills = read.events["oom_kill"] ?? 0;
  if (kills !== expected.kills) found.push(`the cgroup counts ${kills} OOM kills, not ${expected.kills}`);
  return found;
};

/**
 * This function reads one run of a memory cell from the lines of the memory client. A run is void
 * when the client wrote an error or no `done` line, or when the cgroup reads other limits than the
 * cell. A throttle run is also void when the client did not lock its pages, or on a kernel with
 * another HZ. It is void too when the judge reads less than `read` of its steps above `memory.high`.
 * A step is not read when its usage did not rise by one batch: then a reclaim freed pages, or the
 * step charged two batches.
 */
export const measureMemory = (run: Run, expected: MemoryPrediction): Measured => {
  const { events, kernel } = run;
  const base = {
    environment: run.environment,
    index: run.index,
    outcome: { kind: "answered" } as const,
    elapsed: null,
    socket: null,
    noticed: null,
    steps: [],
    probes: 0,
    retransmissions: kernel.filter((record) => record.netns === run.netns && record.ev === "retrans").length,
    acks: 0,
  };
  const voided = (why: string): Measured => ({ ...base, void: why, finding: null });
  const error = events.find((event) => event.ev === "error");
  if (error !== undefined) return voided(`the client stopped: ${String(error["what"])}`);
  const ready = events.find((event) => event.ev === "ready");
  if (ready === undefined) return voided("the client wrote no ready line");
  if (events.find((event) => event.ev === "done") === undefined) {
    const deadline = events.find((event) => event.ev === "deadline");
    return voided(deadline === undefined ? "the client did not reach its end" : `the client reached its deadline in the wait for the ${String(deadline["wait"])}`);
  }
  const differs = limitsDiffer(ready, expected.limits);
  if (differs !== null) return voided(differs);
  const start = numberOr(ready, "current") ?? 0;
  const atReady = countsOf(ready["events"]);
  const last = events.filter((event) => event.ev === "events").at(-1);
  const pressure = events.find((event) => event.ev === "pressure");
  const some = numberOr(pressure, "some");
  const throttle = expected.kind === "throttle";
  const memory: MemoryReading = {
    limits: { high: String(ready["high"]), max: String(ready["max"]), swap: String(ready["swap"]) },
    start,
    steps: throttle ? stepsOf(events, start, atReady["high"] ?? 0, expected.batch, expected.drift) : [],
    tasks: events
      .filter((event) => event.ev === "task")
      .map((event) => ({ name: String(event["name"]), outcome: String(event["outcome"]), signal: numberOr(event, "signal") })),
    events: Object.fromEntries(Object.entries(countsOf(last)).filter(([name]) => name !== "t")),
    stall: some === null ? null : quantity(some / 1e6, "s"),
  };
  if (expected.kind === "throttle") {
    // a reclaim of an unlocked page of the client gives a step less than one batch, and more events high
    if (ready["locked"] === false) return voided("the client did not lock its pages, thus a reclaim can free them: give it IPC_LOCK");
    if (run.hz !== undefined && run.hz !== expected.hz) return voided(`the kernel runs at HZ ${run.hz}, and the bands are for HZ ${expected.hz}`);
    const high = expected.limits.high ?? Number.POSITIVE_INFINITY;
    const over = memory.steps.filter((step) => step.usage + expected.drift > high);
    const counted = over.filter((step) => step.read).length;
    if (over.length === 0 || counted < expected.read * over.length)
      return voided(`the judge read ${counted} of the ${over.length} steps above memory.high, less than ${expected.read * 100}%`);
    const reached = memory.steps.at(-1)?.usage ?? start;
    if (reached < expected.until) return voided(`the growth ended at ${reached} pages, below ${expected.until}`);
  }
  const found = expected.kind === "throttle" ? throttleFindings(memory, expected) : oomFindings(memory, expected);
  return { ...base, void: null, finding: found.length === 0 ? null : found.join(". "), memory };
};
