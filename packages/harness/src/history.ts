import type { Cell, HistoryVerdict, ProbeEvent, Run } from "./cell.ts";
import type { Measured } from "./observe.ts";

/**
 * This module reads the history of a run of an etcd cluster (`Cell.etcd`, SYS-75). The client
 * `etcd-kv` writes one `op` line for each operation. The history is those lines in the form that
 * the checker of linearizability reads. The checker gives one verdict for the whole history, and
 * the measurement of the run compares it with the prediction of its cell.
 */

/** A history line is one operation in the form of the checker: no other field, thus its decoder accepts it. */
export interface HistoryLine {
  readonly client: number;
  readonly op: "put" | "get";
  readonly key: string;
  readonly value?: string | null;
  readonly call: number;
  readonly return?: number;
  readonly result: "ok" | "fail" | "unknown";
}

/** These are the counts of the operations of a set by their result. */
export interface OpCounts {
  readonly ok: number;
  readonly fail: number;
  readonly unknown: number;
}

/**
 * A history measurement is what a run of an etcd cluster measured:
 * - `verdict` is the line of the checker, or null.
 * - `ops` counts each operation of the run by its result.
 * - `cut` counts the operations of the workers of the member that the fault cut, by their kind.
 *   Only an operation with its call in the hold counts: after the commit of the fault, and before
 *   the lift.
 */
export interface HistoryMeasured {
  readonly verdict: HistoryVerdict | null;
  readonly ops: OpCounts;
  readonly cut: { readonly put: OpCounts; readonly get: OpCounts };
}

const RESULTS: ReadonlySet<string> = new Set(["ok", "fail", "unknown"]);

/**
 * This function gives the history of the lines of a client, in their sequence. A line that is not
 * a whole operation is not in it. An unknown operation has no `return`. A put keeps its value, and
 * a get keeps the value that it read: null for a key with no value.
 */
export const historyOf = (events: readonly ProbeEvent[]): HistoryLine[] =>
  events.flatMap((event): HistoryLine[] => {
    const { op, key, client, call, result } = event as Record<string, unknown>;
    if (event.ev !== "op" || (op !== "put" && op !== "get") || typeof key !== "string") return [];
    if (typeof client !== "number" || typeof call !== "number" || typeof result !== "string" || !RESULTS.has(result)) return [];
    const back = event["return"];
    const value = event["value"];
    return [
      {
        client,
        op,
        key,
        ...(value === undefined || (typeof value !== "string" && value !== null) ? {} : { value }),
        call,
        ...(result === "unknown" || typeof back !== "number" ? {} : { return: back }),
        result: result as HistoryLine["result"],
      },
    ];
  });

/** This function gives a history as the input of the checker: one JSON line for each operation. */
export const historyText = (history: readonly HistoryLine[]): string => history.map((line) => `${JSON.stringify(line)}\n`).join("");

const VERDICTS: ReadonlySet<string> = new Set(["Ok", "Illegal", "Unknown"]);

/** This function reads the line of the checker from its output: the last line whose `ev` is `checked`. It gives null without one. */
export const verdictOfText = (text: string): HistoryVerdict | null => {
  for (const line of text.split(/\r?\n/).reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const read = parsed as Partial<Record<keyof HistoryVerdict | "ev", unknown>> | null;
    if (read === null || typeof read !== "object" || read.ev !== "checked" || typeof read.result !== "string" || !VERDICTS.has(read.result)) continue;
    const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : []);
    const count = (value: unknown): number => (typeof value === "number" ? value : 0);
    return {
      result: read.result as HistoryVerdict["result"],
      operations: count(read.operations),
      keys: count(read.keys),
      illegal: names(read.illegal),
      undecided: names(read.undecided),
      dropped: count(read.dropped),
      unknown: count(read.unknown),
    };
  }
  return null;
};

const NONE: OpCounts = { ok: 0, fail: 0, unknown: 0 };

/** This function counts operations by their result. */
const countOf = (lines: readonly ProbeEvent[]): OpCounts =>
  lines.reduce<OpCounts>((counts, line) => {
    const result = line["result"];
    return result === "ok" || result === "fail" || result === "unknown" ? { ...counts, [result]: counts[result] + 1 } : counts;
  }, NONE);

/** This function tells if the endpoint of an operation (`at`) is a host: the address or the name of a member. */
const atMember = (at: unknown, host: string): boolean => {
  if (typeof at !== "string") return false;
  try {
    return new URL(at).hostname === host;
  } catch {
    return false;
  }
};

/**
 * This function measures one run of an etcd cluster against its cell. The run is void when the
 * client wrote no ready line or no done line, thus the history can miss an operation. It is void
 * when the fault has no stamp, and when no operation of the cut member came in the hold. It is
 * void when the checker gave no verdict, or reached its timeout on a key. A verdict other than the
 * one of the prediction (`history`) is a finding.
 */
export const measureEtcd = (cell: Cell, run: Run): Measured & { readonly history: HistoryMeasured } => {
  const ops = run.events.filter((event) => event.ev === "op");
  const member = run.group?.at ?? null;
  // the client names each member by its address on the network
  const host = member === null ? null : (run.group?.members[member]?.ip ?? member);
  const fault = run.fault;
  const start = fault?.t1 ?? Infinity;
  const end = run.heal?.t0 ?? Infinity;
  const held = ops.filter((op) => host !== null && atMember(op["at"], host) && Number(op["call"]) >= start && Number(op["call"]) <= end);
  const verdict = run.history ?? null;
  const history: HistoryMeasured = {
    verdict,
    ops: countOf(ops),
    cut: { put: countOf(held.filter((op) => op["op"] === "put")), get: countOf(held.filter((op) => op["op"] === "get")) },
  };
  const base = {
    environment: run.environment,
    index: run.index,
    outcome: { kind: "answered" } as const,
    elapsed: null,
    socket: null,
    noticed: null,
    steps: [],
    probes: 0,
    retransmissions: 0,
    acks: history.ops.ok,
    history,
  };
  const voidOf = (): string | null => {
    if (!run.events.some((event) => event.ev === "ready")) return "the client wrote no ready line";
    if (!run.events.some((event) => event.ev === "done")) return "the client wrote no done line, thus the history can miss an operation";
    if (fault === null) return "the fault has no stamp";
    if (held.length === 0) return `no operation at the cut member ${member ?? "(none)"} came in the hold`;
    if (verdict === null) return "the checker gave no verdict";
    if (verdict.result === "Unknown") return `the check reached its timeout on ${verdict.undecided.join(", ") || "a key"}`;
    return null;
  };
  const why = voidOf();
  if (why !== null) return { ...base, void: why, finding: null };
  const expected = cell.prediction.detects === null ? cell.prediction.history : undefined;
  const result = verdict!.result;
  const finding =
    expected === undefined || result === expected
      ? null
      : `the history is ${result}, not ${expected}${verdict!.illegal.length === 0 ? "" : `: no linearization of ${verdict!.illegal.join(", ")}`}`;
  return { ...base, void: null, finding };
};
