/**
 * The path of one request: the model behind the page `lab/request`. A program sends one request, and a
 * fault starts on the path. Each layer, from the program to the NIC, can find the fault, or it stays
 * silent. This module computes when each layer finds it.
 *
 * The times come from the algebra (`@mark1russell7/algebra`) over four machine documents of
 * `@mark1russell7/machines`. They are Linux TCP, conntrack, the call of the program with a
 * deadline, and the readiness probe of the kubelet. The bands, the firings and the trains of probes
 * come from `timerBand`, `firings` and `probeTrain` of the algebra. Each amount is a quantity of
 * `@mark1russell7/quantity`, and each amount prints through its `format`.
 *
 * The measured values come from the copies of the cells (`src/data`). A value shows only when the
 * settings of the page are the settings of that cell.
 */
import {
  detection,
  errnoOf,
  firings,
  probeTrain,
  recovery,
  stackedDetection,
  timerBand,
  timerOf,
  type Detection,
  type KnobValues,
  type Manifestation,
  type TimerBounds,
} from "@mark1russell7/algebra";
import { DEADLINE_CALL, KUBELET_READINESS, LINUX_TCP, MANIFESTATIONS, NF_CONNTRACK_TCP } from "@mark1russell7/machines";
import { add, convert, format, formatDuration, isUnbounded, quantity, valueIn, type Extent, type Quantity, type Unknown } from "@mark1russell7/quantity";
import harness from "../data/harness-2026-10-13.json";
import kind from "../data/kind-2026-10-18.json";
import stall from "../data/s2-stall-2026-10-26.json";
import stallCilium from "../data/s2-stall-cilium-2026-10-27.json";

// ---------------------------------------------------------------------------------------------
// the settings of the page
// ---------------------------------------------------------------------------------------------

/** A fault is what goes wrong on the path. A partition is a black hole that heals after its length. */
export type Fault = "blackhole" | "stall" | "partition";

/** A dataplane is what carries a Service on the node: a mode of kube-proxy, or Cilium, which replaces kube-proxy. */
export type Dataplane = "iptables" | "ipvs" | "nftables" | "cilium";

export const DATAPLANES: readonly Dataplane[] = ["iptables", "ipvs", "nftables", "cilium"];

export interface Settings {
  readonly fault: Fault;
  /** This flag tells if the request is in flight when the fault starts. Else the connection waits in the pool of the program. */
  readonly inFlight: boolean;
  /** the length of a partition */
  readonly heal: Quantity;
  // the program
  /** the deadline of one call. 0 is no deadline */
  readonly timeout: Quantity;
  /** the retries after a deadline */
  readonly retries: number;
  /** the first wait between two tries. Each wait doubles, up to `backoffCap` */
  readonly backoff: Quantity;
  readonly backoffCap: Quantity;
  // the kernel
  readonly keepaliveOn: boolean;
  readonly keepidle: Quantity;
  readonly keepintvl: Quantity;
  readonly keepcnt: number;
  readonly retries2: number;
  /** TCP_USER_TIMEOUT. 0 is off */
  readonly userTimeout: Quantity;
  readonly rtt: Quantity;
  readonly hz: number;
  // Kubernetes
  readonly dataplane: Dataplane;
  readonly period: Quantity;
  readonly threshold: number;
  readonly probeTimeout: Quantity;
  readonly ctEstablished: Quantity;
  // the NIC
  readonly txqueuelen: number;
  readonly mtu: Quantity;
  readonly rate: Quantity;
}

const s = (value: number): Quantity => quantity(value, "s");
const ms = (value: number): Quantity => quantity(value, "ms");

/** These are the defaults of Linux 6.6 and Kubernetes 1.37, with a call that has a deadline of 10 s and 2 retries. */
export const DEFAULTS: Settings = {
  fault: "blackhole",
  inFlight: true,
  heal: s(3.5),
  timeout: s(10),
  retries: 2,
  backoff: ms(200),
  backoffCap: s(10),
  keepaliveOn: true,
  keepidle: s(7200),
  keepintvl: s(75),
  keepcnt: 9,
  retries2: 15,
  userTimeout: ms(0),
  rtt: ms(1),
  hz: 1000,
  dataplane: "iptables",
  period: s(10),
  threshold: 3,
  probeTimeout: s(1),
  ctEstablished: s(432000),
  txqueuelen: 1000,
  mtu: quantity(1500, "B"),
  rate: quantity(10, "Gbit/s"),
};

