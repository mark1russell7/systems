import { describe, expect, it } from "vitest";
import { LIMIT, PRESETS, bucketOf, bucketsBetween, clockOf, counts, frameOf, newestCounted, offsetText, opening, replay, rowsOf, say, shiftsOf, stamp, ticksOf, type Act, type Preset } from "./quota.ts";

const at = (iso: string): number => Date.parse(iso);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const preset = (id: string): Preset => {
  const found = PRESETS.find((p) => p.id === id);
  if (found === undefined) throw new Error(`no preset ${id}`);
  return found;
};

/** This function gives `n` takes at the instant `t`. */
const takes = (n: number, t: number): Act[] => Array.from({ length: n }, () => ({ kind: "take", at: t }));

describe("the frame of a calendar window, from probes of the step of service", () => {
  it("gives the day of 25 hours when the clocks of Chicago go back", () => {
    const { rule, start } = preset("back");
    const frame = frameOf(rule, start);
    expect([frame.from, frame.to]).toEqual([at("2026-11-01T05:00:00Z"), at("2026-11-02T06:00:00Z")]);
    expect(frame.to - frame.from).toBe(25 * HOUR);
    expect(frame.buckets).toEqual([frame.from]);
  });

  it("gives the day of 23 hours when the clocks of Chicago go forward", () => {
    const { rule, start } = preset("forward");
    const frame = frameOf(rule, start);
    expect([frame.from, frame.to]).toEqual([at("2026-03-08T06:00:00Z"), at("2026-03-09T05:00:00Z")]);
    expect(frame.to - frame.from).toBe(23 * HOUR);
  });

  it("starts the day with no midnight at 01:00 in Santiago", () => {
    const { rule, start, zone } = preset("skipped");
    // at 23:30 on September 5, the window of September 5 has 24 hours, and it ends at 01:00
    const before = frameOf(rule, start);
    expect([before.from, before.to]).toEqual([at("2026-09-05T04:00:00Z"), at("2026-09-06T04:00:00Z")]);
    expect(clockOf(before.to, zone)).toBe("01:00");
    const after = frameOf(rule, start + HOUR);
    expect([after.from, after.to]).toEqual([at("2026-09-06T04:00:00Z"), at("2026-09-07T03:00:00Z")]);
    expect(after.to - after.from).toBe(23 * HOUR);
  });

  it("keeps the window of the day before at 05:30 in Kolkata, with a start at 06:00", () => {
    const { rule, start, zone } = preset("half");
    const frame = frameOf(rule, start);
    expect([frame.from, frame.to]).toEqual([at("2026-11-13T00:30:00Z"), at("2026-11-14T00:30:00Z")]);
    expect(clockOf(start, zone)).toBe("05:30");
    expect(clockOf(frame.to, zone)).toBe("06:00");
  });
});

describe("the frame of a rolling window", () => {
  it("holds 7 buckets of 10 min for the last hour", () => {
    const { rule, start } = preset("rolling");
    const frame = frameOf(rule, start);
    expect([frame.from, frame.to]).toEqual([at("2026-11-14T14:00:00Z"), at("2026-11-14T15:10:00Z")]);
    expect(frame.buckets).toHaveLength(7);
    expect(bucketOf(rule, start)).toBe(at("2026-11-14T15:00:00Z"));
  });

  it("lists the buckets of a span, the oldest first, for the lines of the strip", () => {
    const rolling = preset("rolling").rule;
    const starts = bucketsBetween(rolling, at("2026-11-14T14:00:00Z"), at("2026-11-14T15:10:00Z"));
    expect(starts).toHaveLength(8);
    expect([starts[0], starts.at(-1)]).toEqual([at("2026-11-14T14:00:00Z"), at("2026-11-14T15:10:00Z")]);
    // a day of a calendar quota is one bucket, thus the day of 25 hours is one bucket, and the next day starts at 06:00Z
    expect(bucketsBetween(preset("back").rule, at("2026-11-01T02:00:00Z"), at("2026-11-02T08:00:00Z"))).toEqual([
      at("2026-10-31T05:00:00Z"),
      at("2026-11-01T05:00:00Z"),
      at("2026-11-02T06:00:00Z"),
    ]);
  });

  it("counts a unit until its whole bucket is more than one hour old", () => {
    const { rule, start } = preset("rolling");
    expect(counts(rule, start, start + 66 * MINUTE)).toBe(true);
    expect(counts(rule, start, start + 67 * MINUTE)).toBe(false);
  });
});

