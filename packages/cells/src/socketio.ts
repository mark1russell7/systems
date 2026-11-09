import { fileURLToPath } from "node:url";
import type { KnobValues, Manifestation } from "@mark1russell7/algebra";
import { errnoOf, overValues, stackedDetection, timerOf, timerUnder } from "@mark1russell7/algebra";
import type { Cell, Fault, Prediction, Reconnects, Subject, Target, WsProbe } from "@mark1russell7/harness";
import { DROP_HANDLING, programOf, subjectClient } from "@mark1russell7/harness";
import { LINUX_TCP, SOCKETIO_CLIENT, SOCKETIO_SERVER } from "@mark1russell7/machines";
import type { Extent } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { HZ, LINUX_66, RTT_MS, RUNS, WINDOW, count, given, ms, q, seconds, sysctlsOf } from "./catalog.ts";
import type { ManifestationName } from "./manifestations.ts";
import { MANIFESTATIONS } from "./manifestations.ts";
import { assuming } from "./rtt.ts";

/**
 * This module is the Socket.IO catalog (SYS-87): the client and the server of Socket.IO 4.8.4 on
 * a direct pair (E1), with the WebSocket transport only. The subject is the image of the folder
 * `targets/socketio`: one lockfile pins socket.io 4.8.4, socket.io-client 4.8.4, engine.io-client
 * 6.6.7 and ws 8.21.3. The client is its `client` program, and the target starts its `server`
 * program from the same image.
 *
 * The predictions compose the documents `SOCKETIO_CLIENT` and `SOCKETIO_SERVER` of
 * `@mark1russell7/machines` over Linux TCP (`stackedDetection`). The server gives pingInterval and
 * pingTimeout in its handshake, thus the settings of the server set the heartbeat of each side:
 * - The client waits pingInterval + pingTimeout for each ping, from the last ping that it read.
 * - The server waits pingTimeout for the pong of each ping.
 *
 * The names of the cells start with `SIO`, thus the nightly selection of the WS catalog (`^WS`)
 * does not take them.
 */

/** These are the settings of the server that a cell gives, in milliseconds: the handshake gives both to the client. */
export interface SocketIoServerSettings {
  readonly pingInterval: number;
  readonly pingTimeout: number;
}

/**
 * These are the settings of the client that a cell gives, in milliseconds. Null turns the reconnect
 * off. The Backoff of the Manager has the factor 2.
 */
export interface SocketIoClientSettings {
  readonly reconnect: { readonly initialDelay: number; readonly maxDelay: number; readonly attempts: number; readonly jitter: number } | null;
  readonly requestTimeout: number;
  readonly connectionTimeout: number;
}

/** A Socket.IO spec is one cell of the catalog, before its prediction. */
export interface SocketIoSpec {
  readonly name: string;
  readonly fault: Fault;
  readonly manifestation: ManifestationName;
  readonly observer: "client" | "server";
  readonly mode: "idle" | "inflight";
  readonly client: SocketIoClientSettings;
  readonly server: SocketIoServerSettings;
  /** These are the knobs of Linux TCP at the observer that differ from Linux 6.6. */
  readonly linux?: Readonly<Record<string, Extent>>;
  /** This count is how many tries of the reconnect the cell times. */
  readonly tries?: number;
}

/** This folder is the context of the build of the subject. */
const CONTEXT = fileURLToPath(new URL("../targets/socketio/", import.meta.url));

/** These are the files of the build context. */
const FILES = ["Dockerfile", "package.json", "npm-lock.json", "lines.ts", "client.ts", "server.ts"];

/** This image is the base of the subject: the Node image of the catalogs. */
const BASE = "node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1";

/** This subject is the Socket.IO subject: the image of `targets/socketio`, and its two programs. */
export const SOCKETIO: Subject = {
  name: "socketio",
  image: { kind: "build", name: "socketio", context: CONTEXT, files: FILES },
  base: BASE,
  programs: { client: ["node", "/srv/client.ts"], server: ["node", "/srv/server.ts"] },
};

/** This port is the port of the Socket.IO server in the target. */
const PORT = 8080;

/**
 * This function gives the Socket.IO server as a target, with the settings of a cell. A held server
 * is the child of a shell, thus a `fin` fault can stop it while the container stays up.
 */
export const socketIoServer = (settings: SocketIoServerSettings, held = false): Target => {
  const run = [
    ...programOf(SOCKETIO, "server"),
    "--port",
    String(PORT),
    "--ping-interval-ms",
    String(settings.pingInterval),
    "--ping-timeout-ms",
    String(settings.pingTimeout),
  ];
  return {
    image: SOCKETIO.base,
    subject: SOCKETIO.image,
    port: PORT,
    ready: '"ev":"listening"',
    lines: true,
    command: held ? ["sh", "-c", `${run.join(" ")} & echo $! > /tmp/server.pid; while :; do sleep 3600; done`] : run,
    ...(held ? { kill: ["sh", "-c", 'kill -KILL "$(cat /tmp/server.pid)"'] } : {}),
  };
};

