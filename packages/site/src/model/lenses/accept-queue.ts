/**
 * The lenses of the accept queue: one listener, a program that does not accept, and many connects. A
 * full queue drops a SYN with no answer, and it drops the final ACK of a handshake. The law of the
 * count is `acceptQueueLimit` and `acceptQueueHeld` of the algebra. The timers of a connection at a
 * full queue come from the document of Linux TCP. They are the SYN ladder of the client, and the
 * SYN-ACK ladder and the expiry of a request at the target. The cells AQ.1 to AQ.10 of the harness measure
 * each term.
 *
 * The story of the page starts at the first new connect. The queue holds `queued` connections at
 * 0 s. Each packet takes one half of the round trip.
 */
import { acceptQueueHeld, acceptQueueLimit, firings, timerOf, type KnobValues } from "@mark1russell7/automata";
import { LINUX_TCP } from "@mark1russell7/machines";
import { format, quantity, valueIn, type Quantity } from "@mark1russell7/quantity";
import { bandOf, finite, memo, say, sayBand, type Band, type Fact, type Lane, type Lens, type Mark } from "../lens.ts";
import { ZERO, bandOfTimer, count, linuxTcpValues, ms, s } from "../path.ts";

/** A listener is the program that calls listen(2): a native program gives its backlog, and Node gives `backlog || 511`. */
export type Listener = "native" | "node";
/** The new connects come at once, or one each round trip. */
export type Arrival = "once" | "turn";
/** The client sends no data, sends at once when it is connected, or sends at a later time. */
export type Send = "never" | "connected" | "later";

export interface QueueSettings {
  readonly listener: Listener;
  /** the backlog that the program declares */
  readonly backlog: number;
  readonly somaxconn: number;
  /** the connections in the queue at 0 s, at most the count that a full queue holds */
  readonly queued: number;
  /** the new connects of the story */
  readonly connections: number;
  readonly arrival: Arrival;
  /** This flag starts the accept of the program at `acceptAt`. From that time, each connection finds a place. */
  readonly accept: boolean;
  readonly acceptAt: Quantity;
  /** This flag is `tcp_abort_on_overflow` 1. */
  readonly abort: boolean;
  readonly send: Send;
  readonly sendAt: Quantity;
  readonly synRetries: number;
  readonly synackRetries: number;
  readonly rtt: Quantity;
  readonly hz: number;
}

/** These are the settings of the cell AQ.5: a backlog of 4, a full queue, and a burst of three connects. The client sends nothing. */
export const QUEUE_DEFAULTS: QueueSettings = {
  listener: "native",
  backlog: 4,
  somaxconn: 4096,
  queued: 4,
  connections: 3,
  arrival: "once",
  accept: false,
  acceptAt: ms(2500),
  abort: false,
  send: "never",
  sendAt: s(70),
  synRetries: 6,
  synackRetries: 5,
  rtt: ms(20),
  hz: 1000,
};

/** The lanes of the accept queue. */
export type QueueLaneId = "queue" | "syn" | "ack";

/** The fate of a new connect: in the queue, in the queue after the accept, a SYN that drops, or a final ACK that overflows. */
export type Fate = "in" | "accepted" | "syn" | "ack";

// ---------------------------------------------------------------------------------------------
// the ladders
// ---------------------------------------------------------------------------------------------

/** A firing is one send of a ladder: its time from the start of the story, and its band. The band is null when a bound is not known. */
export interface Firing {
  readonly at: number;
  readonly band: Band | null;
}

const sec = (quantity: Quantity): number => valueIn(quantity, "s");

/** This function moves a band by `by` seconds. */
const shift = (band: Band | null, by: number): Band | null => (band === null ? null : bandOf(s(sec(band.low) + by), s(sec(band.high) + by)));

/** This function gives the values of the knobs of Linux TCP for the accept queue. */
const values = (settings: QueueSettings): KnobValues =>
  linuxTcpValues({
    rtt: settings.rtt,
    hz: quantity(settings.hz, "Hz"),
    tcp_syn_retries: count(settings.synRetries),
    tcp_synack_retries: count(settings.synackRetries),
    somaxconn: count(settings.somaxconn),
    tcp_abort_on_overflow: count(settings.abort ? 1 : 0),
  });

/**
 * This function gives the firings of a backoff timer of Linux TCP from `start`. Each firing is the sum
 * of its waits, with the sums of how early and how late each wait can fire. `until` and `reach` are the stops of
 * `firings` of the algebra, in seconds from `start`.
 */
