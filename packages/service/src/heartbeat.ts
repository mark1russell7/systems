// @mark1russell7/service/heartbeat: a heartbeat on a clock. A ping starts each interval, each ping
// has a timeout, and a count of misses in sequence finds a dead peer. Each tick is a round of the
// loop core. The entry imports no `node:` module, no zod and no quantity. Thus a client in a browser can use it.

import type { Cancel, Clock } from "./clock.ts";
import { realClock } from "./clock.ts";
import type { RoundContext } from "./loop.ts";
import { runLoop } from "./loop-kernel.ts";

/** These options make a heartbeat. Each time is in milliseconds on the clock. */
export interface HeartbeatOptions {
  /**
   * This time is the interval of the ticks, from the start of one tick to the start of the next.
   * A time that is not finite starts no tick.
   */
  readonly interval: number;
  /** This time bounds each ping. A time that is not finite gives a ping without a timeout. */
  readonly timeout: number;
  /** This count is the number of misses in sequence that make the peer dead. It is a whole number above zero. */
  readonly misses: number;
  /**
   * This function sends one ping. The signal aborts at the timeout of the ping and at `stop()`.
   * - A promise gives the answer: true when the peer answered, and false when it did not.
   * - No value tells that the answer comes later through `answer()`, for example as a pong message.
   * - A throw or a rejection is a miss.
   */
  readonly ping: (signal: AbortSignal) => Promise<boolean> | void;
  /** This function receives the death of the peer: the last of `misses` misses in sequence. The count of misses is then zero again. */
  readonly onDead: () => void;
  /** This function receives each miss, with the count of misses in sequence. */
  readonly onMiss?: ((misses: number) => void) | undefined;
  /**
   * This function operates at each tick, before the ping. The tick sends a ping only when it gives
   * true. A client can also act at the tick, for example to connect again. Without it, each tick sends a ping.
   */
  readonly due?: (() => boolean) | undefined;
  /** This function tells if a miss counts. A miss does not count while it gives false. Without it, each miss counts. */
  readonly live?: (() => boolean) | undefined;
  /** True lets a tick send a ping while an earlier ping waits for its answer. The default is false: one ping at a time. */
  readonly overlap?: boolean | undefined;
  /**
   * This function waits one turn of the event loop. The heartbeat waits it before it counts an
   * answer or a miss, thus it reads a reply that is in the socket first. Without it, the heartbeat counts at once.
   */
  readonly turn?: (() => Promise<void>) | undefined;
  /**
   * This clock gives the ticks and the timeouts. The default is `realClock`, and its timers keep a
   * Node process alive until `stop()`. A heartbeat only watches a connection, and the connection
   * decides if the process stays alive. Thus the owner of a connection gives `unrefClock(clock)`.
   */
  readonly clock?: Clock | undefined;
}

/** A heartbeat is a loop of pings that runs until `stop()`. */
export interface Heartbeat {
  /** This method tells the heartbeat that the peer answered. Each ping that waits gets its answer, and the count of misses is zero. */
  answer(): void;
  /** This method stops the ticks and the timeouts, and it aborts each ping that waits. A second use does nothing. */
  stop(): void;
  /** This count is the number of misses in the current sequence. */
  readonly misses: number;
  /** This count is the number of pings that wait for their answer. */
  readonly waiting: number;
  readonly stopped: boolean;
}

interface Waiting {
  readonly settle: (answered: boolean, error?: unknown) => void;
  readonly scope: RoundContext["scope"];
  timer: Cancel | null;
}

/** This function gives the reason of the abort of a ping at its timeout: a `TimeoutError`, as at the deadline of a scope. */
const timedOut = (timeout: number): DOMException => new DOMException(`The ping had no answer in its timeout of ${timeout} ms.`, "TimeoutError");

/**
 * This function starts a heartbeat. The first tick comes one interval after the start. Each tick
 * starts the next one first, thus the ticks keep their interval while a ping waits. A ping that has
 * no answer at its timeout is a miss. The last miss of `misses` in sequence starts `onDead`.
 *
 * Each tick is a round of the loop core, from `start` with the overlap `allow`. Thus `due()` operates
 * at each tick, also while a ping waits. The heartbeat keeps its own rule of one ping at a time. A
 * round ends at the answer of its ping, and a miss is a failure of the round. At the timeout, the
 * miss counts first, and then the scope of the round aborts with a `TimeoutError`.
 */
