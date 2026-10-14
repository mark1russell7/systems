// @mark1russell7/service/testing: the seams of the runtime for tests. A fake clock gives exact,
// repeatable timing. A seeded random gives the same jitter on each run. A quiet server answers
// until it goes quiet, and then it holds its connections open without an answer.

import type { AddressInfo, Server, Socket } from "node:net";
import { createServer } from "node:net";
import type { Cancel, Clock } from "./clock.ts";
import type { Outcome } from "./latch.ts";
import type { CheckFn } from "./poller.ts";

/**
 * A behavior is what a scripted check does when the runtime starts it:
 * - `"ok"`, `"error"` and `"indeterminate"` give that outcome at once.
 * - `"throw"` throws at once.
 * - `"timeout"` gives no answer until the runtime aborts the use at the timeout of the poll.
 * - `"hang"` gives no answer, and it ignores the abort, until `heal()`.
 */
export type Behavior = Outcome | "throw" | "timeout" | "hang";

/** A scripted check is a check function whose behavior a test sets. */
export interface ScriptedCheck {
  readonly run: CheckFn;
  /** This behavior applies to each later call. */
  behavior: Behavior;
  /** This count is the number of calls of the check. */
  readonly calls: number;
  /** This count is the number of calls that are pending. */
  readonly hung: number;
  /** This method ends each hung call with a pass, as when a driver gets its answer late. */
  heal(): void;
}

/** This function makes a scripted check with a behavior at the start. */
export const scriptedCheck = (behavior: Behavior = "ok"): ScriptedCheck => {
  let calls = 0;
  const hung = new Set<() => void>();
  const script: ScriptedCheck = {
    behavior,
    get calls() {
      return calls;
    },
    get hung() {
      return hung.size;
    },
    heal() {
      for (const end of [...hung]) end();
    },
    run: (signal) => {
      calls += 1;
      const now = script.behavior;
      if (now === "throw") throw new Error("the scripted check threw");
      if (now === "timeout")
        return new Promise<Outcome>((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted at the timeout"))),
        );
      if (now === "hang")
        return new Promise<Outcome>((resolve) => {
          const end = (): void => {
            hung.delete(end);
            resolve("ok");
          };
          hung.add(end);
        });
      return now;
    },
  };
  return script;
};

/** A fake clock moves only when a test tells it to. */
export interface FakeClock extends Clock {
  /** This method moves the clock forward by `ms`, and it starts each timer that comes due, in sequence. */
  advance(ms: number): Promise<void>;
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
        now = timer.at;
        timer.run();
        await settle();
      }
      now = end;
      for (let at = timers.length - 1; at >= 0; at -= 1) if (!timers[at]!.live) timers.splice(at, 1);
      await settle();
    },
    get pending() {
      return timers.filter((timer) => timer.live).length;
    },
  };
};

/** This function gives a seeded random number generator (mulberry32), with numbers in [0, 1). */
export const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** A quiet server is a TCP echo server that can stop its answers and keep its connections open. */
export interface QuietServer {
  readonly port: number;
  /** This method stops the answers. The connections stay open, and the server reads and discards the data. */
  quiet(): void;
  /** This method starts the answers again. */
  speak(): void;
  /** This count is the number of open connections. */
  readonly connections: number;
  close(): Promise<void>;
}

/**
 * This function starts a quiet server on the loopback address. A check against it passes while it
 * answers. When it goes quiet, the check sees a connection that is open but silent. A frozen peer
 * and a black hole that keeps the connection look the same.
 */
export const quietServer = async (): Promise<QuietServer> => {
  let silent = false;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      if (!silent) socket.write(chunk);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    quiet: () => {
      silent = true;
    },
    speak: () => {
      silent = false;
    },
    get connections() {
      return sockets.size;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
};
