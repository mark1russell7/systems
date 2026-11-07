import type { Cell, KafkaPause, PauseBand, PausePrediction } from "@mark1russell7/harness";
import { KAFKA_CONSUMER_GROUP } from "@mark1russell7/machines";
import { valueIn } from "@mark1russell7/quantity";
import { given, ms, q, s } from "../catalog.ts";
import type { Span } from "../mongo/model.ts";
import { defaultsOf, spanOf } from "../mongo/model.ts";
import { KAFKA_TARGET, groupOf } from "./acks.ts";

/**
 * This module holds the cells of SYS-72: what does a paused consumer do after its session ends? The
 * group is three brokers and one controller of Apache Kafka 4.3.2. The clients are two consumers of
 * kafka-clients 4.3.2 on Java 21, with two partitions, one for each member. A SIGSTOP holds the first
 * member in the processing of one batch. Each term comes from the source at the tag 4.3.2, and the
 * document `kafka-consumer-group` holds each one with its citation.
 *
 * The law of the fence: in the consumer protocol the session is a setting of the broker, not of the
 * client (GroupCoordinatorConfig.java:184). The last heartbeat came up to one interval before the stop,
 * thus the fence comes 39.9 s to 46 s after the stop at the defaults. A stop of 30 s ends below that
 * band, thus the member keeps its partition and its epoch, and its commit passes.
 *
 * The law of the takeover: the other member gets the partition at one of its own heartbeats after the
 * fence (GroupMetadataManager.java:3867). It reads from the last commit of the first member.
 *
 * The law of the thaw: a commit after the fence and before any poll gets UNKNOWN_MEMBER_ID, and the
 * client throws CommitFailedException (ConsumerGroup.java:649-690, CommitRequestManager.java:901-905).
 * The error does not name a fenced epoch, because the coordinator has no member to compare.
 *
 * The law of the rejoin: this is the finding of SYS-72. A poll after the thaw joins again and gets a new
 * epoch. A commit at that epoch passes the check at the same epoch, and that check asks no question
 * about who owns the partition. Thus a commit of the old offsets moves the committed offset back
 * while the other member owns the partition.
 *
 * The classic protocol has the session in the client. Its member reaches the same failure at the thaw
 * (ConsumerCoordinator.java:1433-1448). Its cell has no band for the takeover, because a rebalance of
 * the classic protocol waits for the join of each member.
 */

/** This count is the runs of a cell of SYS-72: the decision rule of the prediction reads 4. */
export const PAUSE_RUNS = 4;
/** This time is how long the first member takes for one batch, in ms. It has no source: the stop lands inside it. */
export const PROCESS_MS = 5000;
/** This time is how far the stop lands inside a batch, in ms. It has no source. */
export const STOP_AFTER_MS = 1000;
/** This count is the records of each partition. It has no source: the first member does not reach its end in any hold. */
export const FILL = 1000;
/** This count is the records of one poll. It has no source: one batch is one wait of `PROCESS_MS`. */
export const BATCH = 10;
/** This time is the session that a broker of the cell `K2.pause.setting` has, in ms. It has no source. */
export const SHORT_SESSION_MS = 15_000;
/** This time is the classic session that the client of the cell `K2.pause.classic` has, in ms. It has no source. */
export const CLASSIC_SESSION_MS = 15_000;
/** This time is the most that a rejoin takes after the thaw, in seconds. It has no source: one poll, one heartbeat and its answer. */
export const REJOIN_WITHIN = 2;

/** These are the knobs of the document at its defaults. */
const VALUES = defaultsOf(KAFKA_CONSUMER_GROUP);

/** This function gives the span of a timer of the document, in seconds from the stop. */
const spanAt = (timer: string, overrides: Readonly<Record<string, ReturnType<typeof ms>>> = {}): Span => spanOf(KAFKA_CONSUMER_GROUP, timer, given({ ...VALUES, ...overrides }));

/** This function gives the band of a span. */
const bandOf = (span: Span): PauseBand => ({ low: s(span.lo), high: s(span.hi) });

/** This function gives the fence of the consumer protocol, in seconds from the stop. */
export const fenceOf = (sessionMs?: number): Span => spanAt("fence", sessionMs === undefined ? {} : { consumer_session_timeout: ms(sessionMs) });

/** This function gives the takeover of the other member, in seconds from the stop. */
export const takeoverOf = (sessionMs?: number): Span => spanAt("takeover", sessionMs === undefined ? {} : { consumer_session_timeout: ms(sessionMs) });

/** This function gives the fence of a classic member, in seconds from the stop. */
export const classicFenceOf = (): Span => spanAt("classic_fence", { classic_session_timeout: ms(CLASSIC_SESSION_MS) });