export const heartbeat = (options: HeartbeatOptions): Heartbeat => {
  const { interval, timeout, misses: limit, clock = realClock } = options;
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError(`a heartbeat needs a count of misses that is a whole number above zero, not ${limit}`);
  // an interval that is not finite starts no tick. A timer of zero or less waits 1 ms on the platform, thus such an
  // interval ticks each millisecond, as the old timer of the heartbeat did
  const every = !Number.isFinite(interval) ? Number.POSITIVE_INFINITY : interval > 0 ? interval : 1;
  let misses = 0;
  let stopped = false;
  const pings = new Set<Waiting>();

  const count = (answered: boolean): void => {
    if (stopped) return;
    if (answered) {
      misses = 0;
      return;
    }
    if (options.live !== undefined && !options.live()) return;
    misses += 1;
    options.onMiss?.(misses);
    if (misses >= limit) {
      misses = 0;
      options.onDead();
    }
  };

  /** One ping, as the round of a tick. Its promise resolves at the answer, and it rejects at a miss. */
  const send = ({ scope, signal }: RoundContext): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const entry: Waiting = {
        scope,
        timer: null,
        settle: (answered, error) => {
          if (!pings.delete(entry)) return;
          entry.timer?.();
          if (answered) resolve();
          else reject(error ?? new Error("The peer did not answer the ping."));
          // a ping that the stop settles counts nothing, and it waits for no turn
          if (stopped) return;
          const done = (): void => count(answered);
          if (options.turn === undefined) done();
          else void options.turn().then(done, done);
        },
      };
      pings.add(entry);
      if (Number.isFinite(timeout))
        entry.timer = clock.after(timeout, () => {
          entry.settle(false, timedOut(timeout));
          scope.abort(timedOut(timeout));
        });
      let result: Promise<boolean> | void;
      try {
        result = options.ping(signal);
      } catch (error) {
        entry.settle(false, error);
        return;
      }
      if (result !== undefined)
        result.then(
          (answered) => entry.settle(answered === true),
          (error: unknown) => entry.settle(false, error),
        );
    });

  const ticks = runLoop(
    {
      from: "start",
      period: every,
      jitter: 0,
      first: every,
      // the heartbeat bounds each ping with its own timer: the miss counts before the abort of the ping
      timeout: Number.POSITIVE_INFINITY,
      backoff: null,
      overlap: "allow",
      lanes: 1,
      budget: null,
      // the clock decides: the owner of a connection gives `unrefClock(clock)`
      hold: true,
      stable: null,
    },
    (context) => {
      if (options.due !== undefined && !options.due()) return;
      if (stopped || (options.overlap !== true && pings.size > 0)) return;
      return send(context);
    },
    { name: "heartbeat", clock },
  );
  ticks.start();

  return {
    answer() {
      if (stopped) return;
      misses = 0;
      for (const entry of [...pings]) entry.settle(true);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const entry of [...pings]) {
        // the round of the ping ends, and its scope aborts the ping
        entry.settle(false, new DOMException("The heartbeat stopped.", "AbortError"));
        entry.scope.abort();
      }
      // the stop aborts and closes the scope of each round in flight. A ping holds no resource of its scope
      void ticks.stop().catch(() => undefined);
    },
    get misses() {
      return misses;
    },
    get waiting() {
      return pings.size;
    },
    get stopped() {
      return stopped;
    },
  };
};

/**
 * This function gives the most time that a heartbeat takes to find a silent peer, in milliseconds.
 * The first ping without an answer starts one interval after the silence at the latest. The last
 * of `misses` pings then fails at its timeout: `misses` intervals plus a timeout. An interval that
 * is not finite gives infinity.
 *
 * The time holds when each tick sends a ping: with `overlap`, or with a timeout below the interval.
 */
export const detectionTime = (interval: number, timeout: number, misses: number): number =>
  Number.isFinite(interval) ? misses * interval + timeout : Number.POSITIVE_INFINITY;
