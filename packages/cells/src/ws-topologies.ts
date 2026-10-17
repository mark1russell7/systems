import { overValues, transitionOn } from "@mark1russell7/algebra";
import type { Cell, MiddleboxForm, Prediction } from "@mark1russell7/harness";
import { LINUX_TCP, NF_CONNTRACK_TCP, PROCEDURES_WS_CLIENT } from "@mark1russell7/machines";
import { RTT_MS, RUNS, WINDOW, given, q, sysctlsOf } from "./catalog.ts";
import type { Span } from "./mongo/model.ts";
import { plus, spanOf } from "./mongo/model.ts";
import { assuming } from "./rtt.ts";
import { PROXY_SYSCTLS } from "./t02.ts";
import { IDLE, routerValues } from "./t03.ts";
import type { O03Verdict } from "./topologies.ts";
import { ackDelay, haproxy, o03, router } from "./topologies.ts";
import type { WsClientSettings, WsSpec } from "./ws.ts";
import { CLIENT, HEARTBEAT, QUIET, QUIET_SERVER, clientValues, linuxValues, predictWsAt, probeOf, reconnectsOf, wsServer } from "./ws.ts";

/**
 * This module is the WST catalog: the WebSocket client of `@procedures/client` 0.3.0 through a
 * topology. The router of T03 forgets an idle flow at 5 s, and HAProxy of T02 closes an idle
 * connection at its own timeouts. The client and the server are the client and the server of the
 * WS catalog, with the same documents and settings.
 */

/** These are the times of a heartbeat below the idle timeout of the hop: a ping each 4 s, against 5 s. */
const BELOW = { interval: 4000, timeout: 1000, misses: 1 };
/** These are the times of a heartbeat above the idle timeout of the hop: a ping each 6 s, against 5 s. */
const ABOVE = { interval: 6000, timeout: 1000, misses: 1 };
/** This time is the window of a silent cell: three pings of a heartbeat below the timeout, as T03 has it. */
const SILENT = 15;
/** This time is the window of a measurement of an idle timeout of HAProxy, as T02 has it. */
const MEASURED = 10;
/**
 * This time is the longest first request of a run, from the open of its socket to its reply. The
 * heartbeat counts from the open, and the router counts from the reply. No source bounds it: it is
 * the time of a new process. In the CI run 38976620161 of the WS catalog, it took 1.6 ms to 12.3 ms
 * in 165 runs.
 */
export const FIRST_REPLY = 0.5;

/** A hop of a WST cell is the router of T03 with its form, or HAProxy of T02 with its idle timeouts in seconds. */
export type WstHop =
  | { readonly kind: "router"; readonly form: MiddleboxForm }
  | { readonly kind: "proxy"; readonly timeouts: { readonly client: number; readonly server: number } };

/** A WST spec is one cell of the WebSocket client through a topology, before its prediction. */
export interface WstSpec {
  readonly name: string;
  readonly hop: WstHop;
  readonly fault: "middlebox-forget" | "proxy-idle" | "blackhole";
  /** This side is the side of HAProxy that a black hole faces. */
  readonly toward?: "client" | "target";
  readonly client: WsClientSettings;
  /** This count is how many tries of the reconnect the cell times. */
  readonly tries?: number;
  /** This time is the window of a silent or a measurement-only cell, in seconds. */
  readonly window?: number;
}

/** These are the timeouts of HAProxy when its idle timers stay out of the way: 30 s on each side, as T02 has them. */
const LONG = { client: 30, server: 30 };

/**
 * The WST catalog. Each cell asks if the heartbeat keeps a flow through a hop, or what the client
 * sees when it does not.
 * - The router of T03. O03 decides the flow: the ping of the heartbeat is the refresh, and the idle
 *   timeout of conntrack is the forget. A heartbeat of 4 s keeps the flow, and one of 6 s does not.
 *   Then the form of the router decides what the client sees.
 * - HAProxy of T02. Each ping and its pong is data on the two legs. HAProxy has no machine
 *   document, thus its idle timeouts are measurement-only. A black hole on one leg gets the band
 *   of the heartbeat.
 */