const ladder = (timer: string, knobs: KnobValues, start: number, stop: { readonly until?: number; readonly reach?: number }): Firing[] => {
  const options = {
    count: 64,
    ...(stop.until === undefined ? {} : { until: s(stop.until) }),
    ...(stop.reach === undefined ? {} : { reach: s(stop.reach) }),
  };
  let early = 0;
  let late = 0;
  let known = true;
  return firings(LINUX_TCP, timer, knobs, options).map((firing) => {
    const bounds = timerOf(LINUX_TCP, timer, knobs, firing.fired);
    if (finite(bounds.early) && finite(bounds.lateness)) {
      early += sec(bounds.early);
      late += sec(bounds.lateness);
    } else known = false;
    const at = start + sec(firing.at);
    return { at, band: known ? bandOf(s(at - early), s(at + late)) : null };
  });
};

/** This function gives the segments of the client from its send. They are the first send, then each firing of the retransmission timer, up to the first one at `target` or after it. */
const segments = (knobs: KnobValues, send: number, target: number): Firing[] => [{ at: send, band: bandOf(s(send)) }, ...ladder("retransmit", knobs, send, { reach: target - send })];

// ---------------------------------------------------------------------------------------------
// the law
// ---------------------------------------------------------------------------------------------

/** The first overflow of the queue: its time, its packet, and the connect, from 1. */
export interface Overflow {
  readonly at: number;
  readonly what: "syn" | "ack";
  readonly connection: number;
}

/** The story of the first connect whose SYN drops: its SYNs, and its end. */
export interface SynStory {
  readonly connection: number;
  readonly dial: number;
  /** each retransmission of the SYN until the end */
  readonly syns: readonly Firing[];
  readonly end: { readonly kind: "timeout" | "connected"; readonly at: number; readonly band: Band | null };
}

/** The end of the first connect whose final ACK overflows. */
export interface AckEnd {
  readonly kind: "reset" | "connected" | "blind";
  /** what ends it: the reset of tcp_abort_on_overflow 1, a segment after the expiry, a challenge ACK, or a segment with data */
  readonly by: "abort" | "expiry" | "synack" | "data";
  readonly at: number | null;
  readonly band: Band | null;
}

/** The story of the first connect whose final ACK overflows. */
export interface AckStory {
  readonly connection: number;
  readonly dial: number;
  /** the client is ESTABLISHED at this time */
  readonly connected: number;
  /** the final ACK reaches the full queue at this time */
  readonly overflow: number;
  /** This flag tells if the SYN of the connect got a SYN cookie. */
  readonly cookie: boolean;
  /** each SYN-ACK that the target sends again, at the target */
  readonly synAcks: readonly Firing[];
  /** the expiry of the request at the target, or null when tcp_abort_on_overflow 1 drops it at once */
  readonly expiry: Firing | null;
  /** the first send of data of the client, or null */
  readonly send: number | null;
  readonly end: AckEnd;
  /** This flag tells if a segment of the client reaches the target inside the band of the expiry. */
  readonly near: boolean;
}

/** What the accept queue does with the settings: the count, the fate of each new connect, and the two stories. */
export interface QueueModel {
  /** the backlog that listen(2) gets */
  readonly listen: number;
  readonly limit: number;
  readonly held: number;
  /** the connections in the queue at 0 s */
  readonly start: number;
  readonly fates: readonly Fate[];
  readonly admitted: number;
  readonly accepted: number;
  readonly synDrops: number;
  readonly ackDrops: number;
  readonly cookies: number;
  /** the time at which the queue is full, or null */
  readonly full: number | null;
  readonly first: Overflow | null;
  readonly syn: SynStory | null;
  readonly ack: AckStory | null;
}

/** This function gives the backlog that listen(2) gets from the program: Node gives `backlog || 511` (`lib/net.js` of Node 24). */
export const listenBacklog = (settings: QueueSettings): number => (settings.listener === "node" ? settings.backlog || 511 : settings.backlog);

/** This function gives the time of the dial of the new connect `i`, from 0, in halves of the round trip. */
const dialOf = (settings: QueueSettings, i: number): number => (settings.arrival === "once" ? 0 : 2 * i);

/** One packet of a handshake at the target: the SYN, or the final ACK. Its time is in halves of the round trip. */
interface Arrival_ {
  readonly t: number;
  readonly ack: boolean;
  readonly i: number;
}

