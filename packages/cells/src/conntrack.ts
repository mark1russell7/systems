import { conntrackFloor, synGiveUpSends, timerOf } from "@mark1russell7/algebra";
import type { Cell, ConntrackPrediction, HostSysctl, QueueBand, Target } from "@mark1russell7/harness";
import { LINUX_TCP } from "@mark1russell7/machines";
import { count, given, HZ, LINUX_66, s, seconds } from "./catalog.ts";

/**
 * The cells of the conntrack table (SYS-66): a client that holds its flows on the loopback of its own
 * namespace, and the real kernel. No flow crosses the bridge, thus the table of the host gets no entry
 * from them. The sources are Linux v7.0, the kernel of the runners.
 *
 * - The limit. `nf_conntrack_max` is global, and only the first namespace can write it
 *   (`net/netfilter/nf_conntrack_standalone.c`, lines 1041-1046). The count is for each namespace
 *   (`nf_conntrack_core.c`, lines 1657-1683). Thus a flow of a neighbor does not take a slot.
 * - The new flow. The entry after the limit does not exist, and the hook drops the SYN (lines 1904-1905,
 *   lines 2050-2052). The field `drop` rises by one for each SYN.
 * - The connect. `tcp_connect` ignores that error and arms the timer (`net/ipv4/tcp_output.c`, lines
 *   4376-4395). Thus the connect stalls, and it does not get a refusal. It ends with ETIMEDOUT after
 *   its normal schedule (`net/ipv4/tcp_timer.c`, lines 242-284). That end is the first firing that
 *   passes the count test or the time test: 7 s at 2 retries. Each try after the first one adds one to
 *   TCPRetransFail (`tcp_output.c`, lines 3684-3685).
 * - A reset. The entry goes to CLOSE, with a timeout of 10 s (`nf_conntrack_proto_tcp.c`, lines 69 and
 *   1283-1284). An entry goes only at a scan, and a scan comes at most 60 s after the one before it.
 * - A FIN. The entry goes to TIME_WAIT for 120 s (the same file, line 68). A drop at a full table sets
 *   the pressure of the next scan, which drops such entries down to a floor, `conntrackFloor`. A connect
 *   gets its slot at the next SYN after that scan. The expired entries of other namespaces share the cap
 *   of that scan, thus the floor is a band (`EXPIRED`).
 */

/** This image is the stock base of the image of the harness, for the record. */
const BASE = "alpine:3.23@sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62";
/** This port is the listener of the target. */
const PORT = 6392;
/** This count is the limit of most cells. */
const MAX = 1024;
/** This limit has 95 hundredths as the first end of its scan at each value of HZ. */
const ROUND_MAX = 1000;
/** This time holds the wake of the client and the noise of the machine, in seconds. */
const SLACK = 0.05;
/** This time is the timeout of an entry in CLOSE, in seconds. */
const CLOSE_TIMEOUT = 10;
/** This time is the longest gap between two scans, in seconds, and one second holds the length of a scan and the poll. */
const LONGEST_SCAN_GAP = 61;
/** This time is the wait before a run after a reset: the timeout, the gap of the scans, and a margin, in seconds. */
const SETTLE_RESET = 90;
/** This time is the wait before a run after a FIN: TIME_WAIT, the gap of the scans, and a margin, in seconds. */
const SETTLE_FIN = 200;
/** This time is the longest run: the longest wait, the fill, the longest connect and its end, in seconds. */
const WINDOW = 360;
/** These counts are the settings of the connect that finds no entry. */
const GIVE_UP_RETRIES = 2;
const LINEAR_TIMEOUTS = 4;
/** This count is the retries of a connect that waits for a slot: the default of the kernel, as in `LINUX_66`. */
const WAIT_RETRIES = 6;
/**
 * This count is the most entries of other namespaces that one scan finds expired before its cap. It
 * has no source: the 4 runs of CT.4 in cells run 42397236518 gave 2 to 5. At 14 the floor at the limit
 * of 1000 does not move, because the point of 95 hundredths stops that scan after 51 drops.
 */
const EXPIRED = 14;
/** This count is the last point of the schedule of a connect that gets a slot. That point is 67 s, one gap of the scans after the first. */
const POINTS = 10;

const LINUX = given({ ...LINUX_66, hz: { value: HZ, unit: "Hz" } });
const GIVE_UP = given({ ...LINUX_66, hz: { value: HZ, unit: "Hz" }, tcp_syn_retries: count(GIVE_UP_RETRIES) });

const band = (low: number, high: number): QueueBand => ({
  low: s(Math.round(low * 1e6) / 1e6),
  high: s(Math.round(high * 1e6) / 1e6),
});

/** This function gives the band of the end of a connect that finds no entry, from the document of Linux TCP. */
export const giveUpBand = (): QueueBand => {
  const bounds = timerOf(LINUX_TCP, "syn_giveup", GIVE_UP);
  const time = seconds(bounds.duration, "the end of the connect");
  return band(time - seconds(bounds.early, "how early it ends"), time + seconds(bounds.lateness, "how late it ends") + SLACK);
};

/** This function gives the band of each SYN after the first one. A connect that gets a slot ends on one of them. */
export const schedulePoints = (): readonly QueueBand[] => {
  const points: QueueBand[] = [];
  let at = 0;
  let early = 0;
  let late = 0;
  for (let k = 0; k < POINTS; k += 1) {
    const bounds = timerOf(LINUX_TCP, "syn_retransmit", LINUX, k);
    at += seconds(bounds.duration, `the wait ${k} of the SYN`);
    early += seconds(bounds.early, "how early the SYN timer fires");
    late += seconds(bounds.lateness, "how late the SYN timer fires");
    points.push(band(at - early, at + late + SLACK));
  }
  return points;
};

