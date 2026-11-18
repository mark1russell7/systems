/**
 * The egress queue of a host: the lenses of the page `lab/egress`. A program sends bursts of UDP
 * datagrams, and a qdisc in front of the device holds them. The netem qdisc sends each frame at its
 * rate, after its delay. The tbf qdisc sends the frames that the tokens of its bucket cover at once,
 * and then one frame for each new set of tokens. A full queue drops a frame. The tbf qdisc also drops a
 * frame longer than its bucket.
 *
 * The model is the egress law of `@mark1russell7/algebra`: `netemSchedule` and `tbfSchedule`. The page
 * does no queue arithmetic of its own. Each time counts from the start of the first burst.
 *
 * Three lanes tell the story:
 *
 * - The program sends each burst. With IP_RECVERR, a drop gives ENOBUFS to its send. With the default
 *   of Linux, each send succeeds, and the program does not learn of a drop.
 * - The qdisc counts each drop in its own statistics, at the arrival of the frame.
 * - The device sends the last frame, and the queue is empty again.
 */
import {
  netemPacketTime,
  netemSchedule,
  pschedLengthTime,
  tbfBuckets,
  tbfSchedule,
  udpFrameLength,
  type EgressOutcome,
  type EgressPacket,
  type NetemQueue,
  type TbfQueue,
} from "@mark1russell7/algebra";
import { convert, format, quantity, valueIn, type Quantity } from "@mark1russell7/quantity";
import { bandOf, memo, say, type Fact, type Lane, type Lens, type Mark } from "../lens.ts";

// ---------------------------------------------------------------------------------------------
// the settings
// ---------------------------------------------------------------------------------------------

export type Qdisc = "netem" | "tbf";

/** A burst is a set of datagrams that the program sends together, at one time from the start. */
export interface TrainBurst {
  readonly at: Quantity;
  readonly frames: number;
  /** the UDP payload of each datagram of the burst */
  readonly payload: Quantity;
}

/** The settings of the egress queue. The knob `mtu` is the knob of the path of one request. */
export interface EgressSettings {
  readonly qdisc: Qdisc;
  /** the rate of the qdisc. The knob `rate` is the rate of the link, thus this knob has a name of its own */
  readonly shapeRate: Quantity;
  /** the delay of netem */
  readonly delay: Quantity;
  /** the limit of netem, in packets */
  readonly packetLimit: number;
  /** the depth of the bucket of tbf */
  readonly bucket: Quantity;
  /** the limit of the bfifo of tbf */
  readonly byteLimit: Quantity;
  /** the bursts of the program, in the order of their times */
  readonly train: readonly TrainBurst[];
  /** the socket option IP_RECVERR. Linux sets it off */
  readonly recverr: boolean;
  readonly mtu: Quantity;
}

const B = (value: number): Quantity => quantity(value, "B");
const ms = (value: number): Quantity => quantity(value, "ms");

/** The headers of a UDP datagram over IPv4: 20 bytes of IP and 8 bytes of UDP. A payload above the MTU less these headers leaves in fragments. */
export const UDP_HEADERS = 28;

/** These are the defaults of the page: the settings of the cell EQ.1, with IP_RECVERR off as in Linux. */
export const EGRESS_DEFAULTS: EgressSettings = {
  qdisc: "netem",
  shapeRate: quantity(1, "Mbit/s"),
  delay: ms(0),
  packetLimit: 1000,
  bucket: B(3000),
  byteLimit: B(30_000),
  train: [{ at: ms(0), frames: 10, payload: B(1472) }],
  recverr: false,
  mtu: B(1500),
};

// ---------------------------------------------------------------------------------------------
// the model
// ---------------------------------------------------------------------------------------------

/** A frame is one datagram of the train at the qdisc. */
export interface EgressFrame {
  /** the place of the datagram in the train, from 1 */
  readonly n: number;
  /** the burst of the datagram, from 1 */
  readonly burst: number;
  /** the arrival at the qdisc, in nanoseconds from the start */
  readonly at: number;
  /** the qdisc length of the frame, in bytes */
  readonly length: number;
  readonly outcome: EgressOutcome;
}

