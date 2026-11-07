import { timerOf } from "@mark1russell7/algebra";
import type { Cell, PortsPrediction, QueueBand, Target } from "@mark1russell7/harness";
import { LINUX_TCP } from "@mark1russell7/machines";
import { wheelOf } from "./accept-queue.ts";
import { given, HZ, LINUX_66, seconds, s } from "./catalog.ts";

/**
 * The cells of the port range (SYS-64): one client in a small `ip_local_port_range`, one target that
 * accepts each connection, and the real kernel between them. Each term of the law is visible in a
 * record. The sources are Linux v7.0, the kernel of the runners.
 *
 * - The search. `__inet_hash_connect` (`net/ipv4/inet_hashtables.c`, lines 1066-1090) rounds the size
 *   of the range down to an even number, and it starts from an even offset. It takes steps of 2, so
 *   each pass makes half of that number of tries.
 * - An even range. The two passes reach each port, thus a destination gets exactly the size of the
 *   range. The first half of the connects get the ports of the parity of the low port.
 * - An odd range. The first pass makes `(size - 1) / 2` tries over `(size + 1) / 2` ports of that parity.
 *   Offset 0 does not reach the top port, and each other start does not reach the low port. A range
 *   of 3 gives 2 connects at each try, and the top port stays free. A range of 5 gives 4 or 5. The
 *   random step at the end of each connect sets the chance of each one (lines 1175-1176).
 *   `searchShares` gives the exact law.
 * - The error. The search ends with `EADDRNOTAVAIL` (lines 1146-1151). No SYN leaves. A failed search
 *   does not change the start of the next one.
 * - The unit of the count. The search skips a port that has this 4-tuple (lines 1099-1117). It does not
 *   skip a port that a connection to another destination holds. Thus the count is for each destination.
 * - TIME_WAIT. The port stays held only at the side that closes first. It stays for 60 s from the FIN
 *   of the peer, plus the timer wheel (`net/ipv4/tcp_minisocks.c`, lines 175-182, `include/net/tcp.h`
 *   line 142). With `tcp_tw_reuse` 1, a new connect takes the port 1000 ms after that FIN
 *   (`net/ipv4/tcp_ipv4.c`, lines 168-171). The default of 2 applies to loopback only (lines 130-154).
 * - Other ways to close. A reset holds nothing. If the target closes first, the client holds no
 *   port, and a new SYN passes the TIME_WAIT of the target (`net/ipv4/tcp_minisocks.c`, lines 253-262).
 */

/** This image is the stock base of the image of the harness, for the record. */
const BASE = "alpine:3.23@sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62";
/** This port is the first listener of the cell. The next port is the control port, and the port after it is the second listener. */
const PORT = 6392;
/** This port is the low end of each range. It is even, as the low port of most ranges is. */
const LOW = 40000;
/** This count is the rounds of a cell with one count. */
const ROUNDS = 50;
/** This count is the rounds of a cell with more than one count: its share has a band of 5 standard deviations. */
const SHARE_ROUNDS = 400;
/** This count is how many standard deviations the band of a share holds. */
const SHARE_DEVIATIONS = 5;
/** This time is the wait between two tries after a refused connect, in milliseconds. */
const RETRY = 10;
/** This time is the wait after the client closes, so that its FIN arrives before the next step, in milliseconds. */
const SETTLE = 50;
/** This time holds the wake of the client and the noise of the machine, in seconds. */
const SLACK = 0.05;
/** A connect with no free port does no network work. This time is the longest such connect in a run. */
const AT_ONCE = s(0.1);
/** This time is `tcp_tw_reuse_delay`, in milliseconds: its default, set here for the record. */
const REUSE_DELAY = 1000;

const LINUX = given({ ...LINUX_66, hz: { value: HZ, unit: "Hz" } });

const TARGET: Target = {
  image: BASE,
  subject: { kind: "shipped", name: "harness" },
  command: ["/opt/harness/ports", "target", String(PORT)],
  port: PORT,
  ready: "listening",
  lines: true,
};

/** This function gives the size that the search reads: the size of the range, rounded down to an even number. */
const remainingOf = (size: number): number => (size > 1 ? size & ~1 : size);

/** One try of the search: the two passes from an even offset. It gives the port and the tries of its pass. */
const search = (size: number, remaining: number, taken: number, start: number): { port: number; tries: number } | null => {
  for (let offset = start; ; ) {
    for (let tries = 0, port = offset; tries < remaining; tries += 2, port += 2) {
      if (port >= size) port -= remaining;
      if (((taken >> port) & 1) === 0) return { port, tries };
    }
    offset += 1;
    if ((offset & 1) === 0 || remaining <= 1) return null;
  }
};

