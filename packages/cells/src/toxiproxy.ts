import { transitionOn } from "@mark1russell7/algebra";
import type { Cell, Fault, Prediction, ProxyTime, Toxic } from "@mark1russell7/harness";
import { LINUX_TCP } from "@mark1russell7/machines";
import { valueIn } from "@mark1russell7/quantity";
import { PROXY_TIMES } from "./calibration.ts";
import { REDIS, RTT_MS, RUNS, ms, q } from "./catalog.ts";
import { assuming } from "./rtt.ts";
import { REDIS_CLOSING, toxiproxy } from "./topologies.ts";

/** This function gives the commands that put a value of `bytes` bytes at a key of Redis, before the client connects. */
const value = (key: string, bytes: number): readonly (readonly string[])[] => [
  ["sh", "-c", `head -c ${bytes} /dev/zero | tr '\\000' x | redis-cli -x SET ${key} > /dev/null`],
];

/** A TOX spec is one cell with Toxiproxy as the subject, or its direct counterpart without Toxiproxy. */
interface ToxSpec {
  readonly name: string;
  readonly fault: Fault;
  readonly mode: "idle" | "inflight";
  readonly toxic?: Toxic;
  readonly request?: string;
  readonly setup?: readonly (readonly string[])[];
  /** This flag puts the cell on the direct pair: the same fault, injected with iptables or netem, without Toxiproxy. */
  readonly direct?: true;
  /** This delay goes on the egress of the target before the client connects, in milliseconds. */
  readonly latency?: number;
  /** These are the sysctls of the namespace of Toxiproxy. */
  readonly proxySysctls?: Readonly<Record<string, string>>;
  /** This function gives the prediction at a first round trip in seconds. */
  readonly prediction: (rtt: number) => Prediction;
}

/** This text tells why a close translation is measurement only. */
const NO_CLOSE =
  "Toxiproxy documents its toxics, but not what it sends to the client when its upstream connection fails";
const resetErrno = transitionOn(LINUX_TCP, "ESTABLISHED", "rx.rst")?.errno ?? "ECONNRESET";

/**
 * This function gives the times of Toxiproxy that a band crosses, and their sum in seconds. A
 * request crosses it toward the target (`up`), and a reply or a close toward the client (`down`).
 * The documentation of Toxiproxy states no time of its own, thus each comes from its calibration.
 */
const through = (...directions: readonly ("up" | "down")[]): { through: readonly ProxyTime[]; plus: number } => {
  const terms = directions.map((direction) => PROXY_TIMES.toxiproxy[direction]);
  return { through: terms, plus: terms.reduce((sum, term) => sum + valueIn(term.time, "s"), 0) };
};

/**
 * The TOX catalog: Toxiproxy 2.12.0 as the subject, between the client and Redis 7.4. Each toxic
 * gets a cell. Its prediction comes from the semantics that the documentation of Toxiproxy states, or
 * it has none. Its close translation gets the faults of iptables on its upstream connection. The same
 * faults go on the direct pair, where the algebra predicts what the client sees.
 *
 * A band through Toxiproxy adds its own time for each crossing, from its calibration (`calibration.ts`).
 */
