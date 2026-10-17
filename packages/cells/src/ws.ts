import type { KnobValues, Manifestation } from "@mark1russell7/algebra";
import { errnoOf, overValues, stackedDetection, timerOf, timerUnder, transitionOn } from "@mark1russell7/algebra";
import type { Cell, Fault, Prediction, Reconnects, Reference, Target, WsProbe } from "@mark1russell7/harness";
import { NOISE } from "@mark1russell7/harness";
import { LINUX_TCP, PROCEDURES_WS_CLIENT, PROCEDURES_WS_SERVER } from "@mark1russell7/machines";
import type { Extent } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Spec } from "./catalog.ts";
import { HZ, LINUX_66, RTT_MS, RUNS, WINDOW, count, given, ms, predictAt, q, s, seconds, sysctlsOf } from "./catalog.ts";
import { NODE_IMAGE } from "./http/cells.ts";
import type { ManifestationName } from "./manifestations.ts";
import { MANIFESTATIONS } from "./manifestations.ts";
import { assuming } from "./rtt.ts";

/**
 * This module is the WS catalog: the WebSocket client and server of `@procedures/client` 0.3.0
 * on a direct pair. The client is the harness client `procedures-ws`, and the target starts the
 * server script of the same image. Each cell gives each setting of the client and of the server.
 * It also gives each knob of Linux TCP at the observer, thus nothing comes from a default.
 *
 * The predictions compose the documents `PROCEDURES_WS_CLIENT` and `PROCEDURES_WS_SERVER` of
 * `@mark1russell7/machines` over Linux TCP (`stackedDetection`). Thus the heartbeat of the client
 * competes with the keepalive that undici sets on its socket, and with the retransmission give-up
 * of the kernel.
 */

/**
 * These are the settings of the client that a cell gives, in milliseconds. Null turns the
 * heartbeat or the reconnect off. `socket` is the class of the sockets: the global `WebSocket` of
 * Node, or the `WebSocket` of the `ws` package.
 */
export interface WsClientSettings {
  readonly socket: "global" | "ws";
  readonly heartbeat: { readonly interval: number; readonly timeout: number; readonly misses: number } | null;
  readonly reconnect: {
    readonly initialDelay: number;
    readonly multiplier: number;
    readonly maxDelay: number;
    readonly attempts: number;
    readonly jitter: number;
  } | null;
  readonly requestTimeout: number;
  readonly connectionTimeout: number;
}

/** These are the settings of the server that a cell gives, in milliseconds. Null turns the heartbeat of the server off. */
export interface WsServerSettings {
  readonly heartbeat: { readonly interval: number; readonly misses: number } | null;
}

/** This port is the port of the procedures server in the target. */
const PORT = 8080;

/**
 * This function gives the procedures server as a target. It is the image of the harness with
 * `@procedures/client` 0.3.0, and its server script with the settings of a cell. A held server is
 * the child of a shell, thus a `fin` fault can stop it while the container stays up.
 */
export const wsServer = (settings: WsServerSettings, held = false): Target => {
  const heartbeat =
    settings.heartbeat === null
      ? ["--heartbeat", "off"]
      : ["--heartbeat", "on", "--heartbeat-interval-ms", String(settings.heartbeat.interval), "--heartbeat-misses", String(settings.heartbeat.misses)];
  const run = ["node", "/opt/harness/procedures/server-ws.mjs", "--port", String(PORT), "--tcp-keepalive", "off", ...heartbeat];
  return {
    image: NODE_IMAGE,
    harness: "procedures",
    port: PORT,
    ready: '"ev":"listening"',
    lines: true,
    command: held ? ["sh", "-c", `${run.join(" ")} & echo $! > /tmp/server.pid; while :; do sleep 3600; done`] : run,
    ...(held ? { kill: ["sh", "-c", 'kill -KILL "$(cat /tmp/server.pid)"'] } : {}),
  };
};

/** A manifestation of the WS catalog: one of T01, or the reset of the reference fault. */
type WsManifestation = ManifestationName | "rst";

/** A WS spec is one cell of the WS catalog, before its prediction. */
export interface WsSpec {
  readonly name: string;
  readonly fault: Fault;
  readonly manifestation: WsManifestation;
  readonly observer: "client" | "server";
  readonly mode: "idle" | "inflight";
  readonly client: WsClientSettings;
  readonly server: WsServerSettings;
  /** These are the knobs of Linux TCP at the observer that differ from Linux 6.6. */
  readonly linux?: Readonly<Record<string, Extent>>;
  /** This time is the length of a stall, in seconds. */
  readonly stall?: number;
  /** This time is how long the server holds the reply to the call in flight, in milliseconds. */
  readonly hold?: number;
  /** This count is how many tries of the reconnect the cell times. */
  readonly tries?: number;
  /** This time is the window of a silent cell, in seconds. */
  readonly window?: number;
}

