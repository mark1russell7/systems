import { describe, expect, it } from "vitest";
import {
  type Recurrence,
  addDays,
  addMonths,
  dateOf,
  dateOfDay,
  dayNumber,
  daysBetween,
  nextOccurrence,
  occurrence,
  occurrencesBetween,
  recurrenceProblems,
  weekdayOfDate,
} from "./clock.ts";

describe("calendar dates", () => {
  it("counts days from 1970-01-01, in the two directions", () => {
    expect(dayNumber("1970-01-01")).toBe(0);
    expect(dayNumber("2026-12-01")).toBe(20788);
    expect(dayNumber("1969-12-31")).toBe(-1);
    expect(dateOfDay(20788)).toBe("2026-12-01");
    expect(dateOfDay(dayNumber("0001-01-01") ?? Number.NaN)).toBe("0001-01-01");
    expect(dateOfDay(dayNumber("9999-12-31") ?? Number.NaN)).toBe("9999-12-31");
  });

  it("refuses a text that is not a real date, and a day out of range", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "2026-1-01", "20261201", "", "0000-01-01", "2027-02-29"]) expect(dayNumber(bad)).toBeUndefined();
    expect(dayNumber("2028-02-29")).toBe(21243);
    expect(dateOfDay(0.5)).toBeUndefined();
    expect(dateOfDay((dayNumber("9999-12-31") ?? 0) + 1)).toBeUndefined();
    expect(dayNumber(42 as unknown as string)).toBeUndefined();
  });

  it("reads a year from 0 to 99 as that year, not as 1900 to 1999", () => {
    expect(addDays("0050-12-31", 1)).toBe("0051-01-01");
    expect(addMonths("0099-12-15", 1)).toBe("0100-01-15");
  });

  it("adds days and gives the days between two dates", () => {
    expect(addDays("2026-12-01", 15)).toBe("2026-12-16");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-01", 1.5)).toBeUndefined();
    expect(daysBetween("2026-12-01", "2028-09-12")).toBe(651);
    expect(daysBetween("2028-09-12", "2026-12-01")).toBe(-651);
    expect(daysBetween("2026-12-01", "bad")).toBeUndefined();
  });

  it("adds months and goes to the last day of a short month", () => {
    expect(addMonths("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2028-02-29", 12)).toBe("2029-02-28");
    expect(addMonths("2026-12-15", 0.5)).toBeUndefined();
  });

  it("agrees with the days of each month over 400 years", () => {
    // A cycle of the Gregorian calendar has 146,097 days. Each step of one month adds the days of the month before it.
    let date = "2000-01-01";
    let total = 0;
    for (let n = 0; n < 4800; n += 1) {
      const next = addMonths(date, 1) ?? "";
      total += daysBetween(date, next) ?? Number.NaN;
      date = next;
    }
    expect(date).toBe("2400-01-01");
    expect(total).toBe(146097);
  });

  it("gives the day of the week", () => {
    expect(weekdayOfDate("1970-01-01")).toBe(4);
    expect(weekdayOfDate("2026-11-21")).toBe(6);
    expect(weekdayOfDate("1969-12-28")).toBe(0);
    expect(weekdayOfDate("bad")).toBeUndefined();
  });

  it("gives the date of an instant on the wall clock of a zone", () => {
    const instant = Date.parse("2026-12-01T03:30:00Z");
    expect(dateOf(instant, "UTC")).toBe("2026-12-01");
    expect(dateOf(instant, "America/New_York")).toBe("2026-11-30");
    expect(dateOf(instant, "Asia/Tokyo")).toBe("2026-12-01");
    expect(dateOf(instant, "Not/AZone")).toBeUndefined();
    expect(dateOf(Number.NaN, "UTC")).toBeUndefined();
  });
});

