import type { Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { EgressPacketLaw, EgressPrediction, ProbeEvent, Run } from "./cell.ts";
import type { Measured } from "./observe.ts";
import { bandWords, inside } from "./queue.ts";

/** This record is one datagram of an egress run, as the egress client wrote it. */
export interface EgressPacketReading {
  /** This count is the key of the datagram: its place in the order of the sends, from 0. */
  readonly key: number;
  /** This count is the place of its burst, from 0. */
  readonly burst: number;
  /**
   * This word is the end of the datagram. `sent` has a stamp of its departure. `dropped` is a send
   * that gave ENOBUFS. `unread` is a send that the qdisc took, with no stamp of its departure.
   */
  readonly outcome: "sent" | "dropped" | "unread";
  /** This time is the arrival of the datagram in the qdisc after the first arrival of its burst. */
  readonly arrived: Quantity;
  /** This time is the departure of the datagram after the first arrival of its burst, or null. */
  readonly left: Quantity | null;
}

/** This record is what a run of an egress cell measured. */
export interface EgressReading {
  /** This name is the kind of the root qdisc that `tc` read back. */
  readonly kind: string;
  readonly packets: readonly EgressPacketReading[];
  /** These times are the spread of the arrivals of each burst. */
  readonly spreads: readonly Quantity[];
  /** These times are the first arrival of each burst after the first arrival of the run. */
  readonly starts: readonly Quantity[];
  /** These counts are the rise of the counts of the root qdisc in the run. */
  readonly counts: { readonly packets: number; readonly drops: number };
  /** This time is the step of CLOCK_REALTIME from the start of the bursts to the end of the run. */
  readonly step: Quantity;
}

/**
 * This time is the largest step of CLOCK_REALTIME in a run that the judge accepts. The kernel stamps
 * each datagram on CLOCK_REALTIME, and the client moves the stamps to CLOCK_MONOTONIC with one
 * offset. A step of the clock moves each later stamp by the step. A step of 100 µs is less than one
 * tenth of the smallest band of the catalog.
 */
const MOST_STEP_NS = 100_000;

/** These are the first findings of a run that the words of its finding name. */
const NAMED = 5;

const numberOr = (line: ProbeEvent | undefined, field: string): number | null => {
  const value = line?.[field];
  return typeof value === "number" ? value : null;
};

/** This function gives one field of an object of a line, or undefined. */
const fieldOf = (value: unknown, field: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[field] : undefined;

const countOf = (value: unknown, field: string): number | null => {
  const count = fieldOf(value, field);
  return typeof count === "number" ? count : null;
};

const seconds = (ns: number): Quantity => quantity(Math.round(ns) / 1e9, "s");

const s = (time: Quantity): number => valueIn(time, "s");

/** This function gives the words of the law of one datagram. */
const lawWords = (law: EgressPacketLaw): string => (law.kind === "sent" ? `leaves in ${bandWords(law.left)}` : `is dropped at the ${law.why}`);

/** This function gives the findings of the datagrams that differ from their laws. */
const packetFindings = (read: EgressReading, expected: EgressPrediction): string[] => {
  const off: string[] = [];
  for (const packet of read.packets) {
    const law = expected.packets[packet.key];
    if (law === undefined || packet.outcome === "unread") continue;
    if (law.kind === "dropped" && packet.outcome === "sent")
      off.push(`the datagram ${packet.key} left at ${s(packet.left!)} s, and the law drops it at the ${law.why}`);
    else if (law.kind === "sent" && packet.outcome === "dropped") off.push(`the qdisc dropped the datagram ${packet.key}, and the law ${lawWords(law)}`);
    else if (law.kind === "sent" && packet.left !== null && !inside(packet.left, law.left))
      off.push(`the datagram ${packet.key} left at ${s(packet.left)} s, outside ${bandWords(law.left)}`);
  }
  return off.length === 0 ? [] : [`${off.length} of the ${read.packets.length} datagrams are outside the law: ${off.slice(0, NAMED).join("; ")}`];
};

/**
 * This function reads one run of an egress cell from the lines of the egress client. A run is void
 * when the client wrote an error or no `done` line, or when the qdisc is of another kind. A neighbour
 * of the target that is not permanent voids a run too. It is void too when the client sent another count of
 * datagrams than the law. A send that failed with an error other than ENOBUFS voids its run, and a
 * datagram with no stamp of its arrival voids it too. The arrivals void a run when one burst spreads more than `spread`, or
 * when a later burst starts more than `jitter` off its time. The counts of the qdisc void a run when
 * other traffic went through it. A step of the clock and a read of less than `read` of the
 * departures void a run too.
 */
export const measureEgress = (run: Run, expected: EgressPrediction): Measured => {
  const { events, kernel } = run;
  const base = {
    environment: run.environment,
    index: run.index,
    outcome: { kind: "answered" } as const,
    elapsed: null,
    socket: null,
    noticed: null,
    steps: [],
    probes: 0,
    retransmissions: kernel.filter((record) => record.netns === run.netns && record.ev === "retrans").length,
    acks: 0,
  };
  const voided = (why: string): Measured => ({ ...base, void: why, finding: null });
  const error = events.find((event) => event.ev === "error");
  if (error !== undefined) return voided(`the client stopped: ${String(error["what"])}`);
  const ready = events.find((event) => event.ev === "ready");
  if (ready === undefined) return voided("the client wrote no ready line");
  if (events.find((event) => event.ev === "done") === undefined) return voided("the client did not reach its end");
  const kind = String(fieldOf(ready["qdisc"], "kind") ?? "none");
  if (kind !== expected.kind) return voided(`tc reads a root qdisc of the kind ${kind}, not ${expected.kind}`);
  const states = fieldOf(ready["neighbour"], "state");
  if (!Array.isArray(states) || !states.includes("PERMANENT"))
    return voided(`the neighbour of the target is ${JSON.stringify(states ?? null)}, not PERMANENT: an ARP packet can go through the qdisc`);
  const lines = events.filter((event) => event.ev === "packet");
  if (lines.length !== expected.packets.length)
    return voided(`the client sent ${lines.length} datagrams, and the law has ${expected.packets.length}`);
  const failed = lines.find((line) => line["errno"] !== null && line["errno"] !== "ENOBUFS");
  if (failed !== undefined) return voided(`the send of the datagram ${String(failed["key"])} failed with ${String(failed["errno"])}`);
  const unstamped = lines.find((line) => numberOr(line, "sched") === null);
  if (unstamped !== undefined) return voided(`the datagram ${String(unstamped["key"])} has no stamp of its arrival in the qdisc`);
  // the first arrival of each burst, which the band of each datagram of the burst counts from
  const firsts = expected.bursts.map((_, burst) =>
    Math.min(...lines.filter((line) => line["burst"] === burst).map((line) => numberOr(line, "sched")!)),
  );
  const lasts = expected.bursts.map((_, burst) =>
    Math.max(...lines.filter((line) => line["burst"] === burst).map((line) => numberOr(line, "sched")!)),
  );
  const origin = firsts[0]!;
  const packets: EgressPacketReading[] = lines.map((line) => {
    const burst = numberOr(line, "burst") ?? 0;
    const first = firsts[burst] ?? origin;
    const left = numberOr(line, "left");
    const outcome = line["errno"] === "ENOBUFS" ? "dropped" : left === null ? "unread" : "sent";
    return {
      key: numberOr(line, "key") ?? -1,
      burst,
      outcome,
      arrived: seconds(numberOr(line, "sched")! - first),
      left: outcome === "sent" ? seconds(left! - first) : null,
    };
  });
  const stats = events.find((event) => event.ev === "stats");
  const rise = (field: string): number => (countOf(stats?.["after"], field) ?? 0) - (countOf(stats?.["before"], field) ?? 0);
  const egress: EgressReading = {
    kind,
    packets,
    spreads: firsts.map((first, burst) => seconds(lasts[burst]! - first)),
    starts: firsts.map((first) => seconds(first - origin)),
    counts: { packets: rise("packets"), drops: rise("drops") },
    step: seconds(numberOr(events.find((event) => event.ev === "clock"), "step") ?? 0),
  };
  const voidedWith = (why: string): Measured => ({ ...voided(why), egress });
  if (stats === undefined) return voidedWith("the client wrote no counts of the qdisc");
  const stepNs = Math.abs(s(egress.step) * 1e9);
  if (stepNs > MOST_STEP_NS) return voidedWith(`CLOCK_REALTIME stepped ${Math.round(stepNs / 1e3)} µs in the run, more than ${MOST_STEP_NS / 1e3} µs`);
  const wide = egress.spreads.findIndex((spread) => s(spread) > s(expected.spread));
  if (wide >= 0) return voidedWith(`the arrivals of the burst ${wide} spread ${s(egress.spreads[wide]!)} s, more than ${s(expected.spread)} s`);
  const at0 = s(expected.bursts[0]!.at);
  const late = expected.bursts.findIndex((burst, index) => Math.abs(s(egress.starts[index]!) - (s(burst.at) - at0)) > s(expected.jitter));
  if (late >= 0)
    return voidedWith(`the burst ${late} started ${s(egress.starts[late]!)} s after the first, more than ${s(expected.jitter)} s off ${s(expected.bursts[late]!.at) - at0} s`);
  const dropped = packets.filter((packet) => packet.outcome === "dropped").length;
  const taken = packets.length - dropped;
  if (egress.counts.packets !== taken || egress.counts.drops !== dropped)
    return voidedWith(
      `the qdisc counts ${egress.counts.packets} packets and ${egress.counts.drops} drops, and the client counts ${taken} sends and ${dropped} drops: other traffic went through the qdisc`,
    );
  const sent = packets.filter((packet) => packet.outcome === "sent").length;
  if (taken > 0 && sent < expected.read * taken)
    return voidedWith(`the judge read the departure of ${sent} of the ${taken} datagrams that the qdisc took, less than ${expected.read * 100}%`);
  const found = packetFindings(egress, expected);
  return { ...base, void: null, finding: found.length === 0 ? null : found.join(". "), egress };
};
