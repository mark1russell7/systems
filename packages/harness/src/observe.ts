import type { Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { CallReading, ReconnectReading } from "./application.ts";
import {
  callOf,
  closeOrExit,
  dropFinding,
  dropOf,
  exitOf,
  firstUnanswered,
  leftAfter,
  pingsOf,
  programLines,
  reconnectFinding,
  reconnectOf,
} from "./application.ts";
import type { Cell, KernelRecord, ProbeEvent, Reference, Run } from "./cell.ts";
import { requestFirst } from "./cell.ts";
import type { DriverStepTime } from "./driver.ts";
import { measureDriver, proxiedClose } from "./driver.ts";
import type { GroupMeasured } from "./timeline.ts";
import { measureGroup } from "./timeline.ts";
import { INJECT, delayVoids, noiseOf, requestWords } from "./verdict.ts";

/**
 * An outcome tells how the wait of a run ended. The socket failed with an errno, or it read the
 * end of the file. Or nothing came, or the reply came back after a stall. The observer can also
 * close the connection itself (`closed`), or its program can drop it on its own timer (`dropped`).
 */
export type Outcome =
  | { readonly kind: "error"; readonly errno: string }
  | { readonly kind: "eof" }
  | { readonly kind: "silent" }
  | { readonly kind: "answered" }
  | { readonly kind: "closed" }
  | { readonly kind: "dropped" };

/**
 * A request reading is what the second request of an HTTP client met, from the lines of the
 * client. It holds the connection of its first try, a new try, and its outcome. `gap` is the time
 * from the end of the first reply to the send of the second request.
 */
export interface RequestReading {
  readonly connection: "reused" | "new";
  readonly retried: boolean;
  readonly error: string | null;
  readonly pending: boolean;
  readonly gap: Quantity | null;
}

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
  /**
   * These are the reply times of a measurement-only cell. For each request after the first, a
   * sample is the time from its send to the first data after it.
   */
  readonly samples?: readonly Quantity[];
  /** This count is the number of keepalive probes that the kernel sent. */
  readonly probes: number;
  /** This count is the number of segments that the kernel sent again. */
  readonly retransmissions: number;
  /** This count is the number of segments that the socket received after the request. */
  readonly acks: number;
  /** This count is the number of bytes that the client read after the request. */
  readonly bytes?: number;
  /**
   * This time is when a router of the topology forgot the flow of the client. It counts from the
   * last segment that the client received before the fault. It is null when no router forgot the flow.
   */
  readonly forgot?: Quantity | null;
  /**
   * This time is the first round trip of the socket of the observer. It is the smoothed round trip
   * in its first record, which is the sample of the handshake. It is null when no record has it.
   */
  readonly rtt?: Quantity | null;
  /** This record tells what reordering did in a run of a measurement-only cell, from the records of its two ends. */
  readonly reordering?: Reordering;
  /** These are the times of the proxy of a calibration cell, one for each request and its reply. */
  readonly crossings?: Crossings;
  /** This record is what a run of a group cell measured: the stages of its timeline, and what became of each write. */
  readonly group?: GroupMeasured;
  /** This record is what the second request of an HTTP client met, for a cell whose prediction says it. */
  readonly request?: RequestReading | null;
  /** This record is the time of each later band of a driver cell (`DriverBand.then`). */
  readonly driver?: { readonly steps: readonly DriverStepTime[] };
  /** This record is what the client did after the detection, for a prediction that says when it reconnects. */
  readonly reconnect?: ReconnectReading;
  /** This record is what the call in flight of a WebSocket client met. */
  readonly call?: CallReading;
  /**
   * This time is from the drop line of the program to the close of its socket by its own side: a
   * FIN or an abort. A prediction that says how the program drops (`drop`) gets it. It is null
   * when the socket did not close itself in the run. A prediction can say that the client process
   * ends with the run (`exits`). Then a close at that end is no close by the program, and `left` is null.
   */
  readonly left?: Quantity | null;
  /**
   * This time is from the drop line of the program to the end of the client process. A socket gets
   * it when it stayed open until that end. The kernel closed it then, not the program (`exits`).
   */
  readonly exited?: Quantity;
  /** This text is the reason that the run cannot count, or null. A void run is not a pass and not a finding. */
  readonly void: string | null;
  /** This text tells what in the run disagrees with the prediction, other than its timing, or null. */
  readonly finding: string | null;
}

/**
 * A reordering record is what reordering, duplicates and losses did to the data of a run. The
 * receiver is the client, and the sender is the socket of its peer.
 * - `outOfOrder` counts the arrivals at the client beyond a hole, and `duplicates` counts the
 *   arrivals whose data the client had. The prober reads the two from each arrival, against `rcv_nxt`.
 * - An arrival can hold more than one segment. The kernel joins the segments that wait in the
 *   backlog of a socket while its owner holds it.
 * - `ooo` is the count of the kernel of the client in segments (`rcv_ooopack`).
 * - `sacked` and `lost` are the most segments that the sender held as SACKed and as lost.
 * - `dsacks` is the DSACK blocks that the sender received, and `fast` its fast retransmissions.
 * - `degree` is the highest reordering degree of the sender (`tp->reordering`), and `seen` the
 *   reorderings that it detected (`reord_seen`).
 *
 * The counts of the kernel are null for a record of the prober before version 0.2.
 */