// ---------------------------------------------------------------------------------------------
// the values of the knobs
// ---------------------------------------------------------------------------------------------

const count = (n: number): Quantity => quantity(n, "count");

/** This function gives the values of the knobs of Linux TCP, from the settings and the defaults of the document. */
export const tcpValues =
  (settings: Settings): KnobValues =>
  (name) => {
    const given: Readonly<Record<string, Extent>> = {
      tcp_retries2: count(settings.retries2),
      keepidle: settings.keepaliveOn ? settings.keepidle : { value: "infinite", unit: "s" },
      keepintvl: settings.keepintvl,
      keepcnt: count(settings.keepcnt),
      tcp_user_timeout: settings.userTimeout,
      rtt: settings.rtt,
      hz: quantity(settings.hz, "Hz"),
    };
    const own = given[name];
    if (own !== undefined) return own;
    const knob = LINUX_TCP.knobs[name];
    if (knob === undefined || knob.default === null) return undefined;
    return quantity(knob.default, knob.unit ?? "count");
  };

const callValues =
  (settings: Settings): KnobValues =>
  (name) =>
    ({ timeout: settings.timeout, backoff: settings.backoff, backoff_cap: settings.backoffCap })[name];

const probeValues =
  (settings: Settings): KnobValues =>
  (name) =>
    ({ period: settings.period, threshold: count(settings.threshold), timeout: settings.probeTimeout })[name];

const conntrackValues =
  (settings: Settings): KnobValues =>
  (name) => {
    if (name === "nf_conntrack_tcp_timeout_established") return settings.ctEstablished;
    const knob = NF_CONNTRACK_TCP.knobs[name];
    return knob === undefined || knob.default === null ? undefined : quantity(knob.default, knob.unit ?? "count");
  };

/** This function gives what the fault lets back to the socket of the client: nothing, or the ACKs of a frozen kernel. */
export const manifestationOf = (fault: Fault): Manifestation =>
  fault === "stall"
    ? { name: "freeze-process", passes: MANIFESTATIONS["freeze-process"] ?? ["rx.ack"] }
    : { name: "blackhole", passes: MANIFESTATIONS["blackhole"] ?? [] };

// ---------------------------------------------------------------------------------------------
// the printing of an amount
// ---------------------------------------------------------------------------------------------

/** This function tells if an extent is a finite quantity. */
const finite = (extent: Extent | Unknown | undefined): extent is Quantity => extent !== undefined && !("unknown" in extent) && !isUnbounded(extent);

/**
 * This function prints a time for a reader: "204 ms", "6.528 s", "15 min 24.6 s", "never". Each form
 * comes from `format` or `formatDuration` of the quantity package, in a unit that suits the size.
 */
export const say = (extent: Extent | Unknown | undefined): string => {
  if (extent === undefined) return "never";
  if ("unknown" in extent) return `unknown (${extent.unknown})`;
  if (isUnbounded(extent)) return "never";
  const seconds = valueIn(extent, "s");
  if (seconds === 0) return format(s(0));
  if (Math.abs(seconds) < 1) return format(convert(extent, "ms"), { digits: Math.abs(seconds) < 0.01 ? 2 : 1 });
  if (Math.abs(seconds) < 120) return format(convert(extent, "s"), { digits: 3 });
  return formatDuration(extent, 3);
};

/** This function prints a band: "21 s to 31.092 s", or one time when the two ends are the same. */
export const sayBand = (band: Band): string => (valueIn(band.low, "s") === valueIn(band.high, "s") ? say(band.low) : `${say(band.low)} to ${say(band.high)}`);

// ---------------------------------------------------------------------------------------------
// the results of each layer
// ---------------------------------------------------------------------------------------------

/** A band is the range of times in which an event comes, from the start of the fault. */
export interface Band {
  readonly low: Quantity;
  readonly high: Quantity;
}

export type LayerId = "process" | "socket" | "tcp" | "kube" | "nic";

