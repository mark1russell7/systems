/**
 * The settings of the path of one request, and the values that the machine documents read from them.
 * Each lens of the path (`./lenses/`) reads these settings. A knob has one name in all lenses, thus the
 * key of a setting is the name of its knob.
 *
 * The documents are Linux TCP, conntrack, the call of the program with a deadline, and the readiness
 * probe of the kubelet, from `@mark1russell7/machines`.
 */
import { firings, timerBand, type KnobValues, type Manifestation, type TimerBounds } from "@mark1russell7/algebra";
import { LINUX_TCP, MANIFESTATIONS, NF_CONNTRACK_TCP } from "@mark1russell7/machines";
import { quantity, valueIn, type Extent, type Quantity } from "@mark1russell7/quantity";
import { bandOf, finite, type Band, type Lane } from "./lens.ts";

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

/** The lanes of the path, from the program down to the NIC. */
export type LayerId = "process" | "socket" | "tcp" | "kube" | "nic";

/** The lane of one layer of the path. */
export type LayerResult = Lane<LayerId>;

export const s = (value: number): Quantity => quantity(value, "s");
export const ms = (value: number): Quantity => quantity(value, "ms");
export const count = (n: number): Quantity => quantity(n, "count");
export const ZERO = s(0);
export const atLeast = (a: Quantity, b: Quantity): boolean => valueIn(a, "s") >= valueIn(b, "s");
export const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

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
// the values of the knobs of each machine document
// ---------------------------------------------------------------------------------------------

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

export const callValues =
  (settings: Settings): KnobValues =>
  (name) =>
    ({ timeout: settings.timeout, backoff: settings.backoff, backoff_cap: settings.backoffCap })[name];

export const probeValues =
  (settings: Settings): KnobValues =>
  (name) =>
    ({ period: settings.period, threshold: count(settings.threshold), timeout: settings.probeTimeout })[name];

export const conntrackValues =
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
// the timers
// ---------------------------------------------------------------------------------------------

/** This function gives the band of a timer from `timerBand` of the algebra. If an end of the band is not a known time, it gives null. */
export const bandOfTimer = (bounds: TimerBounds): Band | null => {
  const band = timerBand(bounds);
  return "unknown" in band || !finite(band.low) || !finite(band.high) ? null : bandOf(band.low, band.high);
};

/** This function gives the times of the firings of the retransmission timer from the send, up to `until` or 24 firings. */
export const rtoFirings = (settings: Settings, until: Quantity): Quantity[] =>
  firings(LINUX_TCP, "retransmit", tcpValues(settings), { count: 24, until }).map((firing) => firing.at);

/** This function gives the time of the first retransmission of the RTO timer from the send: the second firing, after the loss probe. */
export const firstRetransmission = (settings: Settings): Quantity =>
  firings(LINUX_TCP, "retransmit", tcpValues(settings), { count: 2 })[1]?.at ?? ZERO;
