// Law 8 of the loop core (SYS-138 part 2): on the same seed and the same scripted rounds, the heartbeat, the watchdog
// and the ticker on the core give the traces of their old code. The old code is here as it was, as a reference. The law
// goes with the old code, in the same pull request.
//
// One change is on purpose, and a test pins it: after a block of the event loop, the ticks of the core keep their grid.
// The old timers of the heartbeat and the watchdog started again from the late tick, thus their ticks moved by the block.

import { valueIn } from "@mark1russell7/quantity";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Channel, ticker, type Ticker } from "./channel.ts";
import type { Cancel, Clock } from "./clock.ts";
import { heartbeat, type Heartbeat, type HeartbeatOptions } from "./heartbeat.ts";
import type { Trace } from "./latch.ts";
import { ms } from "./loop-rig.ts";
import { fakeClock } from "./testing.ts";
import { watchdog, type Watchdog, type WatchdogSpec } from "./watchdog.ts";

/** The runs of the law. A deeper run sets LOOP_LAW_RUNS. */
const RUNS = Number(process.env["LOOP_LAW_RUNS"] ?? 100);

// ---------------------------------------------------------------------------------------------------------------------
// The old code, as it was before the loop core.

const legacyHeartbeat = (options: HeartbeatOptions): Heartbeat => {
  interface Waiting {
    readonly controller: AbortController;
    timer: Cancel | null;
    readonly settle: (answered: boolean) => void;
  }
  const { interval, timeout, misses: limit, clock } = options;
  let misses = 0;
  let stopped = false;
  let next: Cancel | null = null;
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
  const send = (): void => {
    const controller = new AbortController();
    const entry: Waiting = {
      controller,
      timer: null,
      settle: (answered) => {
        if (!pings.delete(entry)) return;
        entry.timer?.();
        const done = (): void => count(answered);
        if (options.turn === undefined) done();
        else void options.turn().then(done, done);
      },
    };
    pings.add(entry);
    if (Number.isFinite(timeout))
      entry.timer = clock!.after(timeout, () => {
        entry.settle(false);
        controller.abort();
      });
    let result: Promise<boolean> | void;
    try {
      result = options.ping(controller.signal);
    } catch {
      entry.settle(false);
      return;
    }
    if (result !== undefined)
      result.then(
        (answered) => entry.settle(answered === true),
        () => entry.settle(false),
      );
  };
  const tick = (): void => {
    next = clock!.after(interval, tick);
    if (options.due !== undefined && !options.due()) return;
    if (stopped || (options.overlap !== true && pings.size > 0)) return;
    send();
  };
  if (Number.isFinite(interval)) next = clock!.after(interval, tick);
  return {
    answer() {
      if (stopped) return;
      misses = 0;
      for (const entry of [...pings]) entry.settle(true);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      next?.();
      next = null;
      for (const entry of [...pings]) {
        pings.delete(entry);
        entry.timer?.();
        entry.controller.abort();
      }
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

const legacyWatchdog = (clock: Clock, spec: WatchdogSpec, trace?: Trace): Watchdog => {
  const tick = valueIn(spec.tick, "ms");
  const threshold = valueIn(spec.threshold, "ms");
  let blocked = false;
  let stopped = false;
  let worst = 0;
  let sincePoll = 0;
  let next: Cancel | null = null;
  const named = (): string => (stopped ? "stopped" : blocked ? "blocked" : "watching");
  const arm = (): void => {
    const due = clock.now() + tick;
    next = clock.after(tick, () => {
      next = null;
      if (stopped) return;
      const late = Math.max(0, clock.now() - due);
      worst = Math.max(worst, late);
      sincePoll = Math.max(sincePoll, late);
      const from = named();
      blocked = late > threshold;
      trace?.(from, named(), "tick");
      arm();
    });
  };
  arm();
  return {
    check: () => {
      const failed = blocked || sincePoll > threshold;
      sincePoll = 0;
      return failed ? "error" : "ok";
    },
    get worst() {
      return worst;
    },
    get blocked() {
      return blocked;
    },
    stop() {
      if (stopped) return;
      const from = named();
      stopped = true;
      next?.();
      next = null;
      trace?.(from, "stopped", "stop");
    },
  };
};

const legacyTicker = (period: number, clock: Clock): Ticker => {
  const ch = new Channel<number>(1);
  const start = clock.now();
  let cancel: Cancel | undefined;
  const arm = (tick: number): void => {
    cancel = clock.after(Math.max(0, start + (tick + 1) * period - clock.now()), () => {
      const due = Math.max(tick, Math.floor((clock.now() - start) / period) - 1);
      ch.trySend(due);
      arm(due + 1);
    });
  };
  arm(0);
  return Object.assign(ch, {
    stop: () => {
      cancel?.();
      ch.close();
    },
  });
};

// ---------------------------------------------------------------------------------------------------------------------
// The heartbeat.

/** A delay of a scripted peer. Half a millisecond off the grid of the timers, or on it: the law holds for each. */
const delayOf = fc.tuple(fc.integer({ min: 0, max: 2000 }), fc.boolean()).map(([whole, half]) => whole + (half ? 0.5 : 0));

/** One ping of a peer that answers each request: a reply after a delay, a rejection, a throw, or no reply at all. */
type RequestPing =
  | { readonly kind: "reply"; readonly delay: number; readonly value: boolean }
  | { readonly kind: "reject"; readonly delay: number }
  | { readonly kind: "throw" }
  | { readonly kind: "silent" };

/** One ping of a peer that gets messages: a pong through answer() after a delay, or none. */
type MessagePing = { readonly kind: "pong"; readonly delay: number } | { readonly kind: "lost" };

const requestPing: fc.Arbitrary<RequestPing> = fc.oneof(
  fc.record({ kind: fc.constant("reply" as const), delay: delayOf, value: fc.boolean() }),
  fc.record({ kind: fc.constant("reject" as const), delay: delayOf }),
  fc.constant({ kind: "throw" as const }),
  fc.constant({ kind: "silent" as const }),
);

const messagePing: fc.Arbitrary<MessagePing> = fc.oneof(
  fc.record({ kind: fc.constant("pong" as const), delay: delayOf }),
  fc.constant({ kind: "lost" as const }),
);

interface BeatCase {
  readonly interval: number;
  readonly timeout: number;
  readonly misses: number;
  readonly overlap: boolean;
  /** The turn before a count: none, one turn of the promises, or a wait on the clock that a stop can fall in. */
  readonly turn: "none" | "promise" | "clock";
  readonly due: readonly boolean[] | null;
  readonly live: readonly boolean[] | null;
  readonly pings: { readonly style: "request"; readonly list: readonly RequestPing[] } | { readonly style: "message"; readonly list: readonly MessagePing[] };
  readonly deadStops: boolean;
  readonly stopAt: number;
}

const beatCase: fc.Arbitrary<BeatCase> = fc.record({
  interval: fc.oneof({ arbitrary: fc.integer({ min: 50, max: 500 }), weight: 9 }, { arbitrary: fc.constant(Number.POSITIVE_INFINITY), weight: 1 }),
  timeout: fc.oneof({ arbitrary: fc.integer({ min: 20, max: 1500 }), weight: 9 }, { arbitrary: fc.constant(Number.POSITIVE_INFINITY), weight: 1 }),
  misses: fc.integer({ min: 1, max: 4 }),
  overlap: fc.boolean(),
  turn: fc.constantFrom("none" as const, "promise" as const, "clock" as const),
  due: fc.option(fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }), { nil: null }),
  live: fc.option(fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }), { nil: null }),
  pings: fc.oneof(
    fc.record({ style: fc.constant("request" as const), list: fc.array(requestPing, { minLength: 1, maxLength: 12 }) }),
    fc.record({ style: fc.constant("message" as const), list: fc.array(messagePing, { minLength: 1, maxLength: 12 }) }),
  ),
  deadStops: fc.boolean(),
  stopAt: fc.integer({ min: 0, max: 8000 }),
});

