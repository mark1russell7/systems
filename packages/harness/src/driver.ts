import type { Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { Cell, DriverBand, KernelRecord, LineMatch, ProbeEvent, Reference, Run } from "./cell.ts";
import { requestFirst } from "./cell.ts";
import type { Measured, Outcome } from "./observe.ts";
import { INJECT, delayVoids, noiseOf } from "./verdict.ts";

/**
 * This module measures a run of a cell whose client is a driver with more than one socket, for
 * example the MongoDB driver. Its monitor, its pool and its round-trip pinger each have their own
 * socket, and the client names each socket by its role. A band counts from an event of one socket,
 * as the kernel records it. It ends at a line of the client, or at the report of the kernel on
 * that socket.
 */

/** A driver socket is one socket of the driver in a run: its role, its local address, its server, and when it opened and ended. */
export interface DriverSocket {
  readonly role: string;
  readonly local: string;
  readonly server: string;
  readonly opened: number;
  readonly ended: number | null;
}

/** A driver step time is the time of one later band of a run. It is null when its line did not come. */
export interface DriverStepTime {
  readonly what: string;
  readonly name: string | null;
  readonly elapsed: Quantity | null;
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

const between = (from: number, to: number): Quantity => quantity(Math.round((to - from) / 1e3) / 1e6, "s");
const round = (seconds: number): number => Math.round(seconds * 1e6) / 1e6;

/** This function gives the value of a field of a line by its name. A dotted name is a field in a field. */
export const fieldOf = (line: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((value, key) => (value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined), line);

/** This function tells if a line of the client matches a line match: its `ev`, and each field that the match names. */
export const matches = (line: ProbeEvent, match: LineMatch): boolean =>
  line.ev === match.ev && Object.entries(match.where ?? {}).every(([path, value]) => fieldOf(line, path) === value);

/** This function says a line match in words, for a finding. */
export const wordsOf = (match: LineMatch): string => {
  const where = Object.entries(match.where ?? {}).map(([path, value]) => `${path} ${String(value)}`);
  return where.length === 0 ? `a ${match.ev} line` : `a ${match.ev} line with ${where.join(", ")}`;
};

/** This function gives the sockets of the driver in a run, from the `socket` and `socket-end` lines of the client. */
export const socketsOf = (events: readonly ProbeEvent[]): DriverSocket[] =>
  events
    .filter((event) => event.ev === "socket")
    .map((event) => {
      const local = String(event["local"]);
      const end = events.find((each) => each.ev === "socket-end" && each["local"] === local && each.t >= event.t);
      return { role: String(event["role"]), local, server: String(event["server"]), opened: event.t, ended: end?.t ?? null };
    });

/**
 * This function finds the socket of a role at an instant. The pool's socket is the first one, which
 * the client names in its `connected` line. Each other role has the latest socket that opened at
 * the instant or before it.
 */
export const socketAt = (events: readonly ProbeEvent[], role: string, at: number): DriverSocket | undefined => {
  const sockets = socketsOf(events);
  if (role === "pool") {
    const local = events.find((event) => event.ev === "connected")?.["local"];
    return sockets.find((socket) => socket.local === local);
  }
  return sockets.filter((socket) => socket.role === role && socket.opened <= at).at(-1);
};

/** A kernel place is the namespace and the cookie of a socket, and its records in the run. */
interface KernelPlace {
  readonly netns: number;
  readonly cookie: number;
  readonly records: readonly KernelRecord[];
}

const placeOf = (run: Run, netns: number, find: (record: KernelRecord) => boolean): KernelPlace | undefined => {
  const cookie = run.kernel.find((record) => record.netns === netns && find(record))?.cookie;
  if (cookie === undefined) return undefined;
  return { netns, cookie, records: run.kernel.filter((record) => record.netns === netns && record.cookie === cookie) };
};

const portOf = (address: string): string => address.split(":").at(-1) ?? "";

/**
 * This function gives the socket of the target for a socket of the client. In a direct pair, its
 * peer is the address of the client socket. Behind a router, its peer is the address of the router
 * with the port of the client socket. The router keeps the port when it is free.
 */
const peerPlace = (run: Run, local: string): KernelPlace | undefined => {
  const peer = run.topology === undefined ? local : `${run.topology.targetPeer}:${portOf(local)}`;
  return placeOf(run, run.targetNetns, (record) => record.dst === peer);
};

/**
 * This function gives the socket that a hop of the topology opens toward its target in the run. It is
 * the first one that moves to SYN_SENT after the outset. A pooler connects to the server by itself,
 * thus no line of the client names that socket. The last hop goes first, because it faces the target.
 */
const upstreamOf = (run: Run): KernelPlace | undefined => {
  if (run.topology === undefined) return undefined;
  const outset = outsetOf(run);
  for (const hop of Object.values(run.topology.hops).reverse()) {
    const place = placeOf(run, hop.netns, (record) => record.ev === "state" && newState(record) === 2 && record.mono >= outset && record.dst === hop.target);
    if (place !== undefined) return place;
  }
  return undefined;
};

/**
 * This function gives the kernel place of a socket of a role at an instant. The role `server` is a
 * socket of the target, and the role `upstream` is the socket that a hop opens toward the target.
 */
const kernelOf = (run: Run, role: string, at: number): { socket: DriverSocket | undefined; place: KernelPlace | undefined } => {
  if (role === "upstream") return { socket: undefined, place: upstreamOf(run) };
  if (role === "server") {
    const pool = socketAt(run.events, "pool", at);
    return { socket: pool, place: pool === undefined ? undefined : peerPlace(run, pool.local) };
  }
  const socket = socketAt(run.events, role, at);
  return { socket, place: socket === undefined ? undefined : placeOf(run, run.netns, (record) => record.src === socket.local) };
};

const newState = (record: KernelRecord): number | undefined => (record as { readonly new?: number }).new;
const oldState = (record: KernelRecord): number | undefined => (record as { readonly old?: number }).old;

/** This function gives the instant that a run starts to look for its outcome. It is the fault, the reply before it, or the start of the client. */
const outsetOf = (run: Run): number => {
  const ready = run.events.find((event) => event.ev === "ready");
  return run.fault?.t0 ?? ready?.t ?? run.events[0]?.t ?? 0;
};

/**
 * This function gives the instant of a reference in a run, on a socket of the driver:
 * - `last-received`: the last segment that the socket received before the fault held. A band of
 *   the kernel counts from the last segment of any kind. A band that a line ends is a timer of
 *   the driver. It counts from the last segment with data that the socket received or sent.
 * - `request-sent`: the send of the operation into the fault, the second `sent` line.
 * - `first-retransmission`: the first retransmission of the RTO timer on the socket.
 * - `last-data`: the last segment with data that the socket received or sent before the fault
 *   held, for a band of the kernel too. An idle timer of a peer counts from the end of a stream.
 * - `peer-closed`: the change of state of the socket of the target, when its process dies.
 * - `fault`: the start of the commit of the fault. `client-start`: the `connecting` line.
 * - `first-sent`: the first segment with data that the socket sends after the fault.
 * A reference that this judge does not know (`ping-sent`) does not come: its band is a finding.
 */
export const referenceOf = (run: Run, from: Reference, role: string, data: boolean): number | undefined => {
  const ready = run.events.find((event) => event.ev === "ready");
  const before = run.fault?.t1 ?? ready?.t ?? Infinity;
  if (from === "fault") return run.fault?.t0;
  if (from === "client-start") return (run.events.find((event) => event.ev === "connecting") ?? run.events[0])?.t;
  if (from === "request-sent") return run.events.filter((event) => event.ev === "sent")[1]?.t;
  const { socket, place } = kernelOf(run, role, before);
  if (place === undefined) return undefined;
  if (from === "last-received" || from === "last-data") {
    // the idle timer of a Node socket starts again at each read and at each write of data
    const withData = data || from === "last-data";
    const counts = (record: KernelRecord) =>
      withData ? (record.ev === "rx" || record.ev === "tx") && (record.seg?.len.value ?? 0) > 0 : record.ev === "rx";
    return place.records.filter((record) => record.mono <= before && counts(record)).at(-1)?.mono;
  }
  if (from === "first-sent")
    return place.records.find((record) => record.ev === "tx" && record.mono > before && (record.seg?.len.value ?? 0) > 0)?.mono;
  // the connect of the socket: its change to SYN_SENT, which the kernel stamps when it sends the SYN
  if (from === "syn-sent") return place.records.find((record) => record.ev === "state" && newState(record) === 2)?.mono;
  if (from === "first-retransmission") {
    const request = run.events.filter((event) => event.ev === "sent")[1]?.t ?? before;
    return place.records.find((record) => record.ev === "retrans" && record.why === "rto" && record.mono > request)?.mono;
  }
  // before 0.11.22 an unknown reference fell to the close of the peer: through a proxy, that was the
  // first close of a socket of the target, for example the idle close of an upstream connection
  if (from !== "peer-closed") return undefined;
  // the close of the peer: the socket of the target leaves ESTABLISHED
  const peer = socket === undefined ? undefined : peerPlace(run, socket.local);
  const closed = peer?.records.find((record) => record.ev === "state" && oldState(record) === 1)?.mono;
  if (closed !== undefined || run.topology === undefined) return closed;
  return proxiedClose(run);
};

/**
 * This function gives the close of the target behind a proxy. It is the first socket of the target
 * toward the last hop that leaves ESTABLISHED after the outset. A proxy opens its own connection to the
 * target, with a port of its own, and a pooler keeps it across its clients. Thus no socket of the
 * target has the port of the client, and the one of the run can be older than the run. The death of
 * the process of the target closes each of them at once.
 */
export const proxiedClose = (run: Run): number | undefined => {
  if (run.topology === undefined) return undefined;
  const hop = run.topology.targetPeer;
  const outset = outsetOf(run);
  return run.kernel.find(
    (record) =>
      record.netns === run.targetNetns && record.ev === "state" && oldState(record) === 1 && record.mono >= outset && record.dst !== undefined && ipOf(record.dst) === hop,
  )?.mono;
};

/** This function gives the address of an address with its port. */
const ipOf = (address: string): string => address.slice(0, address.lastIndexOf(":"));

/** This function gives the first line of the client that matches, after an instant. */
const lineAfter = (events: readonly ProbeEvent[], match: LineMatch, after: number): ProbeEvent | undefined =>
  events.find((event) => event.t > after && matches(event, match));

/** This function gives the name of the error of a line: the field that the match names, or `name`. */
const nameOf = (line: ProbeEvent, match: LineMatch): string => String(fieldOf(line, match.name ?? "name") ?? line.ev);

/**
 * This function gives the report of the kernel on a socket after an instant: an error, or the end of
 * the file (CLOSE_WAIT). With neither, a close of the socket in SYN_SENT is the end. The program gave
 * up on its connect, and the kernel reports no error and sends no FIN. A refused connect also leaves
 * SYN_SENT, but it has its error.
 */
const reportOf = (place: KernelPlace, after: number): { at: number; outcome: Outcome } | undefined => {
  const report = place.records.find(
    (record) => record.mono > after && ((record.ev === "error" && (record.err ?? 0) !== 0) || (record.ev === "state" && newState(record) === 8)),
  );
  if (report === undefined) {
    const given = place.records.find((record) => record.mono > after && record.ev === "state" && oldState(record) === 2 && newState(record) === 7);
    return given === undefined ? undefined : { at: given.mono, outcome: { kind: "closed" } };
  }
  return report.ev === "error"
    ? { at: report.mono, outcome: { kind: "error", errno: ERRNO[report.err!] ?? `E${report.err}` } }
    : { at: report.mono, outcome: { kind: "eof" } };
};

/** This function gives the latest instant of the bands of a driver prediction, in seconds from their references. */
export const longestOf = (cell: Cell): number => {
  const { prediction } = cell;
  if (prediction.detects === null) return valueIn(prediction.window, "s");
  const steps = (prediction.driver?.then ?? []).map((step) => valueIn(step.high, "s"));
  const own = prediction.detects ? valueIn(prediction.high, "s") : valueIn(prediction.window, "s");
  return Math.max(own, ...steps);
};

/**
 * This function tells if a run of a driver cell has its outcome, so that its wait can stop. For a
 * detection, the outcome is the end of its band and of each later band. A silent prediction waits
 * for its window.
 */
export const settled = (cell: Cell, run: Run): boolean => {
  const { prediction } = cell;
  if (prediction.detects !== true || prediction.driver === undefined) return false;
  const driver: DriverBand = prediction.driver;
  const after = outsetOf(run);
  const ended =
    driver.ends === undefined
      ? (() => {
          const { place } = kernelOf(run, driver.socket, run.fault?.t1 ?? after);
          return place !== undefined && reportOf(place, after) !== undefined;
        })()
      : lineAfter(run.events, driver.ends, after) !== undefined;
  return ended && (driver.then ?? []).every((step) => lineAfter(run.events, step.ends, after) !== undefined);
};

/**
 * This function examines the keepalive timer of a socket between two instants. A firing two
 * jiffies or more behind its wheel slot was delayed by the host, which stopped a vCPU. A firing
 * that found the socket held by its owner put itself off by HZ/20. Either way, the run measured
 * something other than the timer.
 */
const delayed = (place: KernelPlace, from: number, to: number, hz: number | undefined, noise: Quantity): string | null => {
  const firings = place.records.filter((record) => record.ev === "timer" && record.what === "keepalive" && record.mono >= from && record.mono <= to);
  const late = firings.find((record) => delayVoids(record.behind?.value ?? 0, hz, noise));
  if (late !== undefined) return `its keepalive timer ran ${late.behind!.value} jiffies behind its wheel slot: the VM delayed it, not the kernel`;
  const held = firings.find((record) => record.owned === true);
  return held === undefined ? null : "its keepalive timer found the socket held by its owner and put itself off by HZ/20: the run measured the owner, not the timer";
};

/**
 * This function reads one run of a driver cell.
 * - The band of the cell counts from its reference on its socket. It ends at its line, or at the
 *   report of the kernel on that socket.
 * - Each later band (`then`) gets the same test. A later band outside its band, or absent, is a finding.
 * - A line that the prediction names as quiet, after the fault and in its window, is a finding.
 *   So is a flow of an open socket of the driver that a router forgot, for a silent prediction.
 *   A prediction with `middlebox.forgets` gives a band for the flow of the socket of the driver. The
 *   band counts from the last segment that the socket got before the fault.
 * - A silent prediction can time a reply (`reply`), and the verdict tests it against `replies`.
 *
 * A run is void when the prober lost records, or when the client did not get its first reply. It
 * is also void when the operation went out before the fault held. A late lift of a hold and a
 * keepalive probe before the fault also make it void. So do a delayed timer and a round trip
 * above the assumption.
 */
export const measureDriver = (cell: Cell, run: Run): Measured => {
  const { prediction } = cell;
  if (prediction.detects === null || prediction.driver === undefined) throw new Error(`${cell.name} has no driver band`);
  const driver = prediction.driver;
  const { events } = run;
  const ready = events.find((event) => event.ev === "ready");
  const request = events.filter((event) => event.ev === "sent")[1];
  const after = outsetOf(run);
  const before = run.fault?.t1 ?? ready?.t ?? after;
  const { place } = kernelOf(run, driver.socket, before);
  const records = place?.records ?? [];
  const pool = kernelOf(run, "pool", before).place;
  const srtt = pool?.records.find((record) => record.tcp?.srtt !== undefined)?.tcp?.srtt;
  const rtt = srtt === undefined ? null : quantity(valueIn(srtt, "us") / 1000, "ms");
  const base = {
    environment: run.environment,
    index: run.index,
    probes: records.filter((record) => record.ev === "probe" && record.what === "keepalive").length,
    retransmissions: records.filter((record) => record.ev === "retrans").length,
    acks: request === undefined ? 0 : records.filter((record) => record.ev === "rx" && record.mono > request.t).length,
    rtt,
  };
  const nothing = { outcome: { kind: "silent" } as const, elapsed: null, socket: null, noticed: null, steps: [], finding: null };

  if (cell.before !== true && ready === undefined) return { ...base, ...nothing, void: "the client never had its reply" };
  if (run.lost === null) return { ...base, ...nothing, void: "the prober wrote no clock line after the run, so nothing says what it dropped" };
  if (run.lost > 0) return { ...base, ...nothing, void: `the prober dropped ${run.lost} records` };

  let voided: string | null = null;
  if (cell.probe.mode !== "idle" && cell.before !== true) {
    if (request === undefined) voided = "the operation was never sent into the fault";
    else if (requestFirst(cell)) {
      // an event at a hop that comes while the operation is in flight: the operation goes first
      if (run.fault !== null && run.fault.t0 < request.t) voided = "the event came before the operation";
    } else if (run.fault !== null && run.fault.t1 > request.t) voided = "the operation went out before the fault held";
  }
  const keepalive = records.find((record) => record.ev === "probe" && record.what === "keepalive");
  if (voided === null && run.fault !== null && keepalive !== undefined && keepalive.mono < run.fault.t1)
    voided = "a keepalive probe went out before the fault held";
  if (voided === null && cell.hold !== undefined && run.fault !== null) {
    const heal = run.heal ?? null;
    if (heal === null) voided = "the fault never lifted";
    else {
      const late = (heal.t0 - run.fault.t0) / 1e9 - valueIn(cell.hold, "s");
      if (late > valueIn(INJECT, "s")) voided = `the lift came ${Math.round(late * 1e4) / 10} ms after its hold: the injector was late, not the client`;
    }
  }
  const assumed = prediction.rtt;
  if (voided === null && assumed !== undefined && rtt !== null && valueIn(rtt, "ms") > valueIn(assumed.high, "ms"))
    voided = `rtt-over-assumption: its first round trip was ${rtt.value} ms, above the ${valueIn(assumed.high, "ms")} ms that the prediction assumes`;

  const findings: string[] = [];
  const noise = valueIn(noiseOf(cell), "s");
  // the end of the window: the window of a silent prediction, or the end of the run
  const until = prediction.detects ? Infinity : after + valueIn(prediction.window, "s") * 1e9;
  for (const match of driver.quiet ?? []) {
    const line = events.find((event) => event.t > after && event.t <= until && matches(event, match));
    if (line !== undefined) findings.push(`${wordsOf(match)} came ${between(after, line.t).value} s after the fault, where none should`);
  }
  const expected = prediction.detects ? undefined : prediction.middlebox?.forgets;
  if (!prediction.detects && (run.middlebox !== undefined || expected !== undefined)) {
    // a router forgets a flow of a socket that is still open: the flow of a live connection is gone,
    // unless the prediction says when the router forgets the flow of the socket of the driver
    const own = socketAt(events, driver.socket, before)?.local;
    if (expected !== undefined && own === undefined) findings.push(`the client opened no ${driver.socket} socket before the fault`);
    const middlebox: NonNullable<Run["middlebox"]> = run.middlebox ?? [];
    for (const socket of socketsOf(events)) {
      const forgot = middlebox.find(
        (line) =>
          line.ev === "ct" &&
          line["type"] === "DESTROY" &&
          String(line["orig"] ?? "").startsWith(`${socket.local}>`) &&
          line.t > socket.opened &&
          (socket.ended === null || line.t < socket.ended) &&
          line.t <= until,
      );
      if (expected === undefined || socket.local !== own) {
        if (forgot !== undefined) findings.push(`a router forgot the flow of the ${socket.role} socket ${between(after, forgot.t).value} s after the fault, where it should keep it`);
        continue;
      }
      // the band counts from the last segment that the socket got before the fault, as for the client of TCP
      const last = referenceOf(run, "last-received", driver.socket, false);
      if (forgot === undefined) findings.push(`no router forgot the flow of the ${socket.role} socket in the window, where it should forget it`);
      else if (last === undefined) findings.push(`the ${socket.role} socket got no segment before the fault`);
      else {
        const at = between(last, forgot.t).value;
        const [low, high] = [round(valueIn(expected.low, "s") - noise), round(valueIn(expected.high, "s") + noise)];
        if (at < low || at > high) findings.push(`a router forgot the flow of the ${socket.role} socket ${at} s after its last segment, outside [${low}, ${high}] s`);
      }
    }
  }
  const stepTimes: DriverStepTime[] = (driver.then ?? []).map((step) => {
    const line = lineAfter(events, step.ends, after);
    const from = referenceOf(run, step.from, step.socket ?? driver.socket, true);
    if (line === undefined || from === undefined) {
      findings.push(line === undefined ? `${step.what}: ${wordsOf(step.ends)} never came` : `${step.what}: its reference (${step.from}) never came`);
      return { what: step.what, name: line === undefined ? null : nameOf(line, step.ends), elapsed: null };
    }
    const elapsed = between(from, line.t);
    const name = nameOf(line, step.ends);
    if (step.name !== "OK" && name !== step.name) findings.push(`${step.what}: it ended with ${name}, not ${step.name}`);
    const [low, high] = [round(valueIn(step.low, "s") - noise), round(valueIn(step.high, "s") + noise)];
    if (elapsed.value < low || elapsed.value > high) findings.push(`${step.what}: ${elapsed.value} s is outside [${low}, ${high}] s`);
    return { what: step.what, name, elapsed };
  });
  const stepped = stepTimes.length === 0 ? {} : { driver: { steps: stepTimes } };

  if (!prediction.detects) {
    if (driver.reply === undefined || prediction.replies === undefined)
      return { ...base, ...nothing, ...stepped, void: voided, finding: findings[0] ?? null };
    const line = lineAfter(events, driver.reply.ends, after);
    const from = referenceOf(run, driver.reply.from, driver.socket, true);
    if (line === undefined || from === undefined)
      return { ...base, ...nothing, ...stepped, void: voided, finding: findings[0] ?? `the reply never came: ${wordsOf(driver.reply.ends)}` };
    return {
      ...base,
      ...nothing,
      ...stepped,
      outcome: { kind: "answered" },
      elapsed: between(from, line.t),
      void: voided,
      finding: findings[0] ?? null,
    };
  }

  // the band of the cell: its line, or the report of the kernel on its socket
  const line = driver.ends === undefined ? undefined : lineAfter(events, driver.ends, after);
  const report = driver.ends === undefined && place !== undefined ? reportOf(place, after) : undefined;
  if (driver.ends === undefined && place === undefined)
    return { ...base, ...nothing, ...stepped, void: voided ?? `the prober saw nothing of the ${driver.socket} socket`, finding: findings[0] ?? null };
  const ended = line?.t ?? report?.at;
  const outcome: Outcome =
    line !== undefined && driver.ends !== undefined ? { kind: "error", errno: nameOf(line, driver.ends) } : (report?.outcome ?? { kind: "silent" });
  if (ended === undefined)
    return { ...base, ...nothing, ...stepped, void: voided, finding: findings[0] ?? `nothing detected it: ${prediction.timer} never fired` };
  const reference = referenceOf(run, prediction.from, driver.socket, driver.ends !== undefined);
  if (reference === undefined)
    return { ...base, ...nothing, ...stepped, outcome, void: voided, finding: `it ended without its reference event (${prediction.from} on the ${driver.socket} socket)` };
  if (driver.ends === undefined && prediction.from === "last-received" && place !== undefined) voided ??= delayed(place, reference, ended, run.hz, noiseOf(cell));
  const name = outcome.kind === "error" ? outcome.errno : outcome.kind === "eof" ? "EOF" : outcome.kind === "closed" ? "CLOSED" : "silent";
  if (prediction.errno !== "OK" && name !== prediction.errno) findings.unshift(`it ended with ${name}, not ${prediction.errno}`);
  // the client's own view: its first error line after the report of the kernel
  const seen = report === undefined ? undefined : events.find((event) => event.t >= report.at && (event.ev === "error" || event.ev === "socket-error"));
  return {
    ...base,
    ...stepped,
    outcome,
    elapsed: between(reference, ended),
    socket: seen === undefined ? null : between(reference, seen.t),
    noticed: report === undefined || seen === undefined ? null : between(report.at, seen.t),
    steps: (prediction.from === "last-received" ? records.filter((record) => record.ev === "probe" && record.what === "keepalive" && record.mono > reference) : []).map(
      (record) => between(reference, record.mono),
    ),
    void: voided,
    finding: findings[0] ?? null,
  };
};
