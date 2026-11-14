// @mark1russell7/algebra/clock: the clock of a runtime, a fake clock for tests, and civil time. It imports
// nothing: no `node:` module, no zod and no other package. Thus a client in a browser can use it.
// The service gives this clock again as @mark1russell7/service/clock.

/**
 * This function stops a timer that `Clock.after` started. A second use does nothing. A clock of
 * the platform also gives `unref`: after it, the timer does not keep a Node process alive.
 */
export type Cancel = (() => void) & { readonly unref?: (() => void) | undefined };

/**
 * A clock gives the monotonic time in milliseconds, and it starts a function after a delay. The
 * runtime reads time only through a clock. Thus a test can give a fake clock, and the timing of
 * the runtime is then exact and repeatable.
 */
export interface Clock {
  /** This method gives the monotonic time, in milliseconds. A step of the wall clock does not move it. */
  now(): number;
  /** This method starts `run` after `ms` milliseconds, and gives the function that stops it. */
  after(ms: number, run: () => void): Cancel;
}

/** These options make a clock of the platform. */
export interface PlatformClockOptions {
  /** True makes each timer not keep a Node process alive. The default is false, as with `setTimeout`. */
  readonly unref?: boolean | undefined;
}

/** This function gives the monotonic time: `performance.now()`, or `Date.now()` on a platform without `performance`. */
const monotonic = (): number => {
  const performance = (globalThis as { performance?: { now(): number } }).performance;
  return performance === undefined ? Date.now() : performance.now();
};

/** This delay is the longest that `setTimeout` takes, in milliseconds. A longer delay starts the function after 1 ms. */
const LONGEST_DELAY = 0x7fffffff;

/**
 * This function makes a clock of the platform: `performance.now()` and `setTimeout`. Each cancel
 * that it gives also has `unref`. A delay longer than `setTimeout` takes waits in steps.
 */
export const platformClock = (options: PlatformClockOptions = {}): Clock => ({
  now: monotonic,
  after(ms, run) {
    let unrefed = options.unref === true;
    const arm = (left: number): ReturnType<typeof setTimeout> => {
      const step =
        left > LONGEST_DELAY ? setTimeout(() => (timer = arm(left - LONGEST_DELAY)), LONGEST_DELAY) : setTimeout(run, Math.max(0, left));
      if (unrefed) (step as { unref?: () => void }).unref?.();
      return step;
    };
    let timer = arm(ms);
    const unref = (): void => {
      unrefed = true;
      (timer as { unref?: () => void }).unref?.();
    };
    return Object.assign(() => clearTimeout(timer), { unref });
  },
});

/**
 * This clock reads `performance.now()` and uses `setTimeout`. Its timers do not keep a Node
 * process alive, thus a timer that is not stopped cannot stop the exit of the process.
 */
export const realClock: Clock = /* @__PURE__ */ platformClock({ unref: true });

/**
 * This function gives a promise that resolves after `ms` milliseconds on the clock. When the signal
 * aborts, the promise stops its timer and rejects with the reason of the signal. A signal that
 * aborted before the call rejects at once, and starts no timer. Each end removes the listener from
 * the signal. A timer of `realClock` does not keep a Node process alive: give `platformClock()` to
 * keep the process alive until the delay ends.
 */
export const delay = (clock: Clock, ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const abort = (): void => {
      cancel();
      reject(signal?.reason);
    };
    const cancel = clock.after(ms, () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    });
    signal?.addEventListener("abort", abort, { once: true });
  });

/** A fake clock moves only when a test tells it to. */
export interface FakeClock extends Clock {
  /** This method moves the clock forward by `ms`, and it starts each timer that comes due, in sequence. */
  advance(ms: number): Promise<void>;
  /**
   * This method moves the clock forward by `ms` and starts no timer, as a blocked event loop does.
   * The next `advance` then starts each timer that came due during the block, late.
   */
  block(ms: number): void;
  /** This count is the number of timers that are not stopped and not called. */
  readonly pending: number;
}

