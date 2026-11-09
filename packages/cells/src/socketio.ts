import { fileURLToPath } from "node:url";
import type { KnobValues, Manifestation, Recovery } from "@mark1russell7/algebra";
import { errnoOf, overValues, recovery as recoveryOf, stackedDetection, timerOf, timerUnder } from "@mark1russell7/algebra";
import type { Cell, CountBand, DeliveryPrediction, Fault, Prediction, Reconnects, Subject, Target, WsProbe } from "@mark1russell7/harness";
import { DROP_HANDLING, QUIET_MS, programOf, subjectClient } from "@mark1russell7/harness";
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

/**
 * These are the settings of the server that a cell gives, in milliseconds. The handshake gives the
 * two times of the ping to the client. `recovery` is maxDisconnectionDuration of
 * connectionStateRecovery, or null to turn the recovery off.
 */
export interface SocketIoServerSettings {
  readonly pingInterval: number;
  readonly pingTimeout: number;
  readonly recovery: number | null;
}

/**
 * A stream is the workload of a delivery cell: `count` numbered events, one each `interval`
 * milliseconds, from `sender`. `retries` is the `retries` of the Socket of a client sender. Each
 * event waits `requestTimeout` for its acknowledgement. After a failed try, the client sends it
 * again. Without `retries`, the client sends each event one time.
 */