const TOX_SPECS: readonly ToxSpec[] = [
  // "latency: Add a delay to all data going through the proxy. The delay is equal to latency +/- jitter."
  // The request crosses Toxiproxy toward Redis, and the reply crosses it back with the delay
  {
    name: "client in flight, toxic latency 100 ms downstream",
    fault: "toxic",
    mode: "inflight",
    toxic: { type: "latency", stream: "downstream", attributes: { latency: 100, jitter: 0 } },
    prediction: (rtt) => {
      const { through: terms, plus } = through("up", "down");
      return { detects: false, window: q(2), replies: { low: q(0.1), high: q(0.1 + rtt + plus) }, through: terms };
    },
  },
  // "timeout: Stops all data from getting through, and closes the connection after timeout."
  // The close crosses Toxiproxy toward the client
  {
    name: "client idle, toxic timeout 2000 ms downstream",
    fault: "toxic",
    mode: "idle",
    toxic: { type: "timeout", stream: "downstream", attributes: { timeout: 2000 } },
    prediction: (rtt) => {
      const { through: terms, plus } = through("down");
      return { detects: true, timer: "toxic timeout", errno: "EOF", from: "fault", low: q(2), high: q(2 + rtt + plus), through: terms };
    },
  },
  // "If timeout is 0, the connection won't close, and data will be dropped until the toxic is removed."
  {
    name: "client idle, toxic timeout 0 downstream",
    fault: "toxic",
    mode: "idle",
    toxic: { type: "timeout", stream: "downstream", attributes: { timeout: 0 } },
    prediction: () => ({ detects: false, window: q(10) }),
  },
  // "reset_peer: Simulate TCP RESET (Connection reset by peer) on the connections by closing the stub Input immediately or after a timeout."
  // The request arrives at the toxic on the upstream: one crossing toward the target
  {
    name: "client in flight, toxic reset_peer 0 upstream on a live connection",
    fault: "toxic",
    mode: "inflight",
    toxic: { type: "reset_peer", stream: "upstream", attributes: { timeout: 0 } },
    prediction: (rtt) => {
      const { through: terms, plus } = through("up");
      return { detects: true, timer: "toxic reset_peer", errno: resetErrno, from: "request-sent", low: q(0), high: q(rtt + plus), through: terms };
    },
  },
  // "slow_close: Delay the TCP socket from closing until delay has elapsed."
  // The close of Redis crosses Toxiproxy toward the client, after the delay
  {
    name: "client idle, toxic slow_close 2000 ms downstream, the server closes",
    fault: "server-close",
    mode: "idle",
    toxic: { type: "slow_close", stream: "downstream", attributes: { delay: 2000 } },
    prediction: (rtt) => {
      const { through: terms, plus } = through("down");
      return { detects: true, timer: "toxic slow_close", errno: "EOF", from: "peer-closed", low: q(2), high: q(2 + rtt + plus), through: terms };
    },
  },
  // "bandwidth: Limit a connection to a maximum number of kilobytes per second."
  {
    name: "client in flight, toxic bandwidth 100 KB/s downstream, a 500000-byte reply",
    fault: "toxic",
    mode: "inflight",
    toxic: { type: "bandwidth", stream: "downstream", attributes: { rate: 100 } },
    request: "GET big",
    setup: value("big", 500_000),
    prediction: () => ({
      detects: null,
      window: q(8),
      from: "request-sent",
      why: "Toxiproxy documents a rate, not when the last byte arrives: the time is measured to the last data",
    }),
  },
  // "limit_data: Closes connection when transmitted data exceeded limit."
  // The request crosses toward Redis, and the reply and the close cross back
  {
    name: "client in flight, toxic limit_data 1000 bytes downstream, a 500000-byte reply",
    fault: "toxic",
    mode: "inflight",
    toxic: { type: "limit_data", stream: "downstream", attributes: { bytes: 1000 } },
    request: "GET big",
    setup: value("big", 500_000),
    prediction: (rtt) => {
      const { through: terms, plus } = through("up", "down");
      return { detects: true, timer: "toxic limit_data", errno: "EOF", from: "request-sent", low: q(0), high: q(rtt + plus), through: terms };
    },
  },
  // "slicer: Slices TCP data up into small bits, optionally adding a delay between each sliced packet."
  {
    name: "client in flight, toxic slicer 100 bytes 10 ms downstream, a 5000-byte reply",
    fault: "toxic",
    mode: "inflight",
    toxic: { type: "slicer", stream: "downstream", attributes: { average_size: 100, size_variation: 0, delay: 10_000 } },
    request: "GET slices",
    setup: value("slices", 5000),
    prediction: () => ({
      detects: null,
      window: q(3),
      from: "request-sent",
      why: "Toxiproxy documents slices and a delay between them, not how its reads cut the reply: the time is measured to the last data",
    }),
  },
  // ---- the close translation: a reset and a black hole on the upstream connection of Toxiproxy
  {
    name: "client in flight, rst at the server, through Toxiproxy",
    fault: "rst",
    mode: "inflight",
    prediction: () => ({ detects: null, window: q(5), from: "request-sent", why: NO_CLOSE }),
  },
  {
    name: "client in flight, blackhole at the server, through Toxiproxy with tcp_retries2 = 3",
    fault: "blackhole",
    mode: "inflight",
    proxySysctls: { "net.ipv4.tcp_retries2": "3" },
    prediction: () => ({ detects: null, window: q(20), from: "request-sent", why: NO_CLOSE }),
  },
  // ---- the direct counterparts, which the algebra predicts: a reset on the next segment, and a delay with netem
  {
    name: "direct, client in flight, rst",
    fault: "rst",
    mode: "inflight",
    direct: true,
    prediction: (rtt) => ({ detects: true, timer: "rx.rst", errno: resetErrno, from: "request-sent", low: q(0), high: q(rtt) }),
  },
  {
    name: "direct, client in flight, netem delay 100 ms",
    fault: "netem",
    mode: "inflight",
    direct: true,
    latency: 100,
    // the reply returns one round trip after the send: the round trip of the path, with the delay in it
    prediction: (rtt) => ({ detects: false, window: q(2), replies: { low: q(0.1), high: q(rtt) } }),
  },
];

/** This function gives the cell of a TOX spec for the harness. Its band assumes the first round trips around its nominal one. */
const toxCell = (spec: ToxSpec): Cell => ({
  name: `TOX ${spec.name}`,
  target: spec.fault === "server-close" ? REDIS_CLOSING : REDIS,
  sysctls: {},
  probe: {
    mode: spec.mode,
    keepalive: false,
    ...(spec.request === undefined ? {} : { request: spec.request }),
  },
  fault: spec.fault,
  ...(spec.direct === true ? {} : { topology: { name: "TOX", hops: [toxiproxy(spec.proxySysctls)] } }),
  ...(spec.toxic === undefined ? {} : { toxic: spec.toxic }),
  ...(spec.setup === undefined ? {} : { targetSetup: spec.setup }),
  ...(spec.latency === undefined ? {} : { latency: ms(spec.latency) }),
  prediction: assuming((rtt) => spec.prediction(rtt / 1000), RTT_MS + (spec.latency ?? 0)),
  runs: RUNS,
  environments: 2,
});

/** These are the cells of the TOX catalog. */
export const TOX_CELLS: readonly Cell[] = TOX_SPECS.map(toxCell);