describe("the shifts and the ticks of a clock", () => {
  it("finds each change of the clock to the millisecond", () => {
    expect(shiftsOf("America/Chicago", at("2026-11-01T05:00:00Z"), at("2026-11-02T06:00:00Z"))).toEqual([{ at: at("2026-11-01T07:00:00Z"), before: "02:00", after: "01:00" }]);
    expect(shiftsOf("America/Chicago", at("2026-03-08T06:00:00Z"), at("2026-03-09T05:00:00Z"))).toEqual([{ at: at("2026-03-08T08:00:00Z"), before: "02:00", after: "03:00" }]);
    expect(shiftsOf("America/Santiago", at("2026-09-05T04:00:00Z"), at("2026-09-07T03:00:00Z"))).toEqual([{ at: at("2026-09-06T04:00:00Z"), before: "00:00", after: "01:00" }]);
    expect(shiftsOf("Asia/Kolkata", at("2026-11-13T00:30:00Z"), at("2026-11-14T00:30:00Z"))).toEqual([]);
  });

  it("gives 26 hour ticks to the day of 25 hours, with 01:00 two times", () => {
    const ticks = ticksOf("America/Chicago", at("2026-11-01T05:00:00Z"), at("2026-11-02T06:00:00Z"), 60, 360);
    expect(ticks).toHaveLength(26);
    expect(ticks.filter((tick) => tick.text === "01:00")).toHaveLength(2);
    expect(ticks.filter((tick) => tick.major).map((tick) => tick.text)).toEqual(["00:00", "06:00", "12:00", "18:00", "00:00"]);
  });

  it("puts the ticks of a half-hour zone on the half hours of UTC", () => {
    const ticks = ticksOf("Asia/Kolkata", at("2026-11-13T00:30:00Z"), at("2026-11-13T03:30:00Z"), 60, 360);
    expect(ticks.map((tick) => new Date(tick.at).toISOString().slice(11, 16))).toEqual(["00:30", "01:30", "02:30", "03:30"]);
    expect(ticks[0]).toMatchObject({ text: "06:00", major: true });
  });

  it("writes the offset with each instant, thus the two 01:30 of a day differ", () => {
    expect(stamp(at("2026-11-01T06:30:00Z"), "America/Chicago")).toBe("Sun 1 Nov, 01:30 UTC−5");
    expect(stamp(at("2026-11-01T07:30:00Z"), "America/Chicago")).toBe("Sun 1 Nov, 01:30 UTC−6");
    expect(stamp(at("2026-11-14T00:00:00Z"), "Asia/Kolkata")).toBe("Sat 14 Nov, 05:30 UTC+5:30");
    expect([offsetText(0), offsetText(-300), offsetText(345)]).toEqual(["UTC", "UTC−5", "UTC+5:45"]);
  });
});