/** The story of the first SYN that drops: its SYN ladder, and ETIMEDOUT, or a place after the accept. */
const synStory = (settings: QueueSettings, connection: number, dial: number): SynStory => {
  const knobs = values(settings);
  const half = sec(settings.rtt) / 2;
  const giveup = timerOf(LINUX_TCP, "syn_giveup", knobs);
  const life = finite(giveup.duration) ? sec(giveup.duration) : Infinity;
  // the firing at the end of the last wait is the end itself, not a SYN
  const syns = ladder("syn_retransmit", knobs, dial, Number.isFinite(life) ? { until: life } : {}).filter((firing) => firing.at < dial + life - 1e-9);
  const at = settings.accept ? sec(settings.acceptAt) : Infinity;
  const found = syns.findIndex((firing) => firing.at + half >= at);
  const recovery = syns[found];
  if (recovery !== undefined) {
    return { connection, dial, syns: syns.slice(0, found + 1), end: { kind: "connected", at: recovery.at + 2 * half, band: shift(recovery.band, 2 * half) } };
  }
  return { connection, dial, syns, end: { kind: "timeout", at: dial + life, band: shift(bandOfTimer(giveup), dial) } };
};

/** This function gives the story of the first final ACK that overflows. The end is a reset, a place after the accept, a reset after the expiry, or a client that knows nothing. */
const ackStory = (settings: QueueSettings, connection: number, dial: number, cookie: boolean): AckStory => {
  const knobs = values(settings);
  const half = sec(settings.rtt) / 2;
  const connected = dial + 2 * half;
  const overflow = dial + 3 * half;
  const send = settings.send === "never" ? null : settings.send === "connected" ? connected : Math.max(connected, sec(settings.sendAt));
  const base = { connection, dial, connected, overflow, cookie, send };
  if (settings.abort) {
    // tcp_abort_on_overflow 1 answers the final ACK with a reset, and the reset takes one half of the round trip
    const at = overflow + half;
    return { ...base, synAcks: [], expiry: null, end: { kind: "reset", by: "abort", at, band: bandOf(s(at)) }, near: false };
  }
  // the timer of the request starts when the SYN reaches the target
  const armed = dial + half;
  const giveup = timerOf(LINUX_TCP, "synack_giveup", knobs);
  const life = finite(giveup.duration) ? sec(giveup.duration) : Infinity;
  const expiry: Firing = { at: armed + life, band: shift(bandOfTimer(giveup), armed) };
  const synAcks = ladder("synack_retransmit", knobs, armed, Number.isFinite(life) ? { until: life } : {}).filter((firing) => firing.at < expiry.at - 1e-9);
  const ends: AckEnd[] = [];
  if (settings.accept) {
    const open = sec(settings.acceptAt);
    // the client answers each SYN-ACK with a challenge ACK, and that ACK reaches the target one round trip after the firing
    const synAck = synAcks.find((firing) => firing.at + 2 * half >= open);
    if (synAck !== undefined) ends.push({ kind: "connected", by: "synack", at: synAck.at + 2 * half, band: shift(synAck.band, 2 * half) });
    if (send !== null) {
      const segment = segments(knobs, send, open - half).find((firing) => firing.at + half >= open);
      if (segment !== undefined && segment.at + half < expiry.at) ends.push({ kind: "connected", by: "data", at: segment.at + half, band: shift(segment.band, half) });
    }
  }
  const found = ends.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))[0];
  if (found !== undefined) return { ...base, synAcks: synAcks.filter((firing) => found.at === null || firing.at < found.at), expiry, end: found, near: false };
  if (send === null || !Number.isFinite(expiry.at)) return { ...base, synAcks, expiry, end: { kind: "blind", by: "expiry", at: null, band: null }, near: false };
  // the first segment that reaches the target after the expiry meets the listener, and it gets a reset
  const sent = segments(knobs, send, expiry.at - half);
  const segment = sent.find((firing) => firing.at + half > expiry.at);
  const band = expiry.band;
  const near = band !== null && sent.some((firing) => firing.at + half >= sec(band.low) && firing.at + half <= sec(band.high));
  if (segment === undefined) return { ...base, synAcks, expiry, end: { kind: "blind", by: "expiry", at: null, band: null }, near };
  return { ...base, synAcks, expiry, end: { kind: "reset", by: "expiry", at: segment.at + 2 * half, band: shift(segment.band, 2 * half) }, near };
};