/** A verdict tells what a layer does with the fault. */
export type LayerVerdict = "detects" | "recovers" | "silent" | "blind";

/** A mark is one event on the timeline of a layer: a firing, a probe, a detection or a recovery. */
export interface Mark {
  readonly t: Quantity;
  readonly label: string;
  readonly kind: "send" | "fire" | "probe" | "detect" | "recover";
}

/** A measured value is a value of a cell beside the value that the page computes. */
export interface Measured {
  readonly cell: string;
  readonly measured: string;
  readonly computed: string;
  readonly href: string;
  /** the measured median on the timeline of the page, from the start of the fault, or null */
  readonly at: Quantity | null;
}

/** A fact is one computed value of a layer, with its label. */
export interface Fact {
  readonly label: string;
  readonly value: string;
}

export interface LayerResult {
  readonly id: LayerId;
  readonly verdict: LayerVerdict;
  /** the band in which the layer finds the fault or recovers from it, or null */
  readonly band: Band | null;
  /** one sentence: what the layer does */
  readonly summary: string;
  readonly facts: readonly Fact[];
  readonly marks: readonly Mark[];
  readonly measured: readonly Measured[];
  /** a warning for these settings, or null */
  readonly warning: string | null;
}

export interface PathResult {
  readonly layers: readonly LayerResult[];
  /** the layer that finds the fault first, and when, or null when no layer finds it */
  readonly first: { readonly layer: LayerId; readonly band: Band } | null;
  /** the end of a partition, or null */
  readonly heal: Quantity | null;
  /** one sentence that answers the question of the page */
  readonly headline: string;
}

const ZERO = s(0);
const bandOf = (low: Quantity, high: Quantity = low): Band => ({ low: convert(low, "s"), high: convert(high, "s") });
const atLeast = (a: Quantity, b: Quantity): boolean => valueIn(a, "s") >= valueIn(b, "s");

/** This function gives the band of a timer from `timerBand` of the algebra. If an end of the band is not a known time, it gives null. */
const bandOfTimer = (bounds: TimerBounds): Band | null => {
  const band = timerBand(bounds);
  return "unknown" in band || !finite(band.low) || !finite(band.high) ? null : bandOf(band.low, band.high);
};

/** This function gives the times of the firings of the retransmission timer from the send, up to `until` or 24 firings. */
export const rtoFirings = (settings: Settings, until: Quantity): Quantity[] =>
  firings(LINUX_TCP, "retransmit", tcpValues(settings), { count: 24, until }).map((firing) => firing.at);

/** This function gives the time of the first retransmission of the RTO timer from the send: the second firing, after the loss probe. */
const firstRetransmission = (settings: Settings): Quantity =>
  firings(LINUX_TCP, "retransmit", tcpValues(settings), { count: 2 })[1]?.at ?? ZERO;

const TCP_NAMES: Readonly<Record<string, string>> = {
  keepalive: "keepalive",
  retrans_giveup: "the retransmission give-up",
  user_timeout: "TCP_USER_TIMEOUT",
};

/** The S1 cells of the harness, by the settings that each one has. Each runs on Linux 6.6 at HZ 250, with no deadline of a program. */
const HARNESS = harness.cells;
const cellOf = (name: string) => HARNESS.find((cell) => cell.name === name);
const medianOf = (name: string): string => {
  const cell = cellOf(name);
  const median = cell?.verdict.median ?? null;
  return median === null ? `silent in ${cell?.verdict.counted ?? 0} runs` : `${say(s(median))} (median of ${cell?.verdict.counted ?? 0} runs)`;
};

const scaledKeepalive = (settings: Settings): boolean =>
  settings.keepaliveOn && valueIn(settings.keepidle, "s") === 5 && valueIn(settings.keepintvl, "s") === 2 && settings.keepcnt === 3 && settings.hz === 250;

/** A cell counts its time from one of these events. The band of the page is in the same frame. */
const FROM: Readonly<Record<string, string>> = {
  "last-received": "from the last segment that the client got",
  "first-retransmission": "from the first retransmission",
};

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const CELLS_PAGE = "results/cells/#the-kernel-of-the-client";
const RECOVERY_PAGE = "results/cells/#recovery-from-a-stall-q4";

