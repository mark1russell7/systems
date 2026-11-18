import type { EgressOutcome, EgressPacket, NetemQueue, TbfQueue } from "@mark1russell7/automata";
import { netemSchedule, tbfSchedule, udpFrameLength } from "@mark1russell7/automata";
import type { Cell, EgressBurst, EgressPacketLaw, EgressPrediction, QueueBand, Target } from "@mark1russell7/harness";
import { s } from "./catalog.ts";

/**
 * The cells of the egress qdisc (SYS-124) have one client in its container, on the real kernel. The
 * client puts a qdisc at the root of its interface with `tc`. Then it sends bursts of UDP datagrams
 * through the qdisc to the sink of the target. The kernel stamps each datagram when the qdisc takes it and
 * when the device takes it from the qdisc. The law is in the algebra (`egress.ts`), from the sources
 * of Linux v7.0.
 *
 * - netem with a rate gives each datagram a time to send. Its start is the time of the datagram
 *   before it or its arrival plus the delay, the later of the two. Its length is the length of the
 *   datagram at the rate. The qdisc drops a datagram when its queue holds `limit` datagrams. The datagrams of the delay
 *   count in that queue.
 * - tbf sends a datagram when its bucket has the tokens of its length. The bucket is full at the
 *   first datagram. Its child bfifo drops a datagram that puts the bytes of its queue above the
 *   limit, and tbf drops a datagram longer than its burst.
 *
 * The arrivals of one burst are not at one instant, and a burst does not start at its exact time.
 * Thus the law of a datagram comes from the corners of its arrivals. At a corner, each burst is
 * together or spread to `SPREAD`, and each start is early or late by `JITTER`. The band of a datagram is the hull of its
 * departures at the corners, plus `LATE` for the timer of the qdisc. The outcome of a datagram is the
 * same at each corner, or the builder refuses the cell.
 */

/** This image is the stock base of the image of the harness, for the record. */
const BASE = "alpine:3.23@sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62";
/** This port is the UDP sink of the target. */
const PORT = 6393;
const MS = 1_000_000;
/** This time is the most that the arrivals of one burst spread, in nanoseconds. A wider run is void. */
const SPREAD = 2 * MS;
/** This time is the most that a later burst starts off its time, in nanoseconds. A run further off is void. */
const JITTER = 2 * MS;
/**
 * This time is the most that a departure comes after its law, in nanoseconds. It holds the wake of
 * the timer of the qdisc and the path to the device. It has no source: it is a first value, and the first
 * records of CI give it its band (SYS-124 part 3).
 */
const LATE = 2 * MS;
/** This share is the least part of the departures that a run reads. */
const READ = 0.9;
/** This time is the window of a run, in seconds: the pin of the neighbour, the settle, the bursts and the drain. */
const WINDOW = 30;

const TARGET: Target = {
  image: BASE,
  subject: { kind: "shipped", name: "harness" },
  command: ["/opt/harness/egress", "sink", String(PORT)],
  port: PORT,
  ready: "listening",
  lines: true,
};

/** This record is one burst of a cell: its time after the first burst in milliseconds, its count and the bytes of its payload. */
export interface EgressBurstSpec {
  readonly at: number;
  readonly count: number;
  readonly payload: number;
}

/** This record is the qdisc of a cell, as the algebra takes it. */
export type EgressQueue = { readonly kind: "netem"; readonly netem: NetemQueue } | { readonly kind: "tbf"; readonly tbf: TbfQueue };

/** This record is one cell: its plan, its name, the reason for its law, its qdisc and its bursts. */
export interface EgressSpec {
  readonly plan: string;
  readonly name: string;
  readonly why: string;
  readonly queue: EgressQueue;
  readonly bursts: readonly EgressBurstSpec[];
}

/** This function gives the words of a rate in bytes per second, as `tc` takes it: SI units of bits. */
export const rateWords = (bytes: number): string => {
  const bits = bytes * 8;
  if (bits % 1_000_000 === 0) return `${bits / 1_000_000}mbit`;
  if (bits % 1000 === 0) return `${bits / 1000}kbit`;
  return `${bits}bit`;
};

/** This function gives the words of a qdisc, as `tc qdisc replace dev eth0 root` takes them. */
export const qdiscWords = (queue: EgressQueue): string => {
  if (queue.kind === "netem") {
    const { latency, rate, limit, packetOverhead, cellSize } = queue.netem;
    if (packetOverhead !== undefined || cellSize !== undefined) throw new Error("the cells set no overhead and no cells of netem");
    const delay = latency === undefined || latency === 0 ? [] : [`delay ${latency % MS === 0 ? `${latency / MS}ms` : `${latency / 1000}us`}`];
    return ["netem", ...delay, `rate ${rateWords(rate)}`, `limit ${limit}`].join(" ");
  }
  const { rate, burst, limit, peak } = queue.tbf;
  if (peak !== undefined || rate.overhead !== undefined || rate.mpu !== undefined || rate.linklayer !== undefined)
    throw new Error("the cells set no peak rate, no overhead, no mpu and no link layer of tbf");
  return `tbf rate ${rateWords(rate.rate)} burst ${burst} limit ${limit}`;
};

