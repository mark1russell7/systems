// @mark1russell7/automata/clock: the clock of a runtime, a fake clock for tests, and civil time. It imports
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
  /**
   * This mark tells the time of `now()`. A clock gives the monotonic time, thus the mark is
   * `"monotonic"` or absent. A `WallClock` has the mark `"wall"`, thus it is not a `Clock`.
   */
  readonly time?: "monotonic" | undefined;
  /** This method gives the monotonic time, in milliseconds. A step of the wall clock does not move it. */
  now(): number;
  /** This method starts `run` after `ms` milliseconds, and gives the function that stops it. */
  after(ms: number, run: () => void): Cancel;
}

/**
 * A wall clock gives the instant: the time in milliseconds from 1970-01-01T00:00:00Z, as `Date.now()`
 * gives it. Civil time, a calendar and a time that another computer sends need the instant. A step
 * of the wall clock moves `now()`, also back. Each timer waits on the monotonic time, thus a step
 * does not move a timer. The mark `"wall"` keeps the two clocks apart: a function that needs the
 * monotonic time does not get a wall clock, and the reverse.
 */
export interface WallClock {
  readonly time: "wall";
  /** This method gives the instant, in milliseconds from the epoch. A step of the wall clock moves it. */
  now(): number;
  /** This method starts `run` after `ms` milliseconds of monotonic time, and gives the function that stops it. */
  after(ms: number, run: () => void): Cancel;
}

/**
 * These options make a clock of the platform. With a speed or a start, the clock is scaled: it
 * counts from its start on the monotonic time of the platform, `speed` times faster. Thus a test
 * runs a long schedule in a short real time, on the real timers.
 */
export interface PlatformClockOptions {
  /** True makes each timer not keep a Node process alive. The default is false, as with `setTimeout`. */
  readonly unref?: boolean | undefined;
  /**
   * The milliseconds of the clock in one real millisecond: a finite number above 0. The default is 1.
   * At the speed 60, `now()` moves 60 ms in each real millisecond, and a timer of 60 s ends after 1
   * real second. A speed below 1 gives a slow clock.
   */
  readonly speed?: number | undefined;
  /**
   * The time of `now()` when the clock is made, in milliseconds: a finite number. A wall clock reads
   * it as an instant. The default is the time of the platform at that moment.
   */
  readonly start?: number | undefined;
}

/** This function gives the monotonic time: `performance.now()`, or `Date.now()` on a platform without `performance`. */
const monotonic = (): number => {
  const performance = (globalThis as { performance?: { now(): number } }).performance;
  return performance === undefined ? Date.now() : performance.now();
};

/** This delay is the longest that `setTimeout` takes, in milliseconds. A longer delay starts the function after 1 ms. */
const LONGEST_DELAY = 0x7fffffff;

/** This function gives the speed of the options. It throws a `RangeError` for a bad speed or a bad start. */
const speedOf = (options: PlatformClockOptions): number => {
  const speed = options.speed ?? 1;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0) throw new RangeError(`The speed ${String(speed)} is not a finite number above 0.`);
  const start = options.start;
  if (start !== undefined && (typeof start !== "number" || !Number.isFinite(start))) throw new RangeError(`The start ${String(start)} is not a finite number.`);
  return speed;
};

/**
 * This function makes the timers of a clock of the platform. A timer of `ms` milliseconds on the
 * clock waits `ms / speed` real milliseconds, in steps when `setTimeout` does not take that delay.
 * With `now`, the timer reads the clock when the platform starts it. When the clock is before the
 * due time, the timer waits again for the rest. Thus `run` reads its due time or a later time.
 */
