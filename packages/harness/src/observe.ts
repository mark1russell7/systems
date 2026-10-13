import type { Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { Cell, KernelRecord, ProbeEvent, Run } from "./cell.ts";

/**
 * An outcome tells how the wait of a run ended. The socket failed with an errno, or it read the
 * end of the file. Or nothing came, or the reply came back after a stall.
 */
export type Outcome =
  | { readonly kind: "error"; readonly errno: string }
  | { readonly kind: "eof" }
  | { readonly kind: "silent" }
  | { readonly kind: "answered" };

/** A measurement is what one run measured, against the prediction of its cell. */
export interface Measured {
  readonly environment: number;
  readonly index: number;
  readonly outcome: Outcome;
  /**
   * This time is from the reference event of the prediction to the detection, both as the kernel
   * stamped them in the records of the prober. It is null when nothing detected the fault.
   */
  readonly elapsed: Quantity | null;
  /** This time is the same interval from the TCP_INFO samples of the client, the second vantage. */
  readonly socket: Quantity | null;
  /** This time is how long the client took to see the error after the kernel reported it. */
  readonly noticed: Quantity | null;
  /**
   * These are the steps of the kernel after the reference: each keepalive probe, or each firing of
   * the RTO timer. After a stall, they are each retransmission from the send, the loss probe first.
   */
  readonly steps: readonly Quantity[];
  /** This count is the number of keepalive probes that the kernel sent. */
  readonly probes: number;
  /** This count is the number of segments that the kernel sent again. */
  readonly retransmissions: number;
  /** This count is the number of segments that the socket received after the request. */
  readonly acks: number;
  /** This text is the reason that the run cannot count, or null. A void run is not a pass and not a finding. */
  readonly void: string | null;
  /** This text tells what in the run disagrees with the prediction, other than its timing, or null. */
  readonly finding: string | null;
}

/** These are the errno numbers that the kernel reports to a socket, by the names that predictions use. */
const ERRNO: Readonly<Record<number, string>> = {
  32: "EPIPE",
  101: "ENETUNREACH",
  103: "ECONNABORTED",
  104: "ECONNRESET",
  110: "ETIMEDOUT",
  111: "ECONNREFUSED",
  113: "EHOSTUNREACH",
};

/** This function gives the interval between two instants on the one clock, in seconds to the microsecond. */
const between = (from: number, to: number): Quantity =>
  quantity(Math.round((to - from) / 1e3) / 1e6, "s");

const count = (event: ProbeEvent | undefined, field: string): number =>
  event === undefined ? 0 : Number(event[field] ?? 0);

/** This function gives the view of the client on the same interval: TCP_INFO, with a sample each 2 ms. */
const socketVantage = (
  cell: Cell,
  events: readonly ProbeEvent[],
  ready: ProbeEvent,
  request: ProbeEvent,
): Quantity | null => {
  if (!cell.prediction.detects) return null;
  const ended = events.find((event) => event.ev === "error" || event.ev === "eof");
  const reference =
    cell.prediction.from === "last-received"
      ? ready
      : cell.prediction.from === "request-sent"
        ? request
        : events.find(
            (event) =>
              event.ev === "kernel" && event.t >= request.t && count(event, "retransmits") > 0,
          );
  return ended === undefined || reference === undefined ? null : between(reference.t, ended.t);
};

/**
 * This function reads one run against its cell, from the records of the kernel first.
 * - The socket of the run is the socket that the client connected from, in its namespace.
 * - The fault must hold before the event that it must meet. That is before the request goes into
 *   it, and before the first keepalive probe. A live peer answers that probe, and the answer
 *   starts the idle time again. A run where the fault was late is void. A run whose records the
 *   prober lost is also void.
 */
export const measure = (cell: Cell, run: Run): Measured => {
  const { events, kernel } = run;
  const ready = events.find((event) => event.ev === "ready");
  const local = events.find((event) => event.ev === "connected")?.["local"];
  const request =
    cell.probe.mode === "inflight" ? events.filter((event) => event.ev === "sent")[1] : ready;
  // the socket of the observer: the client socket, by the address that it connected from, or the
  // socket of the target for the same connection, in its namespace, whose peer is that address
  const server = cell.observer === "server";
  const netns = server ? run.targetNetns : run.netns;
  const cookie = kernel.find(
    (record) => record.netns === netns && (server ? record.dst : record.src) === local,
  )?.cookie;
  const socket = kernel.filter((record) => record.netns === netns && record.cookie === cookie);
  const keepalives = socket.filter(
    (record) => record.ev === "probe" && record.what === "keepalive",
  );
  const retransmitted = socket.filter((record) => record.ev === "retrans");
  /**
   * This function examines the timer that drives the measurement: keepalive or retransmit. It
   * finds the first firing in an interval that was two jiffies or more behind its wheel slot. The
   * wheel does a slot in the tick when it is due, thus such a delay comes from the CPU: the host
   * stopped a vCPU. The prediction is about the timing of the kernel, and that firing measured
   * the timing of the host. One jiffy is a tick that occurred while the wheel worked, and δ_abs
   * includes it. The function ignores the other timer: the retransmit timer fires one time, idle,
   * after a reply, and it does not move a keepalive.
   */
  const delayed = (from: number, to: number, timer: "keepalive" | "retransmit"): string | null => {
    const firings = socket.filter(
      (record) =>
        record.ev === "timer" && record.what === timer && record.mono >= from && record.mono <= to,
    );
    const late = firings.find((record) => (record.behind?.value ?? 0) >= 2);
    if (late !== undefined)
      return `its ${timer} timer ran ${late.behind!.value} jiffies behind its wheel slot: the VM delayed it, not the kernel`;
    // a keepalive timer that finds its socket held by its owner sends nothing, and it tries again
    // HZ/20 later (tcp_keepalive_timer). The retransmit timer only gives its work to the release
    // by the owner, some microseconds later
    const held = firings.find((record) => timer === "keepalive" && record.owned === true);
    return held === undefined
      ? null
      : "its keepalive timer found the socket held by its owner and put itself off by HZ/20: the run measured the owner, not the timer";
  };
  const acks =
    request === undefined
      ? 0
      : socket.filter((record) => record.ev === "rx" && record.mono > request.t).length;
  const base = {
    environment: run.environment,
    index: run.index,
    probes: keepalives.length,
    retransmissions: retransmitted.length,
    acks,
  };
  const nothing = {
    outcome: { kind: "silent" } as const,
    elapsed: null,
    socket: null,
    noticed: null,
    steps: [],
    finding: null,
  };

  if (ready === undefined) return { ...base, ...nothing, void: "the client never had its reply" };
  if (request === undefined)
    return { ...base, ...nothing, void: "the request was never sent into the fault" };
  if (run.lost === null)
    return {
      ...base,
      ...nothing,
      void: "the prober wrote no clock line after the run, so nothing says what it dropped",
    };
  if (run.lost > 0) return { ...base, ...nothing, void: `the prober dropped ${run.lost} records` };
  if (cookie === undefined)
    return { ...base, ...nothing, void: "the prober saw nothing of this connection" };
  let voided: string | null = null;
  if (run.fault !== null) {
    // the request of a client must go into the fault. The request of a cell on the server side must
    // reach the server first, and its reply must not reach the client before the fault holds
    const replied = events.some(
      (event) => event.ev === "data" && event.t > request.t && event.t < run.fault!.t1,
    );
    if (cell.probe.mode === "inflight" && !server && run.fault.t1 > request.t)
      voided = "the request went out before the fault held";
    else if (cell.probe.mode === "inflight" && server && run.fault.t1 < request.t)
      voided = "the request went out into the fault, so the server never had it";
    else if (cell.probe.mode === "inflight" && server && replied)
      voided = "the server's reply arrived before the fault held";
    else if (keepalives[0] !== undefined && keepalives[0].mono < run.fault.t1)
      voided = "a keepalive probe went out before the fault held";
  }

  // the detection as the kernel reported it to the owner of the socket, and as the client saw it.
  // The process of a server tells nothing that the harness reads, thus its kernel tells all
  const reported = socket.find((record) => record.ev === "error" && (record.err ?? 0) !== 0);
  const seen = server
    ? undefined
    : events.find((event) => event.ev === "error" || event.ev === "eof");
  const outcome: Outcome =
    reported !== undefined
      ? { kind: "error", errno: ERRNO[reported.err!] ?? `E${reported.err}` }
      : seen?.ev === "eof"
        ? { kind: "eof" }
        : seen !== undefined
          ? { kind: "error", errno: String(seen["errno"]) }
          : { kind: "silent" };
  const ended = reported?.mono ?? seen?.t;
  const noticed =
    reported !== undefined && seen !== undefined ? between(reported.mono, seen.t) : null;
  const { prediction } = cell;

  // a stall: nothing must detect it, and the connection must move again at the first
  // retransmission after it stops, timed from the send of the request
  if (!prediction.detects && prediction.recovers !== undefined) {
    const { recovers } = prediction;
    const heal = run.heal ?? null;
    if (voided === null && heal === null) voided = "the stall never ended";
    else if (voided === null && heal !== null) {
      const from = between(request.t, heal.t0);
      const to = between(request.t, heal.t1);
      if (
        valueIn(from, "s") <= valueIn(recovers.heal.low, "s") ||
        valueIn(to, "s") >= valueIn(recovers.heal.high, "s")
      )
        voided = `the stall ended ${from.value}–${to.value} s after the send, outside the ${recovers.heal.low.value}–${recovers.heal.high.value} s its prediction assumed`;
    }
    const steps = retransmitted
      .filter((record) => record.mono > request.t)
      .map((record) => between(request.t, record.mono));
    if (ended !== undefined)
      return {
        ...base,
        ...nothing,
        outcome,
        steps,
        void: voided,
        finding: `detected after ${between(request.t, ended).value} s, where it should recover`,
      };
    // the first segment back after the stall stopped: the answer of the server to the
    // retransmission that got through, and the read of the reply by the client
    const answer =
      heal === null
        ? undefined
        : socket.find((record) => record.ev === "rx" && record.mono > heal.t0);
    if (answer === undefined)
      return {
        ...base,
        ...nothing,
        steps,
        void: voided,
        finding: "it never moved again: nothing came back after the stall ended",
      };
    const reply = events.find((event) => event.ev === "data" && event.t > request.t);
    voided ??= delayed(request.t, answer.mono, "retransmit");
    return {
      ...base,
      outcome: { kind: "answered" },
      elapsed: between(request.t, answer.mono),
      socket: reply === undefined ? null : between(request.t, reply.t),
      noticed: reply === undefined ? null : between(answer.mono, reply.t),
      steps,
      void: voided,
      finding: null,
    };
  }

  if (!prediction.detects) {
    // the test of silence covers the window from the send of the request
    const window = valueIn(prediction.window, "s") * 1e9;
    if (ended === undefined || ended - request.t > window)
      return { ...base, ...nothing, void: voided };
    return {
      ...base,
      ...nothing,
      outcome,
      elapsed: between(request.t, ended),
      void: voided,
      finding: `detected after ${between(request.t, ended).value} s, where nothing should`,
    };
  }

  if (ended === undefined)
    return {
      ...base,
      ...nothing,
      void: voided,
      finding: `nothing detected it: ${prediction.timer} never fired`,
    };
  // keepalive counts from the last segment received before the fault. The budget of the give-up
  // counts from the first retransmission of the RTO timer, not from the tail loss probe before it.
  // A reset counts from the send of the client. The kernel has no record of that send, thus the
  // stamp is the stamp of the client
  const before = run.fault?.t1 ?? ready.t;
  const kernelReference: KernelRecord | undefined =
    prediction.from === "last-received"
      ? socket.filter((record) => record.ev === "rx" && record.mono <= before).at(-1)
      : prediction.from === "first-retransmission"
        ? retransmitted.find((record) => record.why === "rto")
        : undefined;
  const reference: number | undefined =
    prediction.from === "request-sent" ? request.t : kernelReference?.mono;
  if (reference === undefined) {
    return {
      ...base,
      ...nothing,
      outcome,
      noticed,
      void: voided,
      finding: `it ended without its reference event (${prediction.from})`,
    };
  }
  const steps = (
    prediction.from === "last-received"
      ? keepalives
      : prediction.from === "first-retransmission"
        ? retransmitted.filter((record) => record.why === "rto" && record.mono > reference)
        : []
  ).map((record) => between(reference, record.mono));
  const finding =
    outcome.kind === "error" && outcome.errno === prediction.errno
      ? null
      : `it ended with ${outcome.kind === "error" ? outcome.errno : "end of file"}, not ${prediction.errno}`;
  // a firing at the reference itself only moves the start of the interval. A reset meets the send
  // with no timer
  if (prediction.from !== "request-sent")
    voided ??= delayed(
      reference,
      ended,
      prediction.from === "last-received" ? "keepalive" : "retransmit",
    );
  return {
    ...base,
    outcome,
    elapsed: between(reference, ended),
    socket: server ? null : socketVantage(cell, events, ready, request),
    noticed,
    steps,
    void: voided,
    finding,
  };
};