const scheduleOf = (queue: EgressQueue, packets: readonly EgressPacket[]): readonly EgressOutcome[] =>
  queue.kind === "netem" ? netemSchedule(packets, queue.netem) : tbfSchedule(packets, queue.tbf);

/** This record is one corner of the arrivals: the earlier bursts early or late, and the burst of the law together or spread. */
interface Corner {
  readonly late: boolean;
  readonly spread: boolean;
}

const CORNERS: readonly Corner[] = [
  { late: false, spread: false },
  { late: false, spread: true },
  { late: true, spread: false },
  { late: true, spread: true },
];

/**
 * This function gives the arrivals of the bursts up to `last` at one corner, in nanoseconds, and the
 * first arrival of `last`. An early corner starts each earlier burst `JITTER` before its time, with its
 * datagrams together, and `last` `JITTER` after its time. Thus the earlier datagrams leave the qdisc as
 * early as they can. A late corner starts them the other way, and it spreads each earlier burst. A
 * departure does not come earlier when an arrival comes later, thus the corners hold the hull of the
 * departures.
 */
const arrivalsOf = (bursts: readonly EgressBurstSpec[], last: number, corner: Corner): { packets: EgressPacket[]; first: number } => {
  const origin = bursts[0]!.at * MS;
  const packets: EgressPacket[] = [];
  let first = 0;
  bursts.slice(0, last + 1).forEach((burst, index) => {
    const planned = burst.at * MS - origin;
    const shift = index === 0 ? 0 : (index === last) === corner.late ? -JITTER : JITTER;
    const start = planned + shift;
    const spread = index === last ? corner.spread : corner.late;
    if (index === last) first = start;
    for (let n = 0; n < burst.count; n++) packets.push({ at: start + (n > 0 && spread ? SPREAD : 0), length: udpFrameLength(burst.payload) });
  });
  return { packets, first };
};

const band = (low: number, high: number): QueueBand => ({ low: s(low / 1e9), high: s(high / 1e9) });

/** This function gives the law of each datagram of a cell, in the order of the sends. */
export const lawsOf = (spec: Pick<EgressSpec, "queue" | "bursts">): EgressPacketLaw[] => {
  const { bursts } = spec;
  bursts.forEach((burst, index) => {
    if (index > 0 && burst.at * MS - bursts[index - 1]!.at * MS < 2 * JITTER + SPREAD)
      throw new Error(`the burst ${index} starts less than ${(2 * JITTER + SPREAD) / MS} ms after the burst before it, thus the corners overlap`);
  });
  return bursts.flatMap((burst, last) => {
    const corners = CORNERS.filter((corner) => last > 0 || !corner.late).map((corner) => {
      const { packets, first } = arrivalsOf(bursts, last, corner);
      return { outcomes: scheduleOf(spec.queue, packets).slice(-burst.count), first };
    });
    return Array.from({ length: burst.count }, (_, n): EgressPacketLaw => {
      const each = corners.map(({ outcomes, first }) => ({ outcome: outcomes[n]!, first }));
      const kinds = new Set(each.map(({ outcome }) => (outcome.kind === "sent" ? "sent" : `dropped at the ${outcome.why}`)));
      if (kinds.size > 1) throw new Error(`the datagram ${n} of the burst ${last} is ${[...kinds].join(" or ")} by the times of its arrivals`);
      const one = each[0]!.outcome;
      if (one.kind === "dropped") return { kind: "dropped", why: one.why };
      const left = each.map(({ outcome, first }) => (outcome.kind === "sent" ? outcome.at - first : Number.NaN));
      return { kind: "sent", left: band(Math.max(0, Math.min(...left)), Math.max(...left) + LATE) };
    });
  });
};

const commandOf = (spec: EgressSpec): readonly string[] => [
  "/opt/harness/egress",
  "send",
  "--qdisc",
  qdiscWords(spec.queue),
  ...spec.bursts.flatMap((burst) => ["--burst", `${burst.at}:${burst.count}:${burst.payload}`]),
];

