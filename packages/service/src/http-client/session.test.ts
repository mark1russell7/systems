import { describe, expect, it } from "vitest";
import type { Clock } from "../clock.ts";
import { fakeClock } from "../testing.ts";
import type { H2Session, SessionCheckKnobs } from "./session.ts";
import { SESSION_CHECK_CLOSE, sessionCheck, sessionCheckDetection, sessionCheckProblems } from "./session.ts";

const ms = (value: number) => ({ value, unit: "ms" }) as const;
const KNOBS: SessionCheckKnobs = { keepalive_time: ms(500), keepalive_timeout: ms(500) };

/** A session on a fake clock: it acknowledges each PING after a delay, until it goes silent. */
const fakeSession = (clock: Clock, options: { readonly delay?: number; readonly silent?: boolean; readonly connecting?: boolean } = {}) => {
  const pings: number[] = [];
  const destroyed: Error[] = [];
  const session: H2Session & { connecting: boolean } = {
    connecting: options.connecting ?? false,
    ping(callback) {
      pings.push(clock.now());
      if (options.silent !== true) clock.after(options.delay ?? 1, () => callback(null));
      return true;
    },
    destroy(error) {
      destroyed.push(error ?? new Error("destroyed"));
    },
  };
  return { session, pings, destroyed };
};

