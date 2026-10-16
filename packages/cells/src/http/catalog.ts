import type { KnobValues, Machine, Manifestation } from "@mark1russell7/algebra";
import { errnoOf, overValues, stackedDetection, timerOf, timerUnder, transitionOn } from "@mark1russell7/algebra";
import type { Fault, MiddleboxForm, Prediction, Reference } from "@mark1russell7/harness";
import type { Extent } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Spec } from "../catalog.ts";
import { HZ, LINUX, LINUX_66, RTT_MS, WINDOW, count, given, ms, predictAt, q, s, seconds } from "../catalog.ts";
import type { ManifestationName } from "../manifestations.ts";
import { MANIFESTATIONS } from "../manifestations.ts";
import { assuming } from "../rtt.ts";
import { CONNTRACK, LISTING, ROUTER_PUMP } from "../topologies.ts";
import type { GoSettings } from "./go-transport.ts";
import { GO_TRANSPORT } from "./go-transport.ts";
import type { AgentSettings } from "./node-agent.ts";
import { NODE_HTTP_AGENT } from "./node-agent.ts";
import type { NodeServerSettings } from "./node-server.ts";
import { NODE_HTTP_SERVER, hintOf } from "./node-server.ts";
import type { Decision, HttpClient, Interval, Ordering, Race, RequestOutcome } from "./race.ts";
import { DISPATCH, decide, gapOf, outcomeOf, poolExpiry, serverClose, timerInterval, valuesOf } from "./race.ts";
import type { UndiciSettings } from "./undici.ts";
import { UNDICI_CLIENT } from "./undici.ts";

/**
 * This module is the HTTP catalog. It holds the cells of T01 and T03 with the Node HTTP server at
 * the defaults stage, and the border cells of the keep-alive race. Each cell has the identifier of
 * the plan cell that it stands for. A cell that no plan cell names has none.
 *
 * Each cell has three parts: its spec, the prediction for the observed socket, and the outcome of
 * the second request. `cells.ts` makes each one a cell of the harness.
 */

/** This time is the time that a client takes to act on a FIN that arrived: an assumption of the cells, 1 ms. */
export const NOTICE = 0.001;

/** This time is how long a kept connection stays silent after the gap, in seconds: less than the wait of the client before its exit. */
const KEPT_AFTER = 0.2;

/** A workload is what the client does: two requests with a gap, a connection that stays idle, or a request into the fault. */
export type Workload =
  | { readonly mode: "gap"; readonly gap: number; readonly method: "GET" | "POST" }
  | { readonly mode: "idle" }
  | {
      readonly mode: "inflight";
      readonly method: "GET" | "POST";
      /** This time is how long the server holds the reply, in milliseconds (`/hold?ms=`). */
      readonly hold?: number;
      /** This length is the length of the reply body, in bytes (`/big?bytes=`). */
      readonly bytes?: number;
    };

/** A router is the router of a T03 cell: the form of a cloud preset, and its idle timeout in whole seconds. */
export interface HttpRouter {
  readonly preset: string;
  readonly form: MiddleboxForm;
  readonly idle: number;
}

/** A scale tells how a cell compresses the timers of its chain: one factor, and the reason. */
export interface Scale {
  readonly k: number;
  readonly why: string;
}

/** An HTTP spec is one cell of the HTTP catalog, before its prediction. */
export interface HttpSpec {
  readonly template: "T01" | "T03";
  /** This identifier is the plan cell that the cell stands for, or null. */
  readonly plan: string | null;
  readonly name: string;
  readonly client: HttpClient;
  readonly server: NodeServerSettings;
  readonly go?: GoSettings;
  readonly agent?: AgentSettings;
  readonly undici?: UndiciSettings;
  readonly workload: Workload;
  /** This fault is the fault of the harness. A race has none. The trigger `app-stall` is a held reply with no fault. */
  readonly fault: Fault;
  readonly manifestation?: ManifestationName;
  readonly observer?: "client" | "server";
  readonly icmp?: "host" | "net" | "port" | "admin";
  readonly drops?: "to-server" | "to-client";
  readonly mtu?: number;
  /** This time is the length of a stall, in seconds. */
  readonly stall?: number;
  /** These are the knobs of Linux TCP at the observer that differ from Linux 6.6. */
  readonly linux?: Readonly<Record<string, Extent>>;
  /** This delay is netem on the egress of the target, in milliseconds. */
  readonly latency?: number;
  readonly router?: HttpRouter;
  readonly scale?: Scale;
}