/** A step of the backlog: the packets and the bytes that the qdisc holds from the time `t`, in nanoseconds. */
export interface BacklogStep {
  readonly t: number;
  readonly packets: number;
  readonly bytes: number;
}

export interface EgressModel {
  readonly frames: readonly EgressFrame[];
  readonly sent: number;
  readonly limitDrops: number;
  readonly sizeDrops: number;
  /** the first frame that the qdisc drops, or null */
  readonly firstDrop: EgressFrame | null;
  /** the first departure and the last departure, in nanoseconds, or null when no frame leaves */
  readonly firstLeave: number | null;
  readonly drain: number | null;
  /** the time of the first frame at the rate of the qdisc, in nanoseconds */
  readonly frameTime: number;
  /** the largest frame that tbf takes, in bytes, or null for netem */
  readonly maxSize: number | null;
  /** the depth of the bucket of tbf, in nanoseconds, or null for netem */
  readonly buffer: number | null;
  readonly backlog: readonly BacklogStep[];
  readonly peak: { readonly packets: number; readonly bytes: number };
  /** the last event of the story, in nanoseconds: the last departure or the last arrival */
  readonly end: number;
  /** the bursts in the order of their times */
  readonly bursts: readonly TrainBurst[];
}

const nsOf = (time: Quantity): number => Math.max(0, Math.round(valueIn(time, "ns")));
const bytesOf = (amount: Quantity): number => Math.max(0, Math.round(valueIn(amount, "B")));
/** the rate of the qdisc in bytes per second, at least 1 */
const rateOf = (settings: EgressSettings): number => Math.max(1, Math.round(valueIn(settings.shapeRate, "B/s")));
/** This function gives a time in nanoseconds as a quantity in seconds. */
export const sec = (ns: number): Quantity => quantity(ns / 1e9, "s");

/** This function gives the netem queue of the settings, in the units of the algebra. */
export const netemOf = (settings: EgressSettings): NetemQueue => ({ rate: rateOf(settings), latency: nsOf(settings.delay), limit: Math.max(0, Math.round(settings.packetLimit)) });

/** This function gives the tbf queue of the settings, in the units of the algebra. */
export const tbfOf = (settings: EgressSettings): TbfQueue => ({ rate: { rate: rateOf(settings) }, burst: Math.max(1, bytesOf(settings.bucket)), limit: bytesOf(settings.byteLimit) });

/** This function gives the bursts in the order of their times. Two bursts at one time keep their order. */
const burstsOf = (settings: EgressSettings): TrainBurst[] => [...settings.train].sort((a, b) => nsOf(a.at) - nsOf(b.at));

/** This function gives the backlog of the qdisc: each sent frame is in the queue from its arrival to its departure. */
const backlogOf = (frames: readonly EgressFrame[]): BacklogStep[] => {
  const events = frames.flatMap((frame) => (frame.outcome.kind === "sent" ? [{ t: frame.at, packets: 1, bytes: frame.length }, { t: frame.outcome.at, packets: -1, bytes: -frame.length }] : []));
  // a frame that leaves at the arrival of another frame is gone first, as in the algebra
  events.sort((a, b) => a.t - b.t || a.packets - b.packets);
  const steps: BacklogStep[] = [{ t: 0, packets: 0, bytes: 0 }];
  let packets = 0;
  let bytes = 0;
  for (const event of events) {
    packets += event.packets;
    bytes += event.bytes;
    const last = steps[steps.length - 1]!;
    if (last.t === event.t) steps[steps.length - 1] = { t: event.t, packets, bytes };
    else steps.push({ t: event.t, packets, bytes });
  }
  return steps;
};