const timersOf =
  (unrefAll: boolean, speed: number, now?: () => number): Clock["after"] =>
  (ms, run) => {
    let unrefed = unrefAll;
    const due = now === undefined ? 0 : now() + Math.max(0, ms);
    const fire = (): void => {
      const early = now === undefined ? 0 : due - now();
      if (early > 0) timer = arm(early / speed);
      else run();
    };
    const arm = (left: number): ReturnType<typeof setTimeout> => {
      const step =
        left > LONGEST_DELAY ? setTimeout(() => (timer = arm(left - LONGEST_DELAY)), LONGEST_DELAY) : setTimeout(fire, Math.max(0, left));
      if (unrefed) (step as { unref?: () => void }).unref?.();
      return step;
    };
    let timer = arm(ms / speed);
    const unref = (): void => {
      unrefed = true;
      (timer as { unref?: () => void }).unref?.();
    };
    return Object.assign(() => clearTimeout(timer), { unref });
  };

/**
 * This function makes a clock of the platform: `performance.now()` and `setTimeout`. Each cancel
 * that it gives also has `unref`. A delay longer than `setTimeout` takes waits in steps.
 *
 * The rule of `unref`: each timer keeps a Node process alive, as `setTimeout` does. Thus a process
 * does not end in a wait that a caller awaits. A hang shows, but a silent exit with lost work does not.
 *
 * The owner of a timer uses its `unref` only when a socket, a child process or another hold keeps the
 * process alive. An example is the heartbeat of a connection. Each other timer stays referenced, a
 * ticker too: its caller stops it. The option `unref` makes each timer of the clock an exception.
 *
 * With a speed or a start, `now()` is the start plus the monotonic time since the call, times the
 * speed. A scaled clock reads `performance.now()` at each timer. Thus the fake timers of a test
 * also fake `performance`, else its timers wait again and again.
 *
 * @throws {RangeError} for a speed that is not a finite number above 0, and for a start that is not finite.
 */
export const platformClock = (options: PlatformClockOptions = {}): Clock => {
  const speed = speedOf(options);
  const unref = options.unref === true;
  if (speed === 1 && options.start === undefined) return { now: monotonic, after: timersOf(unref, 1) };
  const origin = monotonic();
  const start = options.start ?? origin;
  const now = (): number => start + (monotonic() - origin) * speed;
  return { now, after: timersOf(unref, speed, now) };
};

/**
 * This clock reads `performance.now()` and uses `setTimeout`. It is `platformClock()`, thus its
 * timers keep a Node process alive, as `setTimeout` does. A process does not end in a wait that a
 * caller awaits, for example a retry.
 *
 * The owner of a timer uses its `unref` only when a socket, a child process or another hold keeps the
 * process alive. Each other timer stays referenced: its caller stops it. A timer that is not stopped
 * delays the exit, and that delay shows.
 *
 * Before algebra 0.9.0, the timers of this clock did not keep the process alive. A process then ended
 * with the code 0 in a wait, and lost its work.
 */
export const realClock: Clock = /* @__PURE__ */ platformClock();

/**
 * This function gives a clock with the time of `clock`. Its timers do not keep a Node process alive:
 * each timer uses the `unref` of its cancel. The owner of a part gives it to the part only
 * when a socket, a child process or another hold keeps the process alive. An example is the
 * heartbeat of a connection. A wall clock stays a wall clock. The timers of a fake clock have no
 * `unref`, thus they do not change.
 */
export function unrefClock(clock: Clock): Clock;
export function unrefClock(clock: WallClock): WallClock;
export function unrefClock(clock: Clock | WallClock): Clock | WallClock {
  const after = (ms: number, run: () => void): Cancel => {
    const cancel = clock.after(ms, run);
    cancel.unref?.();
    return cancel;
  };
  const now = (): number => clock.now();
  return clock.time === "wall" ? { time: "wall", now, after } : { now, after };
}

/**
 * This function makes the wall clock of the platform: `Date.now()`, and the timers of
 * `platformClock`. The options are the options of `platformClock`.
 *
 * With a speed or a start, `now()` is the start plus the monotonic time since the call, times the
 * speed. It gives whole milliseconds, as `Date.now()` does. The default start is `Date.now()`.
 * A step of the wall clock of the platform does not move a scaled clock.
 *
 * @throws {RangeError} for a speed that is not a finite number above 0, and for a start that is not finite.
 */
