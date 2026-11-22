/**
 * This module keeps the measured ready times of a program, and it gives the ready window of the next start from them.
 * The supervisor keeps the times in the file `<stateDir>/<name>.ready.json`. Thus a new supervisor keeps them.
 */

/** The format of the file of the ready times. */
export const READY_TIMES_FORMAT = "service-ready-times/1";

/** The factor of the window after a start that is not ready in it. The next window is at least two times the window that it missed. */
export const MISSED_GROWTH = 2;

/**
 * A ready time is one start of a program. It has its wall time, and the milliseconds from its spawn to the first pass of
 * its ready probe. A missed start has `missed`. Its milliseconds are the window that it missed: the start needed more time.
 */
export interface ReadyTime {
  readonly at: string;
  readonly ms: number;
  readonly missed?: true | undefined;
}

/** A window rule is a measured window in milliseconds, with `firstMs` as the window before the program has `after` ready times. */
export interface WindowRule {
  readonly firstMs: number;
  readonly after: number;
  readonly keep: number;
  readonly floorMs: number;
  readonly capMs: number;
}

/** A measured window is the window of the next start, with its count of ready times and its count of missed starts. */
export interface MeasuredWindowMs {
  readonly ms: number;
  readonly measured: number;
  readonly missed: number;
}

/** A read of a file of ready times: its times, and the problem of a file that the supervisor cannot use. */
export interface ReadyTimesRead {
  readonly times: readonly ReadyTime[];
  readonly problem: string | null;
}

const isReadyTime = (value: unknown): value is ReadyTime => {
  if (typeof value !== "object" || value === null) return false;
  const { at, ms, missed } = value as Record<string, unknown>;
  return typeof at === "string" && typeof ms === "number" && Number.isFinite(ms) && ms >= 0 && (missed === undefined || missed === true);
};

/** This function gives the index of the last ready time that is not a missed start, or -1. */
const lastReady = (times: readonly ReadyTime[]): number => {
  for (let index = times.length - 1; index >= 0; index -= 1) if (times[index]?.missed !== true) return index;
  return -1;
};

/**
 * This function reads the ready times of the text of a file. A missing file (null) gives no times and no problem.
 * A text that is not JSON, another format and a time with a wrong form give no times and a problem.
 */
export const parseReadyTimes = (text: string | null): ReadyTimesRead => {
  if (text === null) return { times: [], problem: null };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { times: [], problem: "the file is not JSON" };
  }
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const times = record["times"];
  if (record["format"] !== READY_TIMES_FORMAT || !Array.isArray(times)) return { times: [], problem: `the file is not of the format ${READY_TIMES_FORMAT}` };
  if (!times.every(isReadyTime)) return { times: [], problem: "a time of the file has a wrong form" };
  return { times, problem: null };
};

/** This function gives the text of a file of ready times. */
export const readyTimesText = (times: readonly ReadyTime[]): string => `${JSON.stringify({ format: READY_TIMES_FORMAT, times }, null, 2)}\n`;

/**
 * This function gives the times after one more start. It keeps the last `keep` ready times, and the last `keep` missed
 * starts after the last ready start. A ready start thus removes the missed starts before it.
 */
export const addReadyTime = (times: readonly ReadyTime[], time: ReadyTime, keep: number): ReadyTime[] => {
  const all = [...times, time];
  const last = lastReady(all);
  const ready = all.slice(0, last + 1).filter((item) => item.missed !== true);
  return [...ready.slice(-keep), ...all.slice(last + 1).slice(-keep)];
};

/**
 * This function gives the window of the next start from the times of the starts before it.
 * - With `after` ready times or more, the window is the worst of the last `keep` ready times plus the worst minus the best.
 * - With fewer ready times, the window is `firstMs`.
 * - After a missed start, the window is at least `MISSED_GROWTH` times the window that it missed.
 * - The window is not shorter than `floorMs` and not longer than `capMs`.
 */
export const measuredWindowMs = (times: readonly ReadyTime[], rule: WindowRule): MeasuredWindowMs => {
  const last = lastReady(times);
  const ready = times
    .slice(0, last + 1)
    .filter((item) => item.missed !== true)
    .slice(-rule.keep)
    .map((item) => item.ms);
  const missed = times.slice(last + 1);
  const base = ready.length >= rule.after && ready.length > 0 ? Math.ceil(2 * Math.max(...ready) - Math.min(...ready)) : rule.firstMs;
  const latest = missed[missed.length - 1];
  const grown = latest === undefined ? 0 : Math.ceil(latest.ms * MISSED_GROWTH);
  return { ms: Math.min(rule.capMs, Math.max(rule.floorMs, base, grown)), measured: ready.length, missed: missed.length };
};