export const WST_SPECS: readonly WstSpec[] = [
  // ---- the router of T03: the heartbeat on each side of the border of O03
  {
    name: "client idle, router reset-both at 5 s, heartbeat 4 s and 1 s",
    hop: { kind: "router", form: "reset-both" },
    fault: "middlebox-forget",
    client: { ...CLIENT, heartbeat: BELOW },
    window: SILENT,
  },
  ...(["reset-both", "reset-next", "silent-drop"] as const).map(
    (form): WstSpec => ({
      name: `client idle, router ${form} at 5 s, heartbeat 6 s and 1 s`,
      hop: { kind: "router", form },
      fault: "middlebox-forget",
      client: { ...CLIENT, heartbeat: ABOVE },
      tries: 1,
    }),
  ),
  // ---- HAProxy of T02: its idle timeouts on each side of the heartbeat
  {
    name: "client idle, HAProxy timeouts 5 s, heartbeat 4 s and 1 s",
    hop: { kind: "proxy", timeouts: { client: 5, server: 5 } },
    fault: "proxy-idle",
    client: { ...CLIENT, heartbeat: BELOW },
    window: SILENT,
  },
  {
    name: "client idle, HAProxy timeout client 5 s, heartbeat 6 s and 1 s",
    hop: { kind: "proxy", timeouts: { client: 5, server: 30 } },
    fault: "proxy-idle",
    client: { ...CLIENT, heartbeat: ABOVE },
    tries: 1,
    window: MEASURED,
  },
  {
    name: "client idle, HAProxy timeout server 5 s, heartbeat 6 s and 1 s",
    hop: { kind: "proxy", timeouts: { client: 30, server: 5 } },
    fault: "proxy-idle",
    client: { ...CLIENT, heartbeat: ABOVE },
    tries: 1,
    window: MEASURED,
  },
  // ---- a black hole on each leg of HAProxy
  ...(["client", "target"] as const).map(
    (toward): WstSpec => ({
      name: `client idle, blackhole at HAProxy toward the ${toward}, heartbeat 2 s and 1 s`,
      hop: { kind: "proxy", timeouts: LONG },
      fault: "blackhole",
      toward,
      client: { ...CLIENT, heartbeat: HEARTBEAT },
      tries: 1,
    }),
  ),
];

/**
 * This function gives the WS spec of a WST spec: the idle client of the WS catalog. The knobs of
 * Linux TCP keep the kernel out of the way. A black hole toward the target meets the client as a
 * frozen server: the kernel of HAProxy acknowledges the ping, and no pong comes.
 */
const asWs = (spec: WstSpec): WsSpec => ({
  name: spec.name,
  fault: spec.fault,
  manifestation: spec.toward === "target" ? "freeze-process" : "blackhole",
  observer: "client",
  mode: "idle",
  client: spec.client,
  server: QUIET_SERVER,
  linux: QUIET,
  ...(spec.tries === undefined ? {} : { tries: spec.tries }),
  ...(spec.window === undefined ? {} : { window: spec.window }),
});

/** This function gives the latest refresh of an O03 verdict in seconds. A timer that is off refreshes at no time. */
const refreshOf = (verdict: O03Verdict): number => (verdict.refresh === "inf" ? Number.POSITIVE_INFINITY : verdict.refresh);

/**
 * This function gives the O03 verdict of a client against the router of T03, at a round trip in
 * ms. Two timers refresh its flow: the ping of its heartbeat, and the keepalive that its socket
 * class sets. The earlier refresh of the two decides.
 */
export const o03Ws = (client: WsClientSettings, rttMs = RTT_MS): O03Verdict => {
  const spec = asWs({ name: "o03", hop: { kind: "router", form: "none" }, fault: "middlebox-forget", client });
  const values = clientValues(client);
  const rtt = rttMs / 1000;
  const heartbeat = o03({ doc: PROCEDURES_WS_CLIENT, values }, routerValues, rtt);
  const keepalive = o03({ doc: LINUX_TCP, values: overValues(PROCEDURES_WS_CLIENT, values, given(linuxValues(spec, rttMs))) }, routerValues, rtt);
  return refreshOf(heartbeat) <= refreshOf(keepalive) ? heartbeat : keepalive;
};

/**
 * This function gives when the router forgets the flow, from the last segment that the client
 * received. The last segment of the flow is the delayed ACK of the client after it. Then
 * `expire_established` fires, and the pump and two listings make its DESTROY late.
 */
export const forgetOf = (rttMs: number): Span =>
  plus(ackDelay(rttMs), spanOf(NF_CONNTRACK_TCP, "expire_established", routerValues));

