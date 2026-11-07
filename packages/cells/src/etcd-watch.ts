import { fileURLToPath } from "node:url";
import type { Cell, LineCount, Prediction, Target } from "@mark1russell7/harness";
import { ms, s } from "./catalog.ts";
import { NODE_IMAGE } from "./http/cells.ts";

/**
 * This module holds the watch cells of etcd (SYS-74): what does a watcher see after a stall or a
 * compaction? The subject is etcd v3.6.15 and its etcdctl, thus each watcher is clientv3.
 *
 * The law comes from the source, at the tag v3.6.15 of etcd and v1.83.2 of grpc-go, the version in
 * its go.mod. Each term cites its file and line.
 *
 * A watcher below the compaction fails:
 * - A watcher with `minRev` below the compact revision gets that revision and no events
 *   (server/storage/mvcc/watcher_group.go:251-254). The test is strict, thus a watch at the compact
 *   revision goes on. Compaction keeps the latest revision of each key at or below it.
 * - The server sets `Canceled` on that response (server/etcdserver/api/v3rpc/watch.go:444-451). The
 *   client gives `ErrCompacted` (client/v3/watch.go:127-128).
 *
 * Only a watcher out of the synced group meets that test. A synced watcher gets each write from
 * `notify` (server/storage/mvcc/watchable_store.go:468-477). Thus a stall alone loses nothing, and a
 * compaction alone loses nothing. A watcher fails only if the stall fills each buffer on the way:
 * - Response 1 is in the transport. grpc-go takes a whole response while the write quota is above
 *   zero (internal/transport/flowcontrol.go:54-58, http2_server.go:1178). The quota is 64 KiB
 *   (defaults.go:46), and it comes back only as bytes go out (controlbuf.go:988). The window of a
 *   stream is 65,535 bytes (defaults.go:28-30). Thus a long response leaves the quota below zero.
 * - Response 2 is in the hand of `sendLoop`, which blocks in Send (v3rpc/watch.go:473).
 * - Responses 3 to 130 are in the channel of the stream, 128 slots (watchable_store.go:38, :122).
 * - Response 131 is the victim. It leaves the synced group, and `minRev` moves to the next revision
 *   (watchable_store.go:480-491).
 *
 * The client then wakes. The channel drains, the victim goes out, and the watcher joins the unsynced
 * group if `minRev` is at the head or below it (watchable_store.go:285-325). Thus event 131 arrives,
 * and the strict test decides the rest. At 132 writes `minRev` is the compact revision, and nothing
 * is lost. At 133 writes it is one below, thus 131 events are the end of the watch.
 *
 * Short values give the other side of the law. Their bytes fit in the window, thus each response
 * goes through the transport and the kernel holds it for the stopped client. The count of the writes
 * does not decide. Their bytes decide.
 */

/** This folder is the build context of the target: its Dockerfile and its program. */
const CONTEXT = fileURLToPath(new URL("../targets/etcd-watch/", import.meta.url));

/** These are the files of the build context. */
const FILES = ["Dockerfile", "watch.ts"];

/** This port is the port of the program of the target. */
const PORT = 8080;

/** This count is the runs of a cell of SYS-74, as for the other count cells. */
const WATCH_RUNS = 4;

/** This count is `chanBufLen` of etcd v3.6.15 (server/storage/mvcc/watchable_store.go:38). */
export const CHANNEL = 128;

/** This count is the events on the way to a stopped client: the transport, the hand, the channel and the victim. */
export const HELD = CHANNEL + 3;

/** This size is the window of a gRPC stream, in bytes (`defaultWindowSize` of grpc-go). */
export const WINDOW = 65_535;

/** This size is the write quota of a gRPC stream, in bytes (`defaultWriteQuota` of grpc-go). */
export const QUOTA = 65_536;

/** This size is at most the protobuf and the gRPC prefix around one short value, in bytes. */
const ENVELOPE = 128;

/** This size is the long value: one response leaves the quota below zero, in bytes. */
export const LONG = 262_144;

/** This size is the short value, in bytes. */
export const SHORT = 16;

/** A resume writes, compacts at R, writes, then watches at R + `at`. */
export interface Resume {
  readonly kind: "resume";
  readonly before: number;
  readonly after: number;
  readonly at: number;
}

/** A stall stops a synced watcher if `stopped`, writes, compacts if `compact`, then starts the watcher again. */
export interface Stall {
  readonly kind: "stall";
  readonly writes: number;
  readonly bytes: number;
  readonly stopped: boolean;
  readonly compact: boolean;
}

/** A scenario is what the program of the target does for the logical request. */
export type Scenario = Resume | Stall;

/** The law of a scenario is the count of the events that the watcher prints, and if a compaction error ends it. */
export interface WatchLaw {
  readonly events: number;
  readonly canceled: boolean;
}

/** This function gives the law of a scenario `resume`. */
const resumeLaw = (spec: Resume): WatchLaw => (spec.at < 0 ? { events: 0, canceled: true } : { events: spec.after + 1 - spec.at, canceled: false });

/** This function tells if the bytes of a stall all fit in the window. Then no response waits. */
export const fitsWindow = (spec: Stall): boolean => spec.writes * (spec.bytes + ENVELOPE) <= WINDOW;

/** This function tells if one response of a stall leaves the write quota at zero or below, after a whole window goes out. */
export const stopsSend = (spec: Stall): boolean => spec.bytes >= QUOTA + WINDOW;

/**
 * This function gives the law of a scenario `stall`. The law knows two sizes: bytes that fit in the
 * window, and a value that stops Send. Between them, the count of the responses in the transport
 * depends on the size, and the function throws.
 */
