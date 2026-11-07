import type { Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { PortsPrediction, ProbeEvent, Run } from "./cell.ts";
import type { Measured } from "./observe.ts";
import { bandWords, between, inside } from "./queue.ts";

/** This errno ends a search that found no port. */
const NO_PORT = "EADDRNOTAVAIL";

/** This record is what a run of a port cell measured. */
export interface PortsReading {
  /** This count is the rounds of the run, each destination once. */
  readonly rounds: number;
  /** This record gives the count of searches for each count of connects, by that count. */
  readonly counts: Readonly<Record<string, number>>;
  /** These offsets from the low port are the ports that the run used, in rising order. */
  readonly seen: readonly number[];
  /** These errnos ended the searches of the run, each one time. */
  readonly errnos: readonly string[];
  /** This time is the longest connect that failed. */
  readonly refusal: Quantity;
  /** This time is from the `closing` line to the first `freed` line. */
  readonly firstFreed: Quantity | null;
  /** This time is from the `closing` line to the last `freed` line. */
  readonly lastFreed: Quantity | null;
  /** This count is the `freed` lines of the run. */
  readonly freed: number;
  /** This count is the connects that failed before the last `freed` line. */
  readonly tries: number;
}

const portsOf = (line: ProbeEvent): readonly number[] =>
  Array.isArray(line["ports"]) ? line["ports"].filter((port): port is number => typeof port === "number") : [];

/** This function says if the ports of the parity of the low port come first in one search. */
const lowFirst = (ports: readonly number[], low: number): boolean => {
  const odd = ports.findIndex((port) => (port - low) % 2 !== 0);
  return odd < 0 || ports.slice(odd).every((port) => (port - low) % 2 !== 0);
};

/**
 * This function reads one run of a port cell. The `round` lines give each search. The `closing` and
 * `freed` lines give when each held port comes back. The records of the prober give the
 * retransmissions.
 */
export const measurePorts = (run: Run, expected: PortsPrediction): Measured => {
  const { events, kernel } = run;
  const retransmissions = kernel.filter((record) => record.netns === run.netns && record.ev === "retrans").length;
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
  if (events.find((event) => event.ev === "done") === undefined) return voided("the client did not reach its end");
  if (run.lost === null) return voided("the prober wrote no clock line after the run, so nothing says what it dropped");
  if (run.lost > 0) return voided(`the prober dropped ${run.lost} records`);

  const rounds = events.filter((event) => event.ev === "round");
  const closing = events.find((event) => event.ev === "closing");
  const freedLines = events.filter((event) => event.ev === "freed");
  const counts: Record<string, number> = {};
  for (const round of rounds) {
    const count = String(portsOf(round).length);
    counts[count] = (counts[count] ?? 0) + 1;
  }
  const seen = [...new Set(rounds.flatMap((round) => portsOf(round).map((port) => port - expected.low)))].sort((a, b) => a - b);
  const refusal = Math.max(0, ...rounds.map((round) => (typeof round["refusal"] === "number" ? round["refusal"] : 0)));
  const first = freedLines[0];
  const last = freedLines.at(-1);
  const ports: PortsReading = {
    rounds: rounds.length,
    counts,
    seen,
    errnos: [...new Set(rounds.map((round) => String(round["errno"])))],
    refusal: quantity(Math.round(refusal / 1e3) / 1e6, "s"),
    firstFreed: closing === undefined || first === undefined ? null : between(closing.t, first.t),
    lastFreed: closing === undefined || last === undefined ? null : between(closing.t, last.t),
    freed: freedLines.length,
    tries: last === undefined || typeof last["tries"] !== "number" ? 0 : last["tries"],
  };

  const found: string[] = [];
  const searches = expected.rounds * expected.destinations;
  if (ports.rounds !== searches) found.push(`${ports.rounds} searches, not ${searches}`);
  const stray = Object.keys(counts).filter((count) => !expected.counts.includes(Number(count)));
  if (stray.length > 0) found.push(`a search gave ${stray.join(" or ")} connects, outside ${expected.counts.join(" or ")}`);
  if (seen.join() !== expected.seen.join()) found.push(`the ports at offsets ${seen.join(" ")} were used, not ${expected.seen.join(" ")}`);
  if (ports.errnos.join() !== NO_PORT) found.push(`the searches ended with ${ports.errnos.join(" and ")}, not ${NO_PORT}`);
  if (valueIn(ports.refusal, "s") > valueIn(expected.refusedWithin, "s"))
    found.push(`a refused connect took ${valueIn(ports.refusal, "s")} s, above ${valueIn(expected.refusedWithin, "s")} s`);
  if (expected.share !== undefined) {
    const { count, low, high } = expected.share;
    const share = (counts[String(count)] ?? 0) / Math.max(1, ports.rounds);
    if (share < low || share > high) found.push(`the share of ${count} connects is ${share}, outside [${low}, ${high}]`);
  }
  if (expected.lowFirst === true && !rounds.every((round) => lowFirst(portsOf(round), expected.low)))
    found.push("a search got a port of the other parity before each port of the parity of the low port");
  if (expected.retransmissions !== undefined && retransmissions !== expected.retransmissions)
    found.push(`${retransmissions} retransmissions, not ${expected.retransmissions}`);
  if (expected.freed !== undefined) {
    const held = Math.max(...expected.counts);
    if (ports.freed !== held) found.push(`${ports.freed} ports came back, not ${held}`);
    for (const [name, time] of [["first", ports.firstFreed], ["last", ports.lastFreed]] as const) {
      if (time === null || !inside(time, expected.freed))
        found.push(`the ${name} port came back at ${time === null ? "no time" : `${valueIn(time, "s")} s`}, outside ${bandWords(expected.freed)}`);
    }
    if (ports.tries === 0) found.push("no connect was refused before the ports came back");
  }
  return { ...base, void: null, finding: found.length === 0 ? null : found.join(". "), ports };
};
