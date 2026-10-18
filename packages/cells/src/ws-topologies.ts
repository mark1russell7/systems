import { overValues, timerOf, transitionOn } from "@mark1russell7/algebra";
import type { Cell, MiddleboxForm, Prediction, Subject } from "@mark1russell7/harness";
import { SUBJECTS, subjectClient } from "@mark1russell7/harness";
import { LINUX_TCP, NF_CONNTRACK_TCP, PROCEDURES_WS_CLIENT, PROCEDURES_WS_SERVER } from "@mark1russell7/machines";
import { RTT_MS, RUNS, WINDOW, given, q, seconds, sysctlsOf } from "./catalog.ts";
import type { Span } from "./mongo/model.ts";
import { plus, spanOf } from "./mongo/model.ts";
import { assuming } from "./rtt.ts";
import { PROXY_SYSCTLS } from "./t02.ts";
import { IDLE, routerValues } from "./t03.ts";
import type { O03Verdict } from "./topologies.ts";
import { ackDelay, haproxy, o03, o03From, router } from "./topologies.ts";
import type { WsClientSettings, WsServerSettings, WsSpec } from "./ws.ts";
import {
  CLIENT,
  HEARTBEAT,
  QUIET,
  QUIET_SERVER,
  SILENT_CLIENT,
  clientValues,
  linuxValues,
  predictWsAt,
  probeOf,
  reconnectsOf,
  serverValues,
  wsServer,
} from "./ws.ts";

/**
 * This module is the WST catalog: the WebSocket client and server of a procedures subject through
 * a topology. The router of T03 forgets an idle flow at 5 s, and HAProxy of T02 closes an idle
 * connection at its own timeouts. The client and the server are the client and the server of the
 * WS catalog, on the same subject, with the same documents and settings.
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

/** A WST spec is one cell of the WebSocket client and server through a topology, before its prediction. */
export interface WstSpec {
  readonly name: string;
  readonly hop: WstHop;
  readonly fault: "middlebox-forget" | "proxy-idle" | "blackhole";
  /** This side is the side of HAProxy that a black hole faces. */
  readonly toward?: "client" | "target";
  /** This side is the observer of the cell: the client, or the server with its heartbeat. The default is the client. */
  readonly observer?: "client" | "server";
  readonly client: WsClientSettings;
  /** These are the settings of the server. The default is a server without a heartbeat. */
  readonly server?: WsServerSettings;
  /** This count is how many tries of the reconnect the cell times. */
  readonly tries?: number;
  /** This time is the window of a silent or a measurement-only cell, in seconds. */
  readonly window?: number;
}

/** These are the timeouts of HAProxy when its idle timers stay out of the way: 30 s on each side, as T02 has them. */
const LONG = { client: 30, server: 30 };
/** This server beats each 4 s, below the idle timeout of the router, and it drops a connection after 2 misses. */
const SERVER_BELOW: WsServerSettings = { heartbeat: { interval: 4000, misses: 2 } };
/** This server beats each 6 s, above the idle timeout of the router, and it drops a connection after 2 misses. */
const SERVER_ABOVE: WsServerSettings = { heartbeat: { interval: 6000, misses: 2 } };

/**
 * These are the cells of the global WebSocket. Each cell asks if the heartbeat of the client keeps a
 * flow through a hop, or what the client sees when it does not.
 * - The router of T03. O03 decides the flow: the ping of the heartbeat is the refresh, and the idle
 *   timeout of conntrack is the forget. A heartbeat of 4 s keeps the flow, and one of 6 s does not.
 *   Then the form of the router decides what the client sees.
 * - HAProxy of T02. Each ping and its pong is data on the two legs. HAProxy has no machine
 *   document, thus its idle timeouts are measurement-only. A black hole on one leg gets the band
 *   of the heartbeat.
 */