/** This function operates one heartbeat on a case, and gives each event with its time. */
const beatTrace = async (each: BeatCase, make: (options: HeartbeatOptions) => Heartbeat): Promise<string[]> => {
  const clock = fakeClock();
  const events: string[] = [];
  const log = (event: string): void => {
    events.push(`${clock.now()} ${event}`);
  };
  let dues = 0;
  let lives = 0;
  let sent = 0;
  let beat: Heartbeat | undefined;
  const request = (signal: AbortSignal): Promise<boolean> => {
    const index = sent++;
    const ping = (each.pings.list as readonly RequestPing[])[index % each.pings.list.length]!;
    log(`ping ${index}`);
    if (ping.kind === "throw") throw new Error("the peer is gone");
    return new Promise<boolean>((resolve, reject) => {
      let done = false;
      const cancel =
        ping.kind === "silent"
          ? undefined
          : clock.after(ping.delay, () => {
              done = true;
              if (ping.kind === "reply") resolve(ping.value);
              else reject(new Error("the peer refused the ping"));
            });
      signal.addEventListener(
        "abort",
        () => {
          // only an abort of a ping that waits is an event: the old ping got no abort after its reply
          if (done) return;
          done = true;
          cancel?.();
          log(`abort ${index}`);
          resolve(false);
        },
        { once: true },
      );
    });
  };
  const message = (): void => {
    const index = sent++;
    const ping = (each.pings.list as readonly MessagePing[])[index % each.pings.list.length]!;
    log(`ping ${index}`);
    if (ping.kind === "pong")
      clock.after(ping.delay, () => {
        log(`pong ${index}`);
        beat?.answer();
      });
  };
  beat = make({
    interval: each.interval,
    timeout: each.timeout,
    misses: each.misses,
    overlap: each.overlap,
    clock,
    ping: each.pings.style === "request" ? request : message,
    onMiss: (misses) => log(`miss ${misses}`),
    onDead: () => {
      log("dead");
      if (each.deadStops) beat?.stop();
    },
    ...(each.due === null
      ? {}
      : {
          due: () => {
            const due = each.due![dues++ % each.due!.length]!;
            log(`due ${due}`);
            return due;
          },
        }),
    ...(each.live === null
      ? {}
      : {
          live: () => {
            const live = each.live![lives++ % each.live!.length]!;
            log(`live ${live}`);
            return live;
          },
        }),
    ...(each.turn === "promise" ? { turn: () => Promise.resolve() } : {}),
    ...(each.turn === "clock" ? { turn: () => new Promise<void>((resolve) => void clock.after(1, resolve)) } : {}),
  });
  await clock.advance(each.stopAt);
  log(`state misses=${beat.misses} waiting=${beat.waiting} stopped=${beat.stopped}`);
  beat.stop();
  log(`stop waiting=${beat.waiting}`);
  await clock.advance(3000);
  log(`end misses=${beat.misses} waiting=${beat.waiting} stopped=${beat.stopped}`);
  return events;
};