/** This function gives the measured values of the TCP layer for the settings: the cells Q1 to Q4, when the settings are theirs. */
const tcpMeasured = (settings: Settings, computed: { band: Band | null; recovery: Band | null }): Measured[] => {
  const out: Measured[] = [];
  const show = (name: string, href: string, band: Band | null): void => {
    const cell = cellOf(name);
    if (cell === undefined) return;
    const frame = "from" in cell.prediction ? String(cell.prediction.from) : "";
    const from = FROM[frame];
    const computedText = band === null ? "no TCP timer fires" : `${sayBand(band)}${from === undefined ? "" : `, ${from}`}`;
    const median = cell.verdict.median;
    const at = median === null ? null : add(s(median), frame === "first-retransmission" ? firstRetransmission(settings) : ZERO);
    out.push({ cell: name, measured: medianOf(name), computed: computedText, href, at });
  };
  if (settings.fault === "blackhole" && !settings.inFlight && scaledKeepalive(settings)) show("Q1 idle, black hole", CELLS_PAGE, computed.band);
  if (settings.fault === "blackhole" && settings.inFlight && settings.hz === 250 && (settings.retries2 === 3 || settings.retries2 === 5)) {
    show(`Q2 in flight, black hole, tcp_retries2 = ${settings.retries2}`, CELLS_PAGE, computed.band);
  }
  if (settings.fault === "stall" && settings.inFlight && settings.hz === 250 && scaledKeepalive(settings) && settings.retries2 === 3) show("Q3 in flight, frozen process", CELLS_PAGE, null);
  const length = valueIn(settings.heal, "s");
  if (settings.fault === "partition" && settings.inFlight && settings.hz === 250 && (length === 1 || length === 3.5)) {
    show(`Q4 in flight, a ${length} s stall`, RECOVERY_PAGE, computed.recovery);
  }
  return out;
};

/** This function gives what TCP does with the fault: the first live timer, its firings, and the recovery after a partition. */
const tcpLayer = (settings: Settings): { layer: LayerResult; found: Detection; giveUp: Band | null } => {
  const manifestation = manifestationOf(settings.fault);
  const values = tcpValues(settings);
  const found = detection(LINUX_TCP, { state: "ESTABLISHED", inFlight: settings.inFlight }, manifestation, values);
  const first = found.first;
  const offset = first?.timer === "retrans_giveup" || first?.timer === "user_timeout" ? firstRetransmission(settings) : ZERO;
  const own = first === null ? null : bandOfTimer(timerOf(LINUX_TCP, first.timer, values));
  const band = own === null ? null : bandOf(add(own.low, offset), add(own.high, offset));
  const marks: Mark[] = [];
  const facts: Fact[] = [];
  let recovered: Band | null = null;
  let verdict: LayerVerdict = band === null ? "silent" : "detects";
  if (settings.fault === "partition" && settings.inFlight) {
    const back = recovery(LINUX_TCP, "retransmit", values, settings.heal);
    if (!("unknown" in back)) {
      recovered = bandOf(back.low, back.high);
      if (band === null || !atLeast(recovered.low, band.low)) verdict = "recovers";
    }
  }
  // the firings up to the end of the story of this layer: its recovery, or its give-up
  const horizon = verdict === "recovers" && recovered !== null ? recovered.low : (band?.low ?? s(3600));
  if (settings.inFlight && settings.fault !== "stall") {
    const firings = rtoFirings(settings, horizon);
    firings.forEach((t, n) => marks.push({ t, label: n === 0 ? "Tail loss probe" : `Retransmission ${n}`, kind: "fire" }));
    facts.push({ label: "First RTO", value: say(timerOf(LINUX_TCP, "retransmit", values, 1).duration) });
    facts.push({ label: "Retransmissions", value: format(count(Math.max(firings.length - 1, 0))) });
  }
  if (!settings.inFlight && settings.fault !== "stall" && settings.keepaliveOn) {
    probeTrain(settings.keepidle, settings.keepintvl, settings.keepcnt).forEach((t, n) => marks.push({ t, label: `Keepalive probe ${n + 1}`, kind: "probe" }));
  }
  const delack = timerOf(LINUX_TCP, "delayed_ack", values).duration;
  facts.push({ label: "Delayed ACK, at most", value: say(delack) });
  let summary: string;
  if (verdict === "recovers" && recovered !== null) {
    marks.push({ t: recovered.low, label: "The first retransmission after the heal gets through", kind: "recover" });
    summary = `TCP does not report the partition. A retransmission after the heal gets through at ${sayBand(recovered)}, and the request continues.`;
  } else if (first !== null && band !== null) {
    const errno = errnoOf(LINUX_TCP, "ESTABLISHED", first, manifestation) ?? "an error";
    summary = `${capital(TCP_NAMES[first.timer] ?? first.timer)} finds the fault at ${sayBand(band)}, and the socket gets ${errno}.`;
    marks.push({ t: band.low, label: `${TCP_NAMES[first.timer] ?? first.timer}: ${errno}`, kind: "detect" });
  } else if (settings.fault === "stall") {
    summary = "No TCP timer fires. The kernel of the stalled peer acknowledges each segment, and it answers each keepalive probe.";
  } else {
    summary = "No TCP timer is armed on an idle socket without SO_KEEPALIVE. TCP finds the fault only at the next send.";
  }
  for (const held of found.held) facts.push({ label: TCP_NAMES[held.timer] ?? held.timer, value: `held: ${held.why}` });
  const layer: LayerResult = {
    id: "tcp",
    verdict,
    band: verdict === "recovers" ? recovered : band,
    summary,
    facts,
    marks,
    measured: tcpMeasured(settings, { band: own, recovery: recovered }),
    warning: null,
  };
  return { layer, found, giveUp: band };
};