/** These are the times of the heartbeat of most cells: a ping each 2 s, a pong timeout of 1 s, and one miss drops. */
export const HEARTBEAT = { interval: 2000, timeout: 1000, misses: 1 };
/** These are the settings of the reconnect: 0.5 s, then each wait two times the one before it, up to 4 s, with no jitter. */
export const RECONNECT = { initialDelay: 500, multiplier: 2, maxDelay: 4000, attempts: 10, jitter: 0 };
/**
 * These are the settings of the client of most cells: the global WebSocket of Node. A call waits
 * 60 s for its reply, thus no call times out in a band.
 */
export const CLIENT: WsClientSettings = { socket: "global", heartbeat: HEARTBEAT, reconnect: RECONNECT, requestTimeout: 60_000, connectionTimeout: 10_000 };
/** This client has no heartbeat and no reconnect: a cell on the server side, where the client must stay. */
const SILENT_CLIENT: WsClientSettings = { ...CLIENT, heartbeat: null, reconnect: null };
/** This server has no heartbeat: the cells of the client meet no ping of the server. */
export const QUIET_SERVER: WsServerSettings = { heartbeat: null };
/**
 * These are the knobs of Linux TCP that keep the kernel out of the way of the heartbeat. The
 * give-up of a ping comes 102.2 s after its first retransmission at tcp_retries2 = 8. The
 * keepalive of undici waits 60 s with nothing in flight.
 */
export const QUIET = { tcp_retries2: count(8) };

/**
 * The WS catalog. Each cell stands for a claim of the heartbeat or the reconnect of 0.3.0.
 * - A black hole, idle or with a call in flight, and a frozen server. The heartbeat drops the
 *   connection one pong timeout after the ping without an answer. The kernel waits longer.
 * - The drop of each class of sockets. The global WebSocket writes a close frame and its socket
 *   stays ESTABLISHED. The WebSocket of ws ends its socket at once with terminate().
 * - A stall shorter than the pong timeout. The pong comes back, and nothing drops.
 * - A reset and a FIN. The kernel tells the client at once, and the reconnect waits its backoff.
 * - A give-up of the kernel before the pong timeout, and a client without a heartbeat. The kernel
 *   wins.
 * - The server. Its heartbeat drops a silent client after `misses` beats. Without it, only the
 *   kernel finds a silent client, with a reply in flight.
 */