/** This function computes what the qdisc does with each datagram of the train. */
export const egressModel = memo((settings: EgressSettings): EgressModel => {
  const bursts = burstsOf(settings);
  const packets: EgressPacket[] = [];
  const places: Array<{ burst: number; at: number; length: number }> = [];
  bursts.forEach((burst, index) => {
    const at = nsOf(burst.at);
    const length = udpFrameLength(bytesOf(burst.payload));
    for (let n = 0; n < Math.max(0, Math.round(burst.frames)); n++) {
      packets.push({ at, length });
      places.push({ burst: index + 1, at, length });
    }
  });
  const tbf = settings.qdisc === "tbf" ? tbfOf(settings) : null;
  const outcomes = tbf === null ? netemSchedule(packets, netemOf(settings)) : tbfSchedule(packets, tbf);
  const frames: EgressFrame[] = places.map((place, index) => ({ n: index + 1, ...place, outcome: outcomes[index]! }));
  const leaves = frames.flatMap((frame) => (frame.outcome.kind === "sent" ? [frame.outcome.at] : []));
  const firstLength = places[0]?.length ?? udpFrameLength(0);
  const frameTime = tbf === null ? netemPacketTime(firstLength, { rate: rateOf(settings) }) : pschedLengthTime(firstLength, tbf.rate);
  const buckets = tbf === null ? null : tbfBuckets(tbf);
  const backlog = backlogOf(frames);
  const firstLeave = leaves.length === 0 ? null : Math.min(...leaves);
  const drain = leaves.length === 0 ? null : Math.max(...leaves);
  return {
    frames,
    sent: leaves.length,
    limitDrops: frames.filter((frame) => frame.outcome.kind === "dropped" && frame.outcome.why === "limit").length,
    sizeDrops: frames.filter((frame) => frame.outcome.kind === "dropped" && frame.outcome.why === "size").length,
    firstDrop: frames.find((frame) => frame.outcome.kind === "dropped") ?? null,
    firstLeave,
    drain,
    frameTime,
    maxSize: buckets?.maxSize ?? null,
    buffer: buckets?.buffer ?? null,
    backlog,
    peak: { packets: Math.max(...backlog.map((step) => step.packets)), bytes: Math.max(...backlog.map((step) => step.bytes)) },
    end: Math.max(drain ?? 0, ...places.map((place) => place.at)),
    bursts,
  };
});

// ---------------------------------------------------------------------------------------------
// the words
// ---------------------------------------------------------------------------------------------

const count = (n: number): string => format(quantity(n, "count"));
const datagrams = (n: number): string => (n === 1 ? "1 datagram" : `${count(n)} datagrams`);

/** This function gives the qdisc of the settings in the words of `tc`. */
export const qdiscText = (settings: EgressSettings): string => {
  const rate = format(settings.shapeRate);
  if (settings.qdisc === "tbf") return `tbf rate ${rate} burst ${format(settings.bucket)} limit ${format(settings.byteLimit)}`;
  const delay = valueIn(settings.delay, "ns") > 0 ? ` delay ${say(settings.delay)}` : "";
  return `netem${delay} rate ${rate} limit ${count(settings.packetLimit)}`;
};

/** This function gives the limit of the qdisc for a reader: packets for netem, bytes for tbf. */
export const limitText = (settings: EgressSettings): string => (settings.qdisc === "tbf" ? format(settings.byteLimit) : `${count(settings.packetLimit)} packets`);

/** This function gives the warning of the settings, or null: a payload above the MTU leaves in fragments. */
const fragmentWarning = (settings: EgressSettings): string | null => {
  const room = bytesOf(settings.mtu) - UDP_HEADERS;
  const big = settings.train.find((burst) => bytesOf(burst.payload) > room);
  return big === undefined
    ? null
    : `A payload of ${format(big.payload)} is above the MTU less ${UDP_HEADERS} B (${format(B(room))}). IP sends such a datagram in fragments, and this page counts one frame for it.`;
};