describe("the session check of an HTTP/2 client", () => {
  it("closes the session when a stream times out, and the error of each stream names the check", () => {
    const clock = fakeClock();
    const { session, destroyed } = fakeSession(clock);
    const causes: string[] = [];
    const check = sessionCheck(session, { knobs: KNOBS, clock, onClose: (cause) => causes.push(cause) });
    check.opened();
    check.opened();
    check.timedOut();
    expect(check.closed).toBe("stream timeout");
    expect(causes).toEqual(["stream timeout"]);
    expect(destroyed).toHaveLength(1);
    expect((destroyed[0] as Error & { code?: string }).code).toBe(SESSION_CHECK_CLOSE);
    // a second timeout does not close again
    check.timedOut();
    expect(destroyed).toHaveLength(1);
  });

  it("sends no PING while the session hears its peer, and closes a session with no ACK at one timeout after the PING", async () => {
    const clock = fakeClock();
    const { session, pings, destroyed } = fakeSession(clock, { silent: true });
    const check = sessionCheck(session, { knobs: KNOBS, clock });
    check.opened();
    // a response each 20 ms for 2 s: the session is never quiet
    for (let at = 0; at < 100; at += 1) {
      await clock.advance(20);
      check.heard();
    }
    expect(pings).toEqual([]);
    // the peer goes silent at 2000 ms: the tick at 2500 ms heard a response, the tick at 3000 ms did not
    await clock.advance(1000);
    expect(pings).toEqual([3000]);
    expect(check.closed).toBeNull();
    await clock.advance(500);
    expect(check.closed).toBe("no PING answer");
    expect(destroyed).toHaveLength(1);
    expect(clock.now() - 2000).toBeLessThanOrEqual(1000 * valueOf(sessionCheckDetection(KNOBS)));
  });

  it("keeps a session whose peer answers each PING", async () => {
    const clock = fakeClock();
    const { session, pings, destroyed } = fakeSession(clock, { delay: 5 });
    const check = sessionCheck(session, { knobs: KNOBS, clock });
    check.opened();
    await clock.advance(10_000);
    expect(pings.length).toBeGreaterThan(5);
    expect(destroyed).toEqual([]);
    expect(check.closed).toBeNull();
  });

  it("sends no PING with no stream in flight, unless keepaliveWithoutCalls permits it (O26)", async () => {
    const clock = fakeClock();
    const idle = fakeSession(clock, { silent: true });
    const quiet = sessionCheck(idle.session, { knobs: KNOBS, clock });
    const open = fakeSession(clock, { silent: true });
    const permitted = sessionCheck(open.session, { knobs: KNOBS, clock, keepaliveWithoutCalls: true });
    await clock.advance(5000);
    expect(idle.pings).toEqual([]);
    expect(quiet.closed).toBeNull();
    expect(open.pings).toEqual([500]);
    expect(permitted.closed).toBe("no PING answer");
  });

  it("counts the streams, and a stream that ends lets the session go quiet without a PING", async () => {
    const clock = fakeClock();
    const { session, pings } = fakeSession(clock, { silent: true });
    const check = sessionCheck(session, { knobs: KNOBS, clock });
    check.opened();
    check.opened();
    check.ended();
    expect(check.streams).toBe(1);
    check.ended();
    check.ended();
    expect(check.streams).toBe(0);
    await clock.advance(5000);
    expect(pings).toEqual([]);
  });

  it("closes a session that does not connect: its tick waits for the SETTINGS of the peer in one timeout", async () => {
    const clock = fakeClock();
    const { session, pings, destroyed } = fakeSession(clock, { connecting: true });
    const check = sessionCheck(session, { knobs: KNOBS, clock });
    check.opened();
    await clock.advance(999);
    expect(pings).toEqual([]);
    expect(check.closed).toBeNull();
    await clock.advance(1);
    expect(check.closed).toBe("no PING answer");
    expect(destroyed).toHaveLength(1);
  });

  it("keeps a session that connects and sends its SETTINGS in the timeout", async () => {
    const clock = fakeClock();
    const { session, destroyed } = fakeSession(clock, { connecting: true });
    const check = sessionCheck(session, { knobs: KNOBS, clock });
    check.opened();
    await clock.advance(700);
    session.connecting = false;
    check.heard();
    await clock.advance(5000);
    expect(destroyed).toEqual([]);
  });

  it("stops: no tick and no close after it", async () => {
    const clock = fakeClock();
    const { session, pings, destroyed } = fakeSession(clock, { silent: true });
    const check = sessionCheck(session, { knobs: KNOBS, clock });
    check.opened();
    check.stop();
    check.stop();
    await clock.advance(5000);
    expect(pings).toEqual([]);
    expect(destroyed).toEqual([]);
  });

  it("sends no PING with keepalive_time infinite, and only a stream timeout closes the session", async () => {
    const clock = fakeClock();
    const { session, pings } = fakeSession(clock, { silent: true });
    const knobs: SessionCheckKnobs = { keepalive_time: { value: "infinite", unit: "s" }, keepalive_timeout: ms(500) };
    const check = sessionCheck(session, { knobs, clock });
    check.opened();
    await clock.advance(60_000);
    expect(pings).toEqual([]);
    expect(sessionCheckDetection(knobs)).toEqual({ value: "infinite", unit: "s" });
    check.timedOut();
    expect(check.closed).toBe("stream timeout");
  });

  it("gives the detection of the PING: two intervals and one timeout", () => {
    expect(sessionCheckDetection(KNOBS)).toEqual({ value: 1.5, unit: "s" });
  });

  it("gives the problems of its knobs", () => {
    expect(sessionCheckProblems("h2", KNOBS)).toEqual([]);
    expect(sessionCheckProblems("h2", { ...KNOBS, keepalive_time: ms(0) })).toEqual(['h2\'s keepalive_time is zero: give "infinite" for no bound']);
    expect(sessionCheckProblems("h2", { ...KNOBS, keepalive_timeout: ms(0) })).toEqual([
      "h2's keepalive_timeout is not a finite time above zero: the timer of the wrapper is the only bound of a PING",
    ]);
    expect(sessionCheckProblems("h2", { ...KNOBS, keepalive_timeout: ms(-1) })).toEqual(["h2's keepalive_timeout is not a time of zero or more"]);
  });
});

/** This function gives a finite amount in seconds. */
const valueOf = (amount: { readonly value: number | "infinite" }): number => (typeof amount.value === "number" ? amount.value : Number.POSITIVE_INFINITY);