/** An HTTP cell is a spec with its prediction, the outcome of its second request, and what the prediction assumes. */
export interface HttpCell {
  readonly name: string;
  readonly plan: string | null;
  readonly spec: HttpSpec;
  readonly prediction: Prediction;
  /** This outcome is what the second request meets, or null for a workload with one request. */
  readonly request: RequestOutcome | null;
  /** This ordering is the ordering of a race, or null for a cell that is not a race. */
  readonly ordering: Ordering | null;
  readonly assumes: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// the settings that the cells share
// ---------------------------------------------------------------------------------------------

/**
 * These settings keep the keep-alive timer of the server out of the window of a fault cell: 60 s,
 * and S is 61 s. The FIN of the server then does not compete with the detection that the cell
 * measures. A race cell keeps the defaults of the server.
 */
const SERVER_OUT_OF_THE_WAY: NodeServerSettings = { keepAliveTimeout: 60_000 };

/** These knobs are the in-flight knobs of the T01 catalog: `tcp_retries2` at 3, thus a give-up in [3, 6.616] s. */
const IN_FLIGHT = { tcp_retries2: count(3) };

/** This server has a hint of 6 and closes at 6 s exactly: the server of the O01 border cells. */
const SERVER_HINT_6: NodeServerSettings = { keepAliveTimeout: 6000, keepAliveTimeoutBuffer: 0 };

/** This latency on the egress of the target makes the round trip 100 ms, thus a crossing window that the bounds of S fit in. */
const CROSSING_LATENCY = 100;

// ---------------------------------------------------------------------------------------------
// T01: the direct pair, a client and the Node HTTP server
// ---------------------------------------------------------------------------------------------

/** These are the race cells of T01: the defaults of the Go client, the borders of O01, and the borders of the hint. */
const T01_RACE: readonly HttpSpec[] = [
  // ---- T01.defaults.77: Go at its defaults, C = 90 s, against S = 6 s. Each ordering of the gap
  ...(
    [
      [3, "GET", undefined, "a GET 3 s after the reply"],
      [5.95, "GET", CROSSING_LATENCY, "a GET 5.95 s after the reply, 100 ms latency"],
      [5.95, "POST", CROSSING_LATENCY, "a POST 5.95 s after the reply, 100 ms latency"],
      [6.5, "GET", undefined, "a GET 6.5 s after the reply"],
      [6, "GET", undefined, "a GET 6 s after the reply"],
    ] as const
  ).map(
    ([gap, method, latency, name]): HttpSpec => ({
      template: "T01",
      plan: "T01.defaults.77",
      name: `go, ${name}`,
      client: "go",
      server: {},
      workload: { mode: "gap", gap, method },
      fault: "none",
      ...(latency === undefined ? {} : { latency }),
    }),
  ),
  // ---- the borders of O01 (C < S - margin), with the margin of 0.26 s that the plan binds at S = 6 s.
  // Inside: C = 5.5 s. Outside: C = 5.9 s. Each with a gap 50 ms before C and 50 ms after it
  ...(
    [
      ["T01.border-off.129", 5.5, "inside"],
      ["T01.border-off.130", 5.9, "outside"],
    ] as const
  ).flatMap(([plan, c, side]) =>
    [c - 0.05, c + 0.05].map(
      (gap): HttpSpec => ({
        template: "T01",
        plan,
        name: `go, IdleConnTimeout ${c} s (${side} O01), a GET ${round3(gap)} s after the reply`,
        client: "go",
        server: {},
        go: { IdleConnTimeout: c },
        workload: { mode: "gap", gap: round3(gap), method: "GET" },
        fault: "none",
      }),
    ),
  ),
  // the agent and undici take C from the hint, thus the server of these borders has a hint of 6 and S = 6 s
  ...(
    [
      ["T01.border-off.121", "agent", 500, 5.5, "inside"],
      ["T01.border-off.122", "agent", 100, 5.9, "outside"],
      ["T01.border-off.123", "undici", 500, 5.5, "inside"],
      ["T01.border-off.124", "undici", 100, 5.9, "outside"],
    ] as const
  ).flatMap(([plan, client, buffer, c, side]) =>
    [c - 0.05, c + 0.05].map(
      (gap): HttpSpec => ({
        template: "T01",
        plan,
        name:
          client === "agent"
            ? `agent, agentKeepAliveTimeoutBuffer ${buffer} ms against a hint of 6 (${side} O01), a GET ${round3(gap)} s after the reply`
            : `undici, keepAliveTimeoutThreshold ${buffer} ms against a hint of 6 (${side} O01), a GET ${round3(gap)} s after the reply`,
        client,
        server: SERVER_HINT_6,
        ...(client === "agent"
          ? { agent: { timeout: 10_000, agentKeepAliveTimeoutBuffer: buffer } }
          : { undici: { keepAliveTimeoutThreshold: buffer } }),
        workload: { mode: "gap", gap: round3(gap), method: "GET" },
        fault: "none",
      }),
    ),
  ),
  // ---- no plan cell: the agent and undici at their defaults, with a gap between C and S
  {
    template: "T01",
    plan: null,
    name: "agent, a GET 5 s after the reply, between C (4 s) and S (6 s)",
    client: "agent",
    server: {},
    workload: { mode: "gap", gap: 5, method: "GET" },
    fault: "none",
  },
  {
    template: "T01",
    plan: null,
    name: "undici, a GET 4 s after the reply, between C (3 s) and S (6 s)",
    client: "undici",
    server: {},
    workload: { mode: "gap", gap: 4, method: "GET" },
    fault: "none",
  },
  // ---- no plan cell: the hint at or below the buffer of the client, thus no reuse (DV-10)
  {
    template: "T01",
    plan: null,
    name: "agent, keepAliveTimeout 1500 ms (a hint of 1), a GET 1 s after the reply",
    client: "agent",
    server: { keepAliveTimeout: 1500 },
    workload: { mode: "gap", gap: 1, method: "GET" },
    fault: "none",
  },
  {
    template: "T01",
    plan: null,
    name: "undici, keepAliveTimeout 2500 ms (a hint of 2), a GET 1 s after the reply",
    client: "undici",
    server: { keepAliveTimeout: 2500 },
    workload: { mode: "gap", gap: 1, method: "GET" },
    fault: "none",
  },
];

/** These are the fault cells of T01 that the plan pairs with the Node HTTP server at the defaults stage. */
const T01_FAULTS: readonly HttpSpec[] = [
  {
    template: "T01",
    plan: "T01.defaults.4",
    name: "go, a GET in flight, unreachable-host, tcp_retries2 = 3",
    client: "go",
    server: SERVER_OUT_OF_THE_WAY,
    workload: { mode: "inflight", method: "GET" },
    fault: "unreachable",
    manifestation: "unreachable-host",
    icmp: "host",
    linux: IN_FLIGHT,
  },
  {
    template: "T01",
    plan: "T01.defaults.30",
    name: "agent idle, fin",
    client: "agent",
    server: SERVER_OUT_OF_THE_WAY,
    workload: { mode: "idle" },
    fault: "fin",
    manifestation: "fin",
  },
  {
    template: "T01",
    plan: "T01.defaults.30",
    name: "agent, a held reply in flight, fin",
    client: "agent",
    server: SERVER_OUT_OF_THE_WAY,
    workload: { mode: "inflight", method: "GET", hold: 5000 },
    fault: "fin",
    manifestation: "fin",
  },
  {
    template: "T01",
    plan: "T01.defaults.34",
    name: "undici, a GET in flight, freeze-process, headersTimeout 10 s",
    client: "undici",
    server: SERVER_OUT_OF_THE_WAY,
    undici: { headersTimeout: 10_000 },
    workload: { mode: "inflight", method: "GET" },
    fault: "freeze-process",
    manifestation: "freeze-process",
    scale: {
      k: 30,
      why: "headersTimeout is 300 s at its default. At 10 s it stays above each other timer of the cell, and below the kernel keepalive of 70 s, which a frozen kernel answers",
    },
  },
  {
    template: "T01",
    plan: "T01.defaults.76",
    name: "go, a GET in flight, a 1 s stall",
    client: "go",
    server: SERVER_OUT_OF_THE_WAY,
    workload: { mode: "inflight", method: "GET" },
    fault: "stall",
    manifestation: "blackhole",
    stall: 1,
  },
  {
    template: "T01",
    plan: "T01.defaults.79",
    name: "go, a GET in flight, rst",
    client: "go",
    server: SERVER_OUT_OF_THE_WAY,
    workload: { mode: "inflight", method: "GET" },
    fault: "rst",
    manifestation: "blackhole",
    linux: IN_FLIGHT,
  },
  {
    template: "T01",
    plan: "T01.defaults.80",
    name: "go, app-stall: a reply that the server holds for 60 s",
    client: "go",
    server: SERVER_OUT_OF_THE_WAY,
    workload: { mode: "inflight", method: "GET", hold: 60_000 },
    fault: "app-stall",
    manifestation: "freeze-process",
  },
  {
    template: "T01",
    plan: "T01.defaults.146",
    name: "agent, a GET in flight, unreachable-host, tcp_retries2 = 3",
    client: "agent",
    server: SERVER_OUT_OF_THE_WAY,
    workload: { mode: "inflight", method: "GET" },
    fault: "unreachable",
    manifestation: "unreachable-host",
    icmp: "host",
    linux: IN_FLIGHT,
  },
];

// ---------------------------------------------------------------------------------------------
// T03: the client, a NAT router in a cloud form, and the Node HTTP server
// ---------------------------------------------------------------------------------------------

/** These are the forms of the plan for the router of T03, each with its idle timeout at real scale. */
export const ROUTER_PRESETS = {
  aws: { preset: "AWS NAT/NLB form (350 s, RST to the next sender)", form: "reset-next", idle: 350 },
  azureNat: { preset: "Azure NAT form (240 s, silent, then a one-way RST)", form: "reset-next", idle: 240 },
  azureLb: { preset: "Azure LB with TCP reset (240 s, RST to both ends at expiry)", form: "reset-both", idle: 240 },
  gcp: { preset: "GCP firewall form (600 s, forget, later packets dropped)", form: "silent-drop", idle: 600 },
  plain: { preset: "a plain conntrack router", form: "none", idle: 432_000 },
} as const satisfies Readonly<Record<string, HttpRouter>>;

/** This function gives a router with its idle timeout divided by `k`, in whole seconds as conntrack counts it. */
const scaled = (router: HttpRouter, k: number): HttpRouter => ({ ...router, idle: Math.floor(router.idle / k) });

/** These are the T03 cells that the plan pairs with the Node HTTP server at the defaults stage. */
const T03_SPECS: readonly HttpSpec[] = [
  {
    template: "T03",
    plan: "T03.defaults.12",
    name: "server, a long reply to a go GET, mtu-blackhole at the router toward the client, tcp_retries2 = 3",
    client: "go",
    server: SERVER_OUT_OF_THE_WAY,
    workload: { mode: "inflight", method: "GET", bytes: 2_000_000 },
    fault: "mtu-blackhole",
    manifestation: "mtu-blackhole",
    observer: "server",
    mtu: 1200,
    linux: IN_FLIGHT,
    router: ROUTER_PRESETS.azureNat,
  },
  {
    template: "T03",
    plan: "T03.defaults.24",
    name: "agent, a GET 14 s after the reply, the router idle 12 s",
    client: "agent",
    server: {},
    workload: { mode: "gap", gap: 14, method: "GET" },
    fault: "middlebox-forget",
    router: scaled(ROUTER_PRESETS.gcp, 50),
    scale: {
      k: 50,
      why: "only the router: 600 s to 12 s. The timers of the agent and the server keep their real values and their sequence: 1 s keepalive, C 4 s, S 6 s, keepalive window 11 s, then 12 s",
    },
  },
  {
    template: "T03",
    plan: "T03.defaults.30",
    name: "go, a GET in flight, rst at the router toward the client",
    client: "go",
    server: SERVER_OUT_OF_THE_WAY,
    workload: { mode: "inflight", method: "GET" },
    fault: "rst",
    manifestation: "blackhole",
    linux: IN_FLIGHT,
    router: ROUTER_PRESETS.aws,
  },
  {
    template: "T03",
    plan: "T03.defaults.33",
    name: "go, a GET in flight, a 1 s stall at the router toward the client",
    client: "go",
    server: SERVER_OUT_OF_THE_WAY,
    workload: { mode: "inflight", method: "GET" },
    fault: "stall",
    manifestation: "blackhole",
    stall: 1,
    router: ROUTER_PRESETS.azureLb,
  },
  {
    template: "T03",
    plan: "T03.defaults.37",
    name: "undici, a GET in flight, unreachable-host at the router toward the client, tcp_retries2 = 3",
    client: "undici",
    server: SERVER_OUT_OF_THE_WAY,
    workload: { mode: "inflight", method: "GET" },
    fault: "unreachable",
    manifestation: "unreachable-host",
    icmp: "host",
    linux: IN_FLIGHT,
    router: ROUTER_PRESETS.plain,
  },
  {
    template: "T03",
    plan: "T03.defaults.62",
    name: "go, a GET 25 s after the reply, all timers scaled by 15",
    client: "go",
    server: { keepAliveTimeout: 333, keepAliveTimeoutBuffer: 67 },
    go: { IdleConnTimeout: 6, KeepAlive: 2, KeepAliveInterval: 1 },
    workload: { mode: "gap", gap: 25, method: "GET" },
    fault: "middlebox-forget",
    router: scaled(ROUTER_PRESETS.aws, 15),
    scale: {
      k: 15,
      why: "each timer of the chain: S 6 s to 0.4 s, Go keepalive 30 s and 15 s to 2 s and 1 s, C 90 s to 6 s, the router 350 s to 23 s. Their sequence stays, and Go ignores the hint of the server",
    },
  },
  {
    template: "T03",
    plan: "T03.defaults.63",
    name: "go idle, blackhole at the router toward the client, Go timers scaled by 10",
    client: "go",
    server: SERVER_OUT_OF_THE_WAY,
    go: { IdleConnTimeout: 9, KeepAlive: 3, KeepAliveInterval: 1.5 },
    workload: { mode: "idle" },
    fault: "blackhole",
    manifestation: "blackhole",
    router: ROUTER_PRESETS.aws,
    scale: {
      k: 10,
      why: "the Go timers: C 90 s to 9 s, keepalive 30 s and 15 s to 3 s and 1.5 s, which Go rounds up to 2 s. C stays below the keepalive window (21 s), as 90 s is below 165 s",
    },
  },
  {
    template: "T03",
    plan: "T03.defaults.63",
    name: "go, a GET in flight, blackhole at the router toward the client, tcp_retries2 = 3, DialTimeout 3 s",
    client: "go",
    server: SERVER_OUT_OF_THE_WAY,
    go: { DialTimeout: 3 },
    workload: { mode: "inflight", method: "GET" },
    fault: "blackhole",
    manifestation: "blackhole",
    linux: IN_FLIGHT,
    router: ROUTER_PRESETS.aws,
    scale: { k: 10, why: "DialTimeout 30 s to 3 s, for the retry that dials into the black hole. It stays below the SYN give-up of 127 s" },
  },
  {
    template: "T03",
    plan: "T03.defaults.64",
    name: "go, a GET in flight, simplex-to-server at the router toward the client, tcp_retries2 = 3, DialTimeout 3 s",
    client: "go",
    server: SERVER_OUT_OF_THE_WAY,
    go: { DialTimeout: 3 },
    workload: { mode: "inflight", method: "GET" },
    fault: "simplex",
    manifestation: "simplex-to-server",
    drops: "to-server",
    linux: IN_FLIGHT,
    router: ROUTER_PRESETS.aws,
    scale: { k: 10, why: "DialTimeout 30 s to 3 s, for the retry whose SYN the partition drops" },
  },
  {
    template: "T03",
    plan: "T03.defaults.65",
    name: "go idle, fin",
    client: "go",
    server: SERVER_OUT_OF_THE_WAY,
    workload: { mode: "idle" },
    fault: "fin",
    manifestation: "fin",
    router: ROUTER_PRESETS.aws,
  },
];

/** These are the specs of the HTTP catalog: T01, then T03. */
export const HTTP_SPECS: readonly HttpSpec[] = [...T01_RACE, ...T01_FAULTS, ...T03_SPECS];

// ---------------------------------------------------------------------------------------------
// the calibration of the handling time of the Node clients
// ---------------------------------------------------------------------------------------------

/**
 * This count is the number of copies of each calibration of the handling time. The speed of a
 * runner changes the handling time. Thus each copy goes to a runner of its own when the cells have
 * as many shards.
 */
export const HANDLING_COPIES = 4;

/** This text tells what a calibration cell of the handling time measures. */
const HANDLING_WHY =
  "a calibration: the time from the last segment of the first reply to the close by a pool timer of 1 ms. The timer fires after its arm, thus this time is more than the handling time";

/**
 * These are the calibration specs of the handling time of the agent and undici (`race.ts`). The
 * server gives a hint of 6, and the client takes 5999 ms off it. Thus the pool timer of the client
 * is 1 ms. The timer fires after its arm. Thus the time from the last segment to the close is the
 * handling time of the reply and a part of the timer.
 */
export const HANDLING_CAL_SPECS: readonly HttpSpec[] = (["agent", "undici"] as const).flatMap((client) =>
  Array.from(
    { length: HANDLING_COPIES },
    (_, at): HttpSpec => ({
      template: "T01",
      plan: "CAL",
      name:
        client === "agent"
          ? `agent, the handling of the first reply: a free socket timer of 1 ms (${at + 1} of ${HANDLING_COPIES})`
          : `undici, the handling of the first reply: a keep-alive timer of 1 ms (${at + 1} of ${HANDLING_COPIES})`,
      client,
      server: SERVER_HINT_6,
      ...(client === "agent"
        ? { agent: { timeout: 10_000, agentKeepAliveTimeoutBuffer: 5999 } }
        : { undici: { keepAliveTimeoutThreshold: 5999 } }),
      workload: { mode: "gap", gap: 1, method: "GET" },
      fault: "none",
    }),
  ),
);

// ---------------------------------------------------------------------------------------------
// the predictions
// ---------------------------------------------------------------------------------------------

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** This function gives the document of a client, and the values of its knobs for a spec. */
const clientSide = (spec: HttpSpec): { doc: Machine; values: KnobValues } => {
  const hint = hintOf(spec.server);
  if (spec.client === "go") {
    // a value of 0 is no timer for these knobs of Go: no bound
    const go = { ...spec.go, Timeout: spec.go?.Timeout || "infinite", ResponseHeaderTimeout: "infinite" };
    return { doc: GO_TRANSPORT, values: valuesOf(GO_TRANSPORT, go) };
  }
  if (spec.client === "agent") return { doc: NODE_HTTP_AGENT, values: valuesOf(NODE_HTTP_AGENT, { ...spec.agent, hint: hint ?? "infinite" }) };
  return { doc: UNDICI_CLIENT, values: valuesOf(UNDICI_CLIENT, { ...spec.undici, hint: hint ?? "infinite" }) };
};

/** This function gives the values of the server document for a spec: a keep-alive timeout or a socket timeout of 0 is no bound. */
const serverSide = (spec: HttpSpec): KnobValues => {
  const settings = spec.server;
  return valuesOf(NODE_HTTP_SERVER, {
    ...settings,
    keepAliveTimeout: settings.keepAliveTimeout === 0 ? "infinite" : settings.keepAliveTimeout,
    timeout: settings.timeout ? settings.timeout : "infinite",
  });
};

/** These are the states of each document where the connection is idle in the pool, and where a request owns it. */
const STATES: Readonly<Record<HttpClient, { idle: string; busy: string }>> = {
  go: { idle: "IDLE", busy: "ACTIVE" },
  agent: { idle: "FREE", busy: "BUSY" },
  undici: { idle: "IDLE", busy: "BUSY" },
};

/** This function gives the values of Linux TCP at the observer of a spec, at a round trip in ms. */
const linuxValues = (spec: HttpSpec, rttMs: number): Record<string, Extent> => ({
  ...LINUX_66,
  ...spec.linux,
  hz: { value: HZ, unit: "Hz" },
  rtt: ms(rttMs),
});

/** This function gives the round trip of a spec that the models read, in ms: the Docker network and the latency. */
const nominalRtt = (spec: HttpSpec): number => RTT_MS + (spec.latency ?? 0);

/** This function gives the event that arms a timer of Linux TCP, as the reference of a measurement. */
const linuxReference = (timer: string): Reference => {
  const arms = LINUX.timers[timer]?.arms ?? [];
  if (arms.includes("tx.retransmit.first")) return "first-retransmission";
  return "last-received";
};

/** This function gives the T01 spec that a fault cell is to Linux TCP: the same manifestation and knobs, for the stall. */
const asLinuxSpec = (spec: HttpSpec): Spec => ({
  name: spec.name,
  fault: spec.fault,
  manifestation: spec.manifestation ?? "blackhole",
  observer: spec.observer ?? "client",
  mode: spec.workload.mode === "idle" ? "idle" : "inflight",
  ...(spec.linux === undefined ? {} : { linux: spec.linux }),
  ...(spec.stall === undefined ? {} : { stall: spec.stall }),
});

/**
 * This function gives the prediction of a fault cell for its observed socket, at a round trip in
 * ms. It composes the document of the client, or of the server, over Linux TCP
 * (`stackedDetection`). Thus the keepalive of Go or the `keepAliveMsecs` of the agent is the
 * keepalive of the kernel. A timer of the client competes with the timers of the kernel.
 */
const predictFaultAt = (spec: HttpSpec, rttMs: number): Prediction => {
  const rtt = rttMs / 1000;
  if (spec.fault === "stall") return predictAt(asLinuxSpec(spec), rttMs);
  if (spec.fault === "rst")
    return {
      detects: true,
      timer: "rx.rst",
      errno: transitionOn(LINUX, "ESTABLISHED", "rx.rst")?.errno ?? "ECONNRESET",
      from: "request-sent",
      low: q(0),
      high: q(rtt),
    };
  const server = spec.observer === "server";
  const side = server ? { doc: NODE_HTTP_SERVER, values: serverSide(spec) } : clientSide(spec);
  const inFlight = spec.workload.mode !== "idle";
  const state = server ? "HANDLING" : inFlight ? STATES[spec.client].busy : STATES[spec.client].idle;
  const manifestation: Manifestation = MANIFESTATIONS[spec.manifestation ?? "blackhole"];
  const linux = given(linuxValues(spec, rttMs));
  const found = stackedDetection(side.doc, LINUX, { state, inFlight }, manifestation, side.values, linux);
  const [delivered] = found.delivered;
  if (delivered !== undefined)
    return { detects: true, timer: delivered.event, errno: delivered.errno ?? "EOF", from: "peer-closed", low: q(0), high: q(rtt) };
  if (found.unsettled.length > 0) throw new Error(`${spec.name}: a live detector has no time: ${found.unsettled.join(", ")}`);
  if (found.first === null) return { detects: false, window: q(WINDOW) };
  const { timer, fires, beneath } = found.first;
  if (beneath !== undefined) {
    const values = overValues(side.doc, side.values, linux);
    const bounds = timerUnder(LINUX, timer, values, manifestation);
    const duration = seconds(bounds.duration, timer);
    return {
      detects: true,
      timer,
      errno: errnoOf(LINUX, "ESTABLISHED", { timer, fires }, manifestation) ?? "ETIMEDOUT",
      from: linuxReference(timer),
      low: q(duration - seconds(bounds.early, `${timer}'s early bound`)),
      high: q(duration + seconds(bounds.lateness, `${timer}'s lateness`)),
    };
  }
  // a timer of the client itself: its band from its own document
  const band = timerInterval(side.doc, timer, side.values);
  const taken = transitionOn(side.doc, state, fires);
  return {
    detects: true,
    timer,
    errno: taken?.errno ?? (taken?.emits?.includes("tx.fin") === true ? "CLOSED" : "ETIMEDOUT"),
    from: side.doc.timers[timer]!.arms.includes("tx.request") ? "request-sent" : "last-received",
    low: q(band.low),
    high: q(band.high),
  };
};

/** This function gives what the SYN of a new connection meets in a fault: the errno of the dial. */
const dialErrno = (spec: HttpSpec): string => {
  if (spec.fault === "rst") return transitionOn(GO_TRANSPORT, "DIALING", "rx.rst")?.errno ?? "ECONNREFUSED";
  if (spec.fault === "unreachable") return transitionOn(GO_TRANSPORT, "DIALING", "rx.icmp-hard")?.errno ?? "EHOSTUNREACH";
  // a black hole, or a partition in either direction: the dial waits for its timer
  return transitionOn(GO_TRANSPORT, "DIALING", "timer.dial")?.errno ?? "TIMEOUT";
};

/**
 * This function gives the outcome of the second request of a fault cell. It is the request that
 * goes into the fault, on the connection of the first one.
 * - A held reply that nothing ends stays pending in the window.
 * - A timer of the client gives its own errno, and the kernel gives the errno of its detection.
 * - Go sends a GET again on a new connection after a failure before the reply (`gt.retry`). The
 *   new connection meets the fault with its SYN.
 */
const faultOutcome = (spec: HttpSpec, prediction: Prediction): RequestOutcome | null => {
  if (spec.workload.mode !== "inflight") return null;
  if (spec.observer === "server" || spec.fault === "stall")
    return spec.fault === "stall" ? { connection: "reused", retried: false, error: null } : { connection: "reused", retried: false, error: null, pending: true };
  if (prediction.detects !== true) return { connection: "reused", retried: false, error: null, pending: true };
  const own = prediction.timer in (spec.client === "go" ? GO_TRANSPORT : spec.client === "agent" ? NODE_HTTP_AGENT : UNDICI_CLIENT).timers;
  if (own) return { connection: "reused", retried: false, error: prediction.errno };
  if (spec.client === "go" && spec.workload.method === "GET")
    return { connection: "reused", retried: true, error: dialErrno(spec) };
  // the agent and undici give the caller the error of the socket: socket hang up for an end of file
  const error =
    prediction.errno === "EOF"
      ? spec.client === "agent"
        ? (transitionOn(NODE_HTTP_AGENT, "BUSY", "rx.fin")?.errno ?? "ECONNRESET")
        : (transitionOn(UNDICI_CLIENT, "BUSY", "rx.fin")?.errno ?? "UND_ERR_SOCKET")
      : prediction.errno;
  return { connection: "reused", retried: false, error };
};

/** This function gives the round trip interval of a race, in seconds, from a round trip in ms that the models read. */
const rttInterval = (spec: HttpSpec, rttMs: number): Interval =>
  spec.latency === undefined ? { low: 0, high: rttMs / 1000 } : { low: spec.latency / 1000, high: rttMs / 1000 };

/** This function gives the race of a gap cell at a round trip in ms. */
export const raceOf = (spec: HttpSpec, rttMs = nominalRtt(spec)): Race => {
  if (spec.workload.mode !== "gap") throw new Error(`${spec.name} is not a race`);
  const hint = hintOf(spec.server);
  const settings = spec.client === "go" ? (spec.go ?? {}) : spec.client === "agent" ? (spec.agent ?? {}) : (spec.undici ?? {});
  return {
    gap: gapOf(spec.client, spec.workload.gap),
    server: serverClose(spec.server),
    pool: poolExpiry(spec.client, settings, hint),
    rtt: rttInterval(spec, rttMs),
    notice: NOTICE,
  };
};

/** This function gives the timer of a client that closes an idle connection: its pool expiry. */
const POOL_TIMER: Readonly<Record<HttpClient, string>> = { go: "idle_conn", agent: "free_socket", undici: "keep_alive" };

/**
 * This function gives the prediction of a race for the socket of its first connection, at a round
 * trip in ms. That socket meets one end first:
 * - `kept`: nothing in the window. The second request goes on it.
 * - `fin-first` and `crossed`: the FIN of the server at S, an end of file from the last received segment.
 * - `dropped`: the close of the client itself at C, from the last received segment.
 */
const predictRaceAt = (spec: HttpSpec, rttMs: number): { prediction: Prediction; decision: Decision } => {
  const race = raceOf(spec, rttMs);
  const decision = decide(race);
  const gap = (spec.workload as { gap: number }).gap;
  if ("border" in decision)
    return {
      decision,
      prediction: {
        detects: null,
        window: q(gap + 2),
        why: `its ordering is a distribution: ${decision.border}`,
        from: "last-received",
      },
    };
  // the window ends before the client closes its sockets at its exit, a second after its last request
  if (decision.ordering === "kept") return { decision, prediction: { detects: false, window: q(gap + KEPT_AFTER) } };
  if (decision.ordering === "dropped") {
    const { doc, values } = clientSide(spec);
    const band =
      race.pool !== null && race.pool.high === 0
        ? { low: 0, high: DISPATCH }
        : spec.client === "go"
          ? timerInterval(doc, POOL_TIMER.go, values)
          : race.pool!;
    return {
      decision,
      prediction: { detects: true, timer: POOL_TIMER[spec.client], errno: "CLOSED", from: "last-received", low: q(band.low), high: q(band.high) },
    };
  }
  const server = race.server!;
  return {
    decision,
    prediction: { detects: true, timer: "keep_alive", errno: "EOF", from: "last-received", low: q(server.low), high: q(server.high) },
  };
};

/** This time is how far the search of a range of round trips goes, in ms. An ordering that holds that far does not read the round trip. */
const REACH = 1000;

/**
 * This function gives the range of round trips, in ms, where a race keeps its ordering, by
 * bisection to 1 µs. It gives null for a border, and for an ordering that holds from 0 to `REACH`:
 * such an ordering does not read the round trip.
 */
export const raceRtt = (spec: HttpSpec): { low: number; high: number } | null => {
  const nominal = decide(raceOf(spec));
  if ("border" in nominal) return null;
  const at = (rttMs: number): boolean => {
    const race = raceOf(spec, rttMs);
    const point = { low: rttMs / 1000, high: rttMs / 1000 };
    const decision = decide({ ...race, rtt: point });
    return "ordering" in decision && decision.ordering === nominal.ordering;
  };
  const middle = nominalRtt(spec);
  const edge = (from: number, to: number): number => {
    if (at(to)) return to;
    let [good, bad] = [from, to];
    while (Math.abs(bad - good) > 0.001) {
      const half = (good + bad) / 2;
      if (at(half)) good = half;
      else bad = half;
    }
    return good;
  };
  const range = { low: round3(edge(middle, 0)), high: round3(edge(middle, REACH)) };
  return range.low === 0 && range.high === REACH ? null : range;
};

/** This function gives the window of a router forget, in seconds: expire_established at the idle of the router. */
const forgetLow = (router: HttpRouter): number => {
  const values = given({
    nf_conntrack_tcp_timeout_established: s(router.idle),
    gc_lag_max: s(valueIn(ROUTER_PUMP, "s") + 2 * valueIn(LISTING, "s")),
  });
  const bounds = timerOf(CONNTRACK, "expire_established", values);
  return seconds(bounds.duration, "expire_established") - seconds(bounds.early, "the early bound of the forget");
};

/** This function gives the latest time that a prediction waits, in seconds. */
const windowOf = (prediction: Prediction): number =>
  prediction.detects === true
    ? valueIn(prediction.high, "s")
    : prediction.detects === false && prediction.recovers !== undefined
      ? valueIn(prediction.recovers.high, "s")
      : valueIn(prediction.window, "s");

/** This function gives the cell of a spec: its prediction, the outcome of its second request, and its assumptions. */
export const httpCellOf = (spec: HttpSpec): HttpCell => {
  const name = `${spec.plan ?? spec.template} ${spec.name}`;
  const assumes: string[] = [];
  if (spec.workload.mode === "gap") {
    const { prediction, decision } = predictRaceAt(spec, nominalRtt(spec));
    const range = raceRtt(spec);
    assumes.push(
      `the client takes at most ${DISPATCH * 1000} ms from its call to the write of the request`,
      `the client acts on a FIN within ${NOTICE * 1000} ms`,
    );
    if (range !== null) assumes.push(`the round trip is in [${range.low}, ${range.high}] ms`);
    const ordering = "ordering" in decision ? decision.ordering : null;
    const request = ordering === null ? null : outcomeOf(spec.client, ordering, spec.workload.method);
    const withRtt: Prediction =
      prediction.detects === null || range === null
        ? prediction
        : { ...prediction, rtt: { low: ms(range.low), high: ms(range.high) } };
    if (spec.router !== undefined) {
      // the router must not forget a flow that the chain still holds: the connection ends first,
      // at the FIN of the server or at the close of the pool, and the gap goes past the forget
      const race = raceOf(spec);
      const end =
        ordering === "fin-first" ? race.server?.high : ordering === "dropped" ? race.pool?.high : undefined;
      const forget = forgetLow(spec.router);
      if (end === undefined || end + NOTICE >= forget || race.gap.low <= forget)
        throw new Error(`${name}: the connection can be open when the router forgets it, or the gap ends first`);
    }
    return { name, plan: spec.plan, spec, prediction: withRtt, request, ordering, assumes };
  }
  const prediction = assuming((rtt) => predictFaultAt(spec, rtt), nominalRtt(spec));
  if (spec.router !== undefined && windowOf(prediction) + 1 >= forgetLow(spec.router))
    throw new Error(`${name}: the router can forget the flow in the window of the cell`);
  return { name, plan: spec.plan, spec, prediction, request: faultOutcome(spec, prediction), ordering: null, assumes };
};

/** These are the cells of the HTTP catalog. */
export const HTTP_CELLS: readonly HttpCell[] = HTTP_SPECS.map(httpCellOf);

/**
 * These are the calibration cells of the handling time. Each one is the race of its spec, with a
 * measurement in place of its band. It measures the time from the last received segment to the
 * close.
 */
export const HTTP_CAL: readonly HttpCell[] = HANDLING_CAL_SPECS.map((spec) => ({
  ...httpCellOf(spec),
  prediction: { detects: null, window: q((spec.workload as { gap: number }).gap + 2), why: HANDLING_WHY, from: "last-received" },
}));

// ---------------------------------------------------------------------------------------------
// the plan cells with the Node HTTP server that the catalog does not run
// ---------------------------------------------------------------------------------------------

/** A waiting cell is a plan cell whose trigger the harness cannot do yet, with what it needs. */
export interface Waiting {
  readonly plan: string;
  readonly client: string;
  readonly trigger: string;
  readonly why: string;
}

/** These are the plan cells of the defaults stage whose trigger waits for the harness. */
export const HTTP_WAITING: readonly Waiting[] = [
  {
    plan: "T01.defaults.78",
    client: "go",
    trigger: "event:server-restart-same-ip",
    why: "it needs a restart of the target with the same address and a new network namespace, while the client keeps its socket, and a prober that follows the new namespace",
  },
  {
    plan: "T01.defaults.81",
    client: "go",
    trigger: "timed:mid-commit",
    why: "it needs an injector that matches the bytes of a reply (NFQUEUE or a string match) to cut the connection at a state of the protocol",
  },
  {
    plan: "T01.defaults.82",
    client: "go",
    trigger: "in-process:event-loop",
    why: "it needs the event loop of the server blocked on purpose: a request to the server script that blocks its loop, and a fault of the harness that sends it at the time of the fault",
  },
  {
    plan: "T01.defaults.83",
    client: "go",
    trigger: "workload:write-write-read",
    why: "it needs a client that writes the headers and the body of a request in two writes with TCP_NODELAY off, and a Linux TCP document with the delayed ACK and Nagle",
  },
];

/** An out-of-scope cell is a plan cell of a client that this step does not build: Apache HttpClient 5 or the AWS SDK. */
export interface OutOfScope {
  readonly plan: string;
  readonly client: string;
  readonly trigger: string;
}

/** These are the plan cells with the Node HTTP server for Apache HttpClient 5 and the AWS SDK, at the defaults and border stages. */
export const HTTP_OUT_OF_SCOPE: readonly OutOfScope[] = [
  { plan: "T01.defaults.20", client: "apache-httpclient-5", trigger: "blackhole" },
  { plan: "T01.border-off.133", client: "apache-httpclient-5", trigger: "O01 inside" },
  { plan: "T01.border-off.134", client: "apache-httpclient-5", trigger: "O01 outside" },
  { plan: "T01.defaults.24", client: "aws-sdk-v3-node-http-handler", trigger: "rst" },
  { plan: "T01.border-off.135", client: "aws-sdk-v3-node-http-handler", trigger: "O01 inside" },
  { plan: "T01.border-off.136", client: "aws-sdk-v3-node-http-handler", trigger: "O01 outside" },
];

/** A later cell is a border cell of another rule than the keep-alive race, for a later step. */
export interface Later {
  readonly plan: string;
  readonly rule: string;
  readonly why: string;
}

/** These are the T01 border cells with the Node HTTP server whose rule is not the keep-alive race (O01). */
export const HTTP_LATER: readonly Later[] = [
  { plan: "T01.border-off.143", rule: "O02", why: "the pool of an ALB stand-in in front of the server: a proxy, which T02 holds" },
  { plan: "T01.border-off.144", rule: "O02", why: "the pool of an ALB stand-in in front of the server: a proxy, which T02 holds" },
  { plan: "T01.border-off.169", rule: "O03", why: "the idle close of the server against a 240 s balancer: DV-12, not DV-08" },
  { plan: "T01.border-off.170", rule: "O03", why: "the idle close of the server against a 240 s balancer: DV-12, not DV-08" },
  { plan: "T01.border-off.201", rule: "O15", why: "a startup budget against the connect bound of Go" },
  { plan: "T01.border-off.202", rule: "O15", why: "a startup budget against the connect bound of Go" },
  { plan: "T01.border-off.223", rule: "O23", why: "the deadlines of Go in layers: Client.Timeout over the dialer" },
  { plan: "T01.border-off.224", rule: "O23", why: "the deadlines of Go in layers: Client.Timeout over the dialer" },
];