// ---------------------------------------------------------------------------------------------
// the lanes
// ---------------------------------------------------------------------------------------------

export type EgressLaneId = "program" | "qdisc" | "device";

const programLane = (settings: EgressSettings): Lane<"program"> => {
  const model = egressModel(settings);
  const drops = model.limitDrops + model.sizeDrops;
  const marks: Mark[] = model.bursts.map((burst, index) => ({ t: burst.at, label: `Burst ${index + 1}: ${datagrams(burst.frames)} of ${format(burst.payload)}`, kind: "send" }));
  const facts: Fact[] = [
    { label: "Datagrams", value: count(model.frames.length) },
    { label: "IP_RECVERR", value: settings.recverr ? "On" : "Off, the default" },
    { label: "SndbufErrors gains", value: count(drops) },
  ];
  const base = { id: "program" as const, facts, measured: [], warning: null };
  if (drops === 0 || model.firstDrop === null) return { ...base, verdict: "silent", band: null, summary: "Each send succeeds, and each datagram leaves the host.", marks };
  const first = model.firstDrop;
  if (settings.recverr) {
    return {
      ...base,
      verdict: "detects",
      band: bandOf(sec(first.at)),
      summary: `The send of datagram ${first.n} gets ENOBUFS at ${say(sec(first.at))}. Each of the ${datagrams(drops)} that drop gives ENOBUFS to its send.`,
      marks: [...marks, { t: sec(first.at), label: `ENOBUFS, datagram ${first.n}`, kind: "detect" }],
    };
  }
  return {
    ...base,
    verdict: "silent",
    band: null,
    summary: `Each send succeeds. The kernel counts the ${datagrams(drops)} that drop in SndbufErrors, and the program does not learn of them.`,
    marks,
  };
};

const qdiscLane = (settings: EgressSettings): Lane<"qdisc"> => {
  const model = egressModel(settings);
  const drops = model.limitDrops + model.sizeDrops;
  const held = settings.qdisc === "tbf" ? format(B(model.peak.bytes)) : `${count(model.peak.packets)} packets`;
  const facts: Fact[] = [
    { label: "The qdisc", value: qdiscText(settings) },
    { label: "One frame", value: `${format(B(model.frames[0]?.length ?? 0))} in ${say(sec(model.frameTime))}` },
    { label: "The most it holds", value: `${held} of ${limitText(settings)}` },
    ...(model.maxSize === null || model.buffer === null ? [] : [{ label: "The bucket", value: `${format(B(model.maxSize))}, ${say(sec(model.buffer))} of tokens` }]),
    { label: "Drops", value: drops === 0 ? "None" : `${count(model.limitDrops)} at the limit, ${count(model.sizeDrops)} by their size` },
  ];
  const base = { id: "qdisc" as const, facts, measured: [], warning: null };
  const first = model.firstDrop;
  if (first === null || first.outcome.kind !== "dropped") {
    return { ...base, verdict: "silent", band: null, summary: `The queue holds at most ${held} of its limit of ${limitText(settings)}, thus no datagram drops.`, marks: [] };
  }
  const why =
    first.outcome.why === "size"
      ? `Datagram ${first.n} is a frame of ${format(B(first.length))}, longer than the bucket of ${format(B(model.maxSize ?? 0))}. tbf drops it at once.`
      : `Datagram ${first.n} finds the queue full at ${say(sec(first.at))}, with ${settings.qdisc === "tbf" ? format(B(first.outcome.bytes)) : `${count(first.outcome.ahead)} packets`} in it.`;
  return {
    ...base,
    verdict: "detects",
    band: bandOf(sec(first.at)),
    summary: `${why} The qdisc drops ${count(drops)} of ${datagrams(model.frames.length)}.`,
    marks: [{ t: sec(first.at), label: first.outcome.why === "size" ? `Drops datagram ${first.n}, too long` : `Drops datagram ${first.n}, the queue is full`, kind: "detect" }],
  };
};