/** This function gives the time of the send of each try of the call, from the first send, for the retries of the settings. */
const attemptStarts = (settings: Settings): Quantity[] => [
  ZERO,
  ...firings(DEADLINE_CALL, "retry", callValues(settings), { count: settings.retries }).map((firing) => firing.at),
];

/** This function gives what the program does: its deadline, its retries, and the time that the call ends. */
const processLayer = (settings: Settings, tcp: { found: Detection; layer: LayerResult }): LayerResult => {
  const values = callValues(settings);
  const deadline = timerOf(DEADLINE_CALL, "deadline", values).duration;
  const facts: Fact[] = [{ label: "Deadline", value: finite(deadline) ? say(deadline) : "none" }];
  const marks: Mark[] = [{ t: ZERO, label: "The program sends the request", kind: "send" }];
  if (!settings.inFlight) {
    const stacked = stackedDetection(DEADLINE_CALL, LINUX_TCP, { state: "POOLED", inFlight: false }, manifestationOf(settings.fault), values, tcpValues(settings));
    const below = stacked.first;
    return {
      id: "process",
      verdict: below === null ? "silent" : "detects",
      band: tcp.layer.verdict === "detects" ? tcp.layer.band : null,
      summary:
        below === null
          ? "No call is open, thus no deadline runs. The program learns of the fault at its next request."
          : `No call is open. The program learns of the fault when the socket ends: ${TCP_NAMES[below.timer] ?? below.timer} closes it.`,
      facts,
      marks: [],
      measured: [],
      warning: null,
    };
  }
  const starts = finite(deadline) ? attemptStarts(settings) : [ZERO];
  const tcpBand = tcp.layer.verdict === "detects" ? tcp.layer.band : null;
  const tcpBack = tcp.layer.verdict === "recovers" ? tcp.layer.band : null;
  if (!finite(deadline)) {
    // without a deadline, only the socket below can end the call
    const band = tcpBand ?? tcpBack;
    return {
      id: "process",
      verdict: tcpBand !== null ? "detects" : tcpBack !== null ? "recovers" : "silent",
      band,
      summary:
        tcpBand !== null
          ? `The call has no deadline. It waits for TCP, and it fails at ${sayBand(tcpBand)}.`
          : tcpBack !== null
            ? `The call has no deadline. TCP carries the request through the partition, and the reply comes at ${sayBand(tcpBack)}.`
            : "The call has no deadline, and no layer below ends it. The call waits forever.",
      facts,
      marks,
      measured: [],
      warning: tcpBand === null && tcpBack === null ? "Set a deadline: no other layer ends this call." : null,
    };
  }
  const deadlineS = convert(deadline, "s");
  // a reply through TCP before the first deadline: the program sees only a slow reply
  if (tcpBack !== null && !atLeast(tcpBack.high, deadlineS)) {
    return {
      id: "process",
      verdict: "recovers",
      band: tcpBack,
      summary: `The reply comes at ${sayBand(tcpBack)}, before the deadline of ${say(deadline)}. The program sees a slow reply, not a fault.`,
      facts,
      marks,
      measured: [],
      warning: null,
    };
  }
  starts.forEach((start, n) => {
    if (n > 0) marks.push({ t: start, label: `Retry ${n}`, kind: "fire" });
    marks.push({ t: add(start, deadlineS), label: `Deadline of try ${n + 1}`, kind: n === 0 ? "detect" : "fire" });
  });
  const giveUp = add(starts.at(-1)!, deadlineS);
  facts.push({ label: "Tries", value: format(count(starts.length)) });
  facts.push({ label: "The call gives up at", value: say(giveUp) });
  if (settings.fault === "partition") {
    const heal = convert(settings.heal, "s");
    const after = starts.find((start) => atLeast(start, heal));
    if (after !== undefined) {
      const back = recovery(DEADLINE_CALL, "retry", values, settings.heal);
      const band = "unknown" in back ? bandOf(after) : bandOf(back.low, back.high);
      marks.push({ t: band.low, label: "The first try after the heal gets through", kind: "recover" });
      return {
        id: "process",
        verdict: "recovers",
        band,
        summary: `The deadline finds the fault at ${say(deadline)}. The first try after the heal starts at ${sayBand(band)}, and it gets the reply.`,
        facts,
        marks,
        measured: [],
        warning: null,
      };
    }
  }
  return {
    id: "process",
    verdict: "detects",
    band: bandOf(deadlineS),
    summary:
      starts.length === 1
        ? `The deadline finds the fault at ${say(deadline)}, and the call fails.`
        : `The deadline finds the fault at ${say(deadline)}. ${starts.length - 1} ${starts.length === 2 ? "retry" : "retries"} also wait, and the call fails at ${say(giveUp)}.`,
    facts,
    marks,
    measured: [],
    warning: null,
  };
};

