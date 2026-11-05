import type { Cell } from "@mark1russell7/harness";
import type { KindCell } from "@mark1russell7/kind";

/**
 * The pacing of each cell (SYS-91). A client in a closed loop sends a request only after the reply
 * before it, thus a slow reply delays the next send. The stall hides the requests that a fixed
 * schedule sends in it (Gil Tene, "How NOT to Measure Latency"). The table of SYS-91 in
 * `docs/ROADMAP.md` gives the effect on each family. This module reads the pacing from the cells,
 * thus a new closed-loop cell changes the counts, and a test names the table.
 */

/**
 * A pacing tells how the client of a cell sends, and what the cell gives from that:
 * - `one request`: an idle or an in-flight probe. No load exists, thus no send can be late.
 * - `one gap`: the time between two requests is the input of the cell. The cell gives a share or a
 *   count, not a time under load.
 * - `closed loop, reply times`: a stream that gives a distribution of reply times.
 * - `closed loop, first write`: a stream that gives a time to the first accepted write after a fault, or a drill.
 * - `timer`: a timer starts each request and does not wait for an answer. A slow reply delays no send.
 * - `open loop`: a schedule fixes the time of each send, and each latency counts from that planned time (SYS-68).
 */
export type Pacing = "one request" | "one gap" | "closed loop, reply times" | "closed loop, first write" | "timer" | "open loop";

/** This function gives the pacing of a cell of the harness. */
export const pacingOf = (cell: Cell): Pacing => {
  if (cell.probe.mode === "schedule") return "open loop";
  if (cell.probe.mode === "idle" || cell.probe.mode === "inflight") return "one request";
  if (cell.probe.mode === "gap") return "one gap";
  return "group" in cell.prediction ? "closed loop, first write" : "closed loop, reply times";
};

/** This function gives the family of a cell: the first two parts of its plan identifier, or the first word of its name. */
const familyOf = (cell: Cell): string => cell.name.split(/[ ,]/)[0]!.split(".").slice(0, 2).join(".");

/** This function counts the cells of each pacing. Each cell of kind has a timer: `Workload.every` starts each request. */
export const pacingCounts = (cells: readonly Cell[], kind: readonly KindCell[]): Readonly<Record<Pacing, number>> => {
  const count = (pacing: Pacing): number => cells.filter((cell) => pacingOf(cell) === pacing).length;
  return {
    "one request": count("one request"),
    "one gap": count("one gap"),
    "closed loop, reply times": count("closed loop, reply times"),
    "closed loop, first write": count("closed loop, first write"),
    timer: kind.length,
    "open loop": count("open loop"),
  };
};

/** This function gives the closed-loop families of the cells, each with its count, in the sequence of the names. */
export const closedLoopFamilies = (cells: readonly Cell[]): Readonly<Record<string, number>> => {
  const families = new Map<string, number>();
  for (const cell of cells) {
    if (!pacingOf(cell).startsWith("closed loop")) continue;
    const family = `${familyOf(cell)}: ${pacingOf(cell)}`;
    families.set(family, (families.get(family) ?? 0) + 1);
  }
  return Object.fromEntries([...families].sort(([a], [b]) => a.localeCompare(b)));
};