const deviceLane = (settings: EgressSettings): Lane<"device"> => {
  const model = egressModel(settings);
  const warning = fragmentWarning(settings);
  if (model.firstLeave === null || model.drain === null) {
    return { id: "device", verdict: "silent", band: null, summary: "No frame leaves the qdisc.", facts: [{ label: "Frames sent", value: "0" }], marks: [], measured: [], warning };
  }
  // the rate of the departures: the bytes of each frame after the first, over the time from the first departure to the last
  const sent = model.frames.filter((frame) => frame.outcome.kind === "sent");
  const after = sent.slice(1).reduce((sum, frame) => sum + frame.length, 0);
  const span = model.drain - model.firstLeave;
  const facts: Fact[] = [
    { label: "Frames sent", value: `${count(model.sent)} of ${count(model.frames.length)}` },
    { label: "The first frame leaves", value: say(sec(model.firstLeave)) },
    { label: "The last frame leaves", value: say(sec(model.drain)) },
    ...(span > 0 ? [{ label: "The rate of the departures", value: format(convert(quantity(after / (span / 1e9), "B/s"), "Mbit/s"), { digits: 3 }) }] : []),
  ];
  return {
    id: "device",
    verdict: "recovers",
    band: bandOf(sec(model.drain)),
    summary: `The first frame leaves at ${say(sec(model.firstLeave))} and the last at ${say(sec(model.drain))}. The queue is empty again then.`,
    facts,
    marks: [
      { t: sec(model.firstLeave), label: "The first frame leaves", kind: "send" },
      { t: sec(model.drain), label: "The last frame leaves", kind: "recover" },
    ],
    measured: [],
    warning,
  };
};

// ---------------------------------------------------------------------------------------------
// the presets
// ---------------------------------------------------------------------------------------------

const MBIT = quantity(1, "Mbit/s");
/** the payload of a full frame of 1,514 bytes: the MTU of 1,500 and the Ethernet header */
const FULL = B(1472);
/** the payload of a frame of 1,000 bytes */
const THOUSAND = B(958);

const cell = (settings: Partial<EgressSettings>): EgressSettings => ({ ...EGRESS_DEFAULTS, recverr: true, ...settings });
const netem = (rate: Quantity, packetLimit: number, delay: Quantity = ms(0)): Partial<EgressSettings> => ({ qdisc: "netem", shapeRate: rate, packetLimit, delay });
const tbf = (bucket: number, byteLimit: number): Partial<EgressSettings> => ({ qdisc: "tbf", shapeRate: MBIT, bucket: B(bucket), byteLimit: B(byteLimit) });
const TWO_BURSTS: readonly TrainBurst[] = [
  { at: ms(0), frames: 8, payload: FULL },
  { at: ms(30), frames: 8, payload: FULL },
];

export interface EgressPreset {
  readonly id: string;
  readonly label: string;
  readonly settings: EgressSettings;
  /** the cell of the harness with these settings, or null */
  readonly cell: string | null;
  readonly note: string | null;
}