export const wallClock = (options: PlatformClockOptions = {}): WallClock => {
  const speed = speedOf(options);
  const unref = options.unref === true;
  if (speed === 1 && options.start === undefined) return { time: "wall", now: () => Date.now(), after: timersOf(unref, 1) };
  const origin = monotonic();
  const start = options.start ?? Date.now();
  const now = (): number => Math.floor(start + (monotonic() - origin) * speed);
  return { time: "wall", now, after: timersOf(unref, speed, now) };
};

/**
 * This function gives a promise that resolves after `ms` milliseconds on the clock. When the signal
 * aborts, the promise stops its timer and rejects with the reason of the signal. A signal that
 * aborted before the call rejects at once, and starts no timer. Each end removes the listener from
 * the signal. A timer of `realClock` keeps a Node process alive until the delay ends. The clock is
 * a `Clock` or a `WallClock`: the function uses only its timers, and each timer of the two waits
 * on the monotonic time.
 */
export const delay = (clock: Pick<Clock, "after">, ms: number, signal?: AbortSignal): Promise<void> =>
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

/** A fake wall clock moves only when a test tells it to. A test can also step its instant, as a wall clock steps. */
export interface FakeWallClock extends WallClock {
  /** This method moves the instant and the monotonic time forward by `ms`, and it starts each timer that comes due, in sequence. */
  advance(ms: number): Promise<void>;
  /** This method moves the instant and the monotonic time forward by `ms`, and starts no timer, as a blocked event loop does. */
  block(ms: number): void;
  /** This method steps the instant to `instant`, forward or back. The monotonic time does not move, thus no timer comes due. */
  set(instant: number): void;
  /** This count is the number of timers that are not stopped and not called. */
  readonly pending: number;
}

/**
 * This function makes a fake wall clock. Its instant starts at `start`, in milliseconds from the
 * epoch. Its timers are the timers of a `fakeClock`, thus a step of the instant moves no timer.
 *
 * With `monotonic`, the wall clock reads that fake clock and uses its timers. Then the wall clock and
 * the monotonic clock of a test have one queue of timers, and `advance` of either clock moves both.
 * Without it, the wall clock makes its own fake clock.
 */
export const fakeWallClock = (start: number, monotonic?: FakeClock): FakeWallClock => {
  const monotonicTime = monotonic ?? fakeClock(0);
  let offset = start - monotonicTime.now();
  return {
    time: "wall",
    now: () => monotonicTime.now() + offset,
    after: (ms, run) => monotonicTime.after(ms, run),
    advance: (ms) => monotonicTime.advance(ms),
    block(ms) {
      monotonicTime.block(ms);
    },
    set(instant) {
      offset = instant - monotonicTime.now();
    },
    get pending() {
      return monotonicTime.pending;
    },
  };
};

/**
 * A frame clock is a wall clock in frames. A frame starts at a mark. In a frame, the time is the wall
 * time at the mark plus the monotonic time since the mark. Thus the time does not go back in a frame,
 * also when the wall clock steps. At the next mark, `step` gives the change of the wall clock.
 */
export interface FrameClock extends WallClock {
  /**
   * This method gives the step of the wall clock since the last mark, in whole milliseconds. The step is the
   * change of the wall time against the monotonic time. A change of the drift limit or less gives 0. A read
   * does not end the step. Only `mark` ends it.
   */
  step(): number;
  /** This method starts a new frame. The time of the frame is then the wall time again. */
  mark(): void;
}

/** These options make a frame clock. */
export interface FrameClockOptions {
  /**
   * This value is the largest change of the wall clock against the monotonic clock that is a drift, not a
   * step, in milliseconds. The default is `FRAME_DRIFT_LIMIT`.
   */
  readonly driftLimit?: number | undefined;
}

/**
 * This value is the default drift limit of a frame clock, in milliseconds. A slew of NTP changes the wall
 * clock by 0.5 ms in each second at most. Thus a frame of 2000 seconds or less sees no slew as a step.
 */
export const FRAME_DRIFT_LIMIT = 1000;

