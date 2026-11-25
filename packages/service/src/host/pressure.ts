import type { HostPorts } from "./ports.ts";

/**
 * These files give the stall times of a Linux host (PSI, the pressure stall information). The supervisor reads the line
 * `full` of each file. A full stall is a time in which each task of the host waits for the resource.
 */
export const PRESSURE_FILES: readonly string[] = ["/proc/pressure/memory", "/proc/pressure/io"];

/**
 * This function gives the total time of the full stall in a text of a pressure file, in microseconds. A text with no line
 * `full` or with a bad total gives `null`.
 */
export const fullStallMicros = (text: string): number | null => {
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== "full") continue;
    const total = fields.find((field) => field.startsWith("total="));
    if (total === undefined) return null;
    const digits = total.slice("total=".length);
    if (!/^\d+$/.test(digits)) return null;
    const value = Number(digits);
    return Number.isSafeInteger(value) ? value : null;
  }
  return null;
};

/**
 * A stall mark is the full stall totals of the host at one monotonic time. Each total is in microseconds, in the order of
 * `PRESSURE_FILES`.
 */
export interface StallMark {
  /** This time is the monotonic time of the read, in milliseconds. */
  readonly at: number;
  readonly totals: readonly number[];
}

/**
 * This function reads the full stall totals of the host. A host that is not Linux, a file that does not exist and a file
 * that the supervisor cannot read or use each give `null`.
 */
export const readStallMark = async (ports: Pick<HostPorts, "platform" | "files" | "clock">): Promise<StallMark | null> => {
  if (ports.platform !== "linux") return null;
  const totals: number[] = [];
  for (const path of PRESSURE_FILES) {
    let text: string | null;
    try {
      text = await ports.files.read(path);
    } catch {
      return null;
    }
    const total = text === null ? null : fullStallMicros(text);
    if (total === null) return null;
    totals.push(total);
  }
  return { at: ports.clock.now(), totals };
};

/**
 * This function gives the share of the time from `from` to `to` in which the host was in a full stall. The share is the
 * largest share of the resources. A span of zero, totals that go back and two marks of different lengths give `null`.
 */
export const stalledShare = (from: StallMark, to: StallMark): number | null => {
  const spanMicros = (to.at - from.at) * 1000;
  if (!(spanMicros > 0) || from.totals.length !== to.totals.length) return null;
  let largest = 0;
  for (let index = 0; index < to.totals.length; index += 1) {
    const stalled = to.totals[index]! - from.totals[index]!;
    if (stalled < 0) return null;
    largest = Math.max(largest, stalled / spanMicros);
  }
  return Math.min(largest, 1);
};