export interface Reordering {
  readonly outOfOrder: number;
  readonly duplicates: number;
  readonly ooo: number | null;
  readonly sacked: number | null;
  readonly lost: number | null;
  readonly dsacks: number | null;
  readonly fast: number;
  readonly degree: number | null;
  readonly seen: number | null;
}

/**
 * A crossings record is the time of a proxy for each request (`up`) and for each reply (`down`).
 * The time of a request starts at its arrival on the socket toward the client. It stops at the
 * write on the socket toward the target. The time of a reply goes the other way. A write is a
 * `tx` record of the prober.
 */
export interface Crossings {
  readonly hop: string;
  readonly up: readonly Quantity[];
  readonly down: readonly Quantity[];
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

/** These functions give the states of a state record: before the change, and after it. TCP_ESTABLISHED is 1, TCP_CLOSE_WAIT 8. */
const oldState = (record: KernelRecord): number | undefined => (record as { readonly old?: number }).old;
const newState = (record: KernelRecord): number | undefined => (record as { readonly new?: number }).new;

const count = (event: ProbeEvent | undefined, field: string): number =>
  event === undefined ? 0 : Number(event[field] ?? 0);

/** This function gives the view of the client on the same interval: TCP_INFO, with a sample each 2 ms. */
const socketVantage = (
  cell: Cell,
  events: readonly ProbeEvent[],
  ready: ProbeEvent,
  request: ProbeEvent,
): Quantity | null => {
  const { from } = cell.prediction.detects === true ? cell.prediction : { from: undefined };
  if (from === undefined || from === "peer-closed" || from === "fault" || from === "ping-sent" || from === "first-sent" || from === "last-data") return null;
  const ended = events.find((event) => event.ev === "error" || event.ev === "eof");
  const reference =
    from === "last-received"
      ? ready
      : from === "request-sent"
        ? request
        : events.find(
            (event) =>
              event.ev === "kernel" && event.t >= request.t && count(event, "retransmits") > 0,
          );
  return ended === undefined || reference === undefined ? null : between(reference.t, ended.t);
};

/** A socket place is a socket of a run: its namespace and its cookie. */
export interface SocketPlace {
  readonly netns: number;
  readonly cookie: number;
}

const ipOf = (address: string): string => address.split(":")[0]!;

/**
 * This function finds the socket that became ESTABLISHED in a run, in a namespace, whose peer
 * matches. In a topology, an address of a hop serves each run, thus only the socket that the
 * run opened is the socket of the run.
 */
const opened = (
  run: Run,
  netns: number,
  peer: (dst: string) => boolean,
): SocketPlace | undefined => {
  const record = run.kernel.find(
    (each) =>
      each.netns === netns &&
      each.ev === "state" &&
      newState(each) === 1 &&
      each.dst !== undefined &&
      peer(each.dst),
  );
  return record?.cookie === undefined ? undefined : { netns, cookie: record.cookie };
};

/**
 * This function finds the socket of a hop that carries the request of a run toward the target. It is
 * the first socket of the hop that sends data to the target after the send of the request. A pooler can
 * reuse a server that it opened before the run, in the warm-up of the environment. Then the first
 * socket that it opens in the run is another one (run 39160356281).
 */
const carried = (run: Run, netns: number, target: string): SocketPlace | undefined => {
  const request = run.events.filter((event) => event.ev === "sent")[1];
  if (request === undefined) return undefined;
  const record = run.kernel.find(
    (each) => each.netns === netns && each.ev === "tx" && each.dst === target && (each.seg?.len.value ?? 0) > 0 && each.mono >= request.t,
  );
  return record?.cookie === undefined ? undefined : { netns, cookie: record.cookie };
};

/** This function finds the socket of the target for the connection of a run. In a topology, its peer is the last hop. */
const targetSocket = (run: Run, local: unknown): SocketPlace | undefined => {
  if (run.topology === undefined) {
    const cookie = run.kernel.find(
      (record) => record.netns === run.targetNetns && record.dst === local,
    )?.cookie;
    return cookie === undefined ? undefined : { netns: run.targetNetns, cookie };
  }
  const peer = run.topology.targetPeer;
  return opened(run, run.targetNetns, (dst) => ipOf(dst) === peer);
};

/**
 * This function finds the socket of the observer of a cell in a run:
 * - the client socket, by the address that it connected from, in its namespace.
 * - the socket of the target for the same connection, in its namespace.
 * - a socket of a proxy of the topology, toward the client or toward the target. Toward the target,
 *   it is the socket that carries the request, else the first socket that the run opens.
 */
export const socketOf = (cell: Cell, run: Run): SocketPlace | undefined => {
  const local = run.events.find((event) => event.ev === "connected")?.["local"];
  const observer = cell.observer ?? "client";
  if (observer === "client") {
    const cookie = run.kernel.find((record) => record.netns === run.netns && record.src === local)?.cookie;
    return cookie === undefined ? undefined : { netns: run.netns, cookie };
  }
  if (observer === "server") return targetSocket(run, local);
  const hop = run.topology?.hops[observer.hop];
  if (hop === undefined) return undefined;
  return observer.toward === "client"
    ? opened(run, hop.netns, (dst) => ipOf(dst) === hop.client)
    : (carried(run, hop.netns, hop.target) ?? opened(run, hop.netns, (dst) => dst === hop.target));
};

/**
 * This function finds the socket of the peer of the observer: its close is the reference of a FIN.
 * In a direct pair, it is the other end of the connection. In a topology, it is the socket of the
 * target, for the client.
 */
const peerOf = (cell: Cell, run: Run): SocketPlace | undefined => {
  const local = run.events.find((event) => event.ev === "connected")?.["local"];
  const server = cell.observer === "server";
  if (run.topology !== undefined) return server ? undefined : targetSocket(run, local);
  const netns = server ? run.netns : run.targetNetns;
  const cookie = run.kernel.find(
    (record) => record.netns === netns && (server ? record.src : record.dst) === local,
  )?.cookie;
  return cookie === undefined ? undefined : { netns, cookie };
};

/** This function tells if sequence number a is after b, in the 32-bit space of TCP (`after` in include/net/tcp.h). */
const after32 = (a: number, b: number): boolean => ((a - b) | 0) > 0;

/** This function gives the largest value of a count of the kernel in records, or null when no record has it. */
const most = (records: readonly KernelRecord[], count: (record: KernelRecord) => number | undefined): number | null =>
  records.reduce<number | null>((top, record) => {
    const value = count(record);
    return value === undefined ? top : Math.max(top ?? 0, value);
  }, null);

/** This function gives what reordering did in a run, from the records of the receiver and of the sender. */
export const reorderingOf = (
  receiver: readonly KernelRecord[],
  sender: readonly KernelRecord[],
): Reordering => {
  const arrivals = receiver.filter(
    (record) => record.ev === "rx" && (record.seg?.len.value ?? 0) > 0 && record.tcp?.rcv_nxt !== undefined,
  );
  const outOfOrder = arrivals.filter((record) => after32(record.seg!.seq, record.tcp!.rcv_nxt!)).length;
  const duplicates = arrivals.filter(
    (record) => !after32(record.seg!.seq + record.seg!.len.value, record.tcp!.rcv_nxt!),
  ).length;
  return {
    outOfOrder,
    duplicates,
    ooo: most(receiver, (record) => record.tcp?.rcv_ooopack),
    sacked: most(sender, (record) => record.tcp?.sacked),
    lost: most(sender, (record) => record.tcp?.lost),
    dsacks: most(sender, (record) => record.tcp?.dsack_dups),
    fast: sender.filter((record) => record.ev === "retrans" && record.why === "fast").length,
    degree: most(sender, (record) => record.tcp?.reordering),
    seen: most(sender, (record) => record.tcp?.reord_seen),
  };
};

/**
 * This function gives the times of a proxy in a run, for each request after the first. The time
 * of a request starts at its arrival on the socket of the proxy toward the client. It stops at the
 * next write on the socket toward the target. The time of its reply starts at its arrival on the
 * socket toward the target, and it stops at the next write toward the client. A request without
 * each record gives no time.
 */
export const crossingsOf = (
  run: Run,
  hop: string,
  toClient: SocketPlace | undefined,
  toTarget: SocketPlace | undefined,
): Crossings => {
  const up: Quantity[] = [];
  const down: Quantity[] = [];
  if (toClient === undefined || toTarget === undefined) return { hop, up, down };
  const of = (place: SocketPlace) =>
    run.kernel.filter((record) => record.netns === place.netns && record.cookie === place.cookie);
  const near = of(toClient);
  const far = of(toTarget);
  const arrival = (records: readonly KernelRecord[], from: number, to: number) =>
    records.find((record) => record.ev === "rx" && (record.seg?.len.value ?? 0) > 0 && record.mono > from && record.mono < to);
  const write = (records: readonly KernelRecord[], from: number, to: number) =>
    records.find((record) => record.ev === "tx" && record.mono >= from && record.mono < to);
  const sends = run.events.filter((event) => event.ev === "sent").slice(1);
  sends.forEach((send, n) => {
    const next = sends[n + 1]?.t ?? Infinity;
    const request = arrival(near, send.t, next);
    const relayed = request === undefined ? undefined : write(far, request.mono, next);
    if (request === undefined || relayed === undefined) return;
    up.push(between(request.mono, relayed.mono));
    const reply = arrival(far, relayed.mono, next);
    const answered = reply === undefined ? undefined : write(near, reply.mono, next);
    if (reply !== undefined && answered !== undefined) down.push(between(reply.mono, answered.mono));
  });
  return { hop, up, down };
};

/**
 * This function reads one run against its cell, from the records of the kernel first.
 * - The socket of the run is the socket of its observer. It is the socket that the client connected
 *   from, in its namespace, or the socket of the target or of a proxy for that connection.
 * - The fault must hold before the event that it must meet. That is before the request goes into
 *   it, and before the first keepalive probe. A live peer answers that probe, and the answer
 *   starts the idle time again. A run where the fault was late is void. A run whose records the
 *   prober lost is also void.
 * - For an HTTP client, it also reads what the second request met (`requestOf`). An outcome other
 *   than the one that the prediction gives is a finding.
 */
export const measure = (cell: Cell, run: Run): Measured => {
  const read = measureSocket(cell, run);
  const expected = cell.prediction.request;
  if (cell.probe.http === undefined && expected === undefined) return read;
  const request = requestOf(run.events);
  if (expected === undefined || read.void !== null) return { ...read, request };
  const differs = requestFinding(expected, request);
  const finding = read.finding === null ? differs : differs === null ? read.finding : `${read.finding}. ${differs}`;
  return { ...read, request, finding };
};

/** This function tells how a request reading differs from its prediction, or gives null. */
const requestFinding = (expected: NonNullable<Cell["prediction"]["request"]>, read: RequestReading | null): string | null => {
  if (read === null) return `the second request never went out, where it should meet: ${requestWords(expected)}`;
  const same =
    read.connection === expected.connection &&
    read.retried === expected.retried &&
    read.error === expected.error &&
    read.pending === (expected.pending === true);
  return same ? null : `the second request met: ${requestWords(read)}, not ${requestWords(expected)}`;
};

/**
 * This function reads the second request of an HTTP client from its lines. Its first try is its
 * first `request` line, and each `retry` line is a new try. Its end is its `error` line, or its
 * `replied` line. A request with neither is pending. It gives null when the client wrote no try.
 *
 * A new try that gets no connection writes no `retry` line. Its dial writes a `dial-error` line.
 * Thus a `dial-error` line after the first try and before the end is also a new try.
 */
export const requestOf = (events: readonly ProbeEvent[]): RequestReading | null => {
  const of = (event: ProbeEvent) => Number(event["i"]) === 2;
  const tries = events.filter((event) => (event.ev === "request" || event.ev === "retry") && of(event));
  const first = tries[0];
  if (first === undefined) return null;
  const failed = events.find((event) => event.ev === "error" && of(event));
  const replied = events.some((event) => event.ev === "replied" && of(event));
  const ready = events.find((event) => event.ev === "ready");
  const sent = events.find((event) => event.ev === "sent" && of(event));
  const end = failed ?? events.find((event) => event.ev === "done" && of(event));
  const dialed = events.some(
    (event) => event.ev === "dial-error" && event.t > first.t && (end === undefined || event.t <= end.t),
  );
  return {
    connection: first["reused"] === true ? "reused" : "new",
    retried: dialed || tries.some((each) => each.ev === "retry"),
    error: failed === undefined ? null : String(failed["errno"]),
    pending: failed === undefined && !replied,
    gap: ready === undefined || sent === undefined ? null : between(ready.t, sent.t),
  };
};

/** This function reads the socket of one run against its cell, as `measure` does without the second request of an HTTP client. */
const measureSocket = (cell: Cell, run: Run): Measured => {
  if (cell.group !== undefined || cell.replicaSet !== undefined) {
    const read = measureGroup(cell, run);
    return {
      environment: run.environment,
      index: run.index,
      outcome: read.outcome,
      elapsed: read.elapsed,
      socket: read.socket,
      noticed: read.noticed,
      steps: [],
      probes: 0,
      retransmissions: run.kernel.filter((record) => record.netns === run.netns && record.ev === "retrans").length,
      acks: read.group.writes.acked,
      void: read.void,
      finding: read.finding,
      group: read.group,
    };
  }
  // a driver with more than one socket: its bands name their socket and their line
  if (cell.prediction.detects !== null && cell.prediction.driver !== undefined) return measureDriver(cell, run);
  const { events, kernel } = run;
  const ready = events.find((event) => event.ev === "ready");
  const local = events.find((event) => event.ev === "connected")?.["local"];
  // a client in a gap sends its second request by itself, and its idle connection counts from its first reply
  const inflight = cell.probe.mode !== "idle" && cell.probe.mode !== "gap";
  const request = inflight ? events.filter((event) => event.ev === "sent")[1] : ready;
  const server = cell.observer === "server";
  const place = socketOf(cell, run);
  const netns = place?.netns;
  const cookie = place?.cookie;
  const socket = kernel.filter((record) => record.netns === netns && record.cookie === cookie);
  // the socket of the peer for the same connection: a FIN counts from the change of state that its close makes
  const peerPlace = peerOf(cell, run);
  const peerNetns = peerPlace?.netns;
  const peerCookie = peerPlace?.cookie;
  // the bytes that the client read after its request, and the first and last time that data came
  const after = request === undefined ? [] : events.filter((event) => event.ev === "data" && event.t > request.t);
  const bytes = after.reduce((sum, event) => sum + Number(event["n"] ?? 0), 0);
  // the end of the flow in a router of the topology: its DESTROY line, by the address of the client
  const forgotten = (run.middlebox ?? []).find(
    (line) =>
      line.ev === "ct" &&
      line["type"] === "DESTROY" &&
      typeof line["orig"] === "string" &&
      (line["orig"] as string).startsWith(`${String(local)}>`),
  );
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
    const late = firings.find((record) => delayVoids(record.behind?.value ?? 0, run.hz, noiseOf(cell)));
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
  // the first round trip of the observer: the smoothed round trip in its first record, the sample of the handshake
  const srtt = socket.find((record) => record.tcp?.srtt !== undefined)?.tcp?.srtt;
  const rtt = srtt === undefined ? null : quantity(valueIn(srtt, "us") / 1000, "ms");
  const base = {
    environment: run.environment,
    index: run.index,
    probes: keepalives.length,
    retransmissions: retransmitted.length,
    acks,
    rtt,
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
    // reach the server first, and its reply must not reach the client before the fault holds. An
    // mtu-blackhole drops only the long reply, thus its request goes after the fault, as a client's does.
    // An event at a hop that comes while the request is in flight comes after the request too
    const replyFirst = (server && inflight && cell.fault !== "mtu-blackhole") || requestFirst(cell);
    const replied = events.some(
      (event) => event.ev === "data" && event.t > request.t && event.t < run.fault!.t1,
    );
    if (inflight && !replyFirst && run.fault.t1 > request.t)
      voided = "the request went out before the fault held";
    else if (replyFirst && run.fault.t1 < request.t)
      voided = "the request went out into the fault, so the server never had it";
    else if (replyFirst && replied)
      voided = "the server's reply arrived before the fault held";
    else if (keepalives[0] !== undefined && keepalives[0].mono < run.fault.t1)
      voided = "a keepalive probe went out before the fault held";
  }
  // a band holds for the first round trips that its prediction assumes. Above them, the run measured another path
  const assumed = cell.prediction.detects === null ? undefined : cell.prediction.rtt;
  if (voided === null && assumed !== undefined && rtt !== null && valueIn(rtt, "ms") > valueIn(assumed.high, "ms"))
    voided = `rtt-over-assumption: its first round trip was ${rtt.value} ms, above the ${valueIn(assumed.high, "ms")} ms that the prediction assumes`;

  // the detection as the kernel reported it to the owner of the socket, and as the client saw it.
  // The process of a server or of a proxy tells nothing that the harness reads, thus its kernel tells all
  const remote = cell.observer !== undefined && cell.observer !== "client";
  // the run stops the client at its end: what the own close of the client draws after its done line is
  // not a detection. A broker with linger 0, as RabbitMQ, resets each connection that its client closes
  const stop = events.find((event) => event.ev === "done")?.t ?? Number.POSITIVE_INFINITY;
  const reported = socket.find((record) => record.ev === "error" && (record.err ?? 0) !== 0 && record.mono < stop);
  const seen = remote
    ? undefined
    : events.find((event) => (event.ev === "error" || event.ev === "eof") && event.t < stop);
  // an end of file without an error is the change of state that the FIN of the peer makes, from
  // ESTABLISHED to CLOSE_WAIT, as the kernel stamps it
  const closeWait = socket.find((record) => record.ev === "state" && newState(record) === 8 && record.mono < stop);
  // a close of the observer itself, for a prediction that says it: from ESTABLISHED to FIN_WAIT1,
  // the FIN that its pool sends when it closes an idle connection
  const own =
    (cell.prediction.detects === true && cell.prediction.errno === "CLOSED") ||
    (cell.prediction.detects === null && cell.prediction.ends === "own-close")
      ? socket.find((record) => record.ev === "state" && oldState(record) === 1 && newState(record) === 4 && record.mono < stop)
      : undefined;
  // a drop by the program of the observer on its own timer: its `drop` line, at the kernel's stamp
  // of its close frame or its close. It counts when it comes before each report of the kernel
  const lines = programLines(cell, run);
  // a line of the client names the connection by its local address, and a line of a server by its
  // peer. That peer is the peer of the socket of the server: the last hop of a topology
  const named = server ? (socket.find((record) => record.dst !== undefined)?.dst ?? local) : local;
  const kernelEnded = reported?.mono ?? closeWait?.mono ?? own?.mono ?? seen?.t;
  const first = dropOf(lines, socket, named, noiseOf(cell));
  const drop = first !== undefined && (kernelEnded === undefined || first.at <= kernelEnded) ? first : undefined;
  const dropped = drop !== undefined;
  const outcome: Outcome = dropped
    ? { kind: "dropped" }
    : reported !== undefined
      ? { kind: "error", errno: ERRNO[reported.err!] ?? `E${reported.err}` }
      : closeWait !== undefined || seen?.ev === "eof"
        ? { kind: "eof" }
        : own !== undefined
          ? { kind: "closed" }
          : seen !== undefined
            ? { kind: "error", errno: String(seen["errno"]) }
            : { kind: "silent" };
  const ended = drop?.at ?? kernelEnded;
  const noticed =
    reported !== undefined && seen !== undefined && !dropped ? between(reported.mono, seen.t) : null;
  const { prediction } = cell;
  // the pings of a heartbeat of the program, at the kernel's stamps of their writes
  const pings = pingsOf(lines, socket, named, noiseOf(cell));
  // keepalive counts from the last segment received before the fault. The budget of the give-up
  // counts from the first retransmission of the RTO timer after the fault holds, not from the tail
  // loss probe before it. A retransmission before the fault is of an earlier segment, for example
  // the SYN of the connect of a proxy in a fresh environment. A reset counts from the send of the client. The kernel has no record of that send, thus the
  // stamp is the stamp of the client. A toxic counts from the start of its commit. A heartbeat
  // counts from the write of its first ping that got no answer before the detection
  const before = run.fault?.t1 ?? ready.t;
  const referenceAt = (from: Reference): number | undefined => {
    if (from === "request-sent") return request.t;
    if (from === "fault") return run.fault?.t0;
    if (from === "client-start") return (events.find((event) => event.ev === "connecting") ?? events[0])?.t;
    if (from === "ping-sent") return firstUnanswered(pings, socket, ended)?.at;
    const record: KernelRecord | undefined =
      from === "last-received"
        ? socket.filter((each) => each.ev === "rx" && each.mono <= before).at(-1)
        : from === "last-data"
          ? // the receive check of a heartbeat counts bytes, not an ACK: the last segment with data before the end
            socket.filter((each) => each.ev === "rx" && (each.seg?.len.value ?? 0) > 0 && each.mono <= (ended ?? before)).at(-1)
        : from === "first-retransmission"
          ? retransmitted.find((each) => each.why === "rto" && each.mono > before)
          : from === "first-sent"
            ? socket.find((each) => each.ev === "tx" && each.mono > before && (each.seg?.len.value ?? 0) > 0)
            : from === "syn-sent"
              ? socket.find((each) => each.ev === "state" && newState(each) === 2)
              : kernel.find(
              (each) =>
                each.netns === peerNetns &&
                each.cookie === peerCookie &&
                each.ev === "state" &&
                oldState(each) === 1,
            );
    // behind a proxy, a pooler keeps its connection to the target across its clients: the run can
    // reuse one that it did not open, and the close of the target closes each of them at once
    if (record === undefined && from === "peer-closed" && peerCookie === undefined) return proxiedClose(run);
    return record?.mono;
  };
  // in a topology, the bytes after the request and the instant that a router forgot the flow
  const lastRx =
    kernel
      .filter((each) => each.netns === run.netns && each.src === local && each.ev === "rx" && each.mono <= before)
      .at(-1)?.mono ?? ready.t;
  const chain =
    run.topology === undefined
      ? {}
      : { bytes, forgot: forgotten === undefined ? null : between(lastRx, forgotten.t) };

  // a measurement-only cell: each request of the run and the time to its reply, and the time from
  // its reference to the end of the connection, or to the last data
  if (prediction.detects === null) {
    const sends = events.filter((event) => event.ev === "sent").slice(1);
    // a reply ends at its last byte when the client says so (`replied`), and at its first data otherwise
    const answers = events.some((event) => event.ev === "replied") ? "replied" : "data";
    const samples = sends.flatMap((send, n) => {
      const next = sends[n + 1]?.t ?? Infinity;
      const reply = events.find((event) => event.ev === answers && event.t > send.t && event.t < next);
      return reply === undefined ? [] : [between(send.t, reply.t)];
    });
    const from = prediction.from === undefined ? undefined : referenceAt(prediction.from);
    const until = ended ?? after.at(-1)?.t;
    // the data of the client comes from its peer: the receiver and the sender of each reply
    const peerRecords =
      peerCookie === undefined
        ? []
        : kernel.filter((record) => record.netns === peerNetns && record.cookie === peerCookie);
    const proxy = cell.calibrates === undefined ? undefined : run.topology?.hops[cell.calibrates];
    const crossings =
      cell.calibrates === undefined
        ? {}
        : {
            crossings: crossingsOf(
              run,
              cell.calibrates,
              proxy === undefined ? undefined : socketOf({ ...cell, observer: { hop: cell.calibrates, toward: "client" } }, run),
              proxy === undefined ? undefined : socketOf({ ...cell, observer: { hop: cell.calibrates, toward: "target" } }, run),
            ),
          };
    // the reconnect after the end of the connection, against the bands of its waits. The end has no band
    const reconnect =
      prediction.reconnects === undefined || ended === undefined ? undefined : reconnectOf(run, ended, cookie, drop?.line.t ?? ended);
    const late = reconnect === undefined || prediction.reconnects === undefined ? null : reconnectFinding(prediction.reconnects, reconnect, noiseOf(cell));
    return {
      ...base,
      ...nothing,
      ...chain,
      ...(reconnect === undefined ? {} : { reconnect }),
      finding: late,
      outcome: ended !== undefined ? outcome : { kind: "answered" },
      ...(from === undefined || until === undefined ? {} : { elapsed: between(from, until) }),
      noticed: prediction.from === undefined ? null : noticed,
      steps: retransmitted
        .filter((record) => record.mono > request.t)
        .map((record) => between(request.t, record.mono)),
      samples,
      reordering: reorderingOf(
        socket.filter((record) => record.mono > request.t),
        peerRecords.filter((record) => record.mono > request.t),
      ),
      ...crossings,
      void: voided,
    };
  }

  // a stall: nothing must detect it, and the connection must move again at the first
  // retransmission after it stops, timed from the send of the request, or of the first ping
  if (!prediction.detects && prediction.recovers !== undefined) {
    const { recovers } = prediction;
    // an idle client sends only the pings of its heartbeat: its stall counts from its first ping into it
    const start =
      cell.probe.mode === "idle"
        ? (lines.find((line) => line.ev === "ping" && line.t >= (run.fault?.t1 ?? 0)) ?? request)
        : request;
    const heal = run.heal ?? null;
    if (voided === null && heal === null) voided = "the stall never ended";
    else if (voided === null && heal !== null) {
      const from = between(start.t, heal.t0);
      const to = between(start.t, heal.t1);
      if (
        valueIn(from, "s") <= valueIn(recovers.heal.low, "s") ||
        valueIn(to, "s") >= valueIn(recovers.heal.high, "s")
      )
        voided = `the stall ended ${from.value}–${to.value} s after the send, outside the ${recovers.heal.low.value}–${recovers.heal.high.value} s its prediction assumed`;
    }
    const steps = retransmitted
      .filter((record) => record.mono > start.t)
      .map((record) => between(start.t, record.mono));
    if (ended !== undefined)
      return {
        ...base,
        ...nothing,
        outcome,
        steps,
        void: voided,
        finding: `detected after ${between(start.t, ended).value} s, where it should recover`,
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
    const reply = events.find((event) => event.ev === "data" && event.t > start.t);
    voided ??= delayed(start.t, answer.mono, "retransmit");
    return {
      ...base,
      outcome: { kind: "answered" },
      elapsed: between(start.t, answer.mono),
      socket: reply === undefined ? null : between(start.t, reply.t),
      noticed: reply === undefined ? null : between(answer.mono, reply.t),
      steps,
      void: voided,
      finding: null,
    };
  }

  // a reply in a band: nothing must detect the fault, and the reply must come back in its time,
  // from the send of the request to the first segment that the socket receives after it
  if (!prediction.detects && prediction.replies !== undefined) {
    const window = valueIn(prediction.window, "s") * 1e9;
    if (ended !== undefined && ended - request.t <= window)
      return {
        ...base,
        ...nothing,
        ...chain,
        outcome,
        elapsed: between(request.t, ended),
        void: voided,
        finding: `detected after ${between(request.t, ended).value} s, where the reply should come`,
      };
    // the first segment with data: a proxy can acknowledge the request first, with no data
    const answer = socket.find(
      (record) => record.ev === "rx" && record.mono > request.t && (record.seg?.len.value ?? 0) > 0,
    );
    const reply = after[0];
    if (answer === undefined)
      return { ...base, ...nothing, ...chain, void: voided, finding: "the reply never came" };
    return {
      ...base,
      ...chain,
      outcome: { kind: "answered" },
      elapsed: between(request.t, answer.mono),
      socket: reply === undefined ? null : between(request.t, reply.t),
      noticed: reply === undefined ? null : between(answer.mono, reply.t),
      steps: [],
      void: voided,
      finding: null,
    };
  }

  if (!prediction.detects) {
    // the test of silence covers the window from the send of the request
    const window = valueIn(prediction.window, "s") * 1e9;
    if (ended === undefined || ended - request.t > window) {
      // the router keeps the flow in the window, unless the prediction says that it forgets it,
      // and when. Either way, nothing detects it
      const forgetIn = forgotten !== undefined && forgotten.t - request.t <= window ? forgotten : undefined;
      const expected = prediction.middlebox?.forgets;
      const after = forgetIn === undefined ? null : between(lastRx, forgetIn.t);
      let finding: string | null = null;
      if (expected === undefined) {
        if (after !== null) finding = `a router forgot the flow ${after.value} s after the last segment, where it should keep it`;
      } else if (after === null) {
        finding = "no router forgot the flow in the window, where it should forget it";
      } else {
        const noise = valueIn(noiseOf(cell), "s");
        const low = valueIn(expected.low, "s") - noise;
        const high = valueIn(expected.high, "s") + noise;
        if (after.value < low || after.value > high)
          finding = `a router forgot the flow ${after.value} s after the last segment, outside [${Math.round(low * 1e6) / 1e6}, ${Math.round(high * 1e6) / 1e6}] s`;
      }
      return { ...base, ...nothing, ...chain, void: voided, finding };
    }
    return {
      ...base,
      ...nothing,
      ...chain,
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
      ...chain,
      void: voided,
      finding: `nothing detected it: ${prediction.timer} never fired`,
    };
  const reference = referenceAt(prediction.from);
  if (reference === undefined) {
    return {
      ...base,
      ...nothing,
      ...chain,
      outcome,
      noticed,
      void: voided,
      finding: `it ended without its reference event (${prediction.from})`,
    };
  }
  // the steps of a heartbeat are its later pings, each from the first ping that got no answer
  const steps =
    prediction.from === "ping-sent"
      ? pings.filter((ping) => ping.at > reference && ping.at <= ended).map((ping) => between(reference, ping.at))
      : (prediction.from === "last-received"
          ? keepalives
          : prediction.from === "first-retransmission"
            ? retransmitted.filter((record) => record.why === "rto" && record.mono > reference)
            : []
        ).map((record) => between(reference, record.mono));
  const matches =
    prediction.errno === "EOF"
      ? outcome.kind === "eof"
      : prediction.errno === "CLOSED"
        ? outcome.kind === "closed"
        : prediction.errno === "DROPPED"
          ? outcome.kind === "dropped"
          : outcome.kind === "error" && outcome.errno === prediction.errno;
  const words =
    outcome.kind === "error"
      ? outcome.errno
      : outcome.kind === "closed"
        ? "its own close"
        : outcome.kind === "dropped"
          ? "a drop by its own program"
          : "end of file";
  // the reconnect of the client after the detection, against the bands of its waits
  const reconnect = prediction.reconnects === undefined ? undefined : reconnectOf(run, ended, cookie, drop?.line.t ?? ended);
  const late = reconnect === undefined || prediction.reconnects === undefined ? null : reconnectFinding(prediction.reconnects, reconnect, noiseOf(cell));
  // a drop of the program against the way that the prediction gives: a close frame or a close
  const closed = prediction.drop === undefined || drop === undefined ? undefined : leftAfter(socket, drop.line);
  // the end of the client process closes each socket that is still open: that close is not the program's
  const { left, exited } =
    closed === undefined || drop === undefined || prediction.exits !== true
      ? { left: closed, exited: undefined }
      : closeOrExit(drop.line, closed, exitOf(run, cookie), noiseOf(cell));
  const how = prediction.drop === undefined || drop === undefined || left === undefined ? null : dropFinding(prediction.drop, drop, left, noiseOf(cell), exited);
  const found = [matches ? null : `it ended with ${words}, not ${prediction.errno}`, late, how].filter((each) => each !== null);
  const finding = found.length === 0 ? null : found.join(". ");
  // the timer of an HTTP client or server is a timer of the program, not of the kernel: the kernel
  // timers of its socket do not drive the measurement
  const programTimer = cell.probe.http !== undefined && prediction.from === "last-received" && prediction.timer !== "keepalive";
  // a firing at the reference itself only moves the start of the interval. A reset meets the send
  // with no timer, a FIN arrives with none, and a toxic has its own clock
  if ((prediction.from === "last-received" && !programTimer) || prediction.from === "first-retransmission")
    voided ??= delayed(
      reference,
      ended,
      prediction.from === "last-received" ? "keepalive" : "retransmit",
    );
  // a heartbeat is a timer of the program. The retransmit timer of its ping fires in the same
  // interval, thus a delay of that timer behind its wheel slot tells that the VM stopped a vCPU
  if (prediction.from === "ping-sent") voided ??= delayed(reference, ended, "retransmit");
  // a timer of conntrack (expire_…) reaches its DESTROY through the listing of the router. A slow
  // listing between the expiry and the detection breaks the bound of its lag: the run measured the
  // pump, not the router. The expiry is at most the width of the band before the detection
  const lag = (valueIn(prediction.high, "s") - valueIn(prediction.low, "s")) * 1e9;
  const slow = prediction.timer.startsWith("expire_")
    ? (run.middlebox ?? []).find(
        (line) =>
          line.ev === "pump-slow" &&
          line.t <= ended &&
          line.t + Number(line["took"]) * 1e9 >= ended - lag,
      )
    : undefined;
  if (slow !== undefined)
    voided ??= `a listing of the router took ${Math.round(Number(slow["took"]) * 1e4) / 10} ms, longer than the bound of its prediction`;
  // a toxic starts somewhere in the commit of its request. A commit longer than the noise of the
  // pipeline leaves its start unknown within δ_abs
  const commit = run.fault === null ? 0 : (run.fault.t1 - run.fault.t0) / 1e6;
  if (prediction.from === "fault" && commit > valueIn(INJECT, "ms"))
    voided ??= `the commit of the fault took ${Math.round(commit * 10) / 10} ms, longer than the noise of the pipeline: its start is not known`;
  // the view of the program of a heartbeat: from the line of its first ping without an answer to
  // the line of its drop, or to the line of the error that it saw
  const unanswered = prediction.from === "ping-sent" ? firstUnanswered(pings, socket, ended) : undefined;
  const endLine = drop?.line ?? seen;
  const view =
    unanswered !== undefined
      ? endLine === undefined
        ? null
        : between(unanswered.line.t, endLine.t)
      : remote
        ? null
        : socketVantage(cell, events, ready, request);
  return {
    ...base,
    ...chain,
    outcome,
    elapsed: between(reference, ended),
    socket: view,
    noticed,
    steps,
    ...(reconnect === undefined ? {} : { reconnect }),
    ...(left === undefined ? {} : { left }),
    ...(exited === undefined ? {} : { exited }),
    ...(cell.probe.ws !== undefined && inflight ? { call: callOf(events, request, ended) } : {}),
    void: voided,
    finding,
  };
};