/**
 * This function gives the law of the accept queue. Each new connect sends its SYN at its dial, and
 * the SYN reaches the target one half of the round trip later. The final ACK comes one round trip
 * after the SYN. At one time, a final ACK comes before a SYN.
 *
 * - A SYN that finds the queue full drops with no answer.
 * - A final ACK that finds the queue full overflows. With `tcp_abort_on_overflow` 0, the target
 *   keeps the request. With 1, it sends a reset.
 * - From the accept of the program, each packet finds a place.
 */
export const queueModel = memo((settings: QueueSettings): QueueModel => {
  const listen = listenBacklog(settings);
  const limit = acceptQueueLimit(listen, settings.somaxconn);
  const held = acceptQueueHeld(listen, settings.somaxconn);
  const half = sec(settings.rtt) / 2;
  const open = settings.accept ? sec(settings.acceptAt) : Infinity;
  const n = Math.max(0, settings.connections);
  const packets: Arrival_[] = [];
  for (let i = 0; i < n; i += 1) packets.push({ t: dialOf(settings, i) + 1, ack: false, i }, { t: dialOf(settings, i) + 3, ack: true, i });
  packets.sort((a, b) => a.t - b.t || Number(b.ack) - Number(a.ack) || a.i - b.i);
  const fates: Fate[] = Array.from({ length: n }, () => "in");
  const cookie: boolean[] = Array.from({ length: n }, () => false);
  const start = Math.min(Math.max(0, settings.queued), held);
  let queue = start;
  let pending = 0;
  let admitted = 0;
  let accepted = 0;
  let synDrops = 0;
  let ackDrops = 0;
  let cookies = 0;
  let full: number | null = queue >= held ? 0 : null;
  let first: Overflow | null = null;
  for (const packet of packets) {
    const at = packet.t * half;
    const i = packet.i;
    if (!packet.ack) {
      if (at >= open) {
        fates[i] = "accepted";
      } else if (queue >= held) {
        fates[i] = "syn";
        synDrops += 1;
        first ??= { at, what: "syn", connection: i + 1 };
      } else if (pending >= limit) {
        // the queue of requests is full: the target sends a SYN cookie and keeps no request
        cookie[i] = true;
        cookies += 1;
      } else pending += 1;
      continue;
    }
    if (fates[i] === "syn") continue;
    const kept = !cookie[i];
    if (fates[i] === "accepted" || at >= open) {
      fates[i] = "accepted";
      accepted += 1;
      if (kept && at < open) pending -= 1;
      continue;
    }
    if (queue >= held) {
      fates[i] = "ack";
      ackDrops += 1;
      first ??= { at, what: "ack", connection: i + 1 };
      if (kept && settings.abort) pending -= 1;
      continue;
    }
    queue += 1;
    admitted += 1;
    if (kept) pending -= 1;
    if (queue >= held && full === null) full = at;
  }
  const synAt = fates.indexOf("syn");
  const ackAt = fates.indexOf("ack");
  return {
    listen,
    limit,
    held,
    start,
    fates,
    admitted,
    accepted,
    synDrops,
    ackDrops,
    cookies,
    full,
    first,
    syn: synAt < 0 ? null : synStory(settings, synAt + 1, dialOf(settings, synAt) * half),
    ack: ackAt < 0 ? null : ackStory(settings, ackAt + 1, dialOf(settings, ackAt) * half, cookie[ackAt] ?? false),
  };
});

// ---------------------------------------------------------------------------------------------
// the lanes
// ---------------------------------------------------------------------------------------------

const n = (value: number): string => format(count(value));

