import { describe, expect, it } from "vitest";
import { MONGO_CLIENT_MACHINE, MONGO_STARTING_KNOBS, MONGO_STARTING_POLL, mongoMeetings } from "../mongodb.ts";
import { PG_CLIENT_MACHINE, PG_STARTING_KNOBS, PG_STARTING_POLL, pgMeetings } from "../pg.ts";
import type { RedisKnobs } from "../redis.ts";
import { REDIS_CLIENT_MACHINE, meetings } from "../redis.ts";
import { fakeClock } from "../testing.ts";
import type { Attempt } from "./core.ts";
import { STARTING_POLL, deadlineProblem, inFlight, poolProblems, timeProblems, wholeProblems, withinBound, zeroProblems } from "./core.ts";
import { CLIENT_EVENTS } from "./machine.ts";
import { MANIFESTATIONS, WHAT } from "./meets.ts";

const s = (value: number) => ({ value, unit: "s" });
const ms = (value: number) => ({ value, unit: "ms" });
const never = { value: "infinite" as const, unit: "s" };

const REDIS_KNOBS: RedisKnobs = {
  connect_bound: ms(500),
  request_timeout: ms(800),
  driver_writeoff_time: s(2),
  keepalive_idle: s(5),
  heartbeat_interval: s(1),
  heartbeat_timeout: ms(400),
  client_retry_window: s(10),
  retry_base: ms(50),
  retry_cap: ms(400),
  close_bound: ms(300),
  max_connection_age: never,
  retrans_giveup_time: s(924.6),
};

describe("the core of the clients: one vocabulary for each client", () => {
  it("gives each client a meeting for each manifestation, in one sequence, with the shared words", () => {
    for (const meets of [meetings("cache", REDIS_KNOBS, s(2.4)), pgMeetings("db", PG_STARTING_KNOBS), mongoMeetings("docs", MONGO_STARTING_KNOBS)]) {
      expect(meets.map((meeting) => meeting.manifestation)).toEqual([...MANIFESTATIONS]);
      for (const meeting of meets)
        if (meeting.manifestation !== "app-stall") expect(meeting.what).toBe(WHAT[meeting.manifestation as keyof typeof WHAT]);
    }
  });

  it("declares the events of the core in the machine document of each client", () => {
    for (const machine of [REDIS_CLIENT_MACHINE, PG_CLIENT_MACHINE, MONGO_CLIENT_MACHINE])
      for (const event of CLIENT_EVENTS) expect(machine.events, `${machine.id} ${event}`).toHaveProperty([event]);
  });

  it("gives one starting poll, which the pg and mongodb entries give by their own names too", () => {
    expect(PG_STARTING_POLL).toBe(STARTING_POLL);
    expect(MONGO_STARTING_POLL).toBe(STARTING_POLL);
  });

  it("refuses a knob that is not a time of zero or more", () => {
    expect(timeProblems("x", { a: ms(-1), b: never, c: s(0) })).toEqual(["x's a is not a time of zero or more"]);
  });

  it("gives the problems of a driver that reads 0 as no timer, of whole units, of a pool, and O07 (pg and mongodb)", () => {
    const knobs = { a: s(0), b: never, c: s(0), d: never, e: ms(1.5), f: ms(1500) };
    expect(zeroProblems("x", "the driver", knobs, { bounded: ["a", "b"], open: ["c", "d"] })).toEqual([
      "x's a is not a finite time above zero: the driver reads 0 as no bound",
      "x's b is not a finite time above zero: the driver reads 0 as no bound",
      `x's c is zero: give "infinite" for no bound`,
    ]);
    expect(wholeProblems("x", knobs, { millis: ["d", "e", "f"], seconds: ["d", "f"] })).toEqual([
      "x's e is not a whole number of milliseconds",
      "x's f is not a whole number of seconds",
    ]);
    expect(poolProblems("x", { max: 2, min: 0 })).toEqual([]);
    expect(poolProblems("x", { max: 0, min: 1 })).toHaveLength(2);
    expect(deadlineProblem("x", s(5), never, "command")).toBeNull();
    expect(deadlineProblem("x", s(5), s(5), "command")).toMatch(/with a command that the client gave up \(O07\)$/);
  });
});

describe("the calls in flight, and the bound of the close (C10, principle 9)", () => {
  it("settles a call one time, and an abort after the send is indeterminate", async () => {
    const flight = inFlight();
    const abort = new AbortController();
    let settle: ((value: Attempt) => void) | undefined;
    const causes: Array<Error | undefined> = [];
    const pending = flight.track(abort.signal, "abandoned", (given) => (settle = given), (_value, cause) => causes.push(cause));
    expect(flight.size).toBe(1);
    abort.abort();
    settle!({ outcome: "ok", value: 1 });
    expect(await pending).toEqual({ outcome: "indeterminate", error: "abandoned" });
    expect(causes.map((cause) => cause?.message)).toEqual(["abandoned"]);
    expect(flight.size).toBe(0);
  });

  it("settles each call that stays at the close, as indeterminate", async () => {
    const flight = inFlight();
    const calls = [flight.track(undefined, "abandoned", () => {}), flight.track(undefined, "abandoned", () => {})];
    flight.settleAll("closed");
    expect(await Promise.all(calls)).toEqual([
      { outcome: "indeterminate", error: "closed" },
      { outcome: "indeterminate", error: "closed" },
    ]);
  });

  it("gives true for work that ends in its bound, a failure too, and false at the bound", async () => {
    const clock = fakeClock(0);
    expect(await withinBound(clock, 100, Promise.reject(new Error("refused")))).toBe(true);
    const stuck = withinBound(clock, 100, new Promise(() => {}));
    await clock.advance(100);
    expect(await stuck).toBe(false);
  });
});
