import type { Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { PauseBand, PausePrediction, ProbeEvent, Run } from "./cell.ts";
import type { Measured } from "./observe.ts";

/**
 * This module reads one run of a paused consumer against its law. Two members of a group each hold
 * one partition. A SIGSTOP stops the first member while it holds a batch, and a SIGCONT ends that
 * stop. Three sources give the reading: the lines of each member, the log lines of the brokers, and
 * the stamps of the injector.
 *
 * The broker writes its log on the clock of the wall, and the members and the injector use the
 * monotonic clock. The `start` line of a member has both clocks, thus it converts a log line.
 */

/** A commit reading is the first commit of the stopped member after the stop. */
export interface PauseCommit {
  readonly acked: boolean;
  /** This name is the class of the error of the commit. It is null for a commit that the broker acknowledged. */
  readonly name: string | null;
  readonly message: string | null;
  /** This number is the epoch that the member held at the commit. */
  readonly epoch: number | null;
}

/** A pause reading is what one run of a paused consumer measured. Each offset is the next offset to read, as a commit names it. */
export interface PauseReading {
  /** This number is the partition of the stopped member before the stop. */
  readonly partition: number;
  /** This time is from the stop to the log line of the broker that removes the member. It is null when no such line came. */
  readonly fence: Quantity | null;
  /** This time is from the stop to the first report of the partition by the other member. It is null when no report came. */
  readonly takeover: Quantity | null;
  readonly commit: PauseCommit | null;
  /** This number is the epoch at the last acknowledged commit before the stop. */
  readonly epochBefore: number | null;
  /** This offset is the last acknowledged commit of the stopped member before the stop. */
  readonly lastAck: number;
  /** This offset is the first offset of the partition that the other member read after the stop. */
  readonly otherFirst: number | null;
  /** This offset is the last acknowledged commit of the other member on the partition, before the commit of the stopped member. */
  readonly otherLast: number | null;
  /** This time is from the end of the stop to the new epoch of the member. It is null when no new epoch came. */
  readonly rejoin: Quantity | null;
  /** This value tells if the stopped member reported the partition again between the end of the stop and its commit. */
  readonly reassigned: boolean;
  /** This offset is the committed offset that the member read after its commit. */
  readonly committed: number | null;
  /** This offset is what the first commit after the stop names for the partition. */
  readonly stale: number | null;
}

/** This expression finds the stamp of a log line of a broker, as its console writes it, on UTC. */
const LOG_TIME = /\[(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d),(\d{3})\]/;

/** This function gives the time of a log line on the monotonic clock of a member, in ns, from the `start` line of that member. It is null for a line with no stamp. */
export const logTimeOf = (line: string, start: ProbeEvent): number | null => {
  const found = LOG_TIME.exec(line);
  if (found === null) return null;
  const wall = Date.UTC(Number(found[1]), Number(found[2]) - 1, Number(found[3]), Number(found[4]), Number(found[5]), Number(found[6]), Number(found[7]));
  return start.t + (wall - Number(start["wall"])) * 1e6;
};

/** This function gives the time between two instants of the monotonic clock, in s, to 1 microsecond. */
const secondsBetween = (from: number, to: number): Quantity => quantity(Math.round((to - from) / 1e3) / 1e6, "s");

const isInside = (time: Quantity, band: PauseBand): boolean => {
  const seconds = valueIn(time, "s");
  return seconds >= valueIn(band.low, "s") && seconds <= valueIn(band.high, "s");
};

const bandText = (band: PauseBand): string => `[${valueIn(band.low, "s")}, ${valueIn(band.high, "s")}] s`;

const isChange = (event: ProbeEvent): boolean => event.ev === "assigned" || event.ev === "revoked" || event.ev === "lost";

/** This function gives the partitions that a line of the rebalance listener names, in its field `partitions` or `held`. */
const partitionsOf = (event: ProbeEvent, field: "partitions" | "held"): readonly number[] => (event[field] as readonly number[] | undefined) ?? [];

/** This function gives the last line of the rebalance listener in a list of lines. */
const lastChange = (events: readonly ProbeEvent[]): ProbeEvent | undefined => events.findLast(isChange);

/** This function gives the offset that a commit names for a partition, or null. */
const offsetOf = (event: ProbeEvent, partition: number): number | null => {
  const value = (event["offsets"] as Readonly<Record<string, number | null>> | undefined)?.[String(partition)];
  return typeof value === "number" ? value : null;
};

/**
 * This function tells if the two members can take the fault. Each member holds one partition, the
 * two partitions differ, and the first member has two acknowledged commits on its partition after its
 * last change. Thus the first member reads and commits at a steady rate.
 */
export const pauseReady = (first: readonly ProbeEvent[], other: readonly ProbeEvent[]): boolean => {
  const mine = lastChange(first);
  const theirs = lastChange(other);
  if (mine === undefined || theirs === undefined) return false;
  const held = partitionsOf(mine, "held");
  const others = partitionsOf(theirs, "held");
  if (held.length !== 1 || others.length !== 1 || held[0] === others[0]) return false;
  const commits = first.filter((event) => event.ev === "commit" && event.t > mine.t && offsetOf(event, held[0]!) !== null);
  return commits.length >= 2;
};

/** This function tells if a log line of a broker tells that a member left a group, under either protocol. */
export const isFenceLine = (line: string): boolean =>
  /Member \S+ fenced from the group because|Member \S+ in group \S+ has failed, removing it from the group/.test(line);

/** This function tells if a fence line names a group. The two protocols write the name in different words. */
export const namesGroup = (line: string, group: string): boolean => line.includes(`[GroupId ${group}]`) || line.includes(`in group ${group} has`);

/** This function compares a reading to the law, and gives each disagreement. */
const findingsOf = (reading: PauseReading, prediction: PausePrediction, fences: readonly string[], otherReports: boolean): string[] => {
  const found: string[] = [];
  const { commit, fence, takeover } = reading;
  if (prediction.fence === null) {
    if (fences.length > 0) found.push(`the group removed a member: ${fences[0]}`);
    if (otherReports) found.push("the other member reported the partition");
  } else {
    if (fence === null) found.push("no log line tells of a fence, and the other member did not report the partition");
    else if (!isInside(fence, prediction.fence)) found.push(`the fence is ${valueIn(fence, "s")} s, outside ${bandText(prediction.fence)}`);
    if (reading.otherFirst !== reading.lastAck) found.push(`the other member started at offset ${reading.otherFirst}, and the last commit is ${reading.lastAck}`);
  }
  if (prediction.takeover !== null) {
    if (takeover === null) found.push("the other member did not report the partition");
    else if (!isInside(takeover, prediction.takeover)) found.push(`the other member reported the partition at ${valueIn(takeover, "s")} s, outside ${bandText(prediction.takeover)}`);
  }
  if (commit === null) {
    found.push("the member made no commit after the stop");
    return found;
  }
  switch (prediction.thaw) {
    case "fails":
      if (commit.name !== "CommitFailedException") found.push(`the commit after the stop gave ${commit.name ?? "an acknowledgment"}, not CommitFailedException`);
      break;
    case "acknowledged":
      if (!commit.acked) found.push(`the commit after the stop failed with ${commit.name}`);
      if (commit.epoch !== reading.epochBefore) found.push(`the epoch changed from ${reading.epochBefore} to ${commit.epoch}`);
      break;
    case "rejoin": {
      const within = prediction.rejoinWithin;
      if (reading.rejoin === null) found.push("the member did not get a new epoch");
      else if (within !== undefined && valueIn(reading.rejoin, "s") > valueIn(within, "s")) found.push(`the new epoch came at ${valueIn(reading.rejoin, "s")} s, above ${valueIn(within, "s")} s`);
      if (!commit.acked) found.push(`the stale commit failed with ${commit.name}`);
      if (reading.reassigned) found.push("the member held the partition again before its commit");
      if (reading.committed !== reading.stale) found.push(`the committed offset is ${reading.committed}, and the stale commit named ${reading.stale}`);
      if (reading.stale === null || reading.otherLast === null || reading.stale >= reading.otherLast) found.push(`the stale commit ${reading.stale} is not below the progress ${reading.otherLast} of the other member`);
      break;
    }
  }
  return found;
};

/** This function reads one run of a paused consumer against its law. */
export const measurePause = (run: Run, prediction: PausePrediction): Measured => {
  const retransmissions = run.kernel.filter((record) => record.netns === run.netns && record.ev === "retrans").length;
  const base = {
    environment: run.environment,
    index: run.index,
    outcome: { kind: "answered" } as const,
    elapsed: null,
    socket: null,
    noticed: null,
    steps: [],
    probes: 0,
    retransmissions,
    acks: 0,
  };
  const voided = (why: string): Measured => ({ ...base, void: why, finding: null });

  const { fault, heal, pause } = run;
  if (fault === null || pause === undefined) return voided("the partitions were not one for each member before the stop");
  if (heal === undefined || heal === null) return voided("the stop did not end");
  const stop = fault.t0;
  const thaw = heal.t0;
  const before = run.events.filter((event) => event.t < stop);
  const after = run.events.filter((event) => event.t >= stop);
  const start = run.events.find((event) => event.ev === "start");
  if (start === undefined) return voided("the member wrote no start line");

  const mine = lastChange(before);
  const theirs = lastChange(pause.other.filter((event) => event.t < stop));
  const held = mine === undefined ? [] : partitionsOf(mine, "held");
  const others = theirs === undefined ? [] : partitionsOf(theirs, "held");
  const partition = held[0];
  if (partition === undefined || held.length !== 1 || others.length !== 1 || others[0] === partition)
    return voided("the partitions were not one for each member before the stop");
  if (after.find((event) => event.ev === "pause")?.["in"] !== "process") return voided("the stop landed outside the processing of a batch");
  if (before.findLast((event) => event.ev === "read")?.["partition"] !== partition) return voided("the last read before the stop was on another partition");
  const lastCommit = before.findLast((event) => event.ev === "commit" && offsetOf(event, partition) !== null);
  if (lastCommit === undefined) return voided("the member had no acknowledged commit on its partition before the stop");

  const member = String(mine?.["member"]);
  const fenceLines = pause.fences.filter((line) => line.includes(member));
  const fenceAt = fenceLines.map((line) => logTimeOf(line, start)).find((time) => time !== null && time >= stop) ?? null;
  const taken = pause.other.find((event) => event.ev === "assigned" && event.t >= stop && partitionsOf(event, "partitions").includes(partition));
  if (prediction.fence !== null && fenceAt === null && taken !== undefined) return voided("the broker log lost the line of the fence");

  const thawed = after.find((event) => event.ev === "commit" || event.ev === "commit-fail");
  const rejoined = after.find((event) => event.ev === "rejoined");
  const ackAt = thawed?.t ?? Number.POSITIVE_INFINITY;
  const otherCommit = pause.other.findLast((event) => event.ev === "commit" && event.t < ackAt && offsetOf(event, partition) !== null);
  const committed = after.find((event) => event.ev === "committed");
  const epochOf = (event: ProbeEvent | undefined): number | null => (typeof event?.["epoch"] === "number" ? event["epoch"] : null);

  const pauseReading: PauseReading = {
    partition,
    fence: fenceAt === null ? null : secondsBetween(stop, fenceAt),
    takeover: taken === undefined ? null : secondsBetween(stop, taken.t),
    commit:
      thawed === undefined
        ? null
        : {
            acked: thawed.ev === "commit",
            name: typeof thawed["name"] === "string" ? thawed["name"] : null,
            message: typeof thawed["message"] === "string" ? thawed["message"] : null,
            epoch: epochOf(thawed),
          },
    epochBefore: epochOf(lastCommit),
    lastAck: offsetOf(lastCommit, partition)!,
    otherFirst: (pause.other.find((event) => event.ev === "read" && event.t >= stop && event["partition"] === partition)?.["first"] as number | undefined) ?? null,
    otherLast: otherCommit === undefined ? null : offsetOf(otherCommit, partition),
    rejoin: rejoined === undefined ? null : secondsBetween(thaw, rejoined.t),
    reassigned: after.some((event) => event.ev === "assigned" && event.t >= thaw && event.t <= ackAt && partitionsOf(event, "partitions").includes(partition)),
    committed: committed === undefined ? null : offsetOf(committed, partition),
    stale: thawed === undefined ? null : offsetOf(thawed, partition),
  };
  const findings = findingsOf(pauseReading, prediction, pause.fences, taken !== undefined);
  return { ...base, void: null, finding: findings.length === 0 ? null : findings.join(". "), pause: pauseReading };
};