/** This function gives the lane of the queue: its count, and the first overflow. */
const queueLane = (settings: QueueSettings): Lane<QueueLaneId> => {
  const model = queueModel(settings);
  const { listen, held, first } = model;
  const marks: Mark[] = [{ t: ZERO, label: settings.arrival === "once" || settings.connections < 2 ? "The new connects dial" : "Connect 1 dials, then one connect each round trip", kind: "send" }];
  if (model.full !== null) marks.push({ t: s(model.full), label: `The queue is full: ${n(held)} connections`, kind: "probe" });
  if (first !== null) {
    marks.push({ t: s(first.at), label: first.what === "syn" ? `The SYN of connect ${first.connection} drops` : `The final ACK of connect ${first.connection} overflows`, kind: "detect" });
  }
  if (settings.accept) marks.push({ t: settings.acceptAt, label: "The program accepts", kind: "probe" });
  const facts: Fact[] = [
    { label: "listen(2) gets", value: settings.listener === "node" && settings.backlog === 0 ? `${n(listen)}: Node gives 511 for 0` : n(listen) },
    { label: "The limit, after somaxconn", value: n(model.limit) },
    { label: "A full queue holds", value: n(held) },
    { label: "In the queue at 0 s", value: n(model.start) },
    { label: "New connects that find a place", value: n(model.admitted + model.accepted) },
    { label: "SYNs that drop", value: n(model.synDrops) },
    { label: "Final ACKs that overflow", value: n(model.ackDrops) },
  ];
  if (model.cookies > 0) facts.push({ label: "SYN cookies", value: n(model.cookies) });
  const warnings: string[] = [];
  if (settings.queued > held) warnings.push(`A full queue holds ${n(held)} connections, thus the page puts ${n(held)} in it at 0 s.`);
  if (model.cookies > 0) warnings.push("A SYN found the queue of requests full, thus it got a SYN cookie. The count holds, but the page does not show the later steps of a cookie.");
  const count = `listen(2) gets ${n(listen)}, thus the queue holds ${n(held)}.`;
  const summary =
    first === null
      ? `${count} Each new connect finds a place.`
      : `${count} The first overflow comes at ${say(s(first.at))}: the ${first.what === "syn" ? "SYN" : "final ACK"} of connect ${first.connection}.`;
  return { id: "queue", verdict: first === null ? "silent" : "detects", band: first === null ? null : bandOf(s(first.at)), summary, facts, marks, measured: [], warning: warnings.length === 0 ? null : warnings.join(" ") };
};

/** This function gives the lane of the first SYN that drops. */
const synLane = (settings: QueueSettings): Lane<QueueLaneId> => {
  const story = queueModel(settings).syn;
  const knobFacts: Fact[] = [
    { label: "tcp_syn_retries", value: n(settings.synRetries) },
    { label: "tcp_syn_linear_timeouts", value: "4" },
  ];
  if (story === null) {
    return { id: "syn", verdict: "silent", band: null, summary: "No SYN finds the queue full.", facts: knobFacts, marks: [], measured: [], warning: null };
  }
  const { connection, dial, syns, end } = story;
  const marks: Mark[] = [{ t: s(dial), label: `Connect ${connection} sends its SYN`, kind: "send" }];
  syns.forEach((firing, k) => marks.push({ t: s(firing.at), label: `SYN ${k + 2}`, kind: "fire" }));
  const last = syns.at(-1);
  const facts: Fact[] = [
    { label: "SYNs sent", value: n(syns.length + 1) },
    { label: "The last SYN", value: last === undefined ? say(s(dial)) : say(s(last.at)) },
    ...knobFacts,
  ];
  if (end.kind === "connected") {
    marks.push({ t: s(end.at), label: "A SYN after the accept finds a place", kind: "recover" });
    return {
      id: "syn",
      verdict: "recovers",
      band: end.band,
      summary: `The SYN of connect ${connection} drops with no answer, thus the client sends it again on its ladder. The program accepts, and the next SYN finds a place: connected at ${end.band === null ? say(s(end.at)) : sayBand(end.band)}.`,
      facts,
      marks,
      measured: [],
      warning: null,
    };
  }
  marks.push({ t: s(end.at), label: "ETIMEDOUT", kind: "detect" });
  return {
    id: "syn",
    verdict: "detects",
    band: end.band,
    summary: `The SYN of connect ${connection} drops with no answer, and each SYN after it drops too. The connect ends with ETIMEDOUT at ${end.band === null ? say(s(end.at)) : sayBand(end.band)}.`,
    facts,
    marks,
    measured: [],
    warning: settings.accept ? "The program accepts after the last SYN, thus no SYN finds a place." : null,
  };
};