/** This function lets the promises that are ready continue, before the clock moves again. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 64; turn += 1) await Promise.resolve();
};

/** This function makes a fake clock. Its time starts at `start` milliseconds. */
export const fakeClock = (start = 0): FakeClock => {
  let now = start;
  let sequence = 0;
  const timers: Array<{ at: number; order: number; run: () => void; live: boolean }> = [];
  const due = (end: number) => {
    let best: (typeof timers)[number] | undefined;
    for (const timer of timers)
      if (timer.live && timer.at <= end && (best === undefined || timer.at < best.at || (timer.at === best.at && timer.order < best.order)))
        best = timer;
    return best;
  };
  return {
    now: () => now,
    after(ms, run): Cancel {
      const timer = { at: now + Math.max(0, ms), order: sequence++, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    async advance(ms) {
      // a monotonic clock does not go back
      const end = now + Math.max(0, ms);
      await settle();
      for (;;) {
        const timer = due(end);
        if (timer === undefined) break;
        timer.live = false;
        // a timer that came due during a block runs late, at the time of the clock
        now = Math.max(now, timer.at);
        timer.run();
        await settle();
      }
      now = Math.max(now, end);
      for (let at = timers.length - 1; at >= 0; at -= 1) if (!timers[at]!.live) timers.splice(at, 1);
      await settle();
    },
    block(ms) {
      now += Math.max(0, ms);
    },
    get pending() {
      return timers.filter((timer) => timer.live).length;
    },
  };
};

// Civil time: the wall-clock time of an instant in a time zone, and windows of local time. A clock
// gives instants, and civil time maps an instant to the time on the wall of a zone. It uses only
// `Intl.DateTimeFormat`, thus this entry still imports nothing.

/**
 * The wall-clock time of an instant in a time zone. An instant is a time in milliseconds from
 * 1970-01-01T00:00:00Z, as `Date.now()` gives. It is not the monotonic time of `Clock.now()`.
 */
export interface LocalTime {
  readonly year: number;
  /** The month, from 1 (January) to 12. */
  readonly month: number;
  /** The day of the month, from 1. */
  readonly day: number;
  /** The hour, from 0 to 23. */
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** The day of the week, from 0 (Sunday) to 6 (Saturday). */
  readonly weekday: number;
  /** The offset of the zone from UTC at the instant, in minutes. It is positive east of Greenwich. */
  readonly offset: number;
}

/**
 * A window of local time that occurs on each day, or on some days of the week. The window is
 * data, thus a configuration can hold it.
 *
 * - The start is in the window, and the end is not.
 * - An end before the start crosses midnight. An end equal to the start gives a window of a full day.
 * - In a change of the clock, the window follows the time on the wall. A start or an end in a gap
 *   moves to the end of the gap. Thus a window with its start and its end in one gap does not open.
 * - A local time that occurs two times is in the window two times.
 */
export interface TimeWindow {
  /** The IANA name of the time zone, for example `Europe/Berlin`. */
  readonly zone: string;
  /** The start, a local time `HH:MM` from `00:00` to `23:59`. */
  readonly start: string;
  /** The end, a local time `HH:MM` from `00:00` to `23:59`. */
  readonly end: string;
  /**
   * The days of the week on which the window starts, from 0 (Sunday) to 6. When it is absent, the
   * window starts on each day. A window across midnight continues into the next day.
   */
  readonly days?: readonly number[] | undefined;
}

/** A change of a window: the instant at which it opens or closes. */
export interface WindowBoundary {
  readonly at: number;
  /** True: the window opens at `at`. False: it closes. */
  readonly opens: boolean;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const WEEKDAYS: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The cache has one format for each good zone name. It keeps no bad name, and it starts again at
 * `ZONE_CACHE_MAX` names. Thus names from configuration input cannot make it grow without a limit.
 */
const ZONE_FORMATS = new Map<string, Intl.DateTimeFormat>();
const ZONE_CACHE_MAX = 512;
/** The longest IANA name has 32 characters. A longer name than this limit is not a zone. */
const ZONE_NAME_MAX = 100;

const zoneFormat = (zone: string): Intl.DateTimeFormat | undefined => {
  let format = ZONE_FORMATS.get(zone);
  if (format === undefined) {
    if (typeof zone !== "string" || zone.length > ZONE_NAME_MAX) return undefined;
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        era: "short",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
        weekday: "short",
      });
    } catch {
      return undefined;
    }
    if (ZONE_FORMATS.size >= ZONE_CACHE_MAX) ZONE_FORMATS.clear();
    ZONE_FORMATS.set(zone, format);
  }
  return format;
};