/** This function tells if a wall clock is a frame clock: a clock that also gives the steps of the wall clock. */
export function isFrameClock(clock: WallClock): clock is FrameClock {
  const frame = clock as Partial<FrameClock>;
  return typeof frame.step === "function" && typeof frame.mark === "function";
}

/**
 * This function makes a frame clock on a wall clock and a monotonic clock. The first frame starts at
 * once. `now()` gives whole milliseconds. The timers are the timers of the wall clock, thus they wait
 * on the monotonic time, and a step does not move them.
 *
 * A runtime marks a frame at the start of each pass. Then each instant of the pass is in one frame,
 * and the runtime reads the step of the wall clock once, before the mark.
 *
 * @throws {RangeError} for a drift limit that is not a finite number of 0 or more.
 */
export function frameClock(wall: WallClock, monotonic: Pick<Clock, "now">, options: FrameClockOptions = {}): FrameClock {
  const limit = options.driftLimit ?? FRAME_DRIFT_LIMIT;
  if (!(Number.isFinite(limit) && limit >= 0)) {
    throw new RangeError(`The drift limit of a frame clock is ${String(limit)}. It must be a finite number of 0 or more.`);
  }
  let wallAt = wall.now();
  let monotonicAt = monotonic.now();
  return {
    time: "wall",
    now: () => wallAt + Math.floor(monotonic.now() - monotonicAt),
    after: (ms, run) => wall.after(ms, run),
    step() {
      const size = Math.round(wall.now() - monotonic.now() - (wallAt - monotonicAt));
      return Math.abs(size) > limit ? size : 0;
    },
    mark() {
      wallAt = wall.now();
      monotonicAt = monotonic.now();
    },
  };
}

// Civil time: the wall-clock time of an instant in a time zone, and windows of local time. A clock
// gives instants, and civil time maps an instant to the time on the wall of a zone. It uses only
// `Intl.DateTimeFormat`, thus this entry still imports nothing.

/**
 * The wall-clock time of an instant in a time zone. An instant is a time in milliseconds from
 * 1970-01-01T00:00:00Z, as `Date.now()` and `WallClock.now()` give. It is not the monotonic time of `Clock.now()`.
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
 * This function gives the instants at which the wall clock of `zone` shows `wall`, in order. It is
 * the inverse of `localTime`. The wall-clock time is in milliseconds with the arithmetic of UTC: the
 * UTC fields of `new Date(wall)` are the fields of the wall clock.
 *
 * - A wall-clock time in the gap of a change forward gives no instant.
 * - A wall-clock time in the hour of a change back gives two instants.
 * - A name that is not a time zone, or a wall-clock time that is not a date, gives `undefined`.
 *
 * The rule for a gap or for two instants is a choice of the caller. For example, RFC 5545 takes the
 * first of two instants, and in a gap it takes the offset before the gap. The search reads the
 * offset one day before and one day after `wall`. Thus it finds each instant when the offset
 * changes at most one time in these 2 days.
 */
export function instantsOf(wall: number, zone: string): number[] | undefined {
  if (zoneFormat(zone) === undefined || !Number.isFinite(wall)) return undefined;
  // localTime gives whole seconds: the search uses the whole second, and adds the milliseconds at the end
  const whole = Math.floor(wall / 1000) * 1000;
  const offsets = new Set<number>();
  for (const probe of [whole - DAY_MS, whole, whole + DAY_MS]) {
    const local = localTime(probe, zone);
    if (local !== undefined) offsets.add(local.offset);
  }
  // no offset: the wall-clock time is out of the range of a date
  if (offsets.size === 0) return undefined;
  const found: number[] = [];
  for (const offset of offsets) {
    // an old offset of local mean time has seconds, thus the product is rounded to the millisecond
    const instant = whole - Math.round(offset * MINUTE_MS);
    const local = localTime(instant, zone);
    if (local === undefined) continue;
    const back = wallOf(local.year, local.month, local.day, local.hour, local.minute, local.second);
    if (back === whole && !found.includes(instant)) found.push(instant);
  }
  return found.sort((a, b) => a - b).map((instant) => instant + (wall - whole));
}