/** This function gives one round from each start: the chance of each pair of a count and the next start. */
const roundFrom = (size: number, start: number): Map<string, number> => {
  const remaining = remainingOf(size);
  const half = remaining / 2;
  const ends = new Map<string, number>();
  let states = new Map<string, number>([[`0|${start}`, 1]]);
  const add = (map: Map<string, number>, key: string, chance: number): void => {
    map.set(key, (map.get(key) ?? 0) + chance);
  };
  while (states.size > 0) {
    const next = new Map<string, number>();
    for (const [key, chance] of states) {
      const [taken, from] = key.split("|").map(Number) as [number, number];
      const found = search(size, remaining, taken, from);
      if (found === null) {
        add(ends, `${taken.toString(2).replaceAll("0", "").length}|${from}`, chance);
        continue;
      }
      // the step of the perturb table: 2 more than the larger of the tries and a random draw
      for (let draw = 0; draw < 8; draw += 1) {
        const moved = ((from / 2 + (Math.max(found.tries, draw * 2) + 2) / 2) % half) * 2;
        add(next, `${taken | (1 << found.port)}|${moved}`, chance / 8);
      }
    }
    states = next;
  }
  return ends;
};

/**
 * This function gives the law of a search: the share of each count of connects, over many rounds.
 * Each round closes its connections with a reset, and the next round starts from the same table.
 */
export const searchShares = (size: number, rounds = 400): ReadonlyMap<number, number> => {
  const half = remainingOf(size) / 2;
  const table = Array.from({ length: half }, (_, at) => roundFrom(size, at * 2));
  const total = new Map<number, number>();
  let start = Array.from({ length: half }, () => 1 / half);
  for (let round = 0; round < rounds; round += 1) {
    const after = Array.from({ length: half }, () => 0);
    start.forEach((chance, at) => {
      for (const [key, value] of table[at]!) {
        const [count, next] = key.split("|").map(Number) as [number, number];
        after[next / 2]! += chance * value;
        total.set(count, (total.get(count) ?? 0) + (chance * value) / rounds);
      }
    });
    start = after;
  }
  return new Map([...total].sort((a, b) => a[0] - b[0]));
};

/** This function gives the band of a share over one run, from the chance of one round. */
const shareBand = (chance: number, rounds: number): { low: number; high: number } => {
  const deviation = Math.sqrt((chance * (1 - chance)) / rounds);
  return {
    low: Math.round((chance - SHARE_DEVIATIONS * deviation) * 1e4) / 1e4,
    high: Math.round((chance + SHARE_DEVIATIONS * deviation) * 1e4) / 1e4,
  };
};

const band = (low: number, high: number): QueueBand => ({
  low: s(Math.round(low * 1e6) / 1e6),
  high: s(Math.round(high * 1e6) / 1e6),
});

/** This function gives the band of a port in TIME_WAIT: `wait` from the FIN of the peer, to the first connect that gets the port. */
const freedAfter = (wait: number, late: number): QueueBand =>
  band(wait - 1 / HZ, wait + late + RETRY / 1000 + SLACK);

/** This time is how long a port stays in TIME_WAIT, from the document of Linux TCP. */
const timeWait = (): number => seconds(timerOf(LINUX_TCP, "time_wait", LINUX).duration, "TIME_WAIT");

/** These are the settings of a cell: the size of the range, how the client closes, and the sysctls. */
export interface PortsSpec {
  readonly plan: string;
  readonly name: string;
  readonly size: number;
  readonly close: "reset" | "client" | "target";
  readonly rounds: number;
  readonly destinations: number;
  readonly reuse: 1 | 2;
  readonly window: number;
  readonly why: string;
  readonly ports: Omit<PortsPrediction, "low" | "size" | "rounds" | "destinations" | "refusedWithin">;
}

const portsCell = (spec: PortsSpec): Cell => ({
  name: `${spec.plan} ${spec.name}`,
  target: TARGET,
  sysctls: {
    "net.ipv4.ip_local_port_range": `${LOW} ${LOW + spec.size - 1}`,
    "net.ipv4.tcp_tw_reuse": String(spec.reuse),
    "net.ipv4.tcp_tw_reuse_delay": String(REUSE_DELAY),
  },
  client: {
    image: { kind: "shipped", name: "harness" },
    command: [
      "/opt/harness/ports",
      "client",
      "--rounds",
      String(spec.rounds),
      "--close",
      spec.close,
      "--destinations",
      String(spec.destinations),
      "--settle-ms",
      String(SETTLE),
      "--retry-ms",
      String(RETRY),
      "--wait-s",
      String(spec.window),
    ],
  },
  probe: { mode: "idle", keepalive: false },
  fault: "none",
  prediction: {
    detects: null,
    window: s(spec.window + 10),
    why: spec.why,
    ports: {
      low: LOW,
      size: spec.size,
      rounds: spec.rounds,
      destinations: spec.destinations,
      refusedWithin: AT_ONCE,
      ...spec.ports,
    },
  },
  runs: 4,
  environments: 2,
  concurrency: 1,
});

