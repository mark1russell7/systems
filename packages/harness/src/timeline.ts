import type { Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { Cell, KernelRecord, ProbeEvent, ReplicaSetStage, Run, SentinelEvent, SentinelStage, Stage } from "./cell.ts";
import { socketsOf } from "./driver.ts";
import { INJECT, noiseOf } from "./verdict.ts";

/**
 * This module measures a run of a group cell. It gives the first write that a primary accepted
 * after the fault, and the timeline of the group. The Sentinels of a group announce its timeline.
 * The logs of the members of a replica set and its client tell it. The module also gives what
 * became of each write.
 */

/** These are the stages of a timeline under Sentinels, in their sequence after a fault. */
export const STAGES: readonly SentinelStage[] = [
  "+sdown",
  "+odown",
  "+try-failover",
  "+elected-leader",
  "+selected-slave",
  "+promoted-slave",
  "+switch-master",
  "+convert-to-slave",
];

/** An error on the way is one kind of error that the client met after the fault. It has its first time from the fault, and its count. */
export interface ErrorOnTheWay {
  readonly name: string;
  readonly first: Quantity;
  readonly count: number;
}

/**
 * A writes record tells what became of the writes of a run, by their sequence numbers:
 * - `old` counts the writes that the primary of the start of the run accepted after the fault.
 * - `lost` are the writes that a primary accepted and the group did not keep. They are the cost
 *   of a split brain. It is null when the group did not converge after the run.
 * - `unknown` are the writes that the client sent and did not see accepted: an error, or no answer.
 *   `held` tells if the group kept each one, or null when it did not converge.
 */
export interface Writes {
  readonly sent: number;
  readonly acked: number;
  readonly old: number;
  readonly lost: readonly number[] | null;
  readonly unknown: ReadonlyArray<{ readonly n: number; readonly held: boolean | null }>;
}

/** A group measurement is what one run of a group cell measured, beside its time. */
export interface GroupMeasured {
  /** These are the member that was the primary at the start, and the member of the first accepted write after the fault. */
  readonly from: string;
  readonly to: string | null;
  /** These are the times of each stage from the fault: the first announcement by any Sentinel. A stage that no Sentinel announced is absent. */
  readonly stages: Partial<Record<Stage, Quantity>>;
  readonly writes: Writes;
  readonly errors: readonly ErrorOnTheWay[];
  /** These are the delays of the stamps of the observer after the writes of the Sentinels, for a calibration. */
  readonly lags?: readonly Quantity[];
}

const between = (from: number, to: number): Quantity => quantity(Math.round((to - from) / 1e3) / 1e6, "s");

/** This function gives the member whose address and port is `at`, or null. */
const memberAt = (run: Run, at: unknown): string | null => {
  if (typeof at !== "string") return null;
  const ip = at.split(":")[0];
  return Object.entries(run.group?.members ?? {}).find(([, part]) => part.ip === ip)?.[0] ?? null;
};

/** This function gives the time of each stage of a timeline from an instant: the first announcement of each, after the instant. */
export const stagesOf = (timeline: readonly SentinelEvent[], from: number): Partial<Record<Stage, Quantity>> => {
  const out: Partial<Record<Stage, Quantity>> = {};
  for (const line of timeline) {
    if (line.ev !== "sentinel" || line.t < from) continue;
    const stage = STAGES.find((each) => each === line.event);
    if (stage === undefined || out[stage] !== undefined) continue;
    // the down states count for the primary only, not for a replica or a Sentinel
    if ((stage === "+sdown" || stage === "+odown") && !String(line.detail ?? "").startsWith("master ")) continue;
    out[stage] = between(from, line.t);
  }
  return out;
};

/** These are the stages of the timeline of a replica set, in their usual sequence after a fault. */
export const REPLICA_SET_STAGES: readonly ReplicaSetStage[] = [
  "member-down",
  "election-start",
  "elected",
  "caught-up",
  "writable",
  "old-primary-steps-down",
  "discovered",
  "written-off",
  "first-write",
];

/**
 * A member mark is how a log line of mongod marks a stage: by its id, or by its message. The
 * message is the fallback for a version whose ids differ. `at` tells where the line comes from:
 * the old primary, or another member.
 */
interface MemberMark {
  readonly ids: readonly number[];
  readonly message: RegExp;
  readonly at: "old" | "other";
}

/** These are the log lines of mongod that mark each stage of a member. */
export const MEMBER_MARKS: Readonly<Record<Exclude<ReplicaSetStage, "discovered" | "written-off" | "first-write">, MemberMark>> = {
  "member-down": { ids: [21216], message: /now in state DOWN/, at: "other" },
  "election-start": { ids: [4615652, 21437], message: /^Starting an election|Skipping dry run|Conducting a dry run/, at: "other" },
  elected: { ids: [21450], message: /^Election succeeded/, at: "other" },
  "caught-up": { ids: [21363], message: /^Exited primary catch-up mode/, at: "other" },
  writable: { ids: [21331], message: /^Transition to primary complete/, at: "other" },
  "old-primary-steps-down": { ids: [21809, 21475, 962660], message: /relinquishing primary|Stepping down from primary/, at: "old" },
};

/** This function tells if a log line of a member marks a stage, with the old primary of the run. */
const marks = (line: SentinelEvent, stage: keyof typeof MEMBER_MARKS, old: string, oldAddress: string): boolean => {
  const mark = MEMBER_MARKS[stage];
  const member = String(line["member"] ?? "");
  if ((mark.at === "old") !== (member === old)) return false;
  const attr = (line["attr"] ?? {}) as Record<string, unknown>;
  // the DOWN state counts for the old primary only, as another member sees it
  if (stage === "member-down" && !JSON.stringify(attr).includes(oldAddress)) return false;
  // the generic state change of the old primary: PRIMARY to another state
  if (stage === "old-primary-steps-down" && Number(line["id"]) === 21358 && attr["oldState"] === "PRIMARY") return true;
  return mark.ids.includes(Number(line["id"])) || mark.message.test(String(line["msg"] ?? ""));
};

/**
 * This function gives the time of each stage of a replica set from an instant, in a run. The stages
 * of the members come from their log lines (`ev` "mongod"), whose times the lab puts on the
 * monotonic clock. The stages of the client come from its lines:
 * - `discovered`: a member other than the old primary becomes RSPrimary in the view of the client.
 * - `written-off`: the first heartbeat of the client to the old primary that fails.
 * - `first-write`: the first write that a primary accepts, of a write that the client sent after
 *   the commit of the fault (`sentAfter`). It is on a new primary when `lands` is `new`.
 */
export const replicaSetStagesOf = (
  run: Run,
  from: number,
  sentAfter: number,
  lands: "new" | "same",
): Partial<Record<Stage, Quantity>> => {
  const out: Partial<Record<Stage, Quantity>> = {};
  const old = run.group?.primary ?? "";
  const oldIp = run.group?.members[old]?.ip ?? "";
  const oldAddress = `${oldIp}:`;
  for (const line of run.group?.timeline ?? []) {
    if (line.ev !== "mongod" || line.t < from) continue;
    for (const stage of Object.keys(MEMBER_MARKS) as Array<keyof typeof MEMBER_MARKS>)
      if (out[stage] === undefined && marks(line, stage, old, oldAddress)) out[stage] = between(from, line.t);
  }
  const isOld = (address: unknown): boolean => typeof address === "string" && address.startsWith(oldAddress);
  for (const event of run.events) {
    if (event.t < from) continue;
    if (out.discovered === undefined && event.ev === "sdam" && event["event"] === "server-changed" && !isOld(event["address"])) {
      const next = event["next"] as { readonly type?: string } | null;
      if (next?.type === "RSPrimary") out.discovered = between(from, event.t);
    }
    if (out["written-off"] === undefined && event.ev === "sdam" && event["event"] === "heartbeat-failed" && isOld(event["address"]))
      out["written-off"] = between(from, event.t);
  }
  const accepted = acceptedAfter(run, sentAfter, lands);
  if (accepted !== undefined) out["first-write"] = between(from, accepted.t);
  return out;
};

/** This function gives the first write that a primary accepted, of a write sent after an instant. It is on a new primary for `new`. */
const acceptedAfter = (run: Run, sentAfter: number, lands: "new" | "same"): ProbeEvent | undefined => {
  const sent = new Map<number, number>();
  for (const event of run.events) if (event.ev === "sent") sent.set(Number(event["n"]), event.t);
  const primary = run.group?.primary ?? "";
  return run.events.find((event) => {
    if (event.ev !== "ack" || (sent.get(Number(event["n"])) ?? -Infinity) <= sentAfter) return false;
    const member = memberAt(run, event["at"]);
    return member !== null && (lands === "new" ? member !== primary : true);
  });
};

/** This function gives what became of each write of a run, from the lines of the client and the keys that the group kept. */
export const writesOf = (run: Run, after: number, primary: string): Writes => {
  const { events } = run;
  const sent = events.filter((event) => event.ev === "sent");
  // without its done line, the stop ended the last write that the client sent
  const done = events.find((event) => event.ev === "done")?.t ?? sent.at(-1)?.t ?? Infinity;
  const acks = new Map<number, ProbeEvent>();
  for (const event of events) if (event.ev === "ack") acks.set(Number(event["n"]), event);
  const holds = run.group?.holds ?? null;
  const kept = holds === null ? null : new Set(holds);
  const old = [...acks.values()].filter((event) => event.t > after && memberAt(run, event["at"]) === primary).length;
  const lost = kept === null ? null : [...acks.keys()].filter((n) => !kept.has(n)).sort((a, b) => a - b);
  // a write in flight when the client stopped is not on the way: the stop ended it
  const unknown = sent
    .filter((event) => event.t < done && !acks.has(Number(event["n"])))
    .map((event) => {
      const n = Number(event["n"]);
      return { n, held: kept === null ? null : kept.has(n) };
    });
  return { sent: sent.length, acked: acks.size, old, lost, unknown };
};

/** This function gives the errors that the client met after an instant: each kind, its first time, and its count. */
export const errorsOf = (events: readonly ProbeEvent[], after: number): ErrorOnTheWay[] => {
  const done = events.find((event) => event.ev === "done")?.t ?? Infinity;
  const kinds = new Map<string, { first: number; count: number }>();
  for (const event of events) {
    if (event.t <= after || event.t >= done) continue;
    const name =
      event.ev === "error"
        ? String(event["errno"] ?? event["name"] ?? "error")
        : event.ev === "fail"
          ? String(event["name"] ?? "fail")
          : event.ev === "sentinel-error"
            ? "sentinel-error"
            : null;
    if (name === null) continue;
    const seen = kinds.get(name);
    if (seen === undefined) kinds.set(name, { first: event.t, count: 1 });
    else seen.count += 1;
  }
  return [...kinds].map(([name, { first, count }]) => ({ name, first: between(after, first), count }));
};

/**
 * This function gives the delay of each stamp of the observer after the write of its Sentinel that
 * the observer read. That write is the latest write of the Sentinel's socket toward the observer,
 * at the stamp or before it. The prober records each write (`tx`) on the clock of the stamps.
 */
export const lagsOf = (run: Run, kernel: readonly KernelRecord[]): Quantity[] => {
  const timeline = run.group?.timeline ?? [];
  const locals = new Map<string, string>();
  for (const line of timeline) if (line.ev === "subscribed") locals.set(String(line.sentinel), String(line["local"]));
  const out: Quantity[] = [];
  for (const line of timeline) {
    if (line.ev !== "sentinel") continue;
    const sentinel = String(line.sentinel);
    const local = locals.get(sentinel);
    if (local === undefined) continue;
    const write = kernel
      .filter((record) => record.ev === "tx" && record.src === sentinel && record.dst === local && record.mono <= line.t)
      .at(-1);
    if (write !== undefined) out.push(between(write.mono, line.t));
  }
  return out;
};

/** This type is the measurement of observe.ts, which a group run fills. */
export interface GroupReading {
  readonly outcome: { readonly kind: "answered" } | { readonly kind: "silent" };
  readonly elapsed: Quantity | null;
  readonly socket: Quantity | null;
  readonly noticed: Quantity | null;
  readonly void: string | null;
  readonly finding: string | null;
  readonly group: GroupMeasured;
}

/**
 * This function reads one run of a group cell.
 * - The reference is the start of the commit of the fault, as the injector stamped it. For a
 *   stall, it is the first write into the fault, as for the stall of a direct pair.
 * - The outcome is the first write that a primary accepted after the fault. The prediction says
 *   which primary: a new one, or the same one after the lift. In a replica set, it is the first
 *   accepted write of a write that the client sent after the commit of the fault.
 * - The stages come from the Sentinels, or from the logs of the members of a replica set and the
 *   lines of its client (`replicaSetStagesOf`).
 * - Its time is the last segment with data that the client's socket to that primary received
 *   before the client saw the acceptance. The stamp of the client is the fallback.
 * - A run is void when the prober lost records, or when the client did not become ready. It is
 *   also void when a Sentinel entered its TILT mode, or when the election split its votes. A band
 *   from the fault whose commit took longer than δ_abs is void too. So is a band whose hold lifted
 *   more than δ_abs late.
 */
export const measureGroup = (cell: Cell, run: Run): GroupReading => {
  const { events, kernel } = run;
  const { prediction } = cell;
  const expected = prediction.group;
  const primary = run.group?.primary ?? "";
  const ready = events.find((event) => event.ev === "ready");
  const t0 = run.fault?.t0;
  const empty: GroupMeasured = {
    from: primary,
    to: null,
    stages: {},
    writes: { sent: 0, acked: 0, old: 0, lost: null, unknown: [] },
    errors: [],
  };
  const silent = { outcome: { kind: "silent" } as const, elapsed: null, socket: null, noticed: null, finding: null };
  if (ready === undefined) return { ...silent, void: "the client never became ready", group: empty };
  if (t0 === undefined || run.fault === null) return { ...silent, void: "the fault never committed", group: empty };
  if (run.lost === null)
    return { ...silent, void: "the prober wrote no clock line after the run, so nothing says what it dropped", group: empty };
  if (run.lost > 0) return { ...silent, void: `the prober dropped ${run.lost} records`, group: empty };
  const timeline = run.group?.timeline ?? [];
  const heal = run.heal ?? null;
  const lands = expected?.lands ?? "new";
  // a replica set has no authority: its members and the client tell its stages
  const replica = cell.replicaSet !== undefined;
  const stall = prediction.detects === false && prediction.recovers !== undefined;
  const stages = replica ? replicaSetStagesOf(run, t0, run.fault.t1, lands) : stagesOf(timeline, t0);
  // the first write that a primary accepted after the fault: on a new primary, or on the same one
  // after the lift. In a replica set, it is the first write sent after the commit of the fault
  // that a primary accepts: a partial cut leaves the old primary its writes
  const after = lands === "same" && heal !== null && (!replica || stall) ? heal.t0 : t0;
  const sentAt = new Map<number, number>();
  for (const event of events) if (event.ev === "sent") sentAt.set(Number(event["n"]), event.t);
  const accepted = events.find((event) => {
    if (event.ev !== "ack" || event.t <= after) return false;
    if (replica && (sentAt.get(Number(event["n"])) ?? -Infinity) <= run.fault!.t1) return false;
    const member = memberAt(run, event["at"]);
    return member !== null && (lands === "new" ? member !== primary : true);
  });
  const to = accepted === undefined ? null : memberAt(run, accepted["at"]);
  // the first write of a replica set is the outcome itself: a stall's first write is the write into it
  if (replica) {
    delete stages["first-write"];
    if (accepted !== undefined) stages["first-write"] = between(t0, accepted.t);
  }
  const group: GroupMeasured = {
    from: primary,
    to,
    stages,
    writes: writesOf(run, t0, primary),
    errors: errorsOf(events, t0),
    ...(cell.calibrates === "sentinels" ? { lags: lagsOf(run, kernel) } : {}),
  };
  let voided: string | null = null;
  const tilt = timeline.find((line) => line.ev === "sentinel" && line.event === "+tilt" && line.t >= t0);
  if (tilt !== undefined) voided = `a Sentinel entered TILT ${between(t0, tilt.t).value} s after the fault: the host delayed it, not its timers`;
  const split = timeline.find((line) => line.ev === "sentinel" && line.event === "-failover-abort-not-elected" && line.t >= t0);
  const elected = timeline.find((line) => line.ev === "sentinel" && line.event === "+elected-leader" && line.t >= t0);
  if (voided === null && split !== undefined && (elected === undefined || elected.t > split.t))
    voided = "the election split its votes and runs again after 2 × failover-timeout, which the band does not bound";
  // a Sentinel starts a failover in the tick of its +odown, unless an attempt of its own came less
  // than 2 × failover-timeout before: then the run measured an earlier run, not its own fault
  const odown = stages["+odown"];
  if (voided === null && odown !== undefined && stages["+try-failover"] === undefined)
    voided = "no Sentinel started a failover after +odown: each was in the hold-off of 2 × failover-timeout after an earlier attempt";
  // a hold lifts at its instant in the VM: a band assumes that instant, and a lift later than the
  // noise moved each stage after it
  if (voided === null && cell.hold !== undefined && prediction.detects !== null) {
    if (heal === null) voided = "the fault never lifted";
    else {
      const late = (heal.t0 - t0) / 1e9 - valueIn(cell.hold, "s");
      if (late > valueIn(INJECT, "s"))
        voided = `the lift came ${Math.round(late * 1e4) / 10} ms after its hold: the injector was late, not the group`;
    }
  }
  // a band holds for the round trips that it assumes: the first one of the client's socket to the old primary
  const assumed = prediction.detects === null ? undefined : prediction.rtt;
  const first = kernel.find(
    (record) =>
      record.netns === run.netns &&
      record.dst === `${run.group?.members[primary]?.ip}:${(cell.group ?? cell.replicaSet)?.port}` &&
      record.tcp?.srtt !== undefined,
  );
  const rtt = first?.tcp?.srtt === undefined ? null : valueIn(first.tcp.srtt, "us") / 1000;
  if (voided === null && assumed !== undefined && rtt !== null && rtt > valueIn(assumed.high, "ms"))
    voided = `rtt-over-assumption: its first round trip was ${rtt} ms, above the ${valueIn(assumed.high, "ms")} ms that the prediction assumes`;
  if (voided === null && prediction.detects === true && prediction.from === "fault" && (run.fault.t1 - run.fault.t0) / 1e6 > valueIn(INJECT, "ms"))
    voided = `the commit of the fault took ${Math.round((run.fault.t1 - run.fault.t0) / 1e5) / 10} ms, longer than the noise of the pipeline: its start is not known`;

  // the reference: the fault, or for a stall the first write into it
  let reference = t0;
  if (prediction.detects === false && prediction.recovers !== undefined) {
    const into = events.find((event) => event.ev === "sent" && event.t > run.fault!.t1);
    if (into === undefined || (heal !== null && into.t > heal.t0)) {
      voided ??= "the write in flight went out before the fault held";
    } else {
      reference = into.t;
      // the stall must end where the prediction assumed: after the firing before, and before its own
      const { heal: bounds } = prediction.recovers;
      if (heal === null) voided ??= "the stall never ended";
      else if (
        valueIn(between(reference, heal.t0), "s") <= valueIn(bounds.low, "s") ||
        valueIn(between(reference, heal.t1), "s") >= valueIn(bounds.high, "s")
      )
        voided ??= `the stall ended ${between(reference, heal.t0).value}–${between(reference, heal.t1).value} s after the write, outside the ${bounds.low.value}–${bounds.high.value} s its prediction assumed`;
    }
  }

  // findings: a failover where none should be, a client on the wrong primary, an error out of its band
  const findings: string[] = [];
  // a failover: a Sentinel switches the primary, or another member of a replica set wins an election
  const switched = replica ? stages["elected"] : stages["+switch-master"];
  if (expected?.failover === false && switched !== undefined)
    findings.push(`the group failed over ${switched.value} s after the fault, where it should not`);
  for (const stage of expected?.quiet ?? []) {
    const at = stages[stage];
    if (at !== undefined) findings.push(`${stage} came ${at.value} s after the fault, where it should not`);
  }
  if (accepted !== undefined && lands === "same" && to !== primary)
    findings.push(`the client wrote to ${to ?? String(accepted["at"])}, where it should stay on ${primary}`);
  for (const error of expected?.errors ?? []) {
    const met = group.errors.find((each) => each.name === error.name);
    const noise = valueIn(noiseOf(cell), "s");
    if (met === undefined) findings.push(`the client never met ${error.name}`);
    else if (met.first.value < valueIn(error.low, "s") - noise || met.first.value > valueIn(error.high, "s") + noise)
      findings.push(`the client met ${error.name} ${met.first.value} s after the fault, outside [${valueIn(error.low, "s")}, ${valueIn(error.high, "s")}] s`);
  }
  if (accepted === undefined) {
    if (prediction.detects !== null)
      findings.push(lands === "new" ? "the client never wrote to a new primary in the window" : "the client never wrote again in the window");
    return { ...silent, void: voided, finding: findings[0] ?? null, group };
  }
  // the kernel's time of the acceptance: the last segment with data from that primary at the
  // client's stamp or before it. The monitor and the pinger of a driver have their own sockets to
  // each member, thus only the sockets of the pool count
  const address = String(accepted["at"]);
  const others = new Set(socketsOf(events).filter((socket) => socket.role !== "pool").map((socket) => socket.local));
  const segment = kernel
    .filter(
      (record) =>
        record.netns === run.netns &&
        record.ev === "rx" &&
        record.dst === address &&
        !others.has(String(record.src)) &&
        (record.seg?.len.value ?? 0) > 0 &&
        record.mono <= accepted.t &&
        record.mono > after,
    )
    .at(-1);
  const at = segment?.mono ?? accepted.t;
  return {
    outcome: { kind: "answered" },
    elapsed: between(reference, at),
    socket: between(reference, accepted.t),
    noticed: segment === undefined ? null : between(segment.mono, accepted.t),
    void: voided,
    finding: findings[0] ?? null,
    group,
  };
};