/** These are the times of the heartbeat: a ping each 2 s, and a wait of 1 s for its pong. */
export const PING: SocketIoServerSettings = { pingInterval: 2000, pingTimeout: 1000 };
/** These are the settings of the reconnect: 0.5 s, then each wait two times the one before it, up to 4 s, with no jitter. */
export const RECONNECT = { initialDelay: 500, maxDelay: 4000, attempts: 10, jitter: 0 };
/** These are the settings of the client of the cells of the client. A call waits 60 s for its reply, thus no call times out in a band. */
export const CLIENT: SocketIoClientSettings = { reconnect: RECONNECT, requestTimeout: 60_000, connectionTimeout: 10_000 };
/** This client does not reconnect: a cell on the server side. */
export const STAYING_CLIENT: SocketIoClientSettings = { ...CLIENT, reconnect: null };
/** These are the knobs of Linux TCP that keep the kernel out of the way: the give-up of a write comes 102.2 s after its first retransmission. */
export const QUIET = { tcp_retries2: count(8) };

/**
 * The Socket.IO catalog. Each cell stands for a claim of the heartbeat or the reconnect.
 * - A black hole, idle or with a call in flight, and a frozen server. The client drops the
 *   connection pingInterval + pingTimeout after the last ping that it read. The kernel waits longer.
 * - A FIN. The kernel tells the client at once, and the reconnect waits its backoff.
 * - The server. It drops a silent client pingTimeout after the first ping without an answer.
 */
export const SOCKETIO_SPECS: readonly SocketIoSpec[] = [
  {
    name: "client idle, blackhole, ping 2 s and 1 s",
    fault: "blackhole",
    manifestation: "blackhole",
    observer: "client",
    mode: "idle",
    client: CLIENT,
    server: PING,
    linux: QUIET,
    tries: 1,
  },
  {
    name: "client, a call in flight, blackhole, ping 2 s and 1 s",
    fault: "blackhole",
    manifestation: "blackhole",
    observer: "client",
    mode: "inflight",
    client: CLIENT,
    server: PING,
    linux: QUIET,
    tries: 1,
  },
  {
    name: "client idle, freeze-process of the server, ping 2 s and 1 s",
    fault: "freeze-process",
    manifestation: "freeze-process",
    observer: "client",
    mode: "idle",
    client: CLIENT,
    server: PING,
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
    server: PING,
    linux: QUIET,
    tries: 3,
  },
  {
    name: "server idle, blackhole, ping 2 s and 1 s",
    fault: "blackhole",
    manifestation: "blackhole",
    observer: "server",
    mode: "idle",
    client: STAYING_CLIENT,
    server: PING,
    linux: QUIET,
  },
];

/** This function gives the value of an off setting: no bound. */
const off = (unit: string): Extent => ({ value: "infinite", unit });

/** This function gives the values of the knobs of the client document for a spec: the times of the ping come from the server. */
export const clientValues = (spec: SocketIoSpec): KnobValues => {
  const { reconnect } = spec.client;
  return given({
    ping_interval: ms(spec.server.pingInterval),
    ping_timeout: ms(spec.server.pingTimeout),
    reconnection_delay: reconnect === null ? off("ms") : ms(reconnect.initialDelay),
    reconnection_delay_max: reconnect === null ? off("ms") : ms(reconnect.maxDelay),
    reconnection_attempts: count(reconnect === null ? 0 : reconnect.attempts),
    randomization_factor: count(reconnect === null ? 0 : reconnect.jitter),
    connect_timeout: ms(spec.client.connectionTimeout),
    request_timeout: ms(spec.client.requestTimeout),
    hz: { value: HZ, unit: "Hz" },
  });
};

/** This function gives the values of the knobs of the server document for a spec. */
export const serverValues = (spec: SocketIoSpec): KnobValues =>
  given({
    ping_interval: ms(spec.server.pingInterval),
    ping_timeout: ms(spec.server.pingTimeout),
    hz: { value: HZ, unit: "Hz" },
  });

/** This function gives the values of Linux TCP at the observer of a spec, at a round trip in ms: the sysctls of its namespace. */
export const linuxValues = (spec: SocketIoSpec, rttMs: number): Record<string, Extent> => ({
  ...LINUX_66,
  ...spec.linux,
  hz: { value: HZ, unit: "Hz" },
  rtt: ms(rttMs),
});

/**
 * This function gives the values of Linux TCP for the socket of the observer. Neither socket has
 * SO_KEEPALIVE: ws turns none on, and neither does the http.Server of Node at its default. Thus
 * the keepalive sysctls of the namespace do not reach the socket.
 */
const socketValues = (spec: SocketIoSpec, rttMs: number): Record<string, Extent> => ({ ...linuxValues(spec, rttMs), keepidle: off("s") });

/** This function gives the bands of the waits of the reconnect: try n + 1 waits min(delay × 2^n, delayMax), with its jitter, on a Node timer. */
export const reconnectsOf = (spec: SocketIoSpec): { readonly reconnects?: Reconnects } => {
  if (spec.observer !== "client" || spec.client.reconnect === null || spec.tries === undefined) return {};
  const values = clientValues(spec);
  const waits = Array.from({ length: spec.tries }, (_, fired) => {
    const bounds = timerOf(SOCKETIO_CLIENT, "reconnect", values, fired);
    const wait = seconds(bounds.duration, `reconnect wait ${fired}`);
    return {
      low: q(wait - seconds(bounds.early, "the reconnect's early bound")),
      high: q(wait + seconds(bounds.lateness, "the reconnect's lateness")),
    };
  });
  return { reconnects: { waits } };
};