export const WS_SPECS: readonly WsSpec[] = [
  {
    name: "client idle, blackhole, heartbeat 2 s and 1 s",
    fault: "blackhole",
    manifestation: "blackhole",
    observer: "client",
    mode: "idle",
    client: CLIENT,
    server: QUIET_SERVER,
    linux: QUIET,
    tries: 1,
  },
  {
    name: "client idle, blackhole, heartbeat 2 s and 1 s, the ws class: terminate()",
    fault: "blackhole",
    manifestation: "blackhole",
    observer: "client",
    mode: "idle",
    client: { ...CLIENT, socket: "ws" },
    server: QUIET_SERVER,
    linux: QUIET,
    tries: 1,
  },
  {
    name: "client, a call in flight, blackhole, heartbeat 2 s and 1 s",
    fault: "blackhole",
    manifestation: "blackhole",
    observer: "client",
    mode: "inflight",
    client: CLIENT,
    server: QUIET_SERVER,
    linux: QUIET,
    tries: 1,
  },
  {
    name: "client idle, freeze-process of the server, heartbeat 2 s and 1 s",
    fault: "freeze-process",
    manifestation: "freeze-process",
    observer: "client",
    mode: "idle",
    client: CLIENT,
    server: QUIET_SERVER,
    linux: QUIET,
    tries: 1,
  },
  {
    name: "client idle, a 1 s stall, heartbeat 2 s and 3 s",
    fault: "stall",
    manifestation: "blackhole",
    observer: "client",
    mode: "idle",
    client: { ...CLIENT, heartbeat: { interval: 2000, timeout: 3000, misses: 1 } },
    server: QUIET_SERVER,
    linux: QUIET,
    stall: 1,
    window: 5,
  },
  {
    name: "client idle, rst, heartbeat 2 s and 1 s",
    fault: "rst",
    manifestation: "rst",
    observer: "client",
    mode: "idle",
    client: CLIENT,
    server: QUIET_SERVER,
    linux: QUIET,
    tries: 1,
  },
  {
    name: "client idle, fin of the server, three tries refused",
    fault: "fin",
    manifestation: "fin",
    observer: "client",
    mode: "idle",
    client: CLIENT,
    server: QUIET_SERVER,
    linux: QUIET,
    tries: 3,
  },
  {
    name: "client idle, blackhole, tcp_retries2 = 3, heartbeat 2 s and 10 s",
    fault: "blackhole",
    manifestation: "blackhole",
    observer: "client",
    mode: "idle",
    client: { ...CLIENT, heartbeat: { interval: 2000, timeout: 10_000, misses: 1 } },
    server: QUIET_SERVER,
    linux: { tcp_retries2: count(3) },
    tries: 1,
  },
  {
    name: "client idle, blackhole, heartbeat off",
    fault: "blackhole",
    manifestation: "blackhole",
    observer: "client",
    mode: "idle",
    client: { ...CLIENT, heartbeat: null },
    server: QUIET_SERVER,
    linux: QUIET,
    tries: 1,
  },
  {
    name: "server idle, blackhole, server heartbeat 1 s and 2 misses",
    fault: "blackhole",
    manifestation: "blackhole",
    observer: "server",
    mode: "idle",
    client: SILENT_CLIENT,
    server: { heartbeat: { interval: 1000, misses: 2 } },
    linux: QUIET,
  },
  {
    name: "server idle, blackhole, server heartbeat off",
    fault: "blackhole",
    manifestation: "blackhole",
    observer: "server",
    mode: "idle",
    client: SILENT_CLIENT,
    server: QUIET_SERVER,
    linux: QUIET,
  },
  {
    name: "server, a reply in flight, blackhole, tcp_retries2 = 3, server heartbeat off",
    fault: "blackhole",
    manifestation: "blackhole",
    observer: "server",
    mode: "inflight",
    client: SILENT_CLIENT,
    server: QUIET_SERVER,
    linux: { tcp_retries2: count(3) },
    hold: 2000,
  },
];

/** This function gives the value of an off setting: no bound. */
const off = (unit: string): Extent => ({ value: "infinite", unit });

/** This function gives the values of the knobs of the client document for the settings of a cell. A knob that the cell does not give has no value. */
export const clientValues = (settings: WsClientSettings): KnobValues => {
  const { heartbeat, reconnect } = settings;
  return given({
    heartbeat_interval: heartbeat === null ? off("ms") : ms(heartbeat.interval),
    heartbeat_timeout: heartbeat === null ? off("ms") : ms(heartbeat.timeout),
    heartbeat_misses: count(heartbeat === null ? 1 : heartbeat.misses),
    reconnect_initial_delay: reconnect === null ? off("ms") : ms(reconnect.initialDelay),
    reconnect_backoff_multiplier: count(reconnect === null ? 1 : reconnect.multiplier),
    reconnect_max_delay: reconnect === null ? off("ms") : ms(reconnect.maxDelay),
    reconnect_max_attempts: count(reconnect === null ? 0 : reconnect.attempts),
    reconnect_jitter: count(reconnect === null ? 0 : reconnect.jitter),
    request_timeout: ms(settings.requestTimeout),
    connection_timeout: ms(settings.connectionTimeout),
    // undici turns keepalive on with 60 s, and the ws package turns none on
    socket_keepidle: settings.socket === "global" ? s(60) : off("s"),
    hz: { value: HZ, unit: "Hz" },
  });
};

/** This function gives the values of the knobs of the server document for the settings of a cell. */
export const serverValues = (settings: WsServerSettings): KnobValues =>
  given({
    heartbeat_interval: settings.heartbeat === null ? off("ms") : ms(settings.heartbeat.interval),
    heartbeat_misses: count(settings.heartbeat === null ? 1 : settings.heartbeat.misses),
    hz: { value: HZ, unit: "Hz" },
  });

/** This function gives the values of Linux TCP at the observer of a spec, at a round trip in ms: the sysctls of its namespace. */
export const linuxValues = (spec: WsSpec, rttMs: number): Record<string, Extent> => ({
  ...LINUX_66,
  ...spec.linux,
  hz: { value: HZ, unit: "Hz" },
  rtt: ms(rttMs),
});