/** This function gives what the socket shows: the write returns at once, and the error of TCP arrives at the next read. */
const socketLayer = (settings: Settings, tcp: LayerResult, found: Detection): LayerResult => {
  const facts: Fact[] = [];
  const marks: Mark[] = [];
  const manifestation = manifestationOf(settings.fault);
  const first = found.first;
  const errno = first === null ? null : errnoOf(LINUX_TCP, "ESTABLISHED", first, manifestation);
  if (tcp.verdict === "detects" && tcp.band !== null) marks.push({ t: tcp.band.low, label: `The next read returns ${errno ?? "an error"}`, kind: "detect" });
  facts.push({ label: "The write", value: "returns at once" });
  facts.push({ label: "Send queue", value: settings.inFlight && settings.fault !== "stall" ? "the request, until an ACK" : "empty" });
  return {
    id: "socket",
    verdict: tcp.verdict === "detects" ? "detects" : tcp.verdict === "recovers" ? "recovers" : "blind",
    band: tcp.verdict === "blind" ? null : tcp.band,
    summary:
      tcp.verdict === "detects" && tcp.band !== null
        ? `The socket shows nothing until TCP gives up. At ${sayBand(tcp.band)}, the next read or write returns ${errno ?? "an error"}.`
        : tcp.verdict === "recovers" && tcp.band !== null
          ? `The socket shows no error. The request waits in the send queue, and the reply arrives late, at ${sayBand(tcp.band)}.`
          : settings.fault === "stall"
            ? "The kernel of the peer acknowledges the request, thus the send queue empties. The reply does not come, and the read waits."
          : "The socket shows no error. The write went into the send buffer, and the read waits.",
    facts,
    marks,
    measured: [],
    warning: null,
  };
};

/** The measured propagation of a deletion to the rules of each node, by the mode of kube-proxy (the calibrations of T07). */
const propagationOf = (dataplane: Dataplane): Band | null => {
  if (dataplane === "cilium") return null;
  const all = kind.propagation[dataplane].all;
  return bandOf(s(all.min), s(all.max));
};