/**
 * This function gives the prediction of a cell at a round trip in ms. It composes the document of
 * the client, or of the server, over Linux TCP:
 * - A FIN arrives at once: an end of file one way after the close of the peer.
 * - Otherwise the first live timer detects it. A timer of the kernel gives its errno. A timer of
 *   the program drops the connection (`DROPPED`) with close() of ws: a close frame.
 * - The client counts from the last data of its socket before the fault: the pong of the last
 *   ping. The client writes the pong, then starts its timer. The server counts from its ping.
 * - The kernel stamps a drop at that act, after the program handled the firing of its timer. Thus
 *   the high bound of a drop adds the handling time of the program (`DROP_HANDLING` of the harness).
 */
export const predictSocketIoAt = (spec: SocketIoSpec, rttMs: number): Prediction => {
  const rtt = rttMs / 1000;
  const reconnects = reconnectsOf(spec);
  const server = spec.observer === "server";
  const doc = server ? SOCKETIO_SERVER : SOCKETIO_CLIENT;
  const values = server ? serverValues(spec) : clientValues(spec);
  // the server meets a silent fault with its ping in flight; the client has no ping of its own
  const pinging = server && spec.manifestation !== "fin";
  const state = server ? (pinging ? "AWAITING_PONG" : "OPEN") : "CONNECTED";
  const inFlight = spec.mode === "inflight" || pinging;
  const manifestation: Manifestation = MANIFESTATIONS[spec.manifestation];
  const linux = given(socketValues(spec, rttMs));
  const found = stackedDetection(doc, LINUX_TCP, { state, inFlight }, manifestation, values, linux);
  const [delivered] = found.delivered;
  if (delivered !== undefined)
    return { detects: true, timer: delivered.event, errno: delivered.errno ?? "EOF", from: "peer-closed", low: q(0), high: q(rtt), ...reconnects };
  if (found.unsettled.length > 0) throw new Error(`${spec.name}: a live detector has no time: ${found.unsettled.join(", ")}`);
  if (found.first === null) return { detects: false, window: q(WINDOW) };
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
      from: "first-retransmission",
      ...band,
      ...reconnects,
    };
  // the kernel stamps the drop at its close frame, after the handling of the firing
  const high = q(valueIn(band.high, "s") + valueIn(DROP_HANDLING, "s"));
  return {
    detects: true,
    timer,
    errno: "DROPPED",
    from: server ? "ping-sent" : "last-data",
    ...band,
    high,
    ...reconnects,
    drop: "frame",
    // the client process ends at the end of the run, and the kernel closes its sockets then: that close is not the drop
    ...(server ? {} : { exits: true as const }),
  };
};

/** This function gives the prediction of a cell, with the range of first round trips that its band assumes. */
export const predictSocketIo = (spec: SocketIoSpec): Prediction => assuming((rtt) => predictSocketIoAt(spec, rtt), RTT_MS);

/**
 * This function gives the settings of the client of a spec for the harness. The client has no
 * heartbeat of its own, and its sockets are those of ws: the Node build of engine.io-client.
 */
export const probeOf = (spec: SocketIoSpec): WsProbe => {
  const { reconnect } = spec.client;
  return {
    socket: "ws",
    heartbeat: null,
    reconnect:
      reconnect === null
        ? null
        : { initialDelay: ms(reconnect.initialDelay), multiplier: 2, maxDelay: ms(reconnect.maxDelay), attempts: reconnect.attempts, jitter: reconnect.jitter },
    requestTimeout: ms(spec.client.requestTimeout),
    connectionTimeout: ms(spec.client.connectionTimeout),
  };
};

/**
 * This function gives the cell of the harness for a spec. The namespace of the observer gets the
 * knobs of Linux TCP as sysctls. A client `fin` holds the server under a shell, and each run then
 * has its own environment.
 */
export const socketIoCellOf = (spec: SocketIoSpec): Cell => {
  const server = spec.observer === "server";
  const namespace = sysctlsOf(linuxValues(spec, RTT_MS));
  const killsServer = spec.fault === "fin" && !server;
  return {
    name: `SIO ${spec.name}`,
    target: socketIoServer(spec.server, killsServer),
    client: subjectClient(SOCKETIO),
    sysctls: server ? {} : namespace,
    probe: { mode: spec.mode, keepalive: false, ws: probeOf(spec) },
    fault: spec.fault,
    prediction: predictSocketIo(spec),
    ...(server ? { observer: "server" as const, targetSysctls: namespace } : {}),
    runs: RUNS,
    environments: killsServer ? RUNS : 2,
  };
};

/** These are the cells of the Socket.IO catalog, in the sequence of the specs. */
export const SOCKETIO_CELLS: readonly Cell[] = SOCKETIO_SPECS.map(socketIoCellOf);
