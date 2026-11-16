/**
 * The whole path of one connection: the model behind the page `lab/path`. A client takes a local port,
 * its handshake meets the accept queue of the target, and its request meets a fault. Each part is a
 * stage (`./lens.ts`) with the lenses of its own page: the port range, the accept queue and the path of
 * one request. Each stage starts at the exit of the stage before it.
 *
 * The page follows one connection:
 *
 * - In the port range, it is the first connect that gets EADDRNOTAVAIL. With no error, it is a connect
 *   that gets a port at 0 s.
 * - In the accept queue, it is the first connect whose SYN or final ACK overflows. With no overflow,
 *   it is the first new connect, and it is connected after one round trip.
 * - The request starts when the connection holds a place at the target, and the fault starts with it.
 *
 * The client sends its request at once when it is connected. Thus the send of the accept queue comes
 * from the request: a request in flight sends at once, and an idle connection sends nothing.
 */
import { convert, quantity, valueIn, type Quantity } from "@mark1russell7/quantity";
import { bandOf, memo, sayBand, sequence, type Band, type Exit, type Lane, type Stage, type Staged } from "./lens.ts";
import { QUEUE_DEFAULTS, QUEUE_LENSES, queueModel, type QueueLaneId, type QueueSettings } from "./lenses/accept-queue.ts";
import { PORT_DEFAULTS, PORT_LENSES, portModel, type PortLaneId, type PortSettings } from "./lenses/ports.ts";
import { ms, s } from "./path.ts";
import { DEFAULTS, LENSES, layerName, requestPath, type LayerId, type Settings } from "./request.ts";

/** The settings of the whole path: one value for each knob of each lens. A knob with one name in two lenses is one value. */
export type WholeSettings = Settings & PortSettings & QueueSettings;
export type WholeLaneId = LayerId | PortLaneId | QueueLaneId;
export type StageId = "ports" | "queue" | "request";

/** The knobs that the whole path sets from other knobs. The send of the client comes from the request, thus the page shows no control for it. */
export const LINKED_KNOBS: ReadonlySet<string> = new Set(["send", "sendAt"]);

/** This function gives the settings of each stage: the client sends at once when the request is in flight, and it sends nothing on an idle connection. */
export const linked = memo((settings: WholeSettings): WholeSettings => ({ ...settings, send: settings.inFlight ? "connected" : "never" }));

/**
 * These are the defaults of Linux: a port from the whole range, a queue with room, and a request with a
 * deadline behind a black hole. The client connects each 10 ms. At the 1 ms of the page of the port range,
 * the range runs out in 28 s, before TIME_WAIT frees the first port.
 */
export const WHOLE_DEFAULTS: WholeSettings = { ...PORT_DEFAULTS, ...QUEUE_DEFAULTS, ...DEFAULTS, connectGap: ms(10), queued: 0, connections: 1, send: "connected" };

// ---------------------------------------------------------------------------------------------
// the exits
// ---------------------------------------------------------------------------------------------

const ZERO_BAND = bandOf(s(0));
const at = (time: number, band: Band | null): Band => band ?? bandOf(s(time));

/** The exit of the port range: the connect gets a port at once, or the connect gets EADDRNOTAVAIL. */
export const portExit = (settings: WholeSettings): Exit => {
  const { error } = portModel(settings);
  return error === null ? { kind: "pass", at: ZERO_BAND, label: "The connect gets a port" } : { kind: "end", at: error, label: "The connect gets EADDRNOTAVAIL" };
};

/** The exit of the accept queue: the connection holds a place, or its SYN, its reset or its silence ends it. */
export const queueExit = (settings: WholeSettings): Exit => {
  const { first, syn, ack } = queueModel(settings);
  if (first === null) return { kind: "pass", at: bandOf(convert(settings.rtt, "s")), label: "The connect finds a place" };
  if (first.what === "syn" && syn !== null) {
    const when = at(syn.end.at, syn.end.band);
    return syn.end.kind === "timeout"
      ? { kind: "end", at: when, label: `Connect ${syn.connection} gets ETIMEDOUT` }
      : { kind: "pass", at: when, label: `A later SYN of connect ${syn.connection} finds a place` };
  }
  if (ack === null) throw new Error("an overflow of a final ACK with no story");
  const { end } = ack;
  if (end.kind === "connected" && end.at !== null) return { kind: "pass", at: at(end.at, end.band), label: `Connect ${ack.connection} finds a place after the accept` };
  if (end.kind === "reset" && end.at !== null) return { kind: "end", at: at(end.at, end.band), label: `Connect ${ack.connection} gets ECONNRESET` };
  return { kind: "end", at: null, label: `Connect ${ack.connection} stays connected to nothing` };
};

/** The exit of the request: the reply comes after a partition, a layer knows first, or no layer finds the fault. */
export const requestExit = (settings: WholeSettings): Exit => {
  const result = requestPath(settings);
  const program = result.layers.find((layer) => layer.id === "process");
  if (settings.fault === "partition" && program?.verdict === "recovers" && program.band !== null) return { kind: "pass", at: program.band, label: "The reply comes" };
  if (result.first === null) return { kind: "end", at: null, label: "No layer finds the fault" };
  return { kind: "end", at: result.first.band, label: `${layerName(result.first.layer)} knows first` };
};