describe("recurrence rules", () => {
  const monthly: Recurrence = { start: "2027-01-31", every: 1, unit: "month" };

  it("gives each date from the start, not from the date before it", () => {
    expect(occurrencesBetween(monthly, "2027-01-01", "2027-05-31")).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31"]);
    expect(occurrence({ start: "2028-02-29", every: 1, unit: "year" }, 1)).toBe("2029-02-28");
    expect(occurrence({ start: "2028-02-29", every: 1, unit: "year" }, 4)).toBe("2032-02-29");
  });

  it("gives the dates of each unit", () => {
    expect(occurrencesBetween({ start: "2026-12-01", every: 3, unit: "day" }, "2026-12-01", "2026-12-10")).toEqual(["2026-12-01", "2026-12-04", "2026-12-07", "2026-12-10"]);
    expect(occurrencesBetween({ start: "2026-11-21", every: 2, unit: "week" }, "2026-11-22", "2027-01-01")).toEqual(["2026-12-05", "2026-12-19"]);
    expect(occurrencesBetween({ start: "2026-12-01", every: 6, unit: "month" }, "2026-01-01", "2028-01-01")).toEqual(["2026-12-01", "2027-06-01", "2027-12-01"]);
    expect(occurrence({ start: "2026-12-01", every: 1, unit: "year" }, 3)).toBe("2029-12-01");
  });

  it("stops at until and at count", () => {
    expect(occurrencesBetween({ ...monthly, until: "2027-03-31" }, "2027-01-01", "2028-01-01")).toEqual(["2027-01-31", "2027-02-28", "2027-03-31"]);
    expect(occurrencesBetween({ ...monthly, count: 2 }, "2027-01-01", "2028-01-01")).toEqual(["2027-01-31", "2027-02-28"]);
    expect(occurrence({ ...monthly, count: 2 }, 2)).toBeUndefined();
    expect(nextOccurrence({ ...monthly, until: "2027-03-30" }, "2027-03-01")).toBeUndefined();
    expect(occurrencesBetween({ ...monthly, count: 0 }, "2027-01-01", "2028-01-01")).toEqual([]);
  });

  it("holds the limit of the dates", () => {
    expect(occurrencesBetween({ start: "2026-01-01", every: 1, unit: "day" }, "2026-01-01", "2030-01-01")).toHaveLength(1000);
    expect(occurrencesBetween({ start: "2026-01-01", every: 1, unit: "day" }, "2026-01-01", "2030-01-01", 3)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
  });

  it("gives the first date on or after a date, as a scan of the occurrences gives it", () => {
    const rules: Recurrence[] = [];
    for (const unit of ["day", "week", "month", "year"] as const) {
      for (const every of [1, 2, 5, 13]) {
        for (const start of ["2024-02-29", "2026-01-31", "2026-12-01"]) rules.push({ start, every, unit });
      }
    }
    for (const rule of rules) {
      const scan: string[] = [];
      for (let n = 0; n < 60; n += 1) scan.push(occurrence(rule, n) ?? "");
      // The days near each date, and the day halfway to the next date
      const days = scan.flatMap((d, n) => {
        const day = dayNumber(d) ?? 0;
        const after = dayNumber(scan[n + 1] ?? d) ?? day;
        return [day - 2, day - 1, day, day + 1, Math.floor((day + after) / 2)];
      });
      for (const day of days.filter((d) => d <= (dayNumber(scan[scan.length - 1] ?? "") ?? 0))) {
        const date = dateOfDay(day) ?? "";
        const expected = scan.find((d) => (dayNumber(d) ?? 0) >= day);
        expect(nextOccurrence(rule, date), `${JSON.stringify(rule)} from ${date}`).toBe(expected);
      }
    }
  });

  it("names each problem of a bad rule, and a bad rule gives no date", () => {
    const bad = { start: "2026-02-30", every: 0, unit: "hour", until: "x", count: -1 } as unknown as Recurrence;
    expect(recurrenceProblems(bad)).toHaveLength(5);
    expect(recurrenceProblems(monthly)).toEqual([]);
    expect(occurrence(bad, 0)).toBeUndefined();
    expect(nextOccurrence(bad, "2026-01-01")).toBeUndefined();
    expect(occurrencesBetween(bad, "2026-01-01", "2027-01-01")).toEqual([]);
    expect(occurrence(monthly, -1)).toBeUndefined();
    expect(nextOccurrence(monthly, "bad")).toBeUndefined();
  });

  it("gives no date past the year 9999", () => {
    expect(nextOccurrence({ start: "9999-06-01", every: 1, unit: "year" }, "9999-07-01")).toBeUndefined();
    expect(occurrencesBetween({ start: "9999-12-30", every: 1, unit: "day" }, "9999-12-01", "9999-12-31")).toEqual(["9999-12-30", "9999-12-31"]);
  });
});
