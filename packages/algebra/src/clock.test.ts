import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  type Clock,
  type TimeWindow,
  type WallClock,
  delay,
  fakeClock,
  fakeWallClock,
  firstInstantOf,
  inWindow,
  instantsOf,
  localTime,
  nextBoundary,
  offsetChanges,
  platformClock,
  realClock,
  wallClock,
  windowProblems,
} from "./clock.ts";

describe("the clock entry: a client in a browser can import it", () => {
  it("imports nothing: no node: module, no zod and no other package", () => {
    const source = readFileSync(new URL("./clock.ts", import.meta.url), "utf8");
    expect(source.match(/^\s*(import|export)\b[^;]*\bfrom\s/gm)).toBeNull();
    expect(source).not.toMatch(/\bimport\s*\(/);
  });
});

describe("the fake clock", () => {
  it("starts the timers that come due, in the order of their times, then of their starts", async () => {
    const clock = fakeClock(100);
    const runs: string[] = [];
    clock.after(20, () => runs.push("b"));
    clock.after(10, () => runs.push("a"));
    clock.after(20, () => runs.push("c"));
    const stopped = clock.after(5, () => runs.push("stopped"));
    stopped();
    expect(clock.pending).toBe(3);
    await clock.advance(15);
    expect(runs).toEqual(["a"]);
    expect(clock.now()).toBe(115);
    await clock.advance(5);
    expect(runs).toEqual(["a", "b", "c"]);
    expect(clock.pending).toBe(0);
  });

  it("starts a timer that came due during a block late, at the time of the clock", async () => {
    const clock = fakeClock();
    const seen: number[] = [];
    clock.after(10, () => seen.push(clock.now()));
    clock.block(50);
    expect(seen).toEqual([]);
    await clock.advance(0);
    expect(seen).toEqual([50]);
  });

  it("starts a timer that a timer starts, in the same advance, and does not go back", async () => {
    const clock = fakeClock();
    const seen: number[] = [];
    clock.after(10, () => clock.after(5, () => seen.push(clock.now())));
    await clock.advance(-5);
    expect(clock.now()).toBe(0);
    await clock.advance(20);
    expect(seen).toEqual([15]);
    expect(clock.now()).toBe(20);
  });
});

describe("the clock of the platform", () => {
  it("starts a timer, and its cancel stops the timer and has unref", async () => {
    for (const clock of [platformClock(), platformClock({ unref: true }), realClock]) {
      const runs: string[] = [];
      const kept = clock.after(0, () => runs.push("kept"));
      const stopped = clock.after(0, () => runs.push("stopped"));
      stopped();
      stopped();
      expect(typeof kept.unref).toBe("function");
      kept.unref?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runs).toEqual(["kept"]);
    }
  });

  it("waits a delay longer than setTimeout takes in steps, and its cancel stops the next step", () => {
    // setTimeout starts a function after 1 ms for a delay above 2^31 - 1 ms, and the fake timers do the same
    vi.useFakeTimers();
    try {
      const runs: string[] = [];
      const clock = platformClock({ unref: true });
      const long = 2 ** 31 + 1000;
      clock.after(long, () => runs.push("long"));
      const stopped = clock.after(long, () => runs.push("stopped"));
      vi.advanceTimersByTime(2 ** 31 - 1);
      expect(runs).toEqual([]);
      stopped();
      vi.advanceTimersByTime(1000);
      expect(runs).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(runs).toEqual(["long"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a monotonic time", () => {
    const first = realClock.now();
    expect(platformClock().now()).toBeGreaterThanOrEqual(first);
  });
});

describe("the wall clock", () => {
  it("reads the instant of Date.now, and starts its timers as the clock of the platform does", async () => {
    const clock = wallClock({ unref: true });
    expect(clock.time).toBe("wall");
    const before = Date.now();
    const instant = clock.now();
    expect(instant).toBeGreaterThanOrEqual(before);
    expect(instant).toBeLessThanOrEqual(Date.now());
    const runs: string[] = [];
    const kept = clock.after(0, () => runs.push("kept"));
    clock.after(0, () => runs.push("stopped"))();
    expect(typeof kept.unref).toBe("function");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs).toEqual(["kept"]);
  });

  it("keeps a wall clock and a monotonic clock apart in their types", () => {
    const needsMonotonic = (clock: Clock): number => clock.now();
    const needsWall = (clock: WallClock): number => clock.now();
    // @ts-expect-error a wall clock is not a monotonic clock
    needsMonotonic(wallClock());
    // @ts-expect-error a monotonic clock is not a wall clock
    needsWall(realClock);
    expect(needsWall(fakeWallClock(5))).toBe(5);
    expect(needsMonotonic(fakeClock(5))).toBe(5);
  });

  it("steps the instant of a fake wall clock back and forth, and only the monotonic time starts its timers", async () => {
    const start = Date.UTC(2026, 10, 15, 12);
    const clock = fakeWallClock(start);
    const runs: number[] = [];
    clock.after(1000, () => runs.push(clock.now()));
    // a step back of one hour moves no timer
    clock.set(start - 3_600_000);
    expect(clock.now()).toBe(start - 3_600_000);
    await clock.advance(999);
    expect(runs).toEqual([]);
    expect(clock.pending).toBe(1);
    await clock.advance(1);
    expect(runs).toEqual([start - 3_600_000 + 1000]);
    // a step forward of one day starts no timer either
    clock.after(10, () => runs.push(-1));
    clock.set(start + 86_400_000);
    expect(runs).toHaveLength(1);
    clock.block(10);
    expect(clock.now()).toBe(start + 86_400_000 + 10);
    expect(clock.pending).toBe(1);
    await clock.advance(0);
    expect(runs).toEqual([start - 3_600_000 + 1000, -1]);
  });
});

// Civil time. The oracle below takes the offsets of each zone in 2026 from a table, not from Intl.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const utc = (month: number, day: number, hour: number, minute = 0, second = 0): number => Date.UTC(2026, month - 1, day, hour, minute, second);

/** The zones of the tests: their offsets in minutes and the two changes of 2026. */
const ZONES = {
  // north: summer time from the change in March to the change in October
  "Europe/Berlin": { standard: 60, summer: 120, changes: [utc(3, 29, 1), utc(10, 25, 1)], north: true },
  // south: standard time from the change in April to the change in October
  "Australia/Sydney": { standard: 600, summer: 660, changes: [utc(4, 4, 16), utc(10, 3, 16)], north: false },
  // a zone with a 30-minute offset and summer time
  "Australia/Adelaide": { standard: 570, summer: 630, changes: [utc(4, 4, 16, 30), utc(10, 3, 16, 30)], north: false },
  // a zone with a 30-minute offset and no change
  "Asia/Kolkata": { standard: 330, summer: 330, changes: [utc(3, 29, 1), utc(10, 25, 1)], north: true },
} as const;
type Zone = keyof typeof ZONES;

const oracleOffset = (zone: Zone, at: number): number => {
  const { standard, summer, changes, north } = ZONES[zone];
  const between = changes[0] <= at && at < changes[1];
  return between === north ? summer : standard;
};

const oracleLocal = (zone: Zone, at: number) => {
  const offset = oracleOffset(zone, at);
  const wall = new Date(at + offset * MINUTE);
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth() + 1,
    day: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    second: wall.getUTCSeconds(),
    weekday: wall.getUTCDay(),
    offset,
  };
};

const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** The rule of `TimeWindow`, written again over the oracle. */
const oracleIn = (window: TimeWindow & { zone: Zone }, at: number): boolean => {
  const local = oracleLocal(window.zone, at);
  const minute = local.hour * 60 + local.minute;
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  const startsOn = (weekday: number): boolean => window.days === undefined || window.days.includes(weekday);
  if (start < end) return start <= minute && minute < end && startsOn(local.weekday);
  return (minute >= start && startsOn(local.weekday)) || (minute < end && startsOn((local.weekday + 6) % 7));
};

describe("localTime", () => {
  it("gives the wall-clock time, the day of the week and the offset", () => {
    const at = Date.UTC(2026, 0, 15, 12, 34, 56, 789);
    expect(localTime(at, "Europe/Berlin")).toEqual({ year: 2026, month: 1, day: 15, hour: 13, minute: 34, second: 56, weekday: 4, offset: 60 });
    expect(localTime(at, "Australia/Sydney")).toEqual({ year: 2026, month: 1, day: 15, hour: 23, minute: 34, second: 56, weekday: 4, offset: 660 });
    expect(localTime(at, "Asia/Kolkata")).toEqual({ year: 2026, month: 1, day: 15, hour: 18, minute: 4, second: 56, weekday: 4, offset: 330 });
    expect(localTime(at, "America/St_Johns")).toMatchObject({ hour: 9, minute: 4, offset: -210 });
    expect(localTime(Date.UTC(2026, 0, 15, 20, 0), "Australia/Adelaide")).toMatchObject({ day: 16, hour: 6, minute: 30, weekday: 5, offset: 630 });
  });

  it("gives the years from 0 to 99, and the years before the common era", () => {
    const year50 = new Date("0050-06-01T10:00:00Z").getTime();
    expect(localTime(year50, "UTC")).toMatchObject({ year: 50, month: 6, day: 1, hour: 10, offset: 0 });
    const year0 = new Date("0000-06-01T10:00:00Z").getTime();
    expect(localTime(year0, "UTC")).toMatchObject({ year: 0, month: 6, day: 1, hour: 10, offset: 0 });
  });

  it("gives undefined for a name that is not a time zone, and for an instant that is not a date", () => {
    expect(localTime(0, "Mars/Olympus")).toBeUndefined();
    expect(localTime(0, "")).toBeUndefined();
    expect(localTime(0, `Europe/${"x".repeat(200)}`)).toBeUndefined();
    // A bad name is not kept, thus it gives undefined each time.
    expect(localTime(0, "Mars/Olympus")).toBeUndefined();
    expect(localTime(Number.NaN, "UTC")).toBeUndefined();
    expect(localTime(Number.POSITIVE_INFINITY, "UTC")).toBeUndefined();
    expect(localTime(1e20, "UTC")).toBeUndefined();
  });

  it("agrees with the table of offsets each 7 minutes, 36 hours before and after each change of 2026", () => {
    let checked = 0;
    for (const zone of Object.keys(ZONES) as Zone[]) {
      for (const change of ZONES[zone].changes) {
        for (let at = change - 36 * HOUR + 13_000; at < change + 36 * HOUR; at += 7 * MINUTE) {
          expect(localTime(at, zone), `${zone} at ${new Date(at).toISOString()}`).toEqual(oracleLocal(zone, at));
          checked += 1;
        }
      }
    }
    expect(checked).toBe(4 * 2 * 618);
  });

  it("gives the time after the gap at the change to summer time: 02:30 does not occur", () => {
    expect(localTime(utc(3, 29, 0, 59, 59), "Europe/Berlin")).toMatchObject({ hour: 1, minute: 59, second: 59, offset: 60 });
    expect(localTime(utc(3, 29, 1), "Europe/Berlin")).toMatchObject({ hour: 3, minute: 0, offset: 120 });
    expect(localTime(utc(10, 3, 15, 59), "Australia/Sydney")).toMatchObject({ day: 4, hour: 1, minute: 59, offset: 600 });
    expect(localTime(utc(10, 3, 16), "Australia/Sydney")).toMatchObject({ day: 4, hour: 3, minute: 0, offset: 660 });
  });
});

describe("inWindow", () => {
  const night: TimeWindow = { zone: "Europe/Berlin", start: "22:00", end: "07:00" };

  it("holds a window across midnight on a normal day: the start is in, the end is not", () => {
    expect(inWindow(utc(1, 15, 20, 59), night)).toBe(false);
    expect(inWindow(utc(1, 15, 21, 0), night)).toBe(true);
    expect(inWindow(utc(1, 16, 5, 59), night)).toBe(true);
    expect(inWindow(utc(1, 16, 6, 0), night)).toBe(false);
  });

  it("follows the wall clock on the two change days, where a fixed offset fails", () => {
    // 07:00 summer time is 05:00 UTC on 2026-03-29
    expect(inWindow(utc(3, 29, 4, 59), night)).toBe(true);
    expect(inWindow(utc(3, 29, 5, 0), night)).toBe(false);
    // 07:00 standard time is 06:00 UTC on 2026-10-25
    expect(inWindow(utc(10, 25, 5, 59), night)).toBe(true);
    expect(inWindow(utc(10, 25, 6, 0), night)).toBe(false);
  });

  it("holds an hour that occurs two times two times, and an hour that does not occur never", () => {
    const two: TimeWindow = { zone: "Europe/Berlin", start: "02:00", end: "03:00" };
    expect([utc(10, 25, 0, 0), utc(10, 25, 0, 59), utc(10, 25, 1, 0), utc(10, 25, 1, 59)].map((at) => inWindow(at, two))).toEqual([true, true, true, true]);
    expect(inWindow(utc(10, 25, 2, 0), two)).toBe(false);
    for (let at = utc(3, 28, 22); at < utc(3, 29, 6); at += MINUTE) expect(inWindow(at, two)).toBe(false);
  });

  it("starts a window on its days of the week, and a window across midnight continues into the next day", () => {
    // 2026-11-13 is a Friday
    const friday: TimeWindow = { zone: "UTC", start: "22:00", end: "07:00", days: [5] };
    expect(inWindow(Date.UTC(2026, 10, 12, 23), friday)).toBe(false);
    expect(inWindow(Date.UTC(2026, 10, 13, 6), friday)).toBe(false);
    expect(inWindow(Date.UTC(2026, 10, 13, 23), friday)).toBe(true);
    expect(inWindow(Date.UTC(2026, 10, 14, 6, 59), friday)).toBe(true);
    expect(inWindow(Date.UTC(2026, 10, 14, 7), friday)).toBe(false);
    expect(inWindow(Date.UTC(2026, 10, 14, 23), friday)).toBe(false);
  });

  it("gives the full day for an end equal to the start", () => {
    const weekend: TimeWindow = { zone: "UTC", start: "00:00", end: "00:00", days: [6, 0] };
    expect(inWindow(Date.UTC(2026, 10, 13, 23, 59), weekend)).toBe(false);
    expect(inWindow(Date.UTC(2026, 10, 14, 0, 0), weekend)).toBe(true);
    expect(inWindow(Date.UTC(2026, 10, 15, 23, 59), weekend)).toBe(true);
    expect(inWindow(Date.UTC(2026, 10, 16, 0, 0), weekend)).toBe(false);
    expect(inWindow(Date.UTC(2026, 10, 16, 0, 0), { zone: "UTC", start: "07:00", end: "07:00" })).toBe(true);
  });

  it("gives false for a bad window and for a bad instant", () => {
    const at = utc(1, 15, 23);
    expect(inWindow(at, { ...night, zone: "Mars/Olympus" })).toBe(false);
    expect(inWindow(at, { ...night, start: "7:00" })).toBe(false);
    expect(inWindow(at, { ...night, end: "24:00" })).toBe(false);
    expect(inWindow(at, { ...night, days: [7] })).toBe(false);
    expect(inWindow(at, { ...night, days: [] })).toBe(false);
    expect(inWindow(Number.NaN, night)).toBe(false);
    expect(inWindow(1e20, night)).toBe(false);
  });
});

describe("nextBoundary", () => {
  it("closes, opens and closes again when the end is in the hour that occurs two times", () => {
    // On 2026-10-25 in Berlin, 02:30 occurs at 00:30Z (summer time) and at 01:30Z (winter time).
    const night: TimeWindow = { zone: "Europe/Berlin", start: "22:00", end: "02:30" };
    const at = (hour: number, minute: number) => Date.UTC(2026, 9, 25, hour, minute);
    expect(nextBoundary(at(0, 0), night)).toEqual({ at: at(0, 30), opens: false });
    expect(nextBoundary(at(0, 30), night)).toEqual({ at: at(1, 0), opens: true });
    expect(nextBoundary(at(1, 0), night)).toEqual({ at: at(1, 30), opens: false });
    expect(inWindow(at(0, 45), night)).toBe(false);
    expect(inWindow(at(1, 15), night)).toBe(true);
  });

  it("opens a window at the end of the gap when its start does not occur", () => {
    const gap: TimeWindow = { zone: "Europe/Berlin", start: "02:30", end: "04:00" };
    expect(nextBoundary(utc(3, 29, 0), gap)).toEqual({ at: utc(3, 29, 1), opens: true });
    expect(inWindow(utc(3, 29, 1) - 1, gap)).toBe(false);
    expect(inWindow(utc(3, 29, 1), gap)).toBe(true);
    expect(nextBoundary(utc(3, 29, 1), gap)).toEqual({ at: utc(3, 29, 2), opens: false });
    const south: TimeWindow = { zone: "Australia/Sydney", start: "02:30", end: "04:00" };
    expect(nextBoundary(utc(10, 3, 15), south)).toEqual({ at: utc(10, 3, 16), opens: true });
  });

  it("closes a window at the end of the gap when its end does not occur", () => {
    const late: TimeWindow = { zone: "Europe/Berlin", start: "01:00", end: "02:30" };
    expect(nextBoundary(utc(3, 29, 0, 10), late)).toEqual({ at: utc(3, 29, 1), opens: false });
  });

  it("gives each change of an hour that occurs two times", () => {
    const window: TimeWindow = { zone: "Europe/Berlin", start: "02:00", end: "02:30" };
    const changes: string[] = [];
    let at = utc(10, 24, 23);
    for (let step = 0; step < 5; step += 1) {
      const next = nextBoundary(at, window);
      if (next === undefined) break;
      changes.push(`${new Date(next.at).toISOString()} ${next.opens ? "opens" : "closes"}`);
      at = next.at;
    }
    expect(changes).toEqual([
      "2026-10-25T00:00:00.000Z opens",
      "2026-10-25T00:30:00.000Z closes",
      "2026-10-25T01:00:00.000Z opens",
      "2026-10-25T01:30:00.000Z closes",
      "2026-10-26T01:00:00.000Z opens",
    ]);
  });

  it("finds a change some days later for a window of some days", () => {
    const friday: TimeWindow = { zone: "UTC", start: "22:00", end: "07:00", days: [5] };
    expect(nextBoundary(Date.UTC(2026, 10, 14, 7), friday)).toEqual({ at: Date.UTC(2026, 10, 20, 22), opens: true });
    const weekend: TimeWindow = { zone: "UTC", start: "00:00", end: "00:00", days: [6, 0] };
    expect(nextBoundary(Date.UTC(2026, 10, 13, 12), weekend)).toEqual({ at: Date.UTC(2026, 10, 14), opens: true });
    expect(nextBoundary(Date.UTC(2026, 10, 14, 12), weekend)).toEqual({ at: Date.UTC(2026, 10, 16), opens: false });
  });

  it("gives undefined for a window that does not change, a bad window and a bad instant", () => {
    expect(nextBoundary(0, { zone: "UTC", start: "07:00", end: "07:00" })).toBeUndefined();
    expect(nextBoundary(0, { zone: "UTC", start: "07:00", end: "08:00", days: [] })).toBeUndefined();
    expect(nextBoundary(0, { zone: "Mars/Olympus", start: "07:00", end: "08:00" })).toBeUndefined();
    expect(nextBoundary(Number.NaN, { zone: "UTC", start: "07:00", end: "08:00" })).toBeUndefined();
  });

  it("agrees with the oracle around each change of 2026, for 4 zones and 4 windows", () => {
    const shapes = [
      { start: "22:00", end: "07:00" },
      { start: "02:00", end: "03:00" },
      { start: "02:30", end: "02:45" },
      { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] },
    ];
    let checked = 0;
    for (const zone of Object.keys(ZONES) as Zone[]) {
      for (const change of ZONES[zone].changes) {
        for (const shape of shapes) {
          const window = { zone, ...shape };
          // the oracle changes, each minute from 36 hours before the change to 4 days after it
          const from = change - 36 * HOUR;
          const flips: number[] = [];
          let last = oracleIn(window, from - MINUTE);
          for (let at = from; at < change + 96 * HOUR; at += MINUTE) {
            const now = oracleIn(window, at);
            if (now !== last) flips.push(at);
            last = now;
          }
          for (let at = from + 17_000; at < change + 36 * HOUR; at += 73 * MINUTE) {
            const flip = flips.find((candidate) => candidate > at);
            const expected = flip === undefined ? undefined : { at: flip, opens: !oracleIn(window, at) };
            expect(nextBoundary(at, window), `${zone} ${shape.start}-${shape.end} at ${new Date(at).toISOString()}`).toEqual(expected);
            expect(inWindow(at, window)).toBe(oracleIn(window, at));
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(4 * 2 * 4 * 60);
  }, 60_000);
});

describe("windowProblems", () => {
  it("finds a bad zone, a bad local time and a bad day", () => {
    expect(windowProblems({ zone: "Europe/Berlin", start: "22:00", end: "07:00", days: [0, 6] })).toEqual([]);
    expect(windowProblems({ zone: "UTC", start: "06:00", end: "06:00" })).toEqual([]);
    expect(windowProblems({ zone: "Mars/Olympus", start: "22:60", end: "7:00", days: [7, 1.5] })).toEqual([
      '"Mars/Olympus" is not the IANA name of a time zone.',
      'The start "22:60" is not a local time HH:MM from 00:00 to 23:59.',
      'The end "7:00" is not a local time HH:MM from 00:00 to 23:59.',
      "The day 7 is not a day of the week from 0 (Sunday) to 6.",
      "The day 1.5 is not a day of the week from 0 (Sunday) to 6.",
    ]);
    expect(windowProblems({ zone: "UTC", start: "06:00", end: "07:00", days: [] })).toEqual(["The window has no day, thus it does not open."]);
  });
});

/** The instants of a wall-clock time, from the table: each offset of the zone whose instant shows the wall-clock time. */
const oracleInstants = (zone: Zone, wall: number): number[] => {
  const { standard, summer } = ZONES[zone];
  const found = [...new Set<number>([standard, summer])].map((offset) => wall - offset * MINUTE).filter((at) => at + oracleOffset(zone, at) * MINUTE === wall);
  return found.sort((a, b) => a - b);
};

describe("instantsOf", () => {
  it("gives the instants of the table near each change of 2026, also for a time with milliseconds", () => {
    for (const zone of Object.keys(ZONES) as Zone[]) {
      for (const change of ZONES[zone].changes) {
        const near = change + ZONES[zone].standard * MINUTE;
        for (let wall = near - 3 * HOUR; wall <= near + 3 * HOUR; wall += 10 * MINUTE + 1234) {
          expect(instantsOf(wall, zone), `${zone} ${new Date(wall).toISOString()}`).toEqual(oracleInstants(zone, wall));
        }
      }
    }
  });

  it("gives no instant in a gap and two in the hour that occurs two times, and it is the inverse of localTime", () => {
    // Berlin on 2026-03-29: the clock goes from 02:00 to 03:00
    expect(instantsOf(utc(3, 29, 2, 30), "Europe/Berlin")).toEqual([]);
    // Berlin on 2026-10-25: the clock shows the hour from 02:00 two times
    expect(instantsOf(utc(10, 25, 2, 30), "Europe/Berlin")).toEqual([utc(10, 25, 0, 30), utc(10, 25, 1, 30)]);
    expect(instantsOf(utc(7, 1, 12) + 250, "Europe/Berlin")).toEqual([utc(7, 1, 10) + 250]);
    const at = utc(1, 15, 20, 34, 56) + 789;
    const local = localTime(at, "Australia/Adelaide")!;
    const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) + 789;
    expect(instantsOf(wall, "Australia/Adelaide")).toEqual([at]);
  });

  it("gives undefined for a name that is not a time zone, and for a wall-clock time that is not a date", () => {
    expect(instantsOf(0, "Mars/Olympus")).toBeUndefined();
    expect(instantsOf(Number.NaN, "UTC")).toBeUndefined();
    expect(instantsOf(1e20, "UTC")).toBeUndefined();
  });
});

describe("offsetChanges", () => {
  it("gives the changes of the table in 2026, exact to the millisecond", () => {
    for (const zone of Object.keys(ZONES) as Zone[]) {
      const { standard, summer, changes } = ZONES[zone];
      expect(offsetChanges(utc(1, 1, 0), utc(12, 31, 0), zone), zone).toEqual(standard === summer ? [] : [...changes]);
    }
    expect(offsetChanges(utc(1, 1, 0), utc(12, 31, 0), "UTC")).toEqual([]);
  });

  it("gives the changes in (from, to]: the bound to is in the range, the bound from is not", () => {
    const [march] = ZONES["Europe/Berlin"].changes;
    expect(offsetChanges(march - 1, march, "Europe/Berlin")).toEqual([march]);
    expect(offsetChanges(march, march + HOUR, "Europe/Berlin")).toEqual([]);
    expect(offsetChanges(march + HOUR, march - HOUR, "Europe/Berlin")).toEqual([]);
  });

  it("gives undefined for a name that is not a time zone, and for a bound that is not a date", () => {
    expect(offsetChanges(0, 24 * HOUR, "Mars/Olympus")).toBeUndefined();
    expect(offsetChanges(Number.NaN, 0, "UTC")).toBeUndefined();
    expect(offsetChanges(0, 1e20, "UTC")).toBeUndefined();
  });
});

/** The first instant of the table at which the clock of the zone shows `wall` or a later time. */
const oracleFirst = (zone: Zone, wall: number): number | undefined => {
  const [first] = oracleInstants(zone, wall);
  if (first !== undefined) return first;
  // a gap: the change to the larger offset whose skipped wall-clock times hold `wall`
  return ZONES[zone].changes.find((change) => {
    const before = oracleOffset(zone, change - 1) * MINUTE;
    const after = oracleOffset(zone, change) * MINUTE;
    return change + before <= wall && wall < change + after;
  });
};

describe("firstInstantOf", () => {
  it("gives the first instant of the table near each change of 2026, also for a time with milliseconds", () => {
    let gaps = 0;
    for (const zone of Object.keys(ZONES) as Zone[]) {
      for (const change of ZONES[zone].changes) {
        const near = change + ZONES[zone].standard * MINUTE;
        for (let wall = near - 3 * HOUR; wall <= near + 3 * HOUR; wall += 10 * MINUTE + 1234) {
          const expected = oracleFirst(zone, wall);
          expect(expected, `${zone} ${new Date(wall).toISOString()}`).toBeDefined();
          expect(firstInstantOf(wall, zone), `${zone} ${new Date(wall).toISOString()}`).toBe(expected);
          if (oracleInstants(zone, wall).length === 0) gaps += 1;
        }
      }
    }
    // each zone with summer time has one gap of 60 minutes in 2026, and the steps of 601.234 s find it 6 times
    expect(gaps).toBe(3 * 6);
  });

  it("gives the end of a gap, and the first of two instants, in the zones of the providers", () => {
    const at = (iso: string): number => Date.parse(iso);
    // Santiago on 2026-09-06: the clock goes from 00:00 to 01:00 at 04:00 UTC, thus the day starts at the end of the gap
    expect(firstInstantOf(at("2026-09-06T00:00:00Z"), "America/Santiago")).toBe(at("2026-09-06T04:00:00Z"));
    // Chicago on 2026-03-08: the clock goes from 02:00 to 03:00 at 08:00 UTC
    expect(firstInstantOf(at("2026-03-08T02:00:00Z"), "America/Chicago")).toBe(at("2026-03-08T08:00:00Z"));
    expect(firstInstantOf(at("2026-03-08T02:59:59.999Z"), "America/Chicago")).toBe(at("2026-03-08T08:00:00Z"));
    expect(firstInstantOf(at("2026-03-08T03:00:00Z"), "America/Chicago")).toBe(at("2026-03-08T08:00:00Z"));
    // Berlin on 2026-10-25: the clock shows 01:00 one time and 02:00 two times, from 00:00 and 01:00 UTC
    expect(firstInstantOf(at("2026-10-25T01:00:00Z"), "Europe/Berlin")).toBe(at("2026-10-24T23:00:00Z"));
    expect(firstInstantOf(at("2026-10-25T02:00:00Z"), "Europe/Berlin")).toBe(at("2026-10-25T00:00:00Z"));
    // Chicago on 2026-11-01: the day starts at 05:00 UTC, and 01:00 occurs from 06:00 and from 07:00 UTC
    expect(firstInstantOf(at("2026-11-01T00:00:00Z"), "America/Chicago")).toBe(at("2026-11-01T05:00:00Z"));
    expect(firstInstantOf(at("2026-11-01T01:00:00Z"), "America/Chicago")).toBe(at("2026-11-01T06:00:00Z"));
  });

  it("gives undefined for a name that is not a time zone, and for a wall-clock time that is not a date", () => {
    expect(firstInstantOf(0, "Mars/Olympus")).toBeUndefined();
    expect(firstInstantOf(Number.NaN, "UTC")).toBeUndefined();
    expect(firstInstantOf(1e20, "UTC")).toBeUndefined();
  });
});

describe("delay", () => {
  it("resolves after its time on the clock, and removes its listener", async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    let done = false;
    const waited = delay(clock, 1000, controller.signal).then(() => {
      done = true;
    });
    expect(clock.pending).toBe(1);
    await clock.advance(999);
    expect(done).toBe(false);
    await clock.advance(1);
    await waited;
    expect(done).toBe(true);
    expect(clock.pending).toBe(0);
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    // an abort after the end does nothing
    controller.abort(new Error("late"));
  });

  it("stops its timer and rejects with the reason of the signal at an abort", async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    const waited = delay(clock, 1000, controller.signal);
    await clock.advance(400);
    const reason = new Error("the drain started");
    controller.abort(reason);
    await expect(waited).rejects.toBe(reason);
    expect(clock.pending).toBe(0);
  });

  it("rejects at once and starts no timer when the signal aborted before the call", async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    controller.abort();
    await expect(delay(clock, 1000, controller.signal)).rejects.toBe(controller.signal.reason);
    expect(clock.pending).toBe(0);
  });

  it("resolves without a signal, and a delay of 0 or less resolves at the next advance", async () => {
    const clock = fakeClock();
    const order: string[] = [];
    const waits = [delay(clock, 10).then(() => order.push("10")), delay(clock, -5).then(() => order.push("-5"))];
    await clock.advance(10);
    await Promise.all(waits);
    expect(order).toEqual(["-5", "10"]);
  });
});