/** The S2 cell of a stalled pod with endpoints only, by its dataplane: its failed requests in the median run. */
const stallCellOf = (dataplane: Dataplane) =>
  [...stall.cells, ...stallCilium.cells].find((cell) => cell.mode === dataplane && cell.id.endsWith(".endpoints.stall"));

/** This function gives what Kubernetes does: the readiness probe, the propagation to the rules, and conntrack. */
const kubeLayer = (settings: Settings): LayerResult => {
  const facts: Fact[] = [];
  const marks: Mark[] = [];
  const measured: Measured[] = [];
  const propagation = propagationOf(settings.dataplane);
  facts.push({ label: `Propagation, ${settings.dataplane}`, value: propagation === null ? "not calibrated" : `${sayBand(propagation)} (measured)` });
  // conntrack: the flow of this connection, and its timeout
  const ct = detection(NF_CONNTRACK_TCP, { state: "ESTABLISHED", inFlight: settings.inFlight }, { name: "blackhole", passes: settings.inFlight ? ["orig.ack"] : [] }, conntrackValues(settings));
  const forgets = ct.first === null ? null : bandOfTimer(timerOf(NF_CONNTRACK_TCP, ct.first.timer, conntrackValues(settings)));
  facts.push({ label: "conntrack keeps this flow", value: forgets === null ? "while packets pass" : `for ${say(forgets.low)} of silence` });
  let warning: string | null = null;
  if (settings.keepaliveOn && !atLeast(settings.ctEstablished, settings.keepidle)) {
    warning = `The keepalive idle time (${say(settings.keepidle)}) is longer than the conntrack timeout (${say(settings.ctEstablished)}). An idle connection loses its NAT entry before its first probe.`;
  }
  if (settings.fault === "stall") {
    const values = probeValues(settings);
    const kubelet = bandOfTimer(timerOf(KUBELET_READINESS, "unready", values));
    if (kubelet === null) throw new Error("the readiness probe has no time");
    const band = propagation === null ? kubelet : bandOf(add(kubelet.low, propagation.low), add(kubelet.high, propagation.high));
    // the first probe after the fault fails at its timeout, and each next probe comes one interval later
    const interval = timerOf(KUBELET_READINESS, "probe", values, 0).duration;
    if ("unknown" in interval) throw new Error("the readiness probe has no interval");
    probeTrain(settings.probeTimeout, interval, settings.threshold).forEach((t, n) => marks.push({ t, label: `Readiness probe ${n + 1} fails`, kind: "probe" }));
    marks.push({ t: band.low, label: "The pod leaves the Service", kind: "detect" });
    facts.push({ label: "The kubelet marks it not ready", value: sayBand(kubelet) });
    const t18 = kind.cells.find((cell) => cell.trigger === "app-stall");
    if (
      t18 !== undefined &&
      settings.dataplane === "iptables" &&
      valueIn(settings.period, "s") === 10 &&
      settings.threshold === 3 &&
      valueIn(settings.probeTimeout, "s") === 1 &&
      t18.median !== null
    ) {
      measured.push({ cell: `${t18.id}: ${t18.name}`, measured: `${say(s(t18.median))} (median of ${t18.counted} runs)`, computed: sayBand(band), href: "results/kind/#a-stall-a-rollout-and-a-throttle", at: s(t18.median) });
    }
    if (settings.dataplane !== "cilium" && propagation !== null) {
      const all = kind.propagation[settings.dataplane].all;
      measured.push({
        cell: `The propagation of a deletion, ${settings.dataplane}`,
        measured: `${sayBand(propagation)} (${format(count(all.count))} deletions)`,
        computed: "no closed form: the page adds the measured band",
        href: "results/kind/#the-propagation",
        at: null,
      });
    }
    const s2 = stallCellOf(settings.dataplane);
    if (s2 !== undefined && s2.median !== null) {
      measured.push({ cell: `${s2.id}: ${s2.name}`, measured: `${format(quantity(s2.median, "count"))} failed requests (median of ${s2.counted} runs)`, computed: "the requests that start before the removal", href: "results/kind/#a-stalled-pod", at: null });
    }
    return {
      id: "kube",
      verdict: "detects",
      band,
      summary: `The readiness probe times out, and the pod leaves the Service at ${sayBand(band)}. New connections go to other pods. This connection stays on the stalled pod: conntrack keeps its NAT.`,
      facts,
      marks,
      measured,
      warning,
    };
  }
  return {
    id: "kube",
    verdict: "blind",
    band: null,
    summary:
      settings.fault === "partition"
        ? "The kubelet probes the pod from its own node, and the partition is between the nodes. Each probe passes, and the pod stays in the Service."
        : "The kubelet probes the pod from its own node, and the black hole is on the path between the nodes. Each probe passes, and the pod stays in the Service.",
    facts,
    marks,
    measured,
    warning,
  };
};