/** The three stages of one connection, in their order. */
export const STAGES: ReadonlyArray<Stage<WholeSettings, WholeLaneId>> = [
  { id: "ports", title: "The port of the client", short: "Port", lenses: [PORT_LENSES.search, PORT_LENSES.hold], exit: portExit },
  { id: "queue", title: "The accept queue", short: "Queue", lenses: [QUEUE_LENSES.queue, QUEUE_LENSES.syn, QUEUE_LENSES.ack], exit: queueExit },
  { id: "request", title: "The request and the fault", short: "Request", lenses: LENSES, exit: requestExit },
];

// ---------------------------------------------------------------------------------------------
// the whole path
// ---------------------------------------------------------------------------------------------

export interface WholeResult {
  readonly stages: ReadonlyArray<Staged<WholeSettings, WholeLaneId>>;
  /** the lanes of each stage that the connection reaches, on the whole timeline */
  readonly lanes: ReadonlyArray<Lane<WholeLaneId>>;
  /** the fault on the whole timeline, from the start of the request, or null when the connection does not reach the request */
  readonly fault: { readonly start: Quantity; readonly end: Quantity | null } | null;
  /** the lane that acts first in each stage, by the id of the stage */
  readonly first: Readonly<Record<StageId, WholeLaneId | null>>;
  /** one or two sentences that tell how the connection ends */
  readonly headline: string;
}

/** This function computes the whole path of one connection for the settings. */
export const wholePath = memo((settings: WholeSettings): WholeResult => {
  const linkedSettings = linked(settings);
  const stages = sequence(STAGES, linkedSettings);
  const [ports, queue, request] = stages;
  if (ports === undefined || queue === undefined || request === undefined) throw new Error("the whole path has three stages");
  const path = requestPath(linkedSettings);
  const start = request.start === null ? null : request.start.low;
  const fault = start === null ? null : { start, end: path.heal === null ? null : quantity(valueIn(start, "s") + valueIn(path.heal, "s"), "s") };
  const detects = (staged: Staged<WholeSettings, WholeLaneId>): WholeLaneId | null => staged.own.find((lane) => lane.verdict === "detects")?.id ?? null;
  const first = { ports: detects(ports), queue: detects(queue), request: path.first?.layer ?? null };
  let headline: string;
  if (ports.exit?.kind === "end") {
    headline = `${ports.exit.label} at ${ports.exit.at === null ? "an unknown time" : sayBand(ports.exit.at)}. The connection never reaches the target.`;
  } else if (queue.exit?.kind === "end") {
    headline = `${queue.exit.label}${queue.exit.at === null ? "" : ` at ${sayBand(queue.exit.at)}`}. The request never starts.`;
  } else {
    headline = `The connection is ready at ${request.start === null ? "an unknown time" : sayBand(request.start)}, and the fault starts then. From the fault: ${path.headline}`;
  }
  return { stages, lanes: stages.flatMap((staged) => staged.lanes), fault, first, headline };
});

// ---------------------------------------------------------------------------------------------
// the presets
// ---------------------------------------------------------------------------------------------

export interface WholePreset {
  readonly id: string;
  readonly label: string;
  /** one sentence: what the preset shows */
  readonly note: string;
  readonly settings: WholeSettings;
}

/** a full queue of a backlog of 4 and a burst of three connects: the settings of the cell AQ.5 */
const FULL = { backlog: 4, queued: 4, connections: 3, arrival: "once" } as const;

export const WHOLE_PRESETS: readonly WholePreset[] = [
  { id: "defaults", label: "Linux defaults", note: "A port from the whole range at one connect each 10 ms, a queue with room, and a call with a deadline of 10 s behind a black hole.", settings: WHOLE_DEFAULTS },
  {
    id: "ports",
    label: "No port",
    note: "Each connection stays open, thus a range of 16 ports runs out. The story ends at the port.",
    settings: { ...WHOLE_DEFAULTS, portRange: 16, close: "open" },
  },
  {
    id: "syn",
    label: "SYN drop",
    note: "The queue is full before the connect, and the program does not accept. The SYN ladder ends the connect.",
    settings: { ...WHOLE_DEFAULTS, backlog: 1, queued: 2, connections: 1 },
  },
  {
    id: "abort",
    label: "Reset",
    note: "The final ACK finds a full queue, and tcp_abort_on_overflow 1 sends a reset.",
    settings: { ...WHOLE_DEFAULTS, ...FULL, abort: true },
  },
  {
    id: "drain",
    label: "Drain",
    note: "The final ACK finds a full queue, and the program accepts at 2.5 s. The request starts after the accept.",
    settings: { ...WHOLE_DEFAULTS, ...FULL, accept: true, acceptAt: ms(2500) },
  },
  {
    id: "partition",
    label: "Drain and partition",
    note: "The connection finds a place after the accept, and a partition of 3.5 s starts with its request.",
    settings: { ...WHOLE_DEFAULTS, ...FULL, accept: true, acceptAt: ms(2500), fault: "partition", heal: s(3.5) },
  },
];