/**
 * This function gives the wall-clock time of `instant` in `zone`. It gives `undefined` for a name
 * that is not a time zone, and for an instant that is not a date.
 */
export function localTime(instant: number, zone: string): LocalTime | undefined {
  const format = zoneFormat(zone);
  if (format === undefined || !Number.isFinite(instant)) return undefined;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format.formatToParts(instant);
  } catch {
    // an instant out of the range of a date
    return undefined;
  }
  const field: Record<string, string> = {};
  for (const part of parts) field[part.type] = part.value;
  const before = field["era"] === "BC" || field["era"] === "B";
  const year = before ? 1 - Number(field["year"]) : Number(field["year"]);
  const month = Number(field["month"]);
  const day = Number(field["day"]);
  const hour = Number(field["hour"]) % 24;
  const minute = Number(field["minute"]);
  const second = Number(field["second"]);
  const whole = Math.floor(instant / 1000) * 1000;
  return { year, month, day, hour, minute, second, weekday: WEEKDAYS[field["weekday"] ?? ""] ?? 0, offset: (wallOf(year, month, day, hour, minute, second) - whole) / MINUTE_MS };
}

/** The wall-clock time as an instant in UTC. `Date.UTC` reads a year from 0 to 99 as 1900 to 1999, thus this function sets the year by itself. */
const wallOf = (year: number, month: number, day: number, hour: number, minute: number, second: number): number => {
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(hour, minute, second, 0);
  return wall.getTime();
};

/** The minutes from midnight of a local time `HH:MM`. */
const minutesOf = (time: string): number | undefined => {
  const match = LOCAL_TIME.exec(time);
  return match === null ? undefined : Number(match[1]) * 60 + Number(match[2]);
};

interface CheckedWindow {
  readonly start: number;
  readonly end: number;
  readonly days: ReadonlySet<number> | undefined;
}

const isDay = (day: number): boolean => Number.isInteger(day) && day >= 0 && day <= 6;

const checked = (window: TimeWindow): CheckedWindow | undefined => {
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  if (start === undefined || end === undefined || zoneFormat(window.zone) === undefined) return undefined;
  if (window.days !== undefined && !window.days.every(isDay)) return undefined;
  return { start, end, days: window.days === undefined ? undefined : new Set(window.days) };
};

const within = (window: CheckedWindow, local: LocalTime): boolean => {
  const minute = local.hour * 60 + local.minute;
  const startsOn = (weekday: number): boolean => window.days === undefined || window.days.has(weekday);
  if (window.start < window.end) return window.start <= minute && minute < window.end && startsOn(local.weekday);
  // across midnight, or a full day: the part from the start, then the part before the end on the next day
  return (minute >= window.start && startsOn(local.weekday)) || (minute < window.end && startsOn((local.weekday + 6) % 7));
};

/**
 * This function tells if `instant` is in the window. It does not throw. A bad window or a bad
 * instant gives `false`, and `windowProblems` finds the bad window.
 */
export function inWindow(instant: number, window: TimeWindow): boolean {
  const valid = checked(window);
  const local = valid === undefined ? undefined : localTime(instant, window.zone);
  return valid !== undefined && local !== undefined && within(valid, local);
}