/**
 * This function gives the instants in `(from, to]` at which the offset of `zone` changes, in order
 * and exact to the millisecond. At each instant, the new offset starts. The search reads the offset
 * each 6 hours of the range, thus a long range costs more reads. No zone changes its offset two
 * times in 6 hours. A name that is not a time zone, or a bound that is not a date, gives `undefined`.
 */
export function offsetChanges(from: number, to: number, zone: string): number[] | undefined {
  if (localTime(from, zone) === undefined || localTime(to, zone) === undefined) return undefined;
  return changesOf(from, to, zone);
}

/** The instants in (from, to] at which the offset of the zone changes. `offsetChanges` tells the rule. */
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
 * This function gives the first instant at which the wall clock of `zone` shows `wall` or a later
 * wall-clock time. The wall-clock time is in milliseconds with the arithmetic of UTC, as for
 * `instantsOf`. Thus a time on the wall, for example the start of a day, always has an instant.
 *
 * - A wall-clock time that occurs one time gives its instant.
 * - A wall-clock time in the hour of a change back gives the first of its two instants.
 * - A wall-clock time in the gap of a change forward gives the instant of the change: the end of the gap.
 * - A name that is not a time zone, or a wall-clock time that is not a date, gives `undefined`.
 *
 * The search reads the offset one day before and one day after `wall`, as `instantsOf` does. A gap
 * that is not in these 2 days also gives `undefined`.
 */
export function firstInstantOf(wall: number, zone: string): number | undefined {
  const instants = instantsOf(wall, zone);
  if (instants === undefined) return undefined;
  if (instants.length > 0) return instants[0];
  const whole = Math.floor(wall / 1000) * 1000;
  const offsets: number[] = [];
  for (const probe of [whole - DAY_MS, whole, whole + DAY_MS]) {
    const local = localTime(probe, zone);
    if (local !== undefined) offsets.push(Math.round(local.offset * MINUTE_MS));
  }
  // A change at the instant c, from the offset o1 to the larger offset o2, skips the wall-clock times
  // from c + o1 to c + o2, without the end. Thus c is after wall - o2, and at or before wall - o1.
  const from = wall - Math.max(...offsets);
  const to = wall - Math.min(...offsets);
  const offsetAt = (instant: number): number | undefined => {
    const local = localTime(instant, zone);
    return local === undefined ? undefined : Math.round(local.offset * MINUTE_MS);
  };
  for (const change of changesOf(from, to, zone)) {
    const before = offsetAt(change - 1);
    const after = offsetAt(change);
    if (before !== undefined && after !== undefined && change + before <= wall && wall < change + after) return change;
  }
  return undefined;
}

/** The calendar month of an instant on the wall clock of a time zone. The start is in the month, and the end is not. */
export interface LocalMonth {
  /** The first instant of the 1st of the month at 00:00. When 00:00 is in a gap, it is the end of the gap. */
  readonly start: number;
  /** The `start` of the next month. */
  readonly end: number;
}

/**
 * This function gives the calendar month of `at` on the wall clock of `zone`. `firstInstantOf` gives each bound
 * from 00:00 on the 1st. A month with a change of the offset is shorter or longer than its days. A name that
 * is not a time zone, or an instant that is not a date, gives `undefined`.
 */
export function monthOf(at: number, zone: string): LocalMonth | undefined {
  const local = localTime(at, zone);
  if (local === undefined) return undefined;
  // December goes on to January of the next year
  const next = local.month === 12 ? { year: local.year + 1, month: 1 } : { year: local.year, month: local.month + 1 };
  const start = firstInstantOf(wallOf(local.year, local.month, 1, 0, 0, 0), zone);
  const end = firstInstantOf(wallOf(next.year, next.month, 1, 0, 0, 0), zone);
  return start === undefined || end === undefined ? undefined : { start, end };
}

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
    for (const minutes of [valid.start, valid.end]) candidates.push(...(instantsOf(midnight + day * DAY_MS + minutes * MINUTE_MS, window.zone) ?? []));
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
