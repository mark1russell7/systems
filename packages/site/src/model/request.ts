/**
 * The path of one request: the model behind the page `lab/request`. A program sends one request, and a
 * fault starts on the path. Each layer, from the program to the NIC, can find the fault, or it stays
 * silent. This module computes when each layer finds it.
 *
 * Each layer is a lens (`./lens.ts`): the program, the socket, TCP, Kubernetes and the NIC, in
 * `./lenses/`. The settings of the path and their values for each machine document are in `./path.ts`.
 * This module puts the five lanes on one path, and it tells which layer knows first.
 *
 * The measured values come from the copies of the cells (`src/data`). A value shows only when the
 * settings of the page are the settings of that cell.
 */
import { convert, valueIn, type Quantity } from "@mark1russell7/quantity";
import { lanesOf, sayBand, type Band, type Lens, type Verdict } from "./lens.ts";
import { KUBE } from "./lenses/kube.ts";
import { NIC } from "./lenses/nic.ts";
import { PROGRAM } from "./lenses/program.ts";
import { SOCKET } from "./lenses/socket.ts";
import { TCP } from "./lenses/tcp.ts";
import { DEFAULTS, ms, s, type LayerId, type LayerResult, type Settings } from "./path.ts";

export { DATAPLANES, DEFAULTS, manifestationOf, rtoFirings, tcpValues, type Dataplane, type Fault, type LayerId, type LayerResult, type Settings } from "./path.ts";
export { say, sayBand, type Band, type Fact, type Mark, type Measured } from "./lens.ts";

/** A verdict tells what a layer does with the fault. */
export type LayerVerdict = Verdict;

/** The five lenses of the path, from the program down to the NIC. */
export const LENSES: ReadonlyArray<Lens<Settings, LayerId>> = [PROGRAM, SOCKET, TCP, KUBE, NIC];

const LENS_OF = new Map(LENSES.map((lens) => [lens.id, lens]));

/** This function gives the lens of a layer. */
export const lensOf = (id: LayerId): Lens<Settings, LayerId> => {
  const lens = LENS_OF.get(id);
  if (lens === undefined) throw new Error(`no lens for the layer ${id}`);
  return lens;
};

export const layerName = (id: LayerId): string => lensOf(id).names.title;

export interface PathResult {
  readonly layers: readonly LayerResult[];
  /** the layer that finds the fault first, and when, or null when no layer finds it */
  readonly first: { readonly layer: LayerId; readonly band: Band } | null;
  /** the end of a partition, or null */
  readonly heal: Quantity | null;
  /** one sentence that answers the question of the page */
  readonly headline: string;
}

/** On a tie, the lower layer finds the fault, and the program learns of it from that layer. */
const BELOW: Readonly<Record<LayerId, number>> = { nic: 0, tcp: 1, kube: 2, socket: 3, process: 4 };

/** This function computes the whole path for the settings. */
export const requestPath = (settings: Settings): PathResult => {
  const layers = lanesOf(LENSES, settings);
  const process = layers.find((layer) => layer.id === "process");
  if (process === undefined) throw new Error("the path has no lane of the program");
  // the socket shows the error of TCP, thus it does not compete with TCP
  const detecting = layers.filter((layer) => layer.verdict === "detects" && layer.band !== null && layer.id !== "socket");
  const sorted = [...detecting].sort((a, b) => valueIn(a.band!.low, "s") - valueIn(b.band!.low, "s") || BELOW[a.id] - BELOW[b.id]);
  const winner = sorted[0];
  const first = winner === undefined ? null : { layer: winner.id, band: winner.band! };
  const recovered = process.verdict === "recovers" ? process.band : null;
  let headline: string;
  if (settings.fault === "partition" && recovered !== null) {
    headline = `The request survives the partition: the reply comes at ${sayBand(recovered)}.`;
  } else if (first === null) {
    headline = "No layer finds this fault. The request waits forever.";
  } else if (process.verdict === "silent" && settings.inFlight) {
    headline = `${layerName(first.layer)} knows first, at ${sayBand(first.band)}. The program never learns of it: this call waits forever.`;
  } else {
    const next = sorted.find((layer) => valueIn(layer.band!.low, "s") > valueIn(first.band.low, "s"));
    headline = `${layerName(first.layer)} knows first, at ${sayBand(first.band)}.${next === undefined ? "" : ` ${layerName(next.id)} would know at ${sayBand(next.band!)}.`}`;
  }
  return { layers, first, heal: settings.fault === "partition" ? convert(settings.heal, "s") : null, headline };
};

// ---------------------------------------------------------------------------------------------
// the presets
// ---------------------------------------------------------------------------------------------

export interface Preset {
  readonly id: string;
  readonly label: string;
  /** one sentence: what the preset shows */
  readonly note: string;
  readonly settings: Settings;
}

/** the scaled keepalive of the S1 cells: 5 s idle, a probe each 2 s, 3 probes, on a kernel at HZ 250, and no deadline */
const CELL_KERNEL = { keepidle: s(5), keepintvl: s(2), keepcnt: 3, hz: 250, timeout: ms(0), retries: 0 } as const;

export const PRESETS: readonly Preset[] = [
  { id: "defaults", label: "Linux defaults", note: "A call with a deadline of 10 s and 2 retries, on the defaults of Linux and Kubernetes.", settings: DEFAULTS },
  {
    id: "q1",
    label: "Cell Q1",
    note: "An idle connection behind a black hole. Only keepalive can find it.",
    settings: { ...DEFAULTS, ...CELL_KERNEL, fault: "blackhole", inFlight: false },
  },
  {
    id: "q2",
    label: "Cell Q2",
    note: "A request in flight behind a black hole, with tcp_retries2 = 3.",
    settings: { ...DEFAULTS, ...CELL_KERNEL, fault: "blackhole", inFlight: true, retries2: 3 },
  },
  {
    id: "q3",
    label: "Cell Q3",
    note: "The process of the peer is frozen. Its kernel answers, thus no TCP timer fires.",
    settings: { ...DEFAULTS, ...CELL_KERNEL, fault: "stall", inFlight: true, retries2: 3 },
  },
  {
    id: "q4",
    label: "Cell Q4",
    note: "A partition of 3.5 s. TCP retransmits through it, and the request continues.",
    settings: { ...DEFAULTS, fault: "partition", inFlight: true, heal: s(3.5), hz: 250, timeout: ms(0), retries: 0 },
  },
  {
    id: "t18",
    label: "Kind T18",
    note: "The event loop of a pod blocks. The readiness probe takes it out of the Service.",
    settings: { ...DEFAULTS, fault: "stall", inFlight: true, dataplane: "iptables", hz: 1000 },
  },
];