export interface SocketIoStream {
  readonly count: number;
  readonly interval: number;
  readonly sender: "client" | "target";
  readonly retries?: number;
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
  readonly mode: "idle" | "inflight" | "stream";
  readonly client: SocketIoClientSettings;
  readonly server: SocketIoServerSettings;
  /** These are the knobs of Linux TCP at the observer that differ from Linux 6.6. */
  readonly linux?: Readonly<Record<string, Extent>>;
  /** This count is how many tries of the reconnect the cell times. */
  readonly tries?: number;
  /** This stream is the workload of the mode `stream`. */
  readonly stream?: SocketIoStream;
  /** This time is the length of a `stall` fault from the signal, in seconds. */
  readonly stall?: number;
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
    "--recovery",
    settings.recovery === null ? "off" : String(settings.recovery),
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

/** These are the times of the heartbeat: a ping each 2 s, and a wait of 1 s for its pong. The server has no recovery. */
export const PING: SocketIoServerSettings = { pingInterval: 2000, pingTimeout: 1000, recovery: null };
/** These are the settings of the reconnect: 0.5 s, then each wait two times the one before it, up to 4 s, with no jitter. */
export const RECONNECT = { initialDelay: 500, maxDelay: 4000, attempts: 10, jitter: 0 };
/** These are the settings of the client of the cells of the client. A call waits 60 s for its reply, thus no call times out in a band. */
export const CLIENT: SocketIoClientSettings = { reconnect: RECONNECT, requestTimeout: 60_000, connectionTimeout: 10_000 };
/** This client does not reconnect: a cell on the server side. */
export const STAYING_CLIENT: SocketIoClientSettings = { ...CLIENT, reconnect: null };
/** These are the knobs of Linux TCP that keep the kernel out of the way: the give-up of a write comes 102.2 s after its first retransmission. */
export const QUIET = { tcp_retries2: count(8) };

/**
 * This time is the length of the stall of a delivery cell, from the signal, in seconds. The client
 * drops the connection 3 s after its last pong, and tries again 0.5 s later. The SYNs of that try
 * then come each 1 s. The stall ends 5.85 s to 6.2 s after the last pong: after the latest third
 * SYN, and before the earliest fourth SYN. Thus the fourth SYN opens the new connection, and
 * `deliveryOf` checks that from the documents.
 */
export const STALL = 5.6;
/**
 * This time is the most from the end of the quiet time after `ready` (QUIET_MS of the harness) to
 * the signal, in seconds. The fault starts in it, and the client gets the signal after the fault.
 * The harness gives no bound for it: this is an assumption of the cells.
 */
export const SETUP = 0.35;
/**
 * This time is the most from the SYN that gets through to the join of the new socket on the
 * server, in seconds. It holds the handshake of TCP, the upgrade of the WebSocket, the open of the
 * engine and the CONNECT packet. These are a few round trips of the Docker network, and the
 * handling of Node. This is an assumption of the cells.
 */
export const JOIN = 0.05;

/** This stream is the stream of the server: 100 events, one each 100 ms, for 9.9 s. Its last event comes after the new connection. */
const SERVER_STREAM: SocketIoStream = { count: 100, interval: 100, sender: "target" };
/** This client has a time limit of 1 s for each try of an event: its ack timeout. */
const RETRYING_CLIENT: SocketIoClientSettings = { ...CLIENT, requestTimeout: 1000 };

/** These are the parts of each delivery cell: a stall of the network across a stream, and one try of the reconnect. */
const DELIVERY = {
  fault: "stall",
  manifestation: "blackhole",
  observer: "client",
  mode: "stream",
  linux: QUIET,
  tries: 1,
  stall: STALL,
} as const;

/**
 * These are the delivery cells (slice 2 of S7): what a stream loses or repeats across a stall.
 * - D1, D2 and D4: the server streams to the client. D1 has no recovery, and D2 has a recovery of
 *   30 s. D4 has a recovery of 2 s, which ends before the new connection.
 * - U1, U2 and U3: the client streams to the server, with no retries, 3 retries and 2 retries.
 * D3 is a later cell: it needs a quiet time of 70 s before the fault, and the harness has no field
 * for that.
 */
export const DELIVERY_SPECS: readonly SocketIoSpec[] = [
  { ...DELIVERY, name: "D1 the server streams, no recovery, stall 5.6 s", client: CLIENT, server: PING, stream: SERVER_STREAM },
  {
    ...DELIVERY,
    name: "D2 the server streams, recovery 30 s, stall 5.6 s",
    client: CLIENT,
    server: { ...PING, recovery: 30_000 },
    stream: SERVER_STREAM,
  },
  {
    ...DELIVERY,
    name: "D4 the server streams, recovery 2 s, stall 5.6 s",
    client: CLIENT,
    server: { ...PING, recovery: 2000 },
    stream: SERVER_STREAM,
  },
  {
    ...DELIVERY,
    name: "U1 the client streams, no retries, stall 5.6 s",
    client: CLIENT,
    server: PING,
    stream: { count: 80, interval: 100, sender: "client" },
  },
  {
    ...DELIVERY,
    name: "U2 the client streams, 3 retries, stall 5.6 s",
    client: RETRYING_CLIENT,
    server: PING,
    stream: { count: 2, interval: 100, sender: "client", retries: 3 },
  },
  {
    ...DELIVERY,
    name: "U3 the client streams, 2 retries, stall 5.6 s",
    client: RETRYING_CLIENT,
    server: PING,
    stream: { count: 2, interval: 100, sender: "client", retries: 2 },
  },
];

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
  ...DELIVERY_SPECS,
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

/** A band is the least and the most of a time, in seconds. */
interface Band {
  readonly low: number;
  readonly high: number;
}

/** This function gives the band of a Node timer of `duration` ms, by the law of the request timer of the client document. */
const nodeTimerOf = (spec: SocketIoSpec, duration: number): Band => {
  const values: KnobValues = (name) => (name === "request_timeout" ? ms(duration) : clientValues(spec)(name));
  const bounds = timerOf(SOCKETIO_CLIENT, "request", values);
  const wait = seconds(bounds.duration, `a Node timer of ${duration} ms`);
  return { low: wait - seconds(bounds.early, "the early bound of a Node timer"), high: wait + seconds(bounds.lateness, "the lateness of a Node timer") };
};

/** This function gives the band of a sum of two bands. */
const plus = (a: Band, b: Band): Band => ({ low: a.low + b.low, high: a.high + b.high });

/**
 * This function gives the band of the count of the events of a stream in an interval of `length`.
 * The events come each `interval`, each up to `late` after its time. The phase of the stream to the
 * interval is free.
 */
const eventsIn = (length: Band, interval: number, late: number): CountBand => ({
  low: Math.max(0, Math.floor((length.low - late) / interval)),
  high: Math.floor((length.high + late) / interval) + 1,
});

/**
 * This function gives the delivery law of a stream across a stall, at a round trip in seconds.
 * Each time counts from the last pong of the client (`pong-sent`). `detection` is the band of the
 * drop by the client.
 *
 * - The fault and the signal come QUIET_MS to QUIET_MS + SETUP after `ready`. The client writes
 *   `ready` at the pong. The stall ends STALL after the signal.
 * - The client tries again one wait of the reconnect after its drop. The SYNs of that try fire
 *   through the stall (`recovery` of the SYN timer). The shortest and the longest stall from the
 *   first SYN must give the same first SYN after the end: else the function throws. The new socket
 *   joins on the server up to JOIN after that SYN.
 * - The server drops the old connection at its pong timer, from its ping after the pong of the
 *   client. A recovery keeps the session that long after that drop. The new connection restores it
 *   when it comes before the end. It must come clearly before or after the end: else the function
 *   throws.
 * - A stream of the server goes to the room of the client. Each event from the start of the fault to
 *   the join of the new socket is lost, except in a restored session. The restore sends each event
 *   after the last offset of the client again.
 * - A client with no retries writes each event into the black hole until its drop. After the drop,
 *   the Socket keeps the events in its send buffer, and sends them on the new connection.
 * - A client with retries sends one event at a time, and the next events wait in its queue. Each
 *   ack timeout before the drop fails a try, and the drop fails the try in flight. The event is lost
 *   when these failed tries are more than `retries`. An ack timeout in the band of the drop throws.
 * - Neither engine reads a packet on a closed connection. Thus the data of the old connection after
 *   the end of the stall gives no repeat.
 */
export const deliveryOf = (spec: SocketIoSpec, detection: Band, rtt: number): DeliveryPrediction => {
  const { stream, stall } = spec;
  if (stream === undefined || stall === undefined || spec.fault !== "stall")
    throw new Error(`${spec.name}: a delivery law needs a stream across a stall (stream, stall, the fault "stall")`);
  const wait = reconnectsOf(spec).reconnects?.waits[0];
  if (wait === undefined) throw new Error(`${spec.name}: a delivery law needs a try of the reconnect after the drop`);
  const interval = stream.interval / 1000;
  const late = nodeTimerOf(spec, stream.interval).high - interval;
  const signal: Band = { low: QUIET_MS / 1000, high: QUIET_MS / 1000 + SETUP };
  const end: Band = { low: signal.low + stall, high: signal.high + stall };
  const dial = plus(detection, { low: valueIn(wait.low, "s"), high: valueIn(wait.high, "s") });
  const linux = given(linuxValues(spec, rtt * 1000));
  const through = (length: number): Recovery => {
    if (length <= 0) throw new Error(`${spec.name}: the stall can end before the first SYN of the reconnect`);
    const found = recoveryOf(LINUX_TCP, "syn_retransmit", linux, { value: length, unit: "s" });
    if ("unknown" in found) throw new Error(`${spec.name}: the SYN timer through the stall: ${found.unknown}`);
    return found;
  };
  const shortest = through(end.low - dial.high);
  const longest = through(end.high - dial.low);
  if (shortest.first.length !== 1 || longest.first.length !== 1 || shortest.first[0] !== longest.first[0])
    throw new Error(
      `${spec.name}: the end of the stall falls in the bounds of a SYN of the reconnect (firings ${shortest.first.join(", ")} and ${longest.first.join(", ")})`,
    );
  const join: Band = { low: dial.low + valueIn(shortest.low, "s"), high: dial.high + valueIn(shortest.high, "s") + rtt + JOIN };
  if (join.high - dial.low >= spec.client.connectionTimeout / 1000) throw new Error(`${spec.name}: the try can reach its time limit before its SYN gets through`);
  const values = serverValues(spec);
  const ping = timerOf(SOCKETIO_SERVER, "ping", values);
  const pong = timerOf(SOCKETIO_SERVER, "pong", values);
  const serverDrop: Band = {
    low: seconds(ping.duration, "ping") - seconds(ping.early, "ping's early bound") + seconds(pong.duration, "pong") - seconds(pong.early, "pong's early bound"),
    high: rtt + seconds(ping.duration, "ping") + seconds(ping.lateness, "ping's lateness") + seconds(pong.duration, "pong") + seconds(pong.lateness, "pong's lateness"),
  };
  const kept = spec.server.recovery;
  const recovered = (() => {
    if (kept === null) return false;
    if (serverDrop.low + kept / 1000 > join.high) return true;
    if (serverDrop.high + kept / 1000 < join.low) return false;
    throw new Error(`${spec.name}: the session can end in the band of the new connection`);
  })();
  const none: CountBand = { low: 0, high: 0 };
  const last = (stream.count - 1) * interval;
  if (stream.sender === "target") {
    // the client asks for the stream before it waits for the next ping: up to one ping interval before the pong
    if (-spec.server.pingInterval / 1000 - rtt + last <= join.high) throw new Error(`${spec.name}: the last event can come before the new connection`);
    const lost = recovered ? none : eventsIn({ low: join.low - signal.high, high: join.high - signal.low + rtt }, interval, late);
    return { lost, duplicates: none, recovered };
  }
  if (stream.retries === undefined) {
    if (signal.low + last <= detection.high) throw new Error(`${spec.name}: the last event can go into the black hole`);
    return { lost: eventsIn({ low: detection.low - signal.high, high: detection.high - signal.low }, interval, late), duplicates: none };
  }
  const timeout = nodeTimerOf(spec, spec.client.requestTimeout);
  let failed = 1;
  for (let k = 1; signal.low + k * timeout.low <= detection.high; k += 1) {
    if (signal.high + k * timeout.high >= detection.low) throw new Error(`${spec.name}: ack timeout ${k} can fall in the band of the drop`);
    failed += 1;
  }
  const dropped = failed > stream.retries;
  if (dropped && stream.count === 1) throw new Error(`${spec.name}: the lost event is the last of the stream`);
  return { lost: dropped ? { low: 1, high: 1 } : none, duplicates: none };
};

/**
 * This function gives the prediction of a cell at a round trip in ms. It composes the document of
 * the client, or of the server, over Linux TCP:
 * - A FIN arrives at once: an end of file one way after the close of the peer.
 * - Otherwise the first live timer detects it. A timer of the kernel gives its errno. A timer of
 *   the program drops the connection (`DROPPED`) with close() of ws: a close frame.
 * - The client counts from its last pong before the fault (`pong-sent`): it reads a ping, writes
 *   the pong, then starts its timer. A stream of the server brings data after it, thus the last
 *   data is not the reference. The server counts from its ping.
 * - A cell with a stream also gives its delivery law (`deliveryOf`).
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
  // a client that streams writes into the fault
  const inFlight = spec.mode === "inflight" || pinging || spec.stream?.sender === "client";
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
  const delivery = spec.stream === undefined ? {} : { delivery: deliveryOf(spec, { low: valueIn(band.low, "s"), high: valueIn(high, "s") }, rtt) };
  return {
    detects: true,
    timer,
    errno: "DROPPED",
    from: server ? "ping-sent" : "pong-sent",
    ...band,
    high,
    ...reconnects,
    drop: "frame",
    // the client process ends at the end of the run, and the kernel closes its sockets then: that close is not the drop
    ...(server ? {} : { exits: true as const }),
    ...delivery,
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
    ...(spec.stream?.retries === undefined ? {} : { retries: spec.stream.retries }),
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
    probe: {
      mode: spec.mode,
      keepalive: false,
      ws: probeOf(spec),
      ...(spec.stream === undefined ? {} : { count: spec.stream.count, interval: ms(spec.stream.interval), sender: spec.stream.sender }),
    },
    fault: spec.fault,
    ...(spec.stall === undefined ? {} : { stall: q(spec.stall) }),
    prediction: predictSocketIo(spec),
    ...(server ? { observer: "server" as const, targetSysctls: namespace } : {}),
    runs: RUNS,
    environments: killsServer ? RUNS : 2,
  };
};

/** These are the cells of the Socket.IO catalog, in the sequence of the specs. */
export const SOCKETIO_CELLS: readonly Cell[] = SOCKETIO_SPECS.map(socketIoCellOf);
