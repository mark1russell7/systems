import { describe, expect, it } from "vitest";
import { GRPC_CLIENT_MACHINE, GRPC_CLIENT_STARTING_KNOBS, GRPC_CLIENT_STARTING_POLL, grpcMeetings } from "../grpc.ts";
import { HTTP_CLIENT_MACHINE, HTTP_CLIENT_STARTING_KNOBS, HTTP_CLIENT_STARTING_POLL, httpClientMeetings } from "../http-client.ts";
import { MONGO_CLIENT_MACHINE, MONGO_STARTING_KNOBS, MONGO_STARTING_POLL, mongoMeetings } from "../mongodb.ts";
import { PG_CLIENT_MACHINE, PG_STARTING_KNOBS, PG_STARTING_POLL, pgMeetings } from "../pg.ts";
import { RABBIT_CLIENT_MACHINE, RABBIT_STARTING_KNOBS, RABBIT_STARTING_POLL, rabbitMeetings } from "../rabbitmq.ts";
import type { RedisKnobs } from "../redis.ts";
import { REDIS_CLIENT_MACHINE, meetings } from "../redis.ts";
import { fakeClock } from "../testing.ts";
import { WS_CLIENT_MACHINE, WS_CLIENT_STARTING_KNOBS, WS_CLIENT_STARTING_MISSES, WS_CLIENT_STARTING_POLL, wsMeetings } from "../websocket.ts";
import type { Attempt } from "./core.ts";
import {
  STARTING_POLL,
  ageProblems,
  deadlineProblem,
  idleCloseProblem,
  inFlight,
  keepaliveOnProblems,
  missesProblems,
  poolProblems,
  readyWait,
  retryBackoff,
  retryProblems,
  retrySchedule,
  timeProblems,
  trackWithTimer,
  wholeProblems,
  withinBound,
  wrapperTimerProblems,
  zeroProblems,
} from "./core.ts";
import { authority, statusLineJudge } from "./dial.ts";
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
    for (const meets of [
      meetings("cache", REDIS_KNOBS, s(2.4)),
      pgMeetings("db", PG_STARTING_KNOBS),
      mongoMeetings("docs", MONGO_STARTING_KNOBS),
      rabbitMeetings("mq", RABBIT_STARTING_KNOBS),
      httpClientMeetings("api", HTTP_CLIENT_STARTING_KNOBS),
      wsMeetings("feed", WS_CLIENT_STARTING_KNOBS, WS_CLIENT_STARTING_MISSES),
      grpcMeetings("rpc", GRPC_CLIENT_STARTING_KNOBS, false),
    ]) {
      expect(meets.map((meeting) => meeting.manifestation)).toEqual([...MANIFESTATIONS]);
      for (const meeting of meets)
        if (meeting.manifestation !== "app-stall") expect(meeting.what).toBe(WHAT[meeting.manifestation as keyof typeof WHAT]);
    }
  });

  it("declares the events of the core in the machine document of each client", () => {
    for (const machine of [REDIS_CLIENT_MACHINE, PG_CLIENT_MACHINE, MONGO_CLIENT_MACHINE, RABBIT_CLIENT_MACHINE, HTTP_CLIENT_MACHINE, WS_CLIENT_MACHINE, GRPC_CLIENT_MACHINE])
      for (const event of CLIENT_EVENTS) expect(machine.events, `${machine.id} ${event}`).toHaveProperty([event]);
  });

  it("gives one starting poll, which the pg, mongodb, rabbitmq, http-client, websocket and grpc entries give by their own names too", () => {
    expect(PG_STARTING_POLL).toBe(STARTING_POLL);
    expect(MONGO_STARTING_POLL).toBe(STARTING_POLL);
    expect(RABBIT_STARTING_POLL).toBe(STARTING_POLL);
    expect(HTTP_CLIENT_STARTING_POLL).toBe(STARTING_POLL);
    expect(WS_CLIENT_STARTING_POLL).toBe(STARTING_POLL);
    expect(GRPC_CLIENT_STARTING_POLL).toBe(STARTING_POLL);
  });

  it("gives the backoff of the tries to connect from retry_base and retry_cap (redis and rabbitmq)", () => {
    expect(retryBackoff({ retry_base: ms(100), retry_cap: s(2) })).toEqual({ base: 100, factor: 2, cap: 2000, jitter: { kind: "add", amount: 100 } });
    expect(retryProblems("x", { retry_base: s(1), retry_cap: s(1) })).toEqual([]);
    expect(retryProblems("x", { retry_base: s(1), retry_cap: ms(999) })).toEqual(["x's retry_cap is below its retry_base"]);
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

  it("gives the problems of a timer of the wrapper, of an age, of a keepalive that is always on, and O01 (rabbitmq, mongodb and http-client)", () => {
    expect(wrapperTimerProblems("x", { a: s(1), b: s(0), c: never }, { a: "a call", b: "a call", c: "a connect" })).toEqual([
      "x's b is not a finite time above zero: the timer of the wrapper is the only bound of a call",
      "x's c is not a finite time above zero: the timer of the wrapper is the only bound of a connect",
    ]);
    expect(ageProblems("x", { max_connection_age: never }, "why")).toEqual([]);
    expect(ageProblems("x", { max_connection_age: s(60) }, "why")).toEqual(['x\'s max_connection_age is not "infinite": why']);
    expect(keepaliveOnProblems("x", { keepalive_idle: s(1) }, "the agent")).toEqual([]);
    for (const idle of [s(0), never])
      expect(keepaliveOnProblems("x", { keepalive_idle: idle }, "the agent")).toEqual([
        "x's keepalive_idle is not a finite time above zero: the agent always turns keepalive on",
      ]);
    expect(idleCloseProblem("x", s(4), s(6))).toBeNull();
    expect(idleCloseProblem("x", s(4), never)).toBeNull();
    expect(idleCloseProblem("x", s(6), s(6))).toMatch(/pool_idle_expiry is not below the idle close of its server.*\(O01\)$/);
    expect(idleCloseProblem("x", never, s(6))).not.toBeNull();
  });
});