const predictionOf = (spec: EgressSpec): EgressPrediction => ({
  qdisc: qdiscWords(spec.queue),
  kind: spec.queue.kind,
  bursts: spec.bursts.map((burst): EgressBurst => ({ at: s(burst.at / 1000), count: burst.count, payload: burst.payload })),
  packets: lawsOf(spec),
  spread: s(SPREAD / 1e9),
  jitter: s(JITTER / 1e9),
  read: READ,
});

const egressCell = (spec: EgressSpec): Cell => ({
  name: `${spec.plan} ${spec.name}`,
  target: TARGET,
  sysctls: {},
  // the client sets the qdisc and the neighbour of its own interface, and forces the sizes of its buffers
  client: { image: { kind: "shipped", name: "harness" }, command: commandOf(spec), capabilities: ["NET_ADMIN"] },
  probe: { mode: "idle", keepalive: false },
  fault: "none",
  prediction: { detects: null, window: s(WINDOW), why: spec.why, egress: predictionOf(spec) },
  runs: 4,
  environments: 2,
  concurrency: 1,
});

/** This rate is 1 Mbit/s in bytes per second. */
const MBIT = 125_000;
/** This payload gives a frame of 1,514 bytes: the MTU of 1,500 and the Ethernet header. */
const FULL = 1472;
/** This payload gives a frame of 1,000 bytes. */
const THOUSAND = 958;

/** These are the laws that the cells check, one cell for each. */
export const EGRESS_SPECS: readonly EgressSpec[] = [
  {
    plan: "EQ.1",
    name: "netem at 1 Mbit/s sends one full frame each 12.112 ms",
    why: "netem gives each frame its length at the rate after the time to send of the frame before it: 1,514 bytes at 125,000 bytes per second",
    queue: { kind: "netem", netem: { rate: MBIT, limit: 1000 } },
    bursts: [{ at: 0, count: 10, payload: FULL }],
  },
  {
    plan: "EQ.2",
    name: "netem with a limit of 10 drops each frame of a burst after the tenth",
    why: "netem holds each frame until its time to send, and it drops a frame when it holds its limit",
    queue: { kind: "netem", netem: { rate: MBIT, limit: 10 } },
    bursts: [{ at: 0, count: 20, payload: FULL }],
  },
  {
    plan: "EQ.3",
    name: "a delay of 100 ms in netem counts in its limit: the second burst sends 4 frames and drops 4",
    why: "a delayed frame stays in the queue of netem until its time to send, thus the 8 frames of the first burst fill 8 of the 12 places",
    queue: { kind: "netem", netem: { latency: 100 * MS, rate: 10 * MBIT, limit: 12 } },
    bursts: [
      { at: 0, count: 8, payload: FULL },
      { at: 30, count: 8, payload: FULL },
    ],
  },
  {
    plan: "EQ.4",
    name: "netem with no delay sends each frame of two bursts 30 ms apart, the control of EQ.3",
    why: "the first burst leaves in 9.7 ms at 10 Mbit/s, thus the queue is empty at the second burst",
    queue: { kind: "netem", netem: { rate: 10 * MBIT, limit: 12 } },
    bursts: [
      { at: 0, count: 8, payload: FULL },
      { at: 30, count: 8, payload: FULL },
    ],
  },
  {
    plan: "EQ.5",
    name: "tbf with a burst of 3000 bytes sends 3 frames of 1000 bytes at once, then one each 8 ms",
    why: "the bucket is full at the first frame and holds the tokens of 3 frames, and each next frame waits for the tokens of its length",
    queue: { kind: "tbf", tbf: { rate: { rate: MBIT }, burst: 3000, limit: 30_000 } },
    bursts: [{ at: 0, count: 10, payload: THOUSAND }],
  },
  {
    plan: "EQ.6",
    name: "tbf with a limit of 5000 bytes sends 8 frames of a burst of 20 and drops 12",
    why: "3 frames leave with the tokens of the bucket, and the bfifo of tbf holds 5 more: the next frame puts its bytes above the limit",
    queue: { kind: "tbf", tbf: { rate: { rate: MBIT }, burst: 3000, limit: 5000 } },
    bursts: [{ at: 0, count: 20, payload: THOUSAND }],
  },
  {
    plan: "EQ.7",
    name: "tbf with a burst of 1500 bytes drops a frame of 1501 bytes and sends the frames of 1500 bytes around it",
    why: "tbf drops a frame longer than its burst before its queue, and the bucket fills again in 12 ms",
    queue: { kind: "tbf", tbf: { rate: { rate: MBIT }, burst: 1500, limit: 30_000 } },
    bursts: [
      { at: 0, count: 1, payload: 1458 },
      { at: 50, count: 1, payload: 1459 },
      { at: 100, count: 1, payload: 1458 },
    ],
  },
];

export const EGRESS_CELLS: readonly Cell[] = EGRESS_SPECS.map(egressCell);