/** This function gives what the NIC does: it sends each segment, and it does not see a loss past its wire. */
const nicLayer = (settings: Settings, tcp: LayerResult): LayerResult => {
  const bits = valueIn(settings.mtu, "bit") * settings.txqueuelen;
  const drain = quantity(bits / valueIn(settings.rate, "bit/s"), "s");
  const sent = tcp.marks.filter((mark) => mark.kind === "fire" || mark.kind === "probe").length;
  const facts: Fact[] = [
    { label: "A full queue drains in", value: say(drain) },
    { label: "Segments it sends after the request", value: format(count(sent)) },
  ];
  return {
    id: "nic",
    verdict: "blind",
    band: null,
    summary:
      settings.fault === "stall"
        ? "The NIC sends the request and gets the ACK of the peer. The path works, thus the NIC has nothing to find."
        : `The NIC sends each segment, ${format(count(sent))} after the request. The loss is past its wire, thus its link stays up and its counters show no error.`,
    facts,
    marks: tcp.marks.filter((mark) => mark.kind === "fire" || mark.kind === "probe").map((mark) => ({ ...mark, kind: "fire" as const, label: `Sends: ${mark.label.toLowerCase()}` })),
    measured: [],
    warning: null,
  };
};

const LAYER_NAMES: Readonly<Record<LayerId, string>> = {
  process: "The program",
  socket: "The socket",
  tcp: "TCP",
  kube: "Kubernetes",
  nic: "The NIC",
};

export const layerName = (id: LayerId): string => LAYER_NAMES[id];

/** This function computes the whole path for the settings. */
export const requestPath = (settings: Settings): PathResult => {
  const tcp = tcpLayer(settings);
  const process = processLayer(settings, tcp);
  const socket = socketLayer(settings, tcp.layer, tcp.found);
  const kube = kubeLayer(settings);
  const nic = nicLayer(settings, tcp.layer);
  const layers = [process, socket, tcp.layer, kube, nic];
  const detecting = layers.filter((layer) => layer.verdict === "detects" && layer.band !== null && layer.id !== "socket");
  // on a tie, the lower layer finds the fault, and the program learns of it from that layer
  const below: Readonly<Record<LayerId, number>> = { nic: 0, tcp: 1, kube: 2, socket: 3, process: 4 };
  const sorted = [...detecting].sort((a, b) => valueIn(a.band!.low, "s") - valueIn(b.band!.low, "s") || below[a.id] - below[b.id]);
  const winner = sorted[0];
  const first = winner === undefined ? null : { layer: winner.id, band: winner.band! };
  const recovered = process.verdict === "recovers" ? process.band : null;
  let headline: string;
  if (settings.fault === "partition" && recovered !== null) {
    headline = `The request survives the partition: the reply comes at ${sayBand(recovered)}.`;
  } else if (first === null) {
    headline = "No layer finds this fault. The request waits forever.";
  } else if (process.verdict === "silent" && settings.inFlight) {
    headline = `${LAYER_NAMES[first.layer]} knows first, at ${sayBand(first.band)}. The program never learns of it: this call waits forever.`;
  } else {
    const next = sorted.find((layer) => valueIn(layer.band!.low, "s") > valueIn(first.band.low, "s"));
    headline = `${LAYER_NAMES[first.layer]} knows first, at ${sayBand(first.band)}.${next === undefined ? "" : ` ${LAYER_NAMES[next.id]} would know at ${sayBand(next.band!)}.`}`;
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