describe("the schedule of the tries to connect (rabbitmq and websocket)", () => {
  it("counts each try, waits for its delay, stops a try that waits, and starts again at a reset", async () => {
    const clock = fakeClock(0);
    const retries = retrySchedule(clock, retryBackoff({ retry_base: ms(100), retry_cap: ms(400) }), () => 0.5);
    const due: Array<[number, number]> = [];
    const schedule = (): void => retries.schedule(() => due.push([clock.now(), retries.tries]));
    schedule();
    await clock.advance(150);
    schedule();
    await clock.advance(250);
    // a second schedule stops the try that waits
    schedule();
    schedule();
    await clock.advance(1000);
    expect(due).toEqual([
      [150, 1],
      [400, 2],
      [850, 4],
    ]);
    retries.reset();
    schedule();
    retries.cancel();
    await clock.advance(1000);
    expect(due).toHaveLength(3);
    expect(retries.tries).toBe(1);
  });
});

describe("the problems and the dial parts that more than one client shares", () => {
  it("refuses a count of misses that is not a whole number above zero (redis and websocket)", () => {
    expect(missesProblems("x", 1, "watchdog")).toEqual([]);
    expect(missesProblems("x", 0, "watchdog")).toEqual(["x's watchdog closes the connection after 0 misses, not a whole number above zero"]);
    expect(missesProblems("x", 1.5, "heartbeat")).toEqual(["x's heartbeat closes the connection after 1.5 misses, not a whole number above zero"]);
  });

  it("judges an HTTP/1.1 status line, and gives the status to the rule of the client (http-client and websocket)", () => {
    const only101 = statusLineJudge((status) => (status === 101 ? null : new Error(`status ${status}`)));
    expect(only101(Buffer.from("HTTP/1.1 101 Switching Protocols\r\n"))).toBeNull();
    expect(String(only101(Buffer.from("HTTP/1.0 200 OK\r\n")))).toBe("Error: status 200");
    expect(only101(Buffer.from("HTTP/1.1"))).toBe("more");
    expect(String(only101(Buffer.alloc(8193, 65)))).toBe("Error: the answer has no status line in its first 8 KiB");
    expect(String(only101(Buffer.from("SSH-2.0\r\n")))).toBe('Error: the answer "SSH-2.0" is not an HTTP/1.1 status line');
    expect(authority("::1", 80)).toBe("[::1]:80");
    expect(authority("api", 8080)).toBe("api:8080");
  });
});

describe("the wait for a ready client before a second try (redis and rabbitmq)", () => {
  it("gives true at once for a ready client, true at a wake, and the state at the end of its time", async () => {
    const clock = fakeClock(0);
    let ready = true;
    const readied = readyWait(clock, () => ready);
    expect(await readied.wait(100)).toBe(true);
    ready = false;
    const woken = readied.wait(100);
    await clock.advance(50);
    ready = true;
    readied.wake();
    expect(await woken).toBe(true);
    expect(clock.now()).toBe(50);
    ready = false;
    const late = readied.wait(100);
    await clock.advance(100);
    expect(await late).toBe(false);
  });

  it("gives false at an abort", async () => {
    const clock = fakeClock(0);
    const readied = readyWait(clock, () => false);
    const abort = new AbortController();
    const waited = readied.wait(100, abort.signal);
    abort.abort();
    expect(await waited).toBe(false);
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

  it("resolves its idle wait when the last call settles, and at once with no call", async () => {
    const flight = inFlight();
    let idle = false;
    await flight.idle();
    let settle: ((value: Attempt) => void) | undefined;
    const pending = flight.track(undefined, "abandoned", (given) => (settle = given));
    void flight.idle().then(() => (idle = true));
    await Promise.resolve();
    expect(idle).toBe(false);
    settle!({ outcome: "ok", value: 1 });
    await pending;
    await Promise.resolve();
    expect(idle).toBe(true);
  });

  it("ends a call with the timer of the wrapper as indeterminate, and stops the timer when the call settles (rabbitmq and http-client)", async () => {
    const clock = fakeClock(0);
    const flight = inFlight();
    const late = trackWithTimer(flight, clock, 100, undefined, "abandoned", "no reply in the bound", () => {});
    await clock.advance(100);
    expect(await late).toEqual({ outcome: "indeterminate", error: "no reply in the bound" });
    const seen: string[] = [];
    const quick = trackWithTimer<number>(
      flight,
      clock,
      100,
      undefined,
      "abandoned",
      "late",
      (settle) => settle({ outcome: "ok", value: 2 }),
      (value) => seen.push(value.outcome),
    );
    expect(await quick).toEqual({ outcome: "ok", value: 2 });
    expect(seen).toEqual(["ok"]);
    expect(clock.pending).toBe(0);
  });

  it("gives true for work that ends in its bound, a failure too, and false at the bound", async () => {
    const clock = fakeClock(0);
    expect(await withinBound(clock, 100, Promise.reject(new Error("refused")))).toBe(true);
    const stuck = withinBound(clock, 100, new Promise(() => {}));
    await clock.advance(100);
    expect(await stuck).toBe(false);
  });
});