/** A spec is one cell of SYS-72, before its prediction. */
export interface PauseSpec {
  /** This identifier is the name of the cell, for example `K2.pause.long`. */
  readonly plan: string;
  /** This text tells what the cell reads, for its name. */
  readonly title: string;
  /** This time is how long the stop holds, in seconds. */
  readonly hold: number;
  /** This value is the protocol of the group. */
  readonly protocol: KafkaPause["protocol"];
  /** This value is what the first member does after the thaw. */
  readonly afterPause: KafkaPause["afterPause"];
  /** These settings are settings of each broker over the settings of the group. */
  readonly broker?: Readonly<Record<string, string>>;
  /** These settings are settings of each client over the settings of the cell. */
  readonly client?: Readonly<Record<string, number>>;
  /** This value is the law of the cell. */
  readonly law: PausePrediction;
}

/** These are the specs of SYS-72: the law above the session, below it, at a set session, after a rejoin, and on the classic protocol. */
export const PAUSE_SPECS: readonly PauseSpec[] = [
  {
    plan: "K2.pause.long",
    title: "a stop of 60 s, above the session of 45 s",
    hold: 60,
    protocol: "consumer",
    afterPause: "commit",
    law: { fence: bandOf(fenceOf()), takeover: bandOf(takeoverOf()), thaw: "fails" },
  },
  {
    plan: "K2.pause.short",
    title: "a stop of 30 s, below the session of 45 s",
    hold: 30,
    protocol: "consumer",
    afterPause: "commit",
    law: { fence: null, takeover: null, thaw: "acknowledged" },
  },
  {
    plan: "K2.pause.setting",
    title: "a stop of 30 s, above a session of 15 s on the broker",
    hold: 30,
    protocol: "consumer",
    afterPause: "commit",
    broker: {
      "group.consumer.session.timeout.ms": String(SHORT_SESSION_MS),
      // the minimum of 45 s refuses a shorter session (GroupCoordinatorConfig.java:186-188, :592-598). The value 10 s has no source
      "group.consumer.min.session.timeout.ms": "10000",
    },
    law: { fence: bandOf(fenceOf(SHORT_SESSION_MS)), takeover: bandOf(takeoverOf(SHORT_SESSION_MS)), thaw: "fails" },
  },
  {
    plan: "K2.pause.rejoin",
    title: "a stop of 60 s, then a poll before the commit of the old offsets",
    hold: 60,
    protocol: "consumer",
    afterPause: "rejoin",
    law: { fence: bandOf(fenceOf()), takeover: bandOf(takeoverOf()), thaw: "rejoin", rejoinWithin: s(REJOIN_WITHIN) },
  },
  {
    plan: "K2.pause.classic",
    title: "a stop of 30 s, above a classic session of 15 s in the client",
    hold: 30,
    protocol: "classic",
    afterPause: "commit",
    client: { "session.timeout.ms": CLASSIC_SESSION_MS, "heartbeat.interval.ms": 3000 },
    law: { fence: bandOf(classicFenceOf()), takeover: null, thaw: "fails" },
  },
];

/** This time is what a cell waits for after its hold, in seconds, for the record. The lab has its own tail. */
const AFTER_HOLD = 10;

const WHY = "a stop has no detection to time: the bands of the fence and of the takeover, and the answer to the commit at the thaw, judge the cell";

/** This function gives the cell of a spec. It throws if the stop of the spec does not fit its law. */
export const pauseCell = (spec: PauseSpec): Cell => {
  if (spec.law.fence !== null && spec.hold <= valueIn(spec.law.fence.high, "s")) throw new Error(`${spec.plan}: the stop can end before the fence`);
  if (spec.law.fence === null && spec.hold >= fenceOf().lo) throw new Error(`${spec.plan}: the session can end in the stop`);
  return {
    name: `${spec.plan} kafka-clients-4.3 to kafka-4.3 group, ${spec.title}, ${spec.protocol} protocol`,
    target: KAFKA_TARGET,
    sysctls: {},
    probe: { mode: "stream", keepalive: false, interval: ms(50) },
    driverOptions: { "max.poll.records": BATCH, ...spec.client },
    fault: "freeze-process",
    faultAt: "client",
    kafka: {
      ...groupOf(2, 1, spec.broker),
      pause: { protocol: spec.protocol, process: ms(PROCESS_MS), afterPause: spec.afterPause, fill: FILL, stopAfter: ms(STOP_AFTER_MS) },
    },
    hold: s(spec.hold),
    prediction: { detects: null, window: q(spec.hold + AFTER_HOLD), why: WHY, from: "fault", pause: spec.law },
    runs: PAUSE_RUNS,
    environments: 2,
    // four nodes, their sidecars, two clients and a prober fill a runner: one cell at a time
    concurrency: 1,
  };
};

/** These are the cells of SYS-72. */
export const PAUSE_CELLS: readonly Cell[] = PAUSE_SPECS.map(pauseCell);