/** This text tells why a cell of an idle timeout of HAProxy has no band. */
const NO_DOCUMENT =
  "HAProxy has no machine document. Its documentation gives an inactivity timeout on each side, and each ping and pong is data on the two legs, but the algebra cannot read that";

/**
 * This function gives the prediction of a WST cell at a round trip in ms.
 * - An idle timeout of HAProxy is measurement-only. A cell that times its reconnect gets the bands
 *   of its waits from the document of the client.
 * - A black hole on a leg of HAProxy gets the band of the WS catalog: the pong timeout after the
 *   first ping without an answer.
 * - At the router, O03 decides. When it holds, nothing occurs in the window.
 * - When O03 does not hold, the router forgets the flow before the next ping. A reset to both ends
 *   comes at the forget. A reset to the next packet answers the ping. A silent drop leaves the ping
 *   to the pong timeout.
 */
export const predictWstAt = (spec: WstSpec, rttMs: number): Prediction => {
  const ws = asWs(spec);
  if (spec.hop.kind === "proxy") {
    if (spec.fault === "blackhole") return predictWsAt(ws, rttMs);
    const reconnects = reconnectsOf(ws);
    const why =
      reconnects.reconnects === undefined
        ? `${NO_DOCUMENT}: the cell measures if the connection lives`
        : `${NO_DOCUMENT}: the cell measures when HAProxy closes the idle connection. The waits of the reconnect have bands from the document of the client`;
    return { detects: null, window: q(spec.window ?? MEASURED), why, from: "last-received", ...reconnects };
  }
  const verdict = o03Ws(spec.client, rttMs);
  if (verdict.holds) return { detects: false, window: q(spec.window ?? WINDOW) };
  const forget = forgetOf(rttMs);
  // the router forgets the flow before the first ping: the heartbeat counts from the open, at most FIRST_REPLY before the reply
  const ping = spanOf(PROCEDURES_WS_CLIENT, "ping", clientValues(spec.client));
  if (!(ping.lo - FIRST_REPLY > forget.hi)) throw new Error(`${spec.name}: the first ping can come before the router forgets the flow`);
  if (spec.hop.form === "reset-both")
    return {
      detects: true,
      timer: "expire_established",
      errno: transitionOn(LINUX_TCP, "ESTABLISHED", "rx.rst")?.errno ?? "ECONNRESET",
      from: "last-received",
      low: q(forget.lo),
      high: q(forget.hi),
      ...reconnectsOf(ws),
    };
  // the ping is the next packet from inside: the router answers it with a reset, or drops it
  if (spec.hop.form === "reset-next") return predictWsAt({ ...ws, manifestation: "rst" }, rttMs);
  if (spec.hop.form === "silent-drop") return predictWsAt(ws, rttMs);
  throw new Error(`${spec.name}: no prediction for the form ${spec.hop.form}`);
};

/** This function gives the prediction of a WST cell, with the range of first round trips that its band assumes. */
export const predictWst = (spec: WstSpec): Prediction => assuming((rtt) => predictWstAt(spec, rtt), RTT_MS);

/**
 * This function gives the cell of the harness for a WST spec. The target is the procedures server
 * of the WS catalog, and HAProxy serves its port. The cells go one at a time, as the cells of T03:
 * the listing of a router evicts the expired flows of each namespace.
 */
export const wstCellOf = (spec: WstSpec): Cell => {
  const ws = asWs(spec);
  const target = wsServer(QUIET_SERVER);
  const hop =
    spec.hop.kind === "router"
      ? router(spec.hop.form, IDLE)
      : haproxy(spec.hop.timeouts, PROXY_SYSCTLS, { name: "procedures", port: target.port });
  return {
    name: `WST ${spec.name}`,
    target,
    client: "procedures-ws",
    sysctls: sysctlsOf(linuxValues(ws, RTT_MS)),
    probe: { mode: "idle", keepalive: false, ws: probeOf(ws) },
    fault: spec.fault,
    topology: { name: spec.hop.kind === "router" ? "T03" : "T02", hops: [hop] },
    ...(spec.toward === undefined ? {} : { faultAt: { hop: hop.name, toward: spec.toward } }),
    prediction: predictWst(spec),
    runs: RUNS,
    environments: 2,
    concurrency: 1,
  };
};

/** These are the cells of the WST catalog, in the sequence of the specs. */
export const WST_CELLS: readonly Cell[] = WST_SPECS.map(wstCellOf);