describe("a replay of the acts of a reader", () => {
  it("refuses the fifth take of the day until the next midnight, after 25 hours", () => {
    const { rule, start, zone } = preset("back");
    const result = replay(rule, takes(LIMIT + 1, start), start);
    const refusal = result.entries.at(-1)?.verdict;
    expect(refusal).toMatchObject({ allowed: false, cause: "limit", resetAt: at("2026-11-02T06:00:00Z") });
    expect([...result.marks.values()]).toEqual(["counted", "counted", "counted", "counted", "refused"]);
    expect(say(result, zone, start)).toEqual({
      status: "critical",
      verdict: "Refused",
      title: "4 of 4 used",
      detail: "The next unit opens at Mon 2 Nov, 00:00 UTC−6, in 23 h 30 min.",
    });
  });

  it("frees one unit with a give-back, and counts the next take", () => {
    const { rule, start, zone } = preset("back");
    const four = takes(LIMIT, start);
    const full = replay(rule, four, start);
    expect(say(full, zone, start)).toMatchObject({ status: "neutral", verdict: "Full", title: "4 of 4 used, 0 left" });
    const back: Act[] = [...four, { kind: "give-back", at: start + HOUR, take: newestCounted(full) }];
    const freed = replay(rule, back, start + HOUR);
    expect(freed.state).toMatchObject({ used: 3, left: 1 });
    expect(freed.marks.get(3)).toBe("given back");
    expect(say(freed, zone, start + HOUR)).toMatchObject({ status: "good", verdict: "Room", title: "3 of 4 used, 1 left" });
    const again = replay(rule, [...back, { kind: "take", at: start + HOUR }], start + HOUR);
    expect(again.entries.at(-1)?.verdict?.allowed).toBe(true);
    expect(rowsOf(again, zone).map((row) => [row.what, row.verdict, row.used, row.mark])).toEqual([
      ["Take 1", "allowed", 1, "counted"],
      ["Take 2", "allowed", 2, "counted"],
      ["Take 3", "allowed", 3, "counted"],
      ["Take 4", "allowed", 4, "given back"],
      ["Give back take 4", "given back", 3, ""],
      ["Take 5", "allowed", 4, "counted"],
    ]);
  });

  it("lets a take at 15:03 in the rolling hour stop counting at 16:10, 67 min after it", () => {
    const { rule, start, zone } = preset("rolling");
    const later = start + 67 * MINUTE;
    const result = replay(rule, takes(1, start), later);
    expect(result.marks.get(0)).toBe("expired");
    expect(result.state.used).toBe(0);
    expect(say(result, zone, later)).toMatchObject({ title: "0 of 4 used, 4 left", detail: "No unit counts in this window." });
    expect(newestCounted(result)).toBe(-1);
  });

  it("gives back nothing for a take whose bucket stopped counting", () => {
    const { rule, start } = preset("rolling");
    const later = start + 2 * HOUR;
    const result = replay(rule, [...takes(1, start), { kind: "give-back", at: later, take: 0 }], later);
    expect(result.marks.get(0)).toBe("expired");
    expect(result.state.used).toBe(0);
  });

  it("names the refused instant on the clock of the zone in a row", () => {
    const { rule, start, zone } = preset("skipped");
    const result = replay(rule, takes(LIMIT + 1, start), start);
    expect(rowsOf(result, zone).at(-1)).toMatchObject({ what: "Take 5", verdict: "refused until 01:00", used: 4, left: 0, mark: "refused" });
  });

  it("opens each preset with two takes one hour apart, and shows its case", () => {
    const stamps = (id: string): string[] => {
      const p = preset(id);
      const { acts, at: t } = opening(p);
      return rowsOf(replay(p.rule, acts, t), p.zone).map((row) => `${row.when} ${row.mark}`);
    };
    expect(stamps("back")).toEqual(["Sun 1 Nov, 01:30 UTC−5 counted", "Sun 1 Nov, 01:30 UTC−6 counted"]);
    expect(stamps("forward")).toEqual(["Sun 8 Mar, 01:30 UTC−6 counted", "Sun 8 Mar, 03:30 UTC−5 counted"]);
    expect(stamps("skipped")).toEqual(["Sat 5 Sep, 23:30 UTC−4 expired", "Sun 6 Sep, 01:30 UTC−3 counted"]);
    expect(stamps("half")).toEqual(["Sat 14 Nov, 05:30 UTC+5:30 expired", "Sat 14 Nov, 06:30 UTC+5:30 counted"]);
    expect(stamps("rolling")).toEqual(["Sat 14 Nov, 15:03 UTC counted", "Sat 14 Nov, 16:03 UTC counted"]);
  });

  it("counts as many marks as the state counts units, at each step of a script on each preset", () => {
    for (const { rule, start } of PRESETS) {
      const acts: Act[] = [];
      let t = start;
      const script: Array<"take" | "back" | number> = ["take", "take", 10 * MINUTE, "take", "back", HOUR, "take", "take", "take", 6 * HOUR, "take", "back", 20 * HOUR, "take"];
      for (const move of script) {
        if (typeof move === "number") t += move;
        else if (move === "take") acts.push({ kind: "take", at: t });
        else {
          const newest = newestCounted(replay(rule, acts, t));
          if (newest >= 0) acts.push({ kind: "give-back", at: t, take: newest });
        }
        const result = replay(rule, acts, t);
        const counted = [...result.marks.values()].filter((mark) => mark === "counted").length;
        expect(counted).toBe(result.state.used);
        expect(result.state.used).toBeLessThanOrEqual(LIMIT);
      }
    }
  });
});
