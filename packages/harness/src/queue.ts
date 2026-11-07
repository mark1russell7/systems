import type { Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { KernelRecord, ProbeEvent, QueueBand, QueueConnection, QueuePrediction, Run } from "./cell.ts";
import type { Measured } from "./observe.ts";

/** This bit is the SYN of the flags of an `rx` record of the prober. */
const SYN = 2;

/** This record is what one connection of a queue cell did, from its lines and the records of its socket. */
export interface QueueConnectionReading {
  readonly name: string;
  readonly connected: boolean;
  /** These times are the waits of the SYN. The first one counts from the dial. */
  readonly syns: readonly Quantity[];
  /** These times are the waits of each SYN-ACK sent again. The first one counts from the dial. */
  readonly synAcks: readonly Quantity[];
  /** This count is the segments that the socket sent again. */
  readonly retransmissions: number;
  readonly errno: string | null;
  /** This time is from the line of the prediction to the end of the connection. It is null for a live connection, or with no prediction. */
  readonly ended: Quantity | null;
  /** This time is from the last retransmission to the end of the connection. */
  readonly afterLast: Quantity | null;
  /** This count is the segments of the socket with no acknowledgment at the end of the run. */
  readonly unacked: number | null;
}

/** This record is what a run of a queue cell measured. The counts are the changes in the run. */
export interface QueueReading {
  readonly max: number;
  readonly held: number;
  readonly connected: number;
  readonly overflows: number;
  readonly drops: number;
  readonly cookies: number;
  readonly timeouts: number;
  readonly resets: number;
  readonly drained: number;
  /** This time is from the first dial of the burst to the last `TCPTimeouts` of the prediction. */
  readonly expiry: Quantity | null;
  /** This time is from the first dial of the burst to the rise of the count of the queue. */
  readonly rise: Quantity | null;
  readonly connections: readonly QueueConnectionReading[];
}

/** This function gives the time between two stamps of CLOCK_MONOTONIC. */
export const between = (from: number, to: number): Quantity => quantity(Math.round((to - from) / 1e3) / 1e6, "s");

const numberOf = (line: ProbeEvent, field: string): number => {
  const value = line[field];
  return typeof value === "number" ? value : 0;
};

/** This function says if a time is inside a band. */
export const inside = (time: Quantity, band: QueueBand): boolean => {
  const seconds = valueIn(time, "s");
  return seconds >= valueIn(band.low, "s") && seconds <= valueIn(band.high, "s");
};

/** This function gives the words of a band. */
export const bandWords = (band: QueueBand): string => `[${valueIn(band.low, "s")}, ${valueIn(band.high, "s")}] s`;

const waitsOf = (from: number, stamps: readonly number[]): Quantity[] =>
  stamps.map((stamp, at) => between(at === 0 ? from : stamps[at - 1]!, stamp));

/** This function finds the records of the sockets of the client that had this local address. */
const socketsAt = (run: Run, local: unknown): KernelRecord[] => {
  const cookies = new Set(
    run.kernel.filter((record) => record.netns === run.netns && record.src === local).map((record) => record.cookie),
  );
  return run.kernel.filter((record) => record.netns === run.netns && cookies.has(record.cookie));
};

const readConnection = (name: string, run: Run, expected: QueueConnection | undefined): QueueConnectionReading => {
  const lineOf = (ev: string): ProbeEvent | undefined =>
    run.events.find((event) => event.ev === ev && event["name"] === name);
  const dial = lineOf("dial");
  const connected = lineOf("connected");
  const failed = lineOf("failed");
  const state = lineOf("state");
  const socket = dial === undefined ? [] : socketsAt(run, dial["local"]);
  const sent = socket.filter((record) => record.ev === "retrans").map((record) => record.mono);
  const rx = socket.filter((record) => record.ev === "rx" && ((record.seg?.flags ?? 0) & SYN) !== 0);
  const from = dial?.t ?? 0;
  const start = expected?.ends === null || expected?.ends === undefined ? undefined : lineOf(expected.ends.from);
  const last = sent.at(-1);
  return {
    name,
    connected: connected !== undefined,
    // a socket that connected sends its data again, not its SYN
    syns: waitsOf(from, connected === undefined ? sent : sent.filter((stamp) => stamp < connected.t)),
    synAcks: waitsOf(
      from,
      rx.map((record) => record.mono),
    ),
    retransmissions: sent.length,
    errno: failed === undefined ? null : String(failed["errno"]),
    ended: failed === undefined || start === undefined ? null : between(start.t, failed.t),
    afterLast: failed === undefined || last === undefined ? null : between(last, failed.t),
    unacked: state === undefined ? null : numberOf(state, "unacked"),
  };
};

/** This function reads one run against the band of each wait in a list, and gives the words of each miss. */
const waitFindings = (what: string, seen: readonly Quantity[], bands: readonly QueueBand[]): string[] => {
  if (seen.length !== bands.length) return [`${what}: ${seen.length} waits, not ${bands.length}`];
  return seen.flatMap((wait, at) =>
    inside(wait, bands[at]!) ? [] : [`${what}: wait ${at} of ${valueIn(wait, "s")} s, outside ${bandWords(bands[at]!)}`],
  );
};

const connectionFindings = (
  expected: QueueConnection,
  read: QueueConnectionReading,
  expiredAt: number | null,
  stamps: readonly number[],
): string[] => {
  const { name, ends } = expected;
  const found: string[] = [];
  if (read.connected !== expected.connects)
    found.push(`${name}: ${read.connected ? "connected" : "did not connect"}, against the prediction`);
  if (expected.syns !== undefined) found.push(...waitFindings(`${name} SYN`, read.syns, expected.syns));
  if (expected.synAcks !== undefined) found.push(...waitFindings(`${name} SYN-ACK`, read.synAcks, expected.synAcks));
  if (expected.unacked !== undefined && read.unacked !== expected.unacked)
    found.push(`${name}: ${read.unacked ?? "no"} segments without an ACK, not ${expected.unacked}`);
  if (ends === null) {
    if (read.errno !== null) found.push(`${name}: ended with ${read.errno}, and the prediction has no end`);
    return found;
  }
  if (read.errno !== ends.errno) found.push(`${name}: ended with ${read.errno ?? "nothing"}, not ${ends.errno}`);
  if (read.ended === null) return [...found, `${name}: no time for its end`];
  if (!inside(read.ended, ends.within))
    found.push(`${name}: its end came at ${valueIn(read.ended, "s")} s, outside ${bandWords(ends.within)}`);
  if (ends.retransmitted === undefined) return found;
  if (read.afterLast === null || !inside(read.afterLast, ends.retransmitted))
    found.push(`${name}: its end came ${read.afterLast === null ? "with no retransmission" : `${valueIn(read.afterLast, "s")} s after its last retransmission`}, outside ${bandWords(ends.retransmitted)}`);
  if (expiredAt === null) return found;
  const before = stamps.at(-2);
  const last = stamps.at(-1);
  if (last === undefined || last < expiredAt || (before !== undefined && before > expiredAt))
    found.push(`${name}: its last two retransmissions do not span the expiry`);
  return found;
};

/**
 * This function reads one run of a queue cell. The client lines give the connections and the
 * counters at the two ends of the run. The target lines give the count of the queue. The records of
 * the prober give the waits of each socket.
 */
export const measureQueue = (run: Run, expected: QueuePrediction): Measured => {
  const { events, kernel } = run;
  const lineOf = (ev: string): ProbeEvent | undefined => events.find((event) => event.ev === ev);
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
  const opened = lineOf("opened");
  const stats = lineOf("stats");
  if (opened === undefined) return voided("the target did not open its listener");
  if (stats === undefined || lineOf("done") === undefined) return voided("the client did not reach its end");
  if (run.lost === null) return voided("the prober wrote no clock line after the run, so nothing says what it dropped");
  if (run.lost > 0) return voided(`the prober dropped ${run.lost} records`);
  const lines = (run.server ?? []).filter((line) => line.ev === "queue" && line.t >= opened.t);
  if (lines.length === 0) return voided("the target wrote no queue line in the run");

  const named = [...new Set(events.filter((event) => event.ev === "dial").map((event) => String(event["name"])))];
  const predicted = new Map(expected.connections.map((each) => [each.name, each]));
  const connections = named.map((name) => readConnection(name, run, predicted.get(name)));
  const admitted = expected.admitted === undefined ? undefined : connections.find((each) => each.name === expected.admitted);
  if (expected.admitted !== undefined && (admitted === undefined || !admitted.connected || admitted.unacked !== 0))
    return voided(`${expected.admitted} did not take the last place in the queue: the burst did not land in its sequence`);

  const change = (field: string): number => numberOf(stats, field) - numberOf(opened, field);
  const burst = events.find((event) => event.ev === "dial" && event["name"] === "in")?.t ?? opened.t;
  const counted = expected.expiry?.timeouts;
  const expired = counted === undefined ? undefined : lines.find((line) => numberOf(line, "timeouts") - numberOf(opened, "timeouts") >= counted);
  const accepted = events.find((event) => event.ev === "accepted");
  // the rise counts from the first count below it: a line of the count before the accept can come after the reply of the accept
  const rise = expected.rise?.count ?? 0;
  const low = accepted === undefined ? -1 : lines.findIndex((line) => line.t >= accepted.t && numberOf(line, "count") < rise);
  const risen = low < 0 ? undefined : lines.slice(low).find((line) => numberOf(line, "count") >= rise);
  const drained = events
    .filter((event) => event.ev === "accepted")
    .reduce((sum, event) => sum + (Array.isArray(event["peers"]) ? event["peers"].length : 0), 0);
  const queue: QueueReading = {
    max: numberOf(opened, "max"),
    held: Math.max(...lines.map((line) => numberOf(line, "count"))),
    connected: connections.filter((each) => each.connected).length,
    overflows: change("overflows"),
    drops: change("drops"),
    cookies: change("cookies"),
    timeouts: change("timeouts"),
    resets: change("resets"),
    drained,
    expiry: expired === undefined ? null : between(burst, expired.t),
    rise: risen === undefined ? null : between(burst, risen.t),
    connections,
  };

  const found: string[] = [];
  if (queue.max !== expected.max) found.push(`the limit is ${queue.max}, not ${expected.max}`);
  if (queue.held !== expected.held) found.push(`the queue held ${queue.held}, not ${expected.held}`);
  if (queue.connected !== expected.connected) found.push(`${queue.connected} connected, not ${expected.connected}`);
  if (queue.overflows < expected.overflows.low || queue.overflows > expected.overflows.high)
    found.push(`${queue.overflows} overflows, outside [${expected.overflows.low}, ${expected.overflows.high}]`);
  if (queue.resets !== expected.resets) found.push(`${queue.resets} resets, not ${expected.resets}`);
  if (queue.cookies !== 0) found.push(`${queue.cookies} SYN cookies, and the law has none`);
  if (expected.drained !== undefined && queue.drained !== expected.drained)
    found.push(`${queue.drained} accepted, not ${expected.drained}`);
  if (expected.expiry !== undefined && (queue.expiry === null || !inside(queue.expiry, expected.expiry.within)))
    found.push(`the expiry came at ${queue.expiry === null ? "no time" : `${valueIn(queue.expiry, "s")} s`}, outside ${bandWords(expected.expiry.within)}`);
  if (expected.rise !== undefined && (queue.rise === null || !inside(queue.rise, expected.rise.within)))
    found.push(`the count got back to ${expected.rise.count} at ${queue.rise === null ? "no time" : `${valueIn(queue.rise, "s")} s`}, outside ${bandWords(expected.rise.within)}`);
  for (const each of expected.connections) {
    const read = connections.find((connection) => connection.name === each.name);
    if (read === undefined) {
      found.push(`${each.name}: the client did not dial it`);
      continue;
    }
    const dial = events.find((event) => event.ev === "dial" && event["name"] === each.name);
    const stamps = socketsAt(run, dial?.["local"]).filter((record) => record.ev === "retrans").map((record) => record.mono);
    found.push(...connectionFindings(each, read, expired?.t ?? null, stamps));
  }
  return { ...base, void: null, finding: found.length === 0 ? null : found.join(". "), queue };
};