/** This function gives the lane of the first final ACK that overflows. */
const ackLane = (settings: QueueSettings): Lane<QueueLaneId> => {
  const story = queueModel(settings).ack;
  const knobFacts: Fact[] = [
    { label: "tcp_abort_on_overflow", value: settings.abort ? "1" : "0" },
    { label: "tcp_synack_retries", value: n(settings.synackRetries) },
  ];
  if (story === null) {
    return { id: "ack", verdict: "silent", band: null, summary: "No final ACK finds the queue full.", facts: knobFacts, marks: [], measured: [], warning: null };
  }
  const { connection, dial, connected, overflow, synAcks, expiry, send, end } = story;
  const marks: Mark[] = [
    { t: s(dial), label: `Connect ${connection} sends its SYN`, kind: "send" },
    { t: s(connected), label: "The client is connected", kind: "probe" },
    { t: s(overflow), label: "The final ACK overflows", kind: "fire" },
  ];
  synAcks.forEach((firing, k) => marks.push({ t: s(firing.at), label: `SYN-ACK ${k + 2}`, kind: "fire" }));
  if (expiry !== null && end.kind !== "connected") marks.push({ t: s(expiry.at), label: "The target forgets the request", kind: "fire" });
  if (send !== null) marks.push({ t: s(send), label: "The client sends", kind: "send" });
  const facts: Fact[] = [
    { label: "The client is connected at", value: say(s(connected)) },
    { label: "SYN-ACKs that go again", value: n(synAcks.length) },
    { label: "The target forgets the request at", value: expiry === null ? "at once, with a reset" : expiry.band === null ? say(s(expiry.at)) : sayBand(expiry.band) },
    { label: "The first send of the client", value: send === null ? "none" : say(s(send)) },
    ...knobFacts,
  ];
  const warnings: string[] = [];
  if (story.cookie) warnings.push("The SYN of this connect got a SYN cookie, thus the target keeps no request and sends no SYN-ACK again. The page does not show a cookie.");
  if (story.near) warnings.push("A segment of the client reaches the target near the expiry. Thus the reset can come with the segment before or after it.");
  if (settings.send === "later" && send !== null && send > sec(settings.sendAt)) warnings.push("The client sends after it is connected, thus the page moves the send to the connect.");
  const warning = warnings.length === 0 ? null : warnings.join(" ");
  const when = end.band === null ? (end.at === null ? "an unknown time" : say(s(end.at))) : sayBand(end.band);
  const head = `The client is connected at ${say(s(connected))}, but its final ACK overflows.`;
  switch (end.kind) {
    case "reset":
      marks.push({ t: s(end.at ?? 0), label: "ECONNRESET", kind: "detect" });
      return {
        id: "ack",
        verdict: "detects",
        band: end.band,
        summary:
          end.by === "abort"
            ? `${head} tcp_abort_on_overflow 1 sends a reset, and the client gets ECONNRESET at ${when}.`
            : `${head} The target forgets the request at ${say(s(expiry?.at ?? 0))}. The next segment of the client meets the listener, and the client gets ECONNRESET at ${when}.`,
        facts,
        marks,
        measured: [],
        warning,
      };
    case "connected":
      marks.push({ t: s(end.at ?? 0), label: end.by === "synack" ? "The challenge ACK finds a place" : "A segment of the client finds a place", kind: "recover" });
      return {
        id: "ack",
        verdict: "recovers",
        band: end.band,
        summary:
          end.by === "synack"
            ? `${head} The program accepts. The next SYN-ACK gets a challenge ACK from the client, and that ACK finds a place at ${when}.`
            : `${head} The program accepts. The next segment of the client finds a place at ${when}.`,
        facts,
        marks,
        measured: [],
        warning,
      };
    case "blind":
      return {
        id: "ack",
        verdict: "blind",
        band: null,
        summary: `${head} The target forgets the request at ${expiry === null ? "an unknown time" : say(s(expiry.at))}. The client sends nothing, thus it stays connected to nothing.`,
        facts,
        marks,
        measured: [],
        warning,
      };
  }
};

/** This function gives the three lenses of the accept queue. The measured values come with the copy of the cells AQ.1 to AQ.10. */
export const queueLenses = (): { readonly queue: Lens<QueueSettings, QueueLaneId>; readonly syn: Lens<QueueSettings, QueueLaneId>; readonly ack: Lens<QueueSettings, QueueLaneId> } => ({
  queue: {
    id: "queue",
    names: { title: "The accept queue", label: "Queue", short: "Queue", term: "backlog" },
    knobs: ["listener", "backlog", "somaxconn", "queued", "connections", "arrival", "accept", "acceptAt"],
    lanes: (settings) => [queueLane(settings)],
  },
  syn: {
    id: "syn",
    names: { title: "A SYN at a full queue", label: "SYN", short: "SYN", term: "tcp_syn_retries" },
    knobs: ["synRetries", "rtt", "hz"],
    lanes: (settings) => [synLane(settings)],
  },
  ack: {
    id: "ack",
    names: { title: "A final ACK at a full queue", label: "Final ACK", short: "ACK", term: "tcp_abort_on_overflow" },
    knobs: ["abort", "synackRetries", "send", "sendAt"],
    lanes: (settings) => [ackLane(settings)],
  },
});

/** The lenses of the accept queue on each page of the site: the page of the queue, and the page of the whole path. */
export const QUEUE_LENSES = queueLenses();