const everyOffset = (size: number): readonly number[] => Array.from({ length: size }, (_, at) => at);

const fiveCounts = searchShares(5);

/** These are the laws that the cells check, one cell for each. */
export const PORT_RANGE_SPECS: readonly PortsSpec[] = [
  {
    plan: "PR.1",
    name: "an even range of 16 gives 16 connects to one destination, then EADDRNOTAVAIL at once",
    size: 16,
    close: "reset",
    rounds: ROUNDS,
    destinations: 1,
    reuse: 2,
    window: 30,
    why: "The two passes of the search reach each port of an even range. A reset holds no port, thus each round has the same count. The first 8 connects get the ports of the parity of the low port.",
    ports: { counts: [16], seen: everyOffset(16), lowFirst: true },
  },
  {
    plan: "PR.2",
    name: "an odd range of 3 gives 2 connects, and the top port is never used",
    size: 3,
    close: "reset",
    rounds: ROUNDS,
    destinations: 1,
    reuse: 2,
    window: 30,
    why: "The search rounds 3 down to 2. Each pass makes one try, at offset 0 and at offset 1.",
    ports: { counts: [2], seen: [0, 1] },
  },
  {
    plan: "PR.3",
    name: "an odd range of 5 gives 4 or 5 connects, and the share of each count comes from the search",
    size: 5,
    close: "reset",
    rounds: SHARE_ROUNDS,
    destinations: 1,
    reuse: 2,
    window: 30,
    why: "The search rounds 5 down to 4, and each pass makes 2 tries. Thus a port can stay out of reach of each try of a connect, and a later connect from another start reaches it. The share comes from the exact chain of the search.",
    ports: {
      counts: [4, 5],
      seen: everyOffset(5),
      share: { count: 5, ...shareBand(fiveCounts.get(5) ?? 0, SHARE_ROUNDS) },
    },
  },
  {
    plan: "PR.4",
    name: "the count is for each destination: a range of 16 gives 32 connects to two ports of one target",
    size: 16,
    close: "reset",
    rounds: ROUNDS,
    destinations: 2,
    reuse: 2,
    window: 30,
    why: "The search refuses a 4-tuple, not a port. A second destination port gets each port of the range again.",
    ports: { counts: [16], seen: everyOffset(16), lowFirst: true },
  },
  {
    plan: "PR.5",
    name: "the client closes first: each port stays held for 60 s from the FIN of the target, plus the wheel",
    size: 4,
    close: "client",
    rounds: 1,
    destinations: 1,
    reuse: 2,
    window: 80,
    why: "The FIN of the peer moves the socket to TIME_WAIT and sets its timer again. The default tcp_tw_reuse of 2 is for loopback only, and this path is a veth.",
    ports: { counts: [4], seen: everyOffset(4), freed: freedAfter(timeWait(), wheelOf(timeWait())) },
  },
  {
    plan: "PR.6",
    name: "tcp_tw_reuse 1: the client closes first, and each port comes back 1000 ms after the FIN of the target",
    size: 4,
    close: "client",
    rounds: 1,
    destinations: 1,
    reuse: 1,
    window: 30,
    why: "With reuse, a connect takes a port in TIME_WAIT when tcp_tw_reuse_delay has passed from the FIN of the peer, and the search does not wait for the timer.",
    ports: { counts: [4], seen: everyOffset(4), freed: freedAfter(REUSE_DELAY / 1000, 0.001) },
  },
  {
    plan: "PR.7",
    name: "the target closes first: the client holds no port, and each round gets each port at once",
    size: 4,
    close: "target",
    rounds: 10,
    destinations: 1,
    reuse: 2,
    window: 30,
    why: "TIME_WAIT is at the side that closes first, here the target. A new SYN with a newer timestamp passes that TIME_WAIT, thus no connect waits and no SYN is sent again.",
    ports: { counts: [4], seen: everyOffset(4), retransmissions: 0 },
  },
];

/** These are the cells of the port range, for the harness. */
export const PORT_RANGE_CELLS: readonly Cell[] = PORT_RANGE_SPECS.map(portsCell);
