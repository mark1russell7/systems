import { quantity, valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import type { PausePrediction, ProbeEvent, Run } from "./cell.ts";
import { isFenceLine, logTimeOf, measurePause, namesGroup, pauseReady } from "./pause.ts";

const S = 1e9;
const s = (value: number) => quantity(value, "s");
/** This instant is the stop of the first member. Each hand-written line counts from it. */
const STOP = 100 * S;
const WALL = 1_700_000_000_000;
const THAW = STOP + 60 * S;

const at = (seconds: number): number => STOP + seconds * S;
const start: ProbeEvent = { ev: "start", t: at(-20), wall: WALL };

/** This function gives a log line of the broker at an instant of the run, as its console writes it. */
const logLine = (seconds: number, text: string): string => {
  const date = new Date(WALL + (seconds + 20) * 1000);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const stamp = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())},${pad(date.getUTCMilliseconds(), 3)}`;
  return `[${stamp}] INFO [GroupCoordinator id=1] ${text}`;
};

const FENCE = "[GroupId g] Member m1 fenced from the group because the member session expired.";

/** These are the lines of the first member before the stop: it holds partition 0, and its last acknowledged commit is 20. */
const beforeStop: ProbeEvent[] = [
  start,
  { ev: "assigned", t: at(-15), partitions: [0], held: [0], epoch: 3, member: "m1" },
  { ev: "commit", t: at(-10), offsets: { "0": 10 }, epoch: 3 },
  { ev: "commit", t: at(-5), offsets: { "0": 20 }, epoch: 3 },
  { ev: "read", t: at(-1), partition: 0, first: 20, last: 29, count: 10 },
  { ev: "processing", t: at(-1) },
];

/** These are the lines of the other member before the stop. */
const otherBefore: ProbeEvent[] = [{ ev: "assigned", t: at(-15), partitions: [1], held: [1], epoch: 4, member: "m2" }];

/** These are the lines of the other member after a takeover at 44 s. */
const takeover: ProbeEvent[] = [
  { ev: "assigned", t: at(44), partitions: [0], held: [0, 1], epoch: 6, member: "m2" },
  { ev: "read", t: at(44.1), partition: 0, first: 20, last: 29, count: 10 },
  { ev: "commit", t: at(44.2), offsets: { "0": 30 }, epoch: 6 },
  { ev: "commit", t: at(45), offsets: { "0": 1000 }, epoch: 6 },
];

const thawPause: ProbeEvent = { ev: "pause", t: at(60.01), gap: 60 * S, in: "process" };

const runOf = (first: readonly ProbeEvent[], other: readonly ProbeEvent[], fences: readonly string[] = []): Run => ({
  environment: 0,
  index: 0,
  events: [...beforeStop, thawPause, ...first],
  fault: { t0: STOP, t1: STOP + 1000 },
  heal: { t0: THAW, t1: THAW + 1000 },
  kernel: [],
  netns: 1,
  targetNetns: 2,
  lost: 0,
  pause: { other: [...otherBefore, ...other], fences, group: "g" },
});

const LONG: PausePrediction = {
  fence: { low: s(39.9), high: s(46) },
  takeover: { low: s(39.9), high: s(51.5) },
  thaw: "fails",
};

const failed: ProbeEvent = { ev: "commit-fail", t: at(60.02), name: "CommitFailedException", message: "unknown member", offsets: { "0": 30 }, epoch: 3 };

describe("the reading of a paused consumer", () => {
  it("holds the law of a stop above the session", () => {
    const read = measurePause(runOf([failed], takeover, [logLine(43, FENCE)]), LONG);
    expect(read.void).toBeNull();
    expect(read.finding).toBeNull();
    expect(valueIn(read.pause!.fence!, "s")).toBeCloseTo(43, 3);
    expect(valueIn(read.pause!.takeover!, "s")).toBeCloseTo(44, 3);
    expect(read.pause).toMatchObject({ partition: 0, lastAck: 20, otherFirst: 20, stale: 30, commit: { acked: false, name: "CommitFailedException" } });
  });

  it("finds a fence outside its band", () => {
    const read = measurePause(runOf([failed], takeover, [logLine(30, FENCE)]), LONG);
    expect(read.finding).toContain("the fence is 30 s, outside [39.9, 46] s");
  });

  it("finds an acknowledgment where the law has a failure", () => {
    const acked: ProbeEvent = { ev: "commit", t: at(60.02), offsets: { "0": 30 }, epoch: 3 };
    const read = measurePause(runOf([acked], takeover, [logLine(43, FENCE)]), LONG);
    expect(read.finding).toContain("gave an acknowledgment, not CommitFailedException");
  });

  it("finds that the other member started past the last commit", () => {
    const skipped = takeover.map((event) => (event.ev === "read" ? { ...event, first: 30 } : event));
    const read = measurePause(runOf([failed], skipped, [logLine(43, FENCE)]), LONG);
    expect(read.finding).toContain("started at offset 30, and the last commit is 20");
  });

  it("holds the law of a stop below the session, with no fence and the same epoch", () => {
    const short: PausePrediction = { fence: null, takeover: null, thaw: "acknowledged" };
    const acked: ProbeEvent = { ev: "commit", t: at(60.02), offsets: { "0": 30 }, epoch: 3 };
    const read = measurePause(runOf([acked], []), short);
    expect(read.void).toBeNull();
    expect(read.finding).toBeNull();
    expect(read.pause).toMatchObject({ fence: null, takeover: null, epochBefore: 3 });
  });

  it("finds a fence and a takeover in a stop below the session", () => {
    const short: PausePrediction = { fence: null, takeover: null, thaw: "acknowledged" };
    const acked: ProbeEvent = { ev: "commit", t: at(60.02), offsets: { "0": 30 }, epoch: 3 };
    const read = measurePause(runOf([acked], takeover, [logLine(43, FENCE)]), short);
    expect(read.finding).toContain("the group removed a member");
    expect(read.finding).toContain("the other member reported the partition");
  });

  const REJOIN: PausePrediction = { ...LONG, thaw: "rejoin", rejoinWithin: s(2) };
  const rejoined: ProbeEvent = { ev: "rejoined", t: at(60.5), before: 3, epoch: 9 };
  const stale: ProbeEvent = { ev: "commit", t: at(60.6), offsets: { "0": 30 }, epoch: 9 };
  const readBack: ProbeEvent = { ev: "committed", t: at(60.7), offsets: { "0": 30 } };

  it("holds the law of a commit after a rejoin, which moves the offset back", () => {
    const read = measurePause(runOf([rejoined, stale, readBack], takeover, [logLine(43, FENCE)]), REJOIN);
    expect(read.finding).toBeNull();
    expect(read.pause).toMatchObject({ reassigned: false, committed: 30, stale: 30, otherLast: 1000 });
    expect(valueIn(read.pause!.rejoin!, "s")).toBeCloseTo(0.5, 3);
  });

  it("finds a commit after a rejoin that the broker refuses or that does not move back", () => {
    const refused: ProbeEvent = { ev: "commit-fail", t: at(60.6), name: "CommitFailedException", message: "no", offsets: { "0": 30 }, epoch: 9 };
    const read = measurePause(runOf([rejoined, refused], takeover, [logLine(43, FENCE)]), REJOIN);
    expect(read.finding).toContain("the stale commit failed with CommitFailedException");
    const late: ProbeEvent = { ...rejoined, t: at(63) };
    expect(measurePause(runOf([late, { ...stale, t: at(63.1) }, { ...readBack, t: at(63.2) }], takeover, [logLine(43, FENCE)]), REJOIN).finding).toContain("above 2 s");
  });

  it("finds the partition again in the hands of the member before its commit", () => {
    const again: ProbeEvent = { ev: "assigned", t: at(60.55), partitions: [0], held: [0], epoch: 9, member: "m1" };
    const read = measurePause(runOf([rejoined, again, stale, readBack], takeover, [logLine(43, FENCE)]), REJOIN);
    expect(read.finding).toContain("held the partition again");
  });

  it("voids a run with no fault, a stop outside a batch, or a lost log line", () => {
    expect(measurePause({ ...runOf([failed], takeover), fault: null }, LONG).void).toContain("not one for each member");
    const poll = runOf([failed], takeover);
    const inPoll = { ...poll, events: poll.events.map((event) => (event.ev === "pause" ? { ...event, in: "poll" } : event)) };
    expect(measurePause(inPoll, LONG).void).toContain("outside the processing");
    expect(measurePause(runOf([failed], takeover), LONG).void).toBe("the broker log lost the line of the fence");
  });

  it("voids a run where both members hold one partition each only after the stop", () => {
    const both: Run = { ...runOf([failed], takeover), pause: { other: takeover, fences: [], group: "g" } };
    expect(measurePause(both, LONG).void).toContain("not one for each member");
  });

  it("converts a log line to the clock of the member", () => {
    expect(logTimeOf(logLine(43, FENCE), start)).toBe(at(43));
    expect(logTimeOf("no stamp", start)).toBeNull();
  });

  it("knows the fence lines of each protocol and the group that each names", () => {
    const classic = "Member c-1 in group g has failed, removing it from the group.";
    expect(isFenceLine(FENCE)).toBe(true);
    expect(isFenceLine(classic)).toBe(true);
    expect(isFenceLine("Member m1 joined the group")).toBe(false);
    expect(namesGroup(FENCE, "g")).toBe(true);
    expect(namesGroup(classic, "g")).toBe(true);
    expect(namesGroup(FENCE, "g1")).toBe(false);
    expect(namesGroup(classic, "g1")).toBe(false);
  });

  it("waits for one partition for each member and two commits", () => {
    expect(pauseReady(beforeStop, otherBefore)).toBe(true);
    expect(pauseReady(beforeStop, [])).toBe(false);
    expect(pauseReady(beforeStop.slice(0, 3), otherBefore)).toBe(false);
    expect(pauseReady(beforeStop, [{ ev: "assigned", t: at(-15), partitions: [0], held: [0] }])).toBe(false);
    expect(pauseReady([...beforeStop, { ev: "assigned", t: at(-4), partitions: [1], held: [0, 1] }], otherBefore)).toBe(false);
  });
});
