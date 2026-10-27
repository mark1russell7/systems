import type { Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { Cell, Jitter, KernelRecord, ProbeEvent, Reconnects, Run } from "./cell.ts";
import { NOISE } from "./verdict.ts";

/**
 * This module reads the acts of the program of the observer: its heartbeat, its drop of the
 * connection, its reconnect and its call in flight. The kernel has no report of a detection by
 * a program. Thus the program writes a line before each of its own acts, on CLOCK_MONOTONIC:
 * - `ping` before each ping of its heartbeat, and `drop` before it closes the connection by itself.
 * - `reconnecting` when it starts its reconnect timer, and `dial` before each new connection.
 *
 * The kernel then stamps each write of the program on the socket (`tx`) and each change of the
 * state of the socket. A line of the client names its socket by its local address (`local`), and
 * a line of a server names it by its peer (`peer`).
 */

/**
 * This time bounds the handling of a drop by the program of the observer. It starts when the timer
 * of the program fires. It ends at the kernel's stamp of the act: the write of a close frame, or
 * the close of the socket. The `drop` line comes in that time, before the act.
 *
 * This bound is not δ_abs. δ_abs is the noise of the pipeline, and stage 0 calibrates it from a
 * reset. The handling is the time of the code of the program, and it is longer:
 * - No source and no machine document bounds it (`http/timers.ts` of `@mark1russell7/machines`).
 * - The handling time of the HTTP cells (`HANDLING` in `packages/cells/src/http/race.ts`) is
 *   another act. It is the first reply of a new process, up to 11.182 ms.
 * - A drop comes from a timer, long after the start of the process.
 *
 * The bound comes from the CI records of the WS and WST cells, from the `drop` line to the act:
 * - 585 drops with a close frame had a median of 0.652 ms, a 99th percentile of 0.87 ms and a
 *   maximum of 1.017 ms.
 * - 559 drops with a close of the socket had a maximum of 0.914 ms.
 * - Two drops took more than the δ_abs of 1 ms. Each failed its cell, and its time was in the band.
 *   These are the runs 39390222333 and 39903020657 of the client repository.
 *
 * The bound is 1.5 ms: the maximum and a margin of 0.48 ms. The pairing of a drop with its act
 * uses it, or the pairing window of the run when that window is longer. The band of a drop adds
 * it to its high bound (the WS catalog of the cells). Read the records again after a change to the subject, to Node or to
 * the runners.
 */
export const DROP_HANDLING: Quantity = quantity(1.5, "ms");

/** This function gives the window of the act of a drop, in seconds: `DROP_HANDLING`, or the pairing window (`delta`) when it is longer. */
const dropWindow = (delta: Quantity): number => Math.max(valueIn(DROP_HANDLING, "s"), valueIn(delta, "s"));

/** This function gives the interval between two instants on the one clock, in seconds to the microsecond. */
const between = (from: number, to: number): Quantity => quantity(Math.round((to - from) / 1e3) / 1e6, "s");

/** This function gives the state of a state record after the change, and before it. TCP_ESTABLISHED is 1, TCP_SYN_SENT 2. */
const newState = (record: KernelRecord): number | undefined => (record as { readonly new?: number }).new;
const oldState = (record: KernelRecord): number | undefined => (record as { readonly old?: number }).old;

/**
 * A program event is a line of the program of the observer, with the kernel's stamp of its act.
 * The act is a write, or a change of state of the socket. Without a record of the kernel in its
 * window after the line, the instant is the stamp of the line. The window is the pairing window of
 * the run (`pairingOf`), and for a drop it is `DROP_HANDLING` when that is longer.
 */
export interface ProgramEvent {
  readonly line: ProbeEvent;
  readonly at: number;
  /** This flag tells that the kernel stamped the event. */
  readonly kernel: boolean;
  /** This name is the kind of the record of the kernel: a write, or a change of state. It is null without a record. */
  readonly record: "write" | "state" | null;
}

/** This function gives the lines of the program of the observer: the client, or the target for the server. A proxy has no lines. */
export const programLines = (cell: Cell, run: Run): readonly ProbeEvent[] => {
  const observer = cell.observer ?? "client";
  if (observer === "client") return run.events;
  if (observer === "server") return run.server ?? [];
  return [];
};

/**
 * This function tells if a line of the program is about the connection of the run. The client
 * names it by its local address, and a server by its peer. A line with neither is about the one
 * connection of its program. A line whose address is null is about a socket that did not open:
 * a try that failed.
 */
const onConnection = (line: ProbeEvent, local: unknown): boolean => {
  if (!("local" in line) && !("peer" in line)) return true;
  return (line["local"] ?? line["peer"]) === local;
};

/** This function gives the first record of a socket that matches, at the stamp of a line or in a window (`delta`) after it. */
const kernelAt = (
  socket: readonly KernelRecord[],
  line: ProbeEvent,
  matches: (record: KernelRecord) => boolean,
  delta: Quantity,
): KernelRecord | undefined => {
  const noise = valueIn(delta, "s") * 1e9;
  return socket.find((record) => record.mono >= line.t && record.mono <= line.t + noise && matches(record));
};

const eventOf = (
  socket: readonly KernelRecord[],
  line: ProbeEvent,
  matches: (record: KernelRecord) => boolean,
  delta: Quantity = NOISE,
): ProgramEvent => {
  const record = kernelAt(socket, line, matches, delta);
  return {
    line,
    at: record?.mono ?? line.t,
    kernel: record !== undefined,
    record: record === undefined ? null : record.ev === "tx" ? "write" : "state",
  };
};

/**
 * This function gives the time from a line of the program to the close of the socket by its own
 * side. That close is its change from ESTABLISHED to FIN_WAIT1, or to CLOSE (an abort). A FIN of
 * the peer (CLOSE_WAIT) is not such a close. It is null when the socket did not close itself.
 */
export const leftAfter = (socket: readonly KernelRecord[], line: ProbeEvent): Quantity | null => {
  const left = socket.find(
    (record) => record.ev === "state" && oldState(record) === 1 && (newState(record) === 4 || newState(record) === 7) && record.mono >= line.t,
  );
  return left === undefined ? null : between(line.t, left.mono);
};

/**
 * This function gives the end of the client process in a run, as the kernel stamps it. The process
 * ends after its last try, and its kernel then closes each socket that is still open, at one
 * instant. Thus the end is the first change out of ESTABLISHED of another socket of the client
 * after its last `dial` line. The program dropped none of these sockets. It is undefined when the
 * record has no such change, for example when the last try did not open.
 */
export const exitOf = (run: Run, cookie: number | undefined): number | undefined => {
  const last = run.events.filter((line) => line.ev === "dial").at(-1);
  if (last === undefined) return undefined;
  const dropped = new Set(run.events.filter((line) => line.ev === "drop").map((line) => line["local"]));
  return run.kernel.find(
    (record) =>
      record.netns === run.netns &&
      record.cookie !== cookie &&
      record.ev === "state" &&
      oldState(record) === 1 &&
      (newState(record) === 4 || newState(record) === 7) &&
      record.mono >= last.t &&
      !dropped.has(record.src),
  )?.mono;
};

/**
 * This function separates a close of the socket by the program from the end of the client process.
 * `left` is the time from the drop line to the close, and `exit` is the end of the process. A close
 * in δ_abs of that end is the end, not the program: `left` becomes null, and `exited` keeps the time.
 */
export const closeOrExit = (
  line: ProbeEvent,
  left: Quantity | null,
  exit: number | undefined,
  delta: Quantity = NOISE,
): { readonly left: Quantity | null; readonly exited?: Quantity } => {
  if (left === null || exit === undefined) return { left };
  const at = line.t + valueIn(left, "s") * 1e9;
  return Math.abs(at - exit) <= valueIn(delta, "s") * 1e9 ? { left: null, exited: left } : { left };
};

/**
 * This function tells how a drop differs from the way that its prediction gives, or gives null.
 * A close closes the socket at once, in the handling time of the program (`DROP_HANDLING`). If
 * the pairing window of the run (`delta`) is longer, that window is the limit. A close frame is a
 * write, and the program does not close the socket at the drop. A peer that answers the close frame can close it, and that is no finding.
 */
export const dropFinding = (
  expected: "frame" | "close",
  drop: ProgramEvent,
  left: Quantity | null,
  delta: Quantity = NOISE,
  exited?: Quantity,
): string | null => {
  const noise = dropWindow(delta);
  const soon = left !== null && valueIn(left, "s") <= noise;
  if (expected === "close") {
    if (left === null)
      return `the program did not close its socket after the drop, where a close is at once${exited === undefined ? "" : ": it stayed open until the client process ended"}`;
    return soon ? null : `the program closed its socket ${left.value} s after the drop, not at once`;
  }
  if (drop.record !== "write") return "the drop wrote no close frame on its socket";
  return soon ? "the program closed its socket at the drop, where a close frame leaves it open" : null;
};

const isWrite = (record: KernelRecord): boolean => record.ev === "tx";

/**
 * This function measures the jitter of a program from its acts before `until`, the start of the
 * fault. An act is a `write` line or a `ping` line on the connection. Its delay goes from the line
 * to the first write of data on the socket after it, before the next act and before `until`. An
 * act with no such write does not count. The bound is the longest delay, to the microsecond.
 */
export const jitterOfLines = (
  lines: readonly ProbeEvent[],
  socket: readonly KernelRecord[],
  local: unknown,
  until: number,
): Jitter => {
  const acts = lines.filter((line) => (line.ev === "write" || line.ev === "ping") && line.t < until && onConnection(line, local));
  const delays = acts.flatMap((line, at) => {
    const next = Math.min(acts[at + 1]?.t ?? until, until);
    const write = socket.find((record) => isWrite(record) && (record.seg?.len.value ?? 0) > 0 && record.mono >= line.t && record.mono < next);
    return write === undefined ? [] : [write.mono - line.t];
  });
  return {
    acts: delays.length,
    bound: delays.length === 0 ? null : quantity(Math.round(Math.max(...delays) / 1e3) / 1e3, "ms"),
  };
};

/** This function gives each ping of the program on the connection, with the kernel's stamp of its write in the pairing window (`delta`). */
export const pingsOf = (
  lines: readonly ProbeEvent[],
  socket: readonly KernelRecord[],
  local: unknown,
  delta: Quantity = NOISE,
): ProgramEvent[] =>
  lines.filter((line) => line.ev === "ping" && onConnection(line, local)).map((line) => eventOf(socket, line, isWrite, delta));

/**
 * This function gives the first ping that got no answer: no segment with data reached the socket
 * after its write, up to `until`. Its write starts the wait of the heartbeat that the fault met.
 */
export const firstUnanswered = (
  pings: readonly ProgramEvent[],
  socket: readonly KernelRecord[],
  until: number = Number.POSITIVE_INFINITY,
): ProgramEvent | undefined =>
  pings
    .filter((ping) => ping.at <= until)
    .find(
      (ping) =>
        !socket.some((record) => record.ev === "rx" && (record.seg?.len.value ?? 0) > 0 && record.mono > ping.at && record.mono <= until),
    );

/**
 * This function gives the first drop of the connection by its program. The kernel stamps it as the
 * write of a close frame. Or it stamps the change of the socket out of ESTABLISHED: a close or an
 * abort. That stamp comes in the handling time of the program after the drop line
 * (`DROP_HANDLING`). If the pairing window of the run (`delta`) is longer, that window is the limit.
 */
export const dropOf = (
  lines: readonly ProbeEvent[],
  socket: readonly KernelRecord[],
  local: unknown,
  delta: Quantity = NOISE,
): ProgramEvent | undefined => {
  const line = lines.find((each) => each.ev === "drop" && onConnection(each, local));
  return line === undefined
    ? undefined
    : eventOf(socket, line, (record) => isWrite(record) || (record.ev === "state" && oldState(record) === 1), quantity(dropWindow(delta), "s"));
};

/** A reconnect reading is what the client did after the detection, from its lines and from the records of the kernel. */
export interface ReconnectReading {
  /** These are the waits of the program before each try: from a `reconnecting` line to the next `dial` line. */
  readonly waits: readonly Quantity[];
  /** This time is from the detection to the first SYN of a new socket. The kernel stamps the change to SYN_SENT at connect(2). */
  readonly syn: Quantity | null;
  /** This time is from the detection to the first new socket of the client that became ESTABLISHED. */
  readonly established: Quantity | null;
  /** These are the times from each `dial` line after the detection to the SYN of its socket: the work of the program before connect(2). */
  readonly connects: readonly Quantity[];
}

/**
 * This function reads the reconnect of the client after the detection at `detected`. The socket of
 * the run has the cookie `cookie`. The lines of the program count from `from`: the drop line of a
 * drop, which comes before the kernel's stamp of it.
 */
export const reconnectOf = (run: Run, detected: number, cookie: number | undefined, from: number = detected): ReconnectReading => {
  const after = run.events.filter((line) => line.t > from);
  const starts = after.filter((line) => line.ev === "reconnecting");
  const dials = after.filter((line) => line.ev === "dial");
  const waits = starts.flatMap((start, at) => {
    const next = starts[at + 1]?.t ?? Number.POSITIVE_INFINITY;
    const dial = dials.find((each) => each.t >= start.t && each.t < next);
    return dial === undefined ? [] : [between(start.t, dial.t)];
  });
  const fresh = run.kernel.filter((record) => record.netns === run.netns && record.cookie !== cookie && record.ev === "state" && record.mono > detected);
  const syns = fresh.filter((record) => newState(record) === 2);
  const established = fresh.find((record) => newState(record) === 1);
  const connects = dials.flatMap((dial) => {
    const syn = syns.find((record) => record.mono >= dial.t);
    return syn === undefined ? [] : [between(dial.t, syn.mono)];
  });
  return {
    waits,
    syn: syns[0] === undefined ? null : between(detected, syns[0].mono),
    established: established === undefined ? null : between(detected, established.mono),
    connects,
  };
};

/** This function tells how the waits of a reconnect differ from their bands, each widened by δ_abs, or gives null. */
export const reconnectFinding = (expected: Reconnects, read: ReconnectReading, delta: Quantity = NOISE): string | null => {
  const noise = valueIn(delta, "s");
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  const found = expected.waits.flatMap((band, at) => {
    const wait = read.waits[at];
    if (wait === undefined) return [`the client made no try ${at + 1} after the detection`];
    const value = valueIn(wait, "s");
    const low = round(valueIn(band.low, "s") - noise);
    const high = round(valueIn(band.high, "s") + noise);
    return value < low || value > high ? [`its wait before try ${at + 1} was ${value} s, outside [${low}, ${high}] s`] : [];
  });
  return found.length === 0 ? null : found.join(". ");
};

/**
 * A call reading is what the call in flight of a WebSocket client met: its error, a reply, or
 * nothing in the run. The time counts from the detection to its end.
 */
export interface CallReading {
  readonly outcome: string;
  readonly after: Quantity | null;
}

/** This function reads the call that the client sent into the fault: its `call-error` or `data` line after the request. */
export const callOf = (events: readonly ProbeEvent[], request: ProbeEvent, detected: number | undefined): CallReading => {
  const end = events.find((line) => (line.ev === "call-error" || line.ev === "data") && line.t > request.t);
  if (end === undefined) return { outcome: "pending", after: null };
  const outcome = end.ev === "data" ? "a reply" : String(end["message"] ?? end["code"] ?? "an error");
  return { outcome, after: detected === undefined ? null : between(detected, end.t) };
};