/** The presets of the page: the defaults of Linux, and the settings of the cells of the harness. The cells set IP_RECVERR. */
export const EGRESS_PRESETS: readonly EgressPreset[] = [
  { id: "defaults", label: "One burst", settings: EGRESS_DEFAULTS, cell: null, note: "Ten full frames into netem at 1 Mbit/s, with IP_RECVERR off as in Linux." },
  { id: "eq1", label: "EQ.1", settings: cell({ ...netem(MBIT, 1000), train: [{ at: ms(0), frames: 10, payload: FULL }] }), cell: "EQ.1", note: "The settings of the cell EQ.1: netem sends one full frame each 12.112 ms." },
  { id: "eq2", label: "EQ.2", settings: cell({ ...netem(MBIT, 10), train: [{ at: ms(0), frames: 20, payload: FULL }] }), cell: "EQ.2", note: "The settings of the cell EQ.2: a limit of 10 packets drops each frame after the tenth." },
  {
    id: "silent",
    label: "A silent drop",
    settings: { ...cell({ ...netem(MBIT, 10), train: [{ at: ms(0), frames: 20, payload: FULL }] }), recverr: false },
    cell: null,
    note: "The settings of EQ.2 with IP_RECVERR off, the default of Linux: each send succeeds, and 10 datagrams drop.",
  },
  { id: "eq3", label: "EQ.3", settings: cell({ ...netem(quantity(10, "Mbit/s"), 12, ms(100)), train: TWO_BURSTS }), cell: "EQ.3", note: "The settings of the cell EQ.3: the delay of 100 ms counts in the limit of 12." },
  { id: "eq4", label: "EQ.4", settings: cell({ ...netem(quantity(10, "Mbit/s"), 12), train: TWO_BURSTS }), cell: "EQ.4", note: "The settings of the cell EQ.4, the control of EQ.3 with no delay." },
  { id: "eq5", label: "EQ.5", settings: cell({ ...tbf(3000, 30_000), train: [{ at: ms(0), frames: 10, payload: THOUSAND }] }), cell: "EQ.5", note: "The settings of the cell EQ.5: the bucket of 3,000 B sends 3 frames at once." },
  { id: "eq6", label: "EQ.6", settings: cell({ ...tbf(3000, 5000), train: [{ at: ms(0), frames: 20, payload: THOUSAND }] }), cell: "EQ.6", note: "The settings of the cell EQ.6: the bfifo of 5,000 B holds 5 frames after the 3 of the bucket." },
  {
    id: "eq7",
    label: "EQ.7",
    settings: cell({
      ...tbf(1500, 30_000),
      train: [
        { at: ms(0), frames: 1, payload: B(1458) },
        { at: ms(50), frames: 1, payload: B(1459) },
        { at: ms(100), frames: 1, payload: B(1458) },
      ],
    }),
    cell: "EQ.7",
    note: "The settings of the cell EQ.7: a frame of 1,501 B is longer than the bucket of 1,500 B.",
  },
];

// ---------------------------------------------------------------------------------------------
// the headline
// ---------------------------------------------------------------------------------------------

/** This function gives the headline of the page: what drops, who knows, and when the queue is empty again. */
export const headlineOf = (settings: EgressSettings): string => {
  const model = egressModel(settings);
  const drops = model.limitDrops + model.sizeDrops;
  const empty = model.drain === null ? "No frame leaves." : `The last frame leaves at ${say(sec(model.drain))}.`;
  if (drops === 0) return `${qdiscText(settings)} sends each of the ${model.frames.length} datagrams. ${empty}`;
  const who = settings.recverr ? "Each dropped send gets ENOBUFS." : "Each send succeeds, thus the program does not know.";
  return `${qdiscText(settings)} drops ${drops} of ${model.frames.length} datagrams. ${who} ${empty}`;
};

// ---------------------------------------------------------------------------------------------
// the lenses
// ---------------------------------------------------------------------------------------------

/** The three lenses of the egress queue. The measured values come with the copy of the EQ cells. */
export const EGRESS_LENSES = {
  program: {
    id: "program",
    names: { title: "The program", label: "Program", short: "Prog", term: "IP_RECVERR" },
    knobs: ["train", "recverr", "mtu"],
    lanes: (settings) => [programLane(settings)],
  },
  qdisc: {
    id: "qdisc",
    names: { title: "The qdisc", label: "Qdisc", short: "Qdisc", term: "qdisc" },
    knobs: ["qdisc", "shapeRate", "delay", "packetLimit", "bucket", "byteLimit"],
    lanes: (settings) => [qdiscLane(settings)],
  },
  device: {
    id: "device",
    names: { title: "The device", label: "Device", short: "Dev", term: null },
    knobs: [],
    lanes: (settings) => [deviceLane(settings)],
  },
} as const satisfies Record<EgressLaneId, Lens<EgressSettings, EgressLaneId>>;