/**
 * The instants at which the wall clock of the zone shows `wall`, a wall-clock time as an instant in
 * UTC. A gap gives none, and an overlap gives two.
 */
const instantsOf = (wall: number, zone: string): number[] => {
  const offsets = new Set<number>();
  for (const probe of [wall - DAY_MS, wall, wall + DAY_MS]) {
    const local = localTime(probe, zone);
    if (local !== undefined) offsets.add(local.offset);
  }
  const found: number[] = [];
  for (const offset of offsets) {
    const instant = wall - offset * MINUTE_MS;
    const local = localTime(instant, zone);
    if (local === undefined) continue;
    const back = wallOf(local.year, local.month, local.day, local.hour, local.minute, local.second);
    if (back === wall && !found.includes(instant)) found.push(instant);
  }
  return found;
};

/**
 * The instants in (from, to] at which the offset of the zone changes, each one exact to the
 * millisecond. The search reads the offset each 6 hours. No zone changes its offset two times in 6 hours.
 */
const changesOf = (from: number, to: number, zone: string): number[] => {
  const offsetAt = (instant: number): number | undefined => localTime(instant, zone)?.offset;
  const found: number[] = [];
  let low = from;
  let before = offsetAt(low);
  while (low < to) {
    const high = Math.min(low + DAY_MS / 4, to);
    const after = offsetAt(high);
    if (before !== undefined && after !== undefined && after !== before) {
      // the first instant with the new offset
      let left = low;
      let right = high;
      while (right - left > 1) {
        const middle = Math.floor((left + right) / 2);
        if (offsetAt(middle) === before) left = middle;
        else right = middle;
      }
      found.push(right);
    }
    low = high;
    before = after;
  }
  return found;
};

/**
 * This function gives the next change of the window after `instant`: the first later instant at
 * which the window opens or closes. A timer can wait for it in closed form. It gives `undefined`
 * for a bad window, and when the window does not change in the 9 days after `instant`. A window
 * with no day and a full-day window on each day do not change.
 */
export function nextBoundary(instant: number, window: TimeWindow): WindowBoundary | undefined {
  const valid = checked(window);
  const local = valid === undefined ? undefined : localTime(instant, window.zone);
  if (valid === undefined || local === undefined) return undefined;
  const inside = within(valid, local);
  const horizon = instant + 9 * DAY_MS;
  // The state changes only where the wall clock shows the start or the end, or where the offset changes.
  const candidates = changesOf(instant, horizon, window.zone);
  const midnight = wallOf(local.year, local.month, local.day, 0, 0, 0);
  for (let day = -1; day <= 10; day += 1) {
    for (const minutes of [valid.start, valid.end]) candidates.push(...instantsOf(midnight + day * DAY_MS + minutes * MINUTE_MS, window.zone));
  }
  candidates.sort((a, b) => a - b);
  for (const at of candidates) {
    if (at <= instant || at > horizon) continue;
    const there = localTime(at, window.zone);
    if (there !== undefined && within(valid, there) !== inside) return { at, opens: !inside };
  }
  return undefined;
}

/** This function gives the problems of a window. With a problem, `inWindow` gives `false` and `nextBoundary` gives `undefined`. */
export function windowProblems(window: TimeWindow): string[] {
  const problems: string[] = [];
  if (zoneFormat(window.zone) === undefined) problems.push(`"${window.zone}" is not the IANA name of a time zone.`);
  if (minutesOf(window.start) === undefined) problems.push(`The start "${window.start}" is not a local time HH:MM from 00:00 to 23:59.`);
  if (minutesOf(window.end) === undefined) problems.push(`The end "${window.end}" is not a local time HH:MM from 00:00 to 23:59.`);
  for (const day of window.days ?? []) {
    if (!isDay(day)) problems.push(`The day ${day} is not a day of the week from 0 (Sunday) to 6.`);
  }
  if (window.days !== undefined && window.days.length === 0) problems.push("The window has no day, thus it does not open.");
  return problems;
}