describe("law 8: the heartbeat on the core gives the trace of its old code", () => {
  it("gives the same pings, aborts, misses, deaths and counts for each peer, each due() and each live()", async () => {
    await fc.assert(
      fc.asyncProperty(beatCase, async (each) => {
        const old = await beatTrace(each, legacyHeartbeat);
        const core = await beatTrace(each, heartbeat);
        expect(core).toEqual(old);
      }),
      { numRuns: RUNS, seed: 8 },
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The watchdog.

type DogStep = { readonly kind: "advance"; readonly ms: number } | { readonly kind: "check" };

interface DogCase {
  readonly tick: number;
  readonly threshold: number;
  readonly steps: readonly DogStep[];
  /** One block at the end: before it, the old ticks and the ticks of the core have one grid. */
  readonly block: number | null;
}

const dogCase: fc.Arbitrary<DogCase> = fc.record({
  tick: fc.integer({ min: 5, max: 300 }),
  threshold: fc.integer({ min: 0, max: 600 }),
  steps: fc.array(
    fc.oneof(fc.record({ kind: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 1000 }) }), fc.constant({ kind: "check" as const })),
    { maxLength: 20 },
  ),
  block: fc.option(fc.integer({ min: 0, max: 2000 }), { nil: null }),
});

const dogTrace = async (each: DogCase, make: (clock: Clock, spec: WatchdogSpec, trace: Trace) => Watchdog): Promise<string[]> => {
  const clock = fakeClock();
  const events: string[] = [];
  const log = (event: string): void => {
    events.push(`${clock.now()} ${event}`);
  };
  const dog = make(clock, { name: "dog", tick: ms(each.tick), threshold: ms(each.threshold), gates: null } as unknown as WatchdogSpec, (from, to, on) =>
    log(`${from}->${to} ${on}`),
  );
  const look = (): void => log(`worst=${dog.worst} blocked=${dog.blocked}`);
  for (const step of each.steps) {
    if (step.kind === "advance") await clock.advance(step.ms);
    else log(`check ${dog.check()}`);
    look();
  }
  if (each.block !== null) {
    clock.block(each.block);
    await clock.advance(0);
    look();
    log(`check ${dog.check()}`);
  }
  dog.stop();
  look();
  await clock.advance(1000);
  log(`check ${dog.check()}`);
  return events;
};

describe("law 8: the watchdog on the core gives the trace of its old code", () => {
  it("gives the same ticks, states, checks and worst lateness, up to and with a block", async () => {
    await fc.assert(
      fc.asyncProperty(dogCase, async (each) => {
        const old = await dogTrace(each, legacyWatchdog);
        const core = await dogTrace(each, watchdog);
        expect(core).toEqual(old);
      }),
      { numRuns: RUNS, seed: 8 },
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The ticker.

type TickStep = { readonly kind: "advance"; readonly ms: number } | { readonly kind: "block"; readonly ms: number } | { readonly kind: "receive" };

const tickCase = fc.record({
  period: fc.integer({ min: 5, max: 300 }),
  steps: fc.array(
    fc.oneof(
      fc.record({ kind: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 1000 }) }),
      fc.record({ kind: fc.constant("block" as const), ms: fc.integer({ min: 0, max: 3000 }) }),
      fc.constant({ kind: "receive" as const }),
    ),
    { maxLength: 24 },
  ),
});

const tickTrace = async (each: { readonly period: number; readonly steps: readonly TickStep[] }, make: (period: number, clock: Clock) => Ticker): Promise<string[]> => {
  const clock = fakeClock();
  const events: string[] = [];
  const log = (event: string): void => {
    events.push(`${clock.now()} ${event}`);
  };
  const t = make(each.period, clock);
  for (const step of each.steps) {
    if (step.kind === "advance") await clock.advance(step.ms);
    else if (step.kind === "block") clock.block(step.ms);
    else log(`receive ${String(t.tryReceive())} size=${t.size}`);
  }
  log(`size=${t.size}`);
  t.stop();
  await clock.advance(1000);
  log(`after the stop ${String(t.tryReceive())} closed=${t.isClosed}`);
  return events;
};

describe("law 8: the ticker on the core gives the trace of its old code", () => {
  it("gives the same tick numbers at the same times, also after blocks of the event loop", async () => {
    await fc.assert(
      fc.asyncProperty(tickCase, async (each) => {
        const old = await tickTrace(each, legacyTicker);
        const core = await tickTrace(each, ticker);
        expect(core).toEqual(old);
      }),
      { numRuns: RUNS, seed: 8 },
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The change on purpose: the grid after a block.

describe("the grid after a block: the one change on purpose", () => {
  it("the watchdog of the core ticks on its grid after a late tick, and the old watchdog moved by the block", async () => {
    const times = async (make: typeof legacyWatchdog): Promise<{ ticks: number[]; free: number | undefined }> => {
      const clock = fakeClock();
      const ticks: number[] = [];
      let free: number | undefined;
      make(clock, { name: "dog", tick: ms(100), threshold: ms(50) } as unknown as WatchdogSpec, (from, to, on) => {
        if (on !== "tick") return;
        ticks.push(clock.now());
        if (from === "blocked" && to === "watching") free ??= clock.now();
      });
      await clock.advance(50);
      // the tick due at 100 starts at 450, late by 350 ms
      clock.block(400);
      await clock.advance(0);
      await clock.advance(200);
      return { ticks, free };
    };
    expect(await times(legacyWatchdog)).toEqual({ ticks: [450, 550, 650], free: 550 });
    expect(await times(watchdog)).toEqual({ ticks: [450, 500, 600], free: 500 });
  });

  it("the heartbeat of the core pings on its grid after a late tick, and the old heartbeat moved by the block", async () => {
    const times = async (make: (options: HeartbeatOptions) => Heartbeat): Promise<number[]> => {
      const clock = fakeClock();
      const pings: number[] = [];
      const beat = make({ interval: 100, timeout: 50, misses: 9, clock, onDead: () => {}, ping: () => {
          pings.push(clock.now());
          return Promise.resolve(true);
        },
      });
      await clock.advance(50);
      clock.block(400);
      await clock.advance(0);
      await clock.advance(200);
      beat.stop();
      return pings;
    };
    expect(await times(legacyHeartbeat)).toEqual([450, 550, 650]);
    expect(await times(heartbeat)).toEqual([450, 500, 600]);
  });
});