const stallLaw = (spec: Stall): WatchLaw => {
  const whole = { events: spec.writes, canceled: false };
  if (!spec.stopped || fitsWindow(spec)) return whole;
  if (!stopsSend(spec)) throw new Error(`the law has no term for ${spec.writes} writes of ${spec.bytes} bytes`);
  return spec.compact && spec.writes > HELD + 1 ? { events: HELD, canceled: true } : whole;
};

/** This function gives the law of a scenario. */
export const lawOf = (spec: Scenario): WatchLaw => (spec.kind === "resume" ? resumeLaw(spec) : stallLaw(spec));

/** This function gives the target of a scenario, with the scenario as its argument. */
export const watchTarget = (spec: Scenario): Target => ({
  image: NODE_IMAGE,
  subject: { kind: "build", name: "etcd-watch", context: CONTEXT, files: FILES },
  port: PORT,
  ready: '"ev":"listening"',
  lines: true,
  command: ["node", "/srv/watch.ts", "--port", String(PORT), "--scenario", JSON.stringify(spec)],
});

/** This function gives the counts of a scenario: the events, the compaction error at R, each cancel, and the end of the scenario. */
export const countsOf = (spec: Scenario): readonly LineCount[] => {
  const { events, canceled } = lawOf(spec);
  return [
    { what: "the events of the watcher", match: { ev: "event" }, count: events },
    { what: "the compaction errors at the compact revision", match: { ev: "canceled", where: { offset: 0, compacted: true } }, count: canceled ? 1 : 0 },
    { what: "the cancels of the watcher", match: { ev: "canceled" }, count: canceled ? 1 : 0 },
    { what: "the scenarios that ended", match: { ev: "end", where: { reached: true } }, count: 1 },
  ];
};

/** A watch spec is one cell: its plan, its scenario, what it shows, and the longest time of a run in seconds. */
export interface WatchSpec {
  readonly plan: string;
  readonly scenario: Scenario;
  readonly name: string;
  readonly window: number;
}

/** This time is the window of a cell with short writes, in seconds. */
const SHORT_WINDOW = 60;

/** This time is the window of a cell with long writes, in seconds. */
const LONG_WINDOW = 180;

/** This count is the writes of a stall far above what the server holds. */
const MANY = 300;

/** These are the specs of SYS-74. */
export const WATCH_SPECS: readonly WatchSpec[] = [
  {
    plan: "WC.1",
    name: "a watch one revision below the compaction: the compaction error, and no events",
    scenario: { kind: "resume", before: 5, after: 5, at: -1 },
    window: SHORT_WINDOW,
  },
  {
    plan: "WC.2",
    name: "a watch at the compact revision: the test is strict, thus each event from it arrives",
    scenario: { kind: "resume", before: 5, after: 5, at: 0 },
    window: SHORT_WINDOW,
  },
  {
    plan: "WC.3",
    name: "a live watcher, 300 long writes, then a compaction: the control, nothing is lost",
    scenario: { kind: "stall", writes: MANY, bytes: LONG, stopped: false, compact: true },
    window: LONG_WINDOW,
  },
  {
    plan: "WC.4",
    name: "a stopped watcher, 132 long writes, then a compaction: the victim stops at the compact revision, thus nothing is lost",
    scenario: { kind: "stall", writes: HELD + 1, bytes: LONG, stopped: true, compact: true },
    window: LONG_WINDOW,
  },
  {
    plan: "WC.5",
    name: "a stopped watcher, 133 long writes, then a compaction: one more write gives 131 events, then the compaction error",
    scenario: { kind: "stall", writes: HELD + 2, bytes: LONG, stopped: true, compact: true },
    window: LONG_WINDOW,
  },
  {
    plan: "WC.6",
    name: "a stopped watcher, 300 long writes, and no compaction: it catches up, thus the stall alone loses nothing",
    scenario: { kind: "stall", writes: MANY, bytes: LONG, stopped: true, compact: false },
    window: LONG_WINDOW,
  },
  {
    plan: "WC.7",
    name: "a stopped watcher, 300 short writes, then a compaction: they fit in the window, thus the bytes decide and not the count",
    scenario: { kind: "stall", writes: MANY, bytes: SHORT, stopped: true, compact: true },
    window: SHORT_WINDOW,
  },
];

/** This function says a law in words, for the prediction. */
const wordsOf = (law: WatchLaw): string => `${law.events} events, and ${law.canceled ? "the compaction error" : "no error"}. The count reads no timer, thus it has no band`;

/** This function gives the prediction of a spec: the counts of its law. */
export const watchPrediction = (spec: WatchSpec): Prediction => ({
  detects: null,
  window: s(spec.window),
  from: "request-sent",
  why: wordsOf(lawOf(spec.scenario)),
  counts: countsOf(spec.scenario),
});

/** This function gives the cell of a spec. */
export const watchCell = (spec: WatchSpec): Cell => ({
  name: `${spec.plan} etcd-3.6 watch, ${spec.name}`,
  target: watchTarget(spec.scenario),
  sysctls: {},
  client: "undici",
  // the hold only names the logical request: the program answers it at the end of its scenario
  probe: { mode: "gap", keepalive: false, http: { method: "GET", gap: s(0), hold: ms(1), options: {} } },
  fault: "none",
  prediction: watchPrediction(spec),
  runs: WATCH_RUNS,
  environments: 2,
});

/** These are the cells of SYS-74. */
export const WATCH_CELLS: readonly Cell[] = WATCH_SPECS.map(watchCell);