/**
 * This function gives the values of Linux TCP for the socket of the observer. The server socket
 * has no SO_KEEPALIVE (`PROCEDURES_WS_SERVER`), thus the keepalive sysctls do not reach it.
 */
const socketValues = (spec: WsSpec, rttMs: number): Record<string, Extent> => {
  const linux = linuxValues(spec, rttMs);
  return spec.observer === "server" ? { ...linux, keepidle: off("s") } : linux;
};

/** This function gives the event that arms a timer of Linux TCP, as the reference of a measurement. */
const linuxReference = (timer: string): Reference => {
  const arms = LINUX_TCP.timers[timer]?.arms ?? [];
  return arms.includes("tx.retransmit.first") ? "first-retransmission" : "last-received";
};

/**
 * This function gives the bands of the waits of the reconnect. Try n + 1 waits
 * min(initialDelay × multiplier^n, maxDelay), less its jitter. Each wait is a Node timer, with its
 * early and late bounds.
 */
export const reconnectsOf = (spec: WsSpec): { readonly reconnects?: Reconnects } => {
  if (spec.observer !== "client" || spec.client.reconnect === null || spec.tries === undefined) return {};
  const values = clientValues(spec.client);
  const waits = Array.from({ length: spec.tries }, (_, fired) => {
    const bounds = timerOf(PROCEDURES_WS_CLIENT, "reconnect", values, fired);
    const wait = seconds(bounds.duration, `reconnect wait ${fired}`);
    return {
      low: q(wait - seconds(bounds.early, "the reconnect's early bound")),
      high: q(wait + seconds(bounds.lateness, "the reconnect's lateness")),
    };
  });
  return { reconnects: { waits } };
};

/**
 * This function gives the prediction of a stall of an idle client. Its ping goes into the stall,
 * and the retransmission timer of Linux TCP moves it after the stall (`predictAt` of T01). The pong
 * comes back one round trip later. The pong timeout must not fire first: the cell is silent.
 */
const stallAt = (spec: WsSpec, rttMs: number): Prediction => {
  const linux: Spec = {
    name: spec.name,
    fault: "stall",
    manifestation: "blackhole",
    observer: "client",
    mode: "inflight",
    ...(spec.linux === undefined ? {} : { linux: spec.linux }),
    ...(spec.stall === undefined ? {} : { stall: spec.stall }),
  };
  const prediction = predictAt(linux, rttMs);
  if (prediction.detects !== false || prediction.recovers === undefined) throw new Error(`${spec.name}: the stall has no recovery`);
  const pong = timerOf(PROCEDURES_WS_CLIENT, "pong", clientValues(spec.client));
  const earliest = seconds(pong.duration, "the pong timeout") - seconds(pong.early, "the pong timeout's early bound");
  if (earliest <= valueIn(prediction.recovers.high, "s") + valueIn(NOISE, "s"))
    throw new Error(`${spec.name}: the pong timeout can fire before the pong comes back`);
  return { ...prediction, window: q(spec.window ?? WINDOW) };
};

/**
 * This function gives the prediction of a cell at a round trip in ms. It composes the document of
 * the client, or of the server, over Linux TCP:
 * - A FIN arrives at once: an end of file one way after the close of the peer.
 * - A reset answers the first ping into the fault one round trip later.
 * - Otherwise the first live timer detects it. A timer of the kernel gives its errno. A heartbeat
 *   drops the connection (`DROPPED`), from the first ping without an answer. The global WebSocket
 *   drops with a close frame, and the WebSocket of ws and the server with a close of the socket.
 */