const GLOBAL_SPECS: readonly WstSpec[] = [
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
 * These are the cells of the ws class: each cell of the global WebSocket, with the `WebSocket` of
 * ws, the default class of `@procedures/client/node`. The ws class sets no keepalive, thus only the
 * heartbeat refreshes a flow. A drop by the heartbeat ends its socket at once with `terminate()`.
 */
const WS_CLASS_SPECS: readonly WstSpec[] = GLOBAL_SPECS.map((spec) => ({
  ...spec,
  name: `${spec.name}, the ws class`,
  client: { ...spec.client, socket: "ws" },
}));

/**
 * These are the cells of the heartbeat of the server through the router of T03. The client has no
 * heartbeat and no reconnect, and the server is the observer.
 * - O03 decides the flow: each beat of the server pings each connection, and the pong comes back.
 *   A beat each 4 s keeps the flow, and a beat each 6 s does not.
 * - Then a ping from outside meets the form of the router. `reset-next` drops it, and the heartbeat
 *   drops the connection 2 beats later. `none` answers it with a reset from the stack of the router.
 */
const SERVER_SPECS: readonly WstSpec[] = [
  {
    name: "server idle, router reset-both at 5 s, server heartbeat 4 s and 2 misses",
    hop: { kind: "router", form: "reset-both" },
    fault: "middlebox-forget",
    observer: "server",
    client: SILENT_CLIENT,
    server: SERVER_BELOW,
    window: SILENT,
  },
  ...(["reset-next", "none"] as const).map(
    (form): WstSpec => ({
      name: `server idle, router ${form} at 5 s, server heartbeat 6 s and 2 misses`,
      hop: { kind: "router", form },
      fault: "middlebox-forget",
      observer: "server",
      client: SILENT_CLIENT,
      server: SERVER_ABOVE,
    }),
  ),
];

/** The WST catalog: the cells of the global WebSocket, of the ws class, and of the heartbeat of the server. */
export const WST_SPECS: readonly WstSpec[] = [...GLOBAL_SPECS, ...WS_CLASS_SPECS, ...SERVER_SPECS];

/**
 * This function gives the WS spec of a WST spec: an idle cell of the WS catalog. The knobs of Linux
 * TCP keep the kernel out of the way. A black hole toward the target meets the client as a frozen
 * server: the kernel of HAProxy acknowledges the ping, and no pong comes.
 */
const asWs = (spec: WstSpec): WsSpec => ({
  name: spec.name,
  fault: spec.fault,
  manifestation: spec.toward === "target" ? "freeze-process" : "blackhole",
  observer: spec.observer ?? "client",
  mode: "idle",
  client: spec.client,
  server: spec.server ?? QUIET_SERVER,
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
 * This function gives one beat of the heartbeat of a server: its heartbeat timer of
 * `PROCEDURES_WS_SERVER` at one miss. That is one interval, with the lateness and the early bound
 * of one Node timer.
 */
export const beatOf = (server: WsServerSettings & { readonly heartbeat: NonNullable<WsServerSettings["heartbeat"]> }) =>
  timerOf(PROCEDURES_WS_SERVER, "heartbeat", serverValues({ heartbeat: { ...server.heartbeat, misses: 1 } }));

/**
 * This function gives the O03 verdict of the heartbeat of a server against the router of T03, at a
 * round trip in ms. Each beat pings each connection, and the pong comes back. Thus the refresh is
 * one beat. `PROCEDURES_WS_SERVER` realizes no idle refresh, thus the refresh is its heartbeat timer
 * at one miss (`beatOf`). The server socket has no keepalive.
 */
export const o03Server = (server: WsServerSettings, rttMs = RTT_MS): O03Verdict | undefined => {
  const { heartbeat } = server;
  return heartbeat === null ? undefined : o03From(beatOf({ heartbeat }), routerValues, rttMs / 1000);
};

/** This function gives the O03 verdict of a WST cell: the earlier refresh of its client and of its server. */
export const o03Wst = (spec: WstSpec, rttMs = RTT_MS): O03Verdict => {
  const client = o03Ws(spec.client, rttMs);
  const server = o03Server(spec.server ?? QUIET_SERVER, rttMs);
  return server === undefined || refreshOf(client) <= refreshOf(server) ? client : server;
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
 * This function gives what the server sees when the router forgot the flow, at a round trip in ms.
 * One `setInterval` of the transport beats for all connections, from its start. No document gives
 * the phase of a beat after the accept. Thus each band counts from the first ping without an answer.
 * - The router forgets the flow before the next beat: a beat is longer than the latest forget
 *   after the pong of the beat before it.
 * - `reset-next` and `silent-drop` drop a ping from outside. The heartbeat drops the connection
 *   `misses` beats after it, and the kernel waits longer.
 * - `none` answers the ping with a reset from the stack of the router, in one round trip.
 * - `reset-both` resets the two ends at the forget, from the last segment of the flow. A ping can
 *   refresh the flow after the reply. The harness counts from the last segment before the reply,
 *   thus it has no reference for that cell.
 */
const serverAt = (spec: WstSpec, form: MiddleboxForm, rttMs: number): Prediction => {
  const ws = asWs(spec);
  const { heartbeat } = ws.server;
  if (heartbeat === null) throw new Error(`${spec.name}: a server without a heartbeat sends nothing to meet the router`);
  const beat = beatOf({ heartbeat });
  const rtt = rttMs / 1000;
  const forget = forgetOf(rttMs);
  const earliest = seconds(beat.duration, "a beat") - seconds(beat.early, "the early bound of a beat");
  if (!(earliest > forget.hi + rtt)) throw new Error(`${spec.name}: the next beat can come before the router forgets the flow`);
  // a beat before the forget refreshes the flow. Thus the first ping without an answer comes at
  // most one forget and one beat after the reply, and the run waits for it
  const latest = seconds(beat.duration, "a beat") + seconds(beat.lateness, "the lateness of a beat");
  const startsBy = q(forget.hi + latest + rtt);
  const late = (prediction: Prediction): Prediction => {
    if (prediction.detects !== true) throw new Error(`${spec.name}: nothing detects the forgotten flow`);
    return { ...prediction, startsBy };
  };
  if (form === "reset-next" || form === "silent-drop") return late(predictWsAt(ws, rttMs));
  if (form === "none") return late(predictWsAt({ ...ws, manifestation: "rst" }, rttMs));
  throw new Error(`${spec.name}: the harness has no reference for the form ${form} against the heartbeat of a server`);
};

/**
 * This function gives the prediction of a WST cell at a round trip in ms.
 * - An idle timeout of HAProxy is measurement-only. A cell that times its reconnect gets the bands
 *   of its waits from the document of the client.
 * - A black hole on a leg of HAProxy gets the band of the WS catalog: the pong timeout after the
 *   first ping without an answer.
 * - At the router, O03 decides with the earlier refresh of the two ends. When it holds, nothing
 *   occurs in the window.
 * - When O03 does not hold, the router forgets the flow before the next ping of the client. A reset
 *   to both ends comes at the forget. A reset to the next packet answers the ping. A silent drop
 *   leaves the ping to the pong timeout.
 * - A server with a heartbeat is the observer of its own cells (`serverAt`).
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
  const verdict = o03Wst(spec, rttMs);
  if (verdict.holds) return { detects: false, window: q(spec.window ?? WINDOW) };
  if (ws.observer === "server") return serverAt(spec, spec.hop.form, rttMs);
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
 * This function gives the cell of the harness for a WST spec, on a subject. The target is the
 * procedures server of the WS catalog, and HAProxy serves its port. The namespace of the observer
 * gets the knobs of Linux TCP. The cells go one at a time, as the cells of T03: the listing of a
 * router evicts the expired flows of each namespace.
 */
export const wstCellOf = (spec: WstSpec, subject: Subject = SUBJECTS.procedures): Cell => {
  const ws = asWs(spec);
  const server = ws.observer === "server";
  const target = wsServer(ws.server, false, subject);
  const namespace = sysctlsOf(linuxValues(ws, RTT_MS));
  const hop =
    spec.hop.kind === "router"
      ? router(spec.hop.form, IDLE)
      : haproxy(spec.hop.timeouts, PROXY_SYSCTLS, { name: "procedures", port: target.port });
  return {
    name: `WST ${spec.name}`,
    target,
    client: subjectClient(subject),
    sysctls: server ? {} : namespace,
    probe: { mode: "idle", keepalive: false, ws: probeOf(ws) },
    fault: spec.fault,
    topology: { name: spec.hop.kind === "router" ? "T03" : "T02", hops: [hop] },
    ...(spec.toward === undefined ? {} : { faultAt: { hop: hop.name, toward: spec.toward } }),
    prediction: predictWst(spec),
    ...(server ? { observer: "server" as const, targetSysctls: namespace } : {}),
    runs: RUNS,
    environments: 2,
    concurrency: 1,
  };
};

/** This function gives the cells of the WST catalog on a subject, in the sequence of the specs. */
export const wstCells = (subject: Subject): readonly Cell[] => WST_SPECS.map((spec) => wstCellOf(spec, subject));

/** These are the cells of the WST catalog on the subject that the harness ships. */
export const WST_CELLS: readonly Cell[] = wstCells(SUBJECTS.procedures);
