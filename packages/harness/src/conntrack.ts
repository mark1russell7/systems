import type { Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { ConntrackPrediction, ProbeEvent, Run } from "./cell.ts";
import type { Measured } from "./observe.ts";
import { bandWords, between, inside } from "./queue.ts";

/** This errno tells that a connect got a slot. */
const NONE = "none";

/** This record is the end of a connect that found no entry at its start. */
export interface StallReading {
  readonly errno: string;
  readonly time: Quantity;
  /** This count is the rise of the field `drop` of the conntrack statistics during the connect. */
  readonly drops: number;
  /** This count is the rise of `TCPRetransFail` during the connect. */
  readonly retransFail: number;
}

/** This record is what a run of a conntrack cell measured. */
export interface ConntrackReading {
  /** This count is the flows that the client holds at its `full` line. */
  readonly flows: number;
  /** This count is what the namespace of the client reads at that line. */
  readonly count: number;
  /** This count is what the namespace of the target reads while the client holds its flows. */
  readonly neighbor: number | null;
  readonly stall: StallReading | null;
  /** This time is from the `closing` line to the first fall of the count. */
  readonly firstFall: Quantity | null;
  /** This time is from the `closing` line to the zero of the count. */
  readonly zero: Quantity | null;
  /** This count is what the namespace reads after each side closes. */
  readonly closed: number | null;
  /** This count is the lowest that the poll of the count read. */
  readonly lowest: number | null;
  /** This count is what the namespace reads after a connect that got a slot. */
  readonly after: number | null;
}

const numberOr = (line: ProbeEvent | undefined, field: string): number | null => {
  const value = line?.[field];
  return typeof value === "number" ? value : null;
};

/** This function gives the time from one stamp to a stamp of a field of a line, when the line has it. */
const untilField = (from: ProbeEvent | undefined, line: ProbeEvent | undefined, field: string): Quantity | null => {
  const stamp = numberOr(line, field);
  return from === undefined || stamp === null ? null : between(from.t, stamp);
};

const stallOf = (line: ProbeEvent | undefined): StallReading | null =>
  line === undefined
    ? null
    : {
        errno: String(line["errno"]),
        time: quantity(Math.round((numberOr(line, "elapsed") ?? 0) / 1e3) / 1e6, "s"),
        drops: numberOr(line, "drops") ?? 0,
        retransFail: numberOr(line, "retrans_fail") ?? 0,
      };

/** This function tells where a reading differs from the law of its cell. */
const findingsOf = (read: ConntrackReading, failed: unknown, expected: ConntrackPrediction): string[] => {
  const found: string[] = [];
  const { max, neighbor, refused, drained, pressure } = expected;
  if (typeof failed === "string") found.push(`a connect failed with ${failed} before the client held its flows`);
  if (read.flows !== max) found.push(`the client held ${read.flows} flows, not ${max}`);
  if (read.count !== max) found.push(`the count read ${read.count} at the fill, not ${max}`);
  if (neighbor !== undefined && read.neighbor !== neighbor)
    found.push(`the namespace of the target read ${read.neighbor ?? "nothing"}, not ${neighbor}`);
  if (refused !== undefined) {
    const stall = read.stall;
    if (stall === null) found.push("no connect after the fill ended");
    else {
      if (stall.errno !== refused.errno) found.push(`the connect after the fill ended with ${stall.errno}, not ${refused.errno}`);
      if (!inside(stall.time, refused.within))
        found.push(`the connect after the fill took ${valueIn(stall.time, "s")} s, outside ${bandWords(refused.within)}`);
      if (stall.drops !== refused.drops) found.push(`the field drop rose by ${stall.drops}, not ${refused.drops}`);
      if (stall.retransFail !== refused.retransFail) found.push(`TCPRetransFail rose by ${stall.retransFail}, not ${refused.retransFail}`);
    }
  }
  if (drained !== undefined) {
    for (const [name, time] of [["first fall", read.firstFall], ["zero", read.zero]] as const) {
      if (time === null || !inside(time, drained))
        found.push(`the ${name} of the count came at ${time === null ? "no time" : `${valueIn(time, "s")} s`}, outside ${bandWords(drained)}`);
    }
  }
  if (pressure !== undefined) {
    const stall = read.stall;
    if (read.closed !== max) found.push(`the count read ${read.closed ?? "nothing"} after each side closed, not ${max}`);
    if (read.lowest !== pressure.lowest) found.push(`the lowest count was ${read.lowest ?? "nothing"}, not ${pressure.lowest}`);
    if (read.after !== pressure.after) found.push(`the count read ${read.after ?? "nothing"} after the connect, not ${pressure.after}`);
    if (stall === null) found.push("no connect after the close ended");
    else {
      if (stall.errno !== NONE) found.push(`the connect after the close ended with ${stall.errno}`);
      if (!pressure.points.some((point) => inside(stall.time, point)))
        found.push(`the connect after the close took ${valueIn(stall.time, "s")} s, on no point of the schedule`);
    }
  }
  return found;
};

/**
 * This function reads one run of a conntrack cell from the lines of its client and its target. An
 * `unsettled` line makes the run void. The entries of the run before it were still in the table, thus
 * the run did not start from an empty table.
 */
export const measureConntrack = (run: Run, expected: ConntrackPrediction): Measured => {
  const { events, kernel } = run;
  const retransmissions = kernel.filter((record) => record.netns === run.netns && record.ev === "retrans").length;
  const base = {
    environment: run.environment,
    index: run.index,
    outcome: { kind: "answered" } as const,
    elapsed: null,
    socket: null,
    noticed: null,
    steps: [],
    probes: 0,
    retransmissions,
    acks: 0,
  };
  const voided = (why: string): Measured => ({ ...base, void: why, finding: null });
  const unsettled = events.find((event) => event.ev === "unsettled");
  if (unsettled !== undefined) return voided(`the table held ${String(unsettled["count"])} entries at the end of the wait before the run`);
  if (events.find((event) => event.ev === "done") === undefined) return voided("the client did not reach its end");
  if (run.lost === null) return voided("the prober wrote no clock line after the run, so nothing says what it dropped");
  if (run.lost > 0) return voided(`the prober dropped ${run.lost} records`);

  const full = events.find((event) => event.ev === "full");
  if (full === undefined) return voided("the client wrote no line for its fill");
  const stall = events.find((event) => event.ev === "stall");
  const closing = events.find((event) => event.ev === "closing");
  const drained = events.find((event) => event.ev === "drained");
  const closed = events.find((event) => event.ev === "closed");
  // the count of the neighbor while the client holds its flows: from the fill to the end of the connect after it
  const neighbor = (run.server ?? []).filter((line) => line.ev === "count" && line.t >= full.t && (stall === undefined || line.t <= stall.t)).at(-1);
  const conntrack: ConntrackReading = {
    flows: numberOr(full, "flows") ?? 0,
    count: numberOr(full, "count") ?? 0,
    neighbor: numberOr(neighbor, "count"),
    stall: stallOf(stall),
    firstFall: untilField(closing, drained, "first_fall"),
    zero: untilField(closing, drained, "zero"),
    closed: numberOr(closed, "count"),
    lowest: numberOr(drained ?? stall, "lowest"),
    after: numberOr(stall, "after"),
  };
  const found = findingsOf(conntrack, full["errno"], expected);
  return { ...base, void: null, finding: found.length === 0 ? null : found.join(". "), conntrack };
};