export const predictWsAt = (spec: WsSpec, rttMs: number): Prediction => {
  const rtt = rttMs / 1000;
  const reconnects = reconnectsOf(spec);
  if (spec.stall !== undefined) return stallAt(spec, rttMs);
  if (spec.manifestation === "rst")
    return {
      detects: true,
      timer: "rx.rst",
      errno: transitionOn(LINUX_TCP, "ESTABLISHED", "rx.rst")?.errno ?? "ECONNRESET",
      from: "ping-sent",
      low: q(0),
      high: q(rtt),
      ...reconnects,
    };
  const server = spec.observer === "server";
  const doc = server ? PROCEDURES_WS_SERVER : PROCEDURES_WS_CLIENT;
  const values = server ? serverValues(spec.server) : clientValues(spec.client);
  // a side with a heartbeat meets a silent fault with its ping in flight, and awaits its pong
  const pinging = (server ? spec.server.heartbeat !== null : spec.client.heartbeat !== null) && spec.manifestation !== "fin";
  const state = server ? (pinging ? "MISSING" : "OPEN") : pinging ? "AWAITING_PONG" : "CONNECTED";
  const inFlight = spec.mode === "inflight" || pinging;
  const manifestation: Manifestation = MANIFESTATIONS[spec.manifestation];
  const linux = given(socketValues(spec, rttMs));
  const found = stackedDetection(doc, LINUX_TCP, { state, inFlight }, manifestation, values, linux);
  const [delivered] = found.delivered;
  if (delivered !== undefined)
    return { detects: true, timer: delivered.event, errno: delivered.errno ?? "EOF", from: "peer-closed", low: q(0), high: q(rtt), ...reconnects };
  if (found.unsettled.length > 0) throw new Error(`${spec.name}: a live detector has no time: ${found.unsettled.join(", ")}`);
  if (found.first === null) return { detects: false, window: q(spec.window ?? WINDOW) };
  const { timer, fires, beneath } = found.first;
  const bounds = beneath === undefined ? timerUnder(doc, timer, values, manifestation) : timerUnder(LINUX_TCP, timer, overValues(doc, values, linux), manifestation);
  const duration = seconds(bounds.duration, timer);
  const band = {
    low: q(duration - seconds(bounds.early, `${timer}'s early bound`)),
    high: q(duration + seconds(bounds.lateness, `${timer}'s lateness`)),
  };
  if (beneath !== undefined)
    return {
      detects: true,
      timer,
      errno: errnoOf(LINUX_TCP, "ESTABLISHED", { timer, fires }, manifestation) ?? "ETIMEDOUT",
      from: linuxReference(timer),
      ...band,
      ...reconnects,
    };
  // a timer of the program itself: the heartbeat drops the connection by itself. The client process
  // ends at the end of the run, and the kernel closes its sockets then: that close is not the drop
  const drop = !server && spec.client.socket === "global" ? "frame" : "close";
  return { detects: true, timer, errno: "DROPPED", from: "ping-sent", ...band, ...reconnects, drop, ...(server ? {} : { exits: true as const }) };
};

/** This function gives the prediction of a cell, with the range of first round trips that its band assumes. */
export const predictWs = (spec: WsSpec): Prediction => assuming((rtt) => predictWsAt(spec, rtt), RTT_MS);

/** This function gives the settings of the client of a spec for the harness. */
export const probeOf = (spec: WsSpec): WsProbe => {
  const { heartbeat, reconnect } = spec.client;
  return {
    socket: spec.client.socket,
    heartbeat: heartbeat === null ? null : { interval: ms(heartbeat.interval), timeout: ms(heartbeat.timeout), misses: heartbeat.misses },
    reconnect:
      reconnect === null
        ? null
        : {
            initialDelay: ms(reconnect.initialDelay),
            multiplier: reconnect.multiplier,
            maxDelay: ms(reconnect.maxDelay),
            attempts: reconnect.attempts,
            jitter: reconnect.jitter,
          },
    requestTimeout: ms(spec.client.requestTimeout),
    connectionTimeout: ms(spec.client.connectionTimeout),
    ...(spec.hold === undefined ? {} : { hold: ms(spec.hold) }),
  };
};

/**
 * This function gives the cell of the harness for a spec. The namespace of the observer gets the
 * knobs of Linux TCP as sysctls. A client `fin` holds the server under a shell, and each run then
 * has its own environment.
 */
export const wsCellOf = (spec: WsSpec): Cell => {
  const server = spec.observer === "server";
  const namespace = sysctlsOf(linuxValues(spec, RTT_MS));
  const killsServer = spec.fault === "fin" && !server;
  return {
    name: `WS ${spec.name}`,
    target: wsServer(spec.server, killsServer),
    client: "procedures-ws",
    sysctls: server ? {} : namespace,
    probe: { mode: spec.mode, keepalive: false, ws: probeOf(spec) },
    fault: spec.fault,
    prediction: predictWs(spec),
    ...(server ? { observer: "server" as const, targetSysctls: namespace } : {}),
    ...(spec.stall === undefined ? {} : { stall: s(spec.stall) }),
    runs: RUNS,
    environments: killsServer ? RUNS : 2,
  };
};

/** These are the cells of the WS catalog, in the sequence of the specs. */
export const WS_CELLS: readonly Cell[] = WS_SPECS.map(wsCellOf);