const targetOf = (fill: number | null): Target => ({
  image: BASE,
  subject: { kind: "shipped", name: "harness" },
  command: ["/opt/harness/ctfull", "target", String(PORT), ...(fill === null ? [] : ["--fill", String(fill)])],
  port: PORT,
  ready: "listening",
  lines: true,
});

/** This rule starts conntrack in a namespace: a match on it registers the hooks. It accepts each packet that it sees. */
const START_CONNTRACK = ["iptables", "-A", "OUTPUT", "-m", "conntrack", "--ctstate", "NEW,ESTABLISHED,RELATED", "-j", "ACCEPT"];

/** This setting gives a host its limit. The flows of the host stay below half of it, so that the host keeps its own slots. */
const hostLimit = (max: number): HostSysctl => ({
  name: "net.netfilter.nf_conntrack_max",
  value: String(max),
  guard: { name: "net.netfilter.nf_conntrack_count", atMost: Math.floor(max / 2) },
});

/** These are the settings of a cell: its limit, its plan, and its law. */
export interface ConntrackSpec {
  readonly plan: string;
  readonly name: string;
  readonly max: number;
  readonly way: "full" | "reset" | "fin";
  readonly fill: number | null;
  readonly retries: number;
  readonly settle: number;
  readonly why: string;
  readonly law: Omit<ConntrackPrediction, "max">;
}

const conntrackCell = (spec: ConntrackSpec): Cell => ({
  name: `${spec.plan} ${spec.name}`,
  target: targetOf(spec.fill),
  sysctls: {
    "net.ipv4.tcp_syn_retries": String(spec.retries),
    "net.ipv4.tcp_syn_linear_timeouts": String(LINEAR_TIMEOUTS),
  },
  namespaceSetup: [START_CONNTRACK],
  hostSysctls: [hostLimit(spec.max)],
  client: {
    image: { kind: "shipped", name: "harness" },
    command: ["/opt/harness/ctfull", "client", "--max", String(spec.max), "--plan", spec.way, "--settle-s", String(spec.settle)],
    // the client reads the field drop over ctnetlink, and each message of nfnetlink needs NET_ADMIN
    capabilities: ["NET_ADMIN"],
  },
  probe: { mode: "idle", keepalive: false },
  fault: "none",
  prediction: {
    detects: null,
    window: s(WINDOW),
    why: spec.why,
    conntrack: { max: spec.max, ...spec.law },
  },
  runs: 4,
  environments: 2,
  concurrency: 1,
});

/** This count is the SYNs of a connect that finds no entry, until the firing that gives up: the first one and each retry. */
const TRIES = synGiveUpSends(GIVE_UP_RETRIES, LINEAR_TIMEOUTS);

const REFUSED = { within: giveUpBand(), errno: "ETIMEDOUT", drops: TRIES, retransFail: TRIES - 1 };

const pressure = (max: number): NonNullable<ConntrackPrediction["pressure"]> => {
  const lowest = conntrackFloor(max, HZ);
  return { lowest, highest: conntrackFloor(max, HZ, EXPIRED), after: lowest + 1, points: schedulePoints() };
};

/** These are the laws that the cells check, one cell for each. */
export const CONNTRACK_SPECS: readonly ConntrackSpec[] = [
  {
    plan: "CT.1",
    name: "a table at its limit holds exactly that count, and the next connect stalls to ETIMEDOUT",
    max: MAX,
    way: "full",
    fill: null,
    retries: GIVE_UP_RETRIES,
    settle: SETTLE_RESET,
    why: "the hook drops each SYN after the limit, and tcp_connect ignores that error, so the connect has its normal schedule. At 2 retries the time test ends it first",
    law: { refused: REFUSED },
  },
  {
    plan: "CT.2",
    name: "a neighbor at the limit takes no slot of the client, because the count is for each namespace",
    max: MAX,
    way: "full",
    fill: MAX,
    retries: GIVE_UP_RETRIES,
    settle: SETTLE_RESET,
    why: "the limit is global and the count is for each network namespace",
    law: { neighbor: MAX, refused: REFUSED },
  },
  {
    plan: "CT.3",
    name: "the slots of a reset come back at a scan, at least 10 s after it",
    max: MAX,
    way: "reset",
    fill: null,
    retries: GIVE_UP_RETRIES,
    settle: SETTLE_RESET,
    why: "an entry in CLOSE has 10 s, and only a scan takes it out of the count",
    law: { drained: band(CLOSE_TIMEOUT - 1 / HZ, LONGEST_SCAN_GAP) },
  },
  {
    plan: "CT.4",
    name: "a connect at a table of TIME_WAIT gets a slot from the scan under pressure, down to the cap of its drops",
    max: MAX,
    way: "fin",
    fill: null,
    retries: WAIT_RETRIES,
    settle: SETTLE_FIN,
    why: "the drop of a SYN sets the pressure, and one scan counts at most 64000 / HZ + 1 entries. The expired entries of other namespaces share that count",
    law: { pressure: pressure(MAX) },
  },
  {
    plan: "CT.5",
    name: "a connect at a table of TIME_WAIT gets a slot from the scan under pressure, down to 95 hundredths of the limit",
    max: ROUND_MAX,
    way: "fin",
    fill: null,
    retries: WAIT_RETRIES,
    settle: SETTLE_FIN,
    why: "the drop of a SYN sets the pressure, and the scan stops one entry below the integer point of 95 hundredths",
    law: { pressure: pressure(ROUND_MAX) },
  },
];

export const CONNTRACK_CELLS: readonly Cell[] = CONNTRACK_SPECS.map(conntrackCell);
