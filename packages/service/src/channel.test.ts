/**
 * The channels came from @mark1russell7/collections 0.7 with their regressions: BUGS-2026-07 L17
 * (an unbuffered channel had a buffer of 1) and audit O56 (the cases of `select` that lost, and the
 * inputs of `merge`, kept a receive and dropped the next value). These tests use no real timer:
 * a fake clock moves the time, and a flush of the ready promises replaces a wait.
 */

import { describe, expect, it } from "vitest";
import { PreemptedError, channel, fanIn, fanOut, merge, pipeline, preemptivePool, select, ticker, timeout, unbuffered, workerPool, type Channel } from "./channel.ts";
import { fakeClock, seeded } from "./testing.ts";

/** This function lets the ready promises continue, `turns` times. */
const flush = async (turns = 100): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
};

/** This function gives the value of a promise that settles after a flush. A lost value does not settle at any time, so the test fails. */
const settles = async <T>(promise: Promise<T>, what: string): Promise<T> => {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await flush(2000);
  if (!done) throw new Error(`${what} did not settle: a value was lost`);
  return promise;
};

/** This function gives a whole number in [low, high], from a seeded generator. */
const between = (random: () => number, low: number, high: number): number => low + Math.floor(random() * (high + 1 - low));

/** A step of a script: a send of the next number to a channel, or a receive. A wait lets the ready promises continue. */
interface Step {
  readonly send: boolean;
  readonly to: number;
  readonly wait: boolean;
}

/** This function gives 100 seeded cases of capacities (2 or 3 channels, each 0 to 2) and a script of 1 to 40 steps. */
const scripts = (seed: number): Array<{ capacities: number[]; script: Step[] }> => {
  const random = seeded(seed);
  return Array.from({ length: 100 }, () => ({
    capacities: Array.from({ length: between(random, 2, 3) }, () => between(random, 0, 2)),
    script: Array.from({ length: between(random, 1, 40) }, () => ({ send: random() < 0.5, to: between(random, 0, 2), wait: random() < 0.5 })),
  }));
};

describe("Channel", () => {
  it("an unbuffered channel makes send wait for a receiver (L17)", async () => {
    const ch = unbuffered<string>();
    expect(ch.trySend("x")).toBe(false);
    let sent = false;
    const send = ch.send("hello").then(() => (sent = true));
    await flush();
    expect(sent).toBe(false);
    expect(await ch.receive()).toBe("hello");
    await send;
    expect(sent).toBe(true);
  });

  it("a buffered channel takes its buffer size without a receiver", async () => {
    const ch = channel<number>(2);
    expect(ch.trySend(1)).toBe(true);
    expect(ch.trySend(2)).toBe(true);
    expect(ch.trySend(3)).toBe(false);
    ch.close();
    const seen: number[] = [];
    for await (const n of ch) seen.push(n);
    expect(seen).toEqual([1, 2]);
  });

  it("refuses a send after close, and a receive of a closed empty channel rejects", async () => {
    const ch = channel<number>(1);
    ch.close();
    expect(ch.isClosed).toBe(true);
    expect(ch.trySend(1)).toBe(false);
    await expect(ch.send(1)).rejects.toThrow("closed");
    await expect(ch.receive()).rejects.toThrow();
  });
});

describe("select (audit O56 #4: the cases that lose keep no receive)", () => {
  it("withdraws the receive of each case that loses, so a later send finds no receiver", async () => {
    const a = channel<string>();
    const b = channel<string>();
    const first = select(
      a.case((v) => `a:${v}`),
      b.case((v) => `b:${v}`),
    );
    await flush();
    expect(a.trySend("1")).toBe(true);
    expect(await first).toBe("a:1");
    // Before the fix, the receive of the case b still waited: it took "2" and dropped it
    expect(b.trySend("2")).toBe(false);
    const sent = b.send("2");
    expect(await settles(b.receive(), "receive")).toBe("2");
    await sent;
  });

  it("two sends in one turn: the first wins, and the second stays for the next receiver", async () => {
    const a = channel<number>();
    const b = channel<number>(1);
    const first = select(
      a.case((v) => `a${v}`),
      b.case((v) => `b${v}`),
    );
    await flush();
    expect(a.trySend(1)).toBe(true);
    expect(b.trySend(2)).toBe(true);
    expect(await first).toBe("a1");
    expect(b.size).toBe(1);
    const second = select(
      a.case((v) => `a${v}`),
      b.case((v) => `b${v}`),
    );
    expect(await settles(second, "select")).toBe("b2");
  });

  it("a loop of select calls gets each value one time, in the order of each channel", async () => {
    const a = channel<number>(2);
    const b = channel<number>();
    const got: string[] = [];
    const loop = (async () => {
      for (let i = 0; i < 6; i++)
        got.push(
          await select(
            a.case((v) => `a${v}`),
            b.case((v) => `b${v}`),
          ),
        );
    })();
    const sends: Promise<void>[] = [];
    for (let i = 1; i <= 3; i++) {
      await flush();
      sends.push(a.send(i));
      await flush();
      sends.push(b.send(i));
    }
    await settles(loop, "the loop of select calls");
    await settles(Promise.all(sends), "the sends");
    expect(got.filter((v) => v.startsWith("a"))).toEqual(["a1", "a2", "a3"]);
    expect(got.filter((v) => v.startsWith("b"))).toEqual(["b1", "b2", "b3"]);
  });

  it("gives a value that is undefined, from a channel that has it at once", async () => {
    const done = channel<void>(1);
    const data = channel<number>();
    expect(done.trySend(undefined)).toBe(true);
    const result = select(
      data.case((v) => `data ${v}`),
      done.case(() => "done"),
    );
    expect(await settles(result, "select")).toBe("done");
    expect(done.size).toBe(0);
    expect(data.trySend(1)).toBe(false);
  });

  it("a timeout case wins when the fake clock reaches it, and leaves no receive on the data channel", async () => {
    const clock = fakeClock();
    const data = channel<number>();
    let result: string | undefined;
    const race = select(
      data.case((v) => `data ${v}`),
      timeout(5, clock).case(() => "timeout"),
    ).then((value) => (result = value));
    await clock.advance(4);
    expect(result).toBeUndefined();
    await clock.advance(1);
    await settles(race, "select");
    expect(result).toBe("timeout");
    expect(data.trySend(1)).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it("rejects for a closed channel, and withdraws the receives of the other cases", async () => {
    const a = channel<number>();
    const b = channel<number>();
    b.close();
    await expect(
      select(
        a.case((v) => v),
        b.case((v) => v),
      ),
    ).rejects.toThrow("closed");
    expect(a.trySend(1)).toBe(false);
  });

  it("keeps each value one time and the order of each channel, with any capacity and any interleaving", async () => {
    for (const { capacities, script } of scripts(56)) {
      const channels = capacities.map((capacity) => channel<number>(capacity));
      const sent: number[][] = channels.map(() => []);
      const got: number[][] = channels.map(() => []);
      const pending: Promise<unknown>[] = [];
      let values = 0;
      let selects = 0;
      const startSelect = (): void => {
        selects++;
        pending.push(select(...channels.map((ch, index) => ch.case((value: number) => got[index]!.push(value)))));
      };
      const send = (index: number): void => {
        sent[index]!.push(values);
        pending.push(channels[index]!.send(values++));
      };
      for (const step of script) {
        if (step.send) send(step.to % channels.length);
        else startSelect();
        if (step.wait) await flush();
      }
      // The same number of sends and selects: each select gets one value
      while (values < selects) send(values % channels.length);
      while (selects < values) startSelect();
      await settles(Promise.all(pending), "a send or a select");
      expect(got).toEqual(sent);
      expect(channels.map((ch) => ch.size)).toEqual(channels.map(() => 0));
    }
  });
});

describe("merge (audit O56 #6: no value of an input is lost)", () => {
  it("passes on every value of each input, in the order of each input", async () => {
    const a = channel<number>();
    const b = channel<number>();
    const out = merge([a, b]);
    const sends = [a.send(1), b.send(11), a.send(2), b.send(12), a.send(3), b.send(13)];
    const got: number[] = [];
    for (let i = 0; i < 6; i++) got.push(await settles(out.receive(), `receive ${i + 1}`));
    await Promise.all(sends);
    expect(got.filter((v) => v < 10)).toEqual([1, 2, 3]);
    expect(got.filter((v) => v > 10)).toEqual([11, 12, 13]);
  });

  it("takes the inputs in turn, so a busy input does not starve the others", async () => {
    const a = channel<string>(4);
    const b = channel<string>(4);
    for (const v of ["a1", "a2", "a3"]) await a.send(v);
    for (const v of ["b1", "b2", "b3"]) await b.send(v);
    const out = merge([a, b]);
    const got: string[] = [];
    for (let i = 0; i < 6; i++) got.push(await settles(out.receive(), `receive ${i + 1}`));
    expect(got).toEqual(["a1", "b1", "a2", "b2", "a3", "b3"]);
  });

  it("closes when the first input closes, and leaves no receive on the other inputs", async () => {
    const a = channel<number>();
    const b = channel<number>();
    const out = merge([a, b]);
    const sent = a.send(1);
    expect(await settles(out.receive(), "receive")).toBe(1);
    await sent;
    a.close();
    const end = out.receive().then(
      () => "value",
      () => "closed",
    );
    expect(await settles(end, "the end of the output")).toBe("closed");
    // Before the fix, the pending receive of b took this value and dropped it
    expect(b.trySend(5)).toBe(false);
  });

  it("with no input, the output is closed and its iteration ends, as with fanIn", async () => {
    for (const out of [merge<number>([]), fanIn<number>([])]) {
      await flush();
      expect(out.isClosed).toBe(true);
      const seen: number[] = [];
      await settles(
        (async () => {
          for await (const value of out) seen.push(value);
        })(),
        "the iteration of the output",
      );
      expect(seen).toEqual([]);
    }
  });

  it("keeps each value one time and the order of each input, with any capacity and any interleaving", async () => {
    for (const { capacities, script } of scripts(66)) {
      const inputs: Channel<number>[] = capacities.map((capacity) => channel<number>(capacity));
      const out = merge(inputs);
      const sent: number[][] = inputs.map(() => []);
      const origin = new Map<number, number>();
      const sends: Promise<void>[] = [];
      const receives: Promise<number>[] = [];
      let values = 0;
      for (const step of script) {
        if (step.send) {
          const index = step.to % inputs.length;
          sent[index]!.push(values);
          origin.set(values, index);
          sends.push(inputs[index]!.send(values++));
        } else if (receives.length < values) {
          receives.push(out.receive());
        }
        if (step.wait) await flush();
      }
      while (receives.length < values) receives.push(out.receive());
      const got = await settles(Promise.all(receives), "a receive of the output");
      await settles(Promise.all(sends), "a send of an input");
      const byInput: number[][] = inputs.map(() => []);
      for (const value of got) byInput[origin.get(value)!]!.push(value);
      expect(byInput).toEqual(sent);
    }
  });
});

describe("ticker: the ticks of a clock, with no drift", () => {
  it("gives tick k at start + (k + 1) * ms, also after a late timer", async () => {
    const clock = fakeClock(1000);
    const tick = ticker(100, clock);
    await clock.advance(100);
    expect(tick.tryReceive()).toBe(0);
    // A blocked event loop: the timer of tick 1 (at 1200) starts late, at 1350
    clock.block(250);
    await clock.advance(0);
    // Ticks 1 and 2 came due: the late timer gives the last one, and skips tick 1
    expect(tick.tryReceive()).toBe(2);
    await clock.advance(49);
    expect(tick.tryReceive()).toBeUndefined();
    // Tick 3 comes at 1400, the time of its slot. A timer armed 100 ms after the late tick drifts to 1450.
    await clock.advance(1);
    expect(tick.tryReceive()).toBe(3);
    tick.stop();
  });

  it("a slow receiver loses ticks: the buffer has one tick", async () => {
    const clock = fakeClock();
    const tick = ticker(10, clock);
    await clock.advance(30);
    expect(tick.tryReceive()).toBe(0);
    expect(tick.tryReceive()).toBeUndefined();
    await clock.advance(10);
    expect(tick.tryReceive()).toBe(3);
    tick.stop();
  });

  it("stop stops the timer and closes the channel", async () => {
    const clock = fakeClock();
    const tick = ticker(10, clock);
    expect(clock.pending).toBe(1);
    tick.stop();
    expect(clock.pending).toBe(0);
    expect(tick.isClosed).toBe(true);
    await clock.advance(100);
    expect(tick.tryReceive()).toBeUndefined();
  });

  it("refuses a period that is not a finite number above 0", () => {
    const clock = fakeClock();
    for (const ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => ticker(ms, clock)).toThrow(RangeError);
    expect(clock.pending).toBe(0);
  });
});

describe("the functions that start work give each failure to onError, and close the output", () => {
  it("pipeline: a transform that fails (audit pass 2)", async () => {
    const errors: unknown[] = [];
    const input = channel<number>(4);
    const output = pipeline(
      input,
      (value) => {
        if (value === 2) throw new Error("bad value");
        return value * 10;
      },
      { onError: (error) => errors.push(error) },
    );
    await input.send(1);
    await input.send(2);
    const got: number[] = [];
    await settles(
      (async () => {
        for await (const value of output) got.push(value);
      })(),
      "the output",
    );
    expect(got).toEqual([10]);
    expect(errors).toEqual([new Error("bad value")]);
  });

  it("pipeline: the output closes when the input is closed and empty, with no failure", async () => {
    const errors: unknown[] = [];
    const input = channel<number>(2);
    const output = pipeline(input, (value) => value + 1, { bufferSize: 2, onError: (error) => errors.push(error) });
    await input.send(1);
    await input.send(2);
    input.close();
    const got: number[] = [];
    await settles(
      (async () => {
        for await (const value of output) got.push(value);
      })(),
      "the output",
    );
    expect(got).toEqual([2, 3]);
    expect(errors).toEqual([]);
  });

  it("fanOut: each output gets each value, and a closed output ends the work", async () => {
    const errors: unknown[] = [];
    const input = channel<number>(4);
    const [a, b] = fanOut(input, 2, { bufferSize: 1, onError: (error) => errors.push(error) });
    await input.send(1);
    await flush();
    expect([a!.tryReceive(), b!.tryReceive()]).toEqual([1, 1]);
    a!.close();
    await input.send(2);
    await flush();
    expect(errors).toHaveLength(1);
    expect(b!.isClosed).toBe(true);
  });

  it("fanIn: a send to a closed output goes to onError, and the output closes after each input", async () => {
    const errors: unknown[] = [];
    const a = channel<number>(1);
    const b = channel<number>(1);
    const out = fanIn([a, b], { onError: (error) => errors.push(error) });
    out.close();
    await a.send(1);
    b.close();
    a.close();
    await flush();
    expect(errors).toHaveLength(1);
    expect(out.isClosed).toBe(true);
  });

  it("fanIn: the values of all inputs, and the output closes when each input is closed", async () => {
    const a = channel<number>(2);
    const b = channel<number>(2);
    const out = fanIn([a, b], { bufferSize: 4 });
    await a.send(1);
    await b.send(2);
    a.close();
    b.close();
    const got: number[] = [];
    await settles(
      (async () => {
        for await (const value of out) got.push(value);
      })(),
      "the output",
    );
    expect(got.sort()).toEqual([1, 2]);
  });

  it("workerPool: a failed job goes to onError with the job, and the other jobs continue", async () => {
    const failed: Array<[unknown, number]> = [];
    const jobs = channel<number>(4);
    for (const job of [1, 2, 3]) await jobs.send(job);
    jobs.close();
    const results = workerPool(
      jobs,
      async (job) => {
        if (job === 2) throw new Error("bad job");
        return job * 10;
      },
      { workers: 2, bufferSize: 4, onError: (error, job) => failed.push([error, job]) },
    );
    const got: number[] = [];
    await settles(
      (async () => {
        for await (const value of results) got.push(value);
      })(),
      "the results",
    );
    expect(got.sort()).toEqual([10, 30]);
    expect(failed).toEqual([[new Error("bad job"), 2]]);
  });
});

describe("preemptivePool", () => {
  /** A task that a test ends by hand, with its signal. */
  const handTask = () => {
    const tasks: Array<{ signal: AbortSignal; end(value: number): void; fail(error: Error): void }> = [];
    const task = (signal: AbortSignal): Promise<number> => new Promise((end, fail) => tasks.push({ signal, end, fail }));
    return { task, tasks };
  };

  it("runs at most max tasks, and a new task stops the oldest at once", async () => {
    const { task, tasks } = handTask();
    const pool = preemptivePool(2);
    const first = pool.run(task);
    const second = pool.run(task);
    await flush();
    expect(pool.size).toBe(2);
    const third = pool.run(task);
    await expect(first).rejects.toBeInstanceOf(PreemptedError);
    await flush();
    expect(tasks.map((each) => each.signal.aborted)).toEqual([true, false, false]);
    expect(pool.size).toBe(2);
    // A stopped task that ends later changes nothing
    tasks[0]?.end(0);
    tasks[1]?.end(1);
    tasks[2]?.end(2);
    expect([await second, await third]).toEqual([1, 2]);
    await flush();
    expect(pool.size).toBe(0);
  });

  it("stops each task with the reason of stop, and passes the failure of a task", async () => {
    const { task, tasks } = handTask();
    const pool = preemptivePool(3);
    const a = pool.run(task);
    const b = pool.run(task);
    const reason = new Error("The window closed.");
    pool.stop(reason);
    await expect(a).rejects.toBe(reason);
    await expect(b).rejects.toBe(reason);
    expect(pool.size).toBe(0);
    const c = pool.run(task);
    pool.stop();
    await expect(c).rejects.toBeInstanceOf(PreemptedError);

    const failed = pool.run(task);
    await flush();
    tasks[3]?.fail(new Error("No route."));
    await expect(failed).rejects.toThrow("No route.");
    await expect(
      pool.run(() => {
        throw new Error("At once.");
      }),
    ).rejects.toThrow("At once.");
    expect(() => preemptivePool(0)).toThrow(RangeError);
    expect(() => preemptivePool(1.5)).toThrow(RangeError);
  });

  it("keeps at most max tasks, and stops only the oldest task, in 100 seeded scripts", async () => {
    const random = seeded(0x9e3779b9);
    for (let run = 0; run < 100; run += 1) {
      const max = between(random, 1, 3);
      const pool = preemptivePool(max);
      /** The tasks that run, from the oldest, as the test sees them. */
      const open: Array<{ id: number; end(): void }> = [];
      const outcome = new Map<number, "done" | "stopped">();
      const steps = between(random, 1, 30);
      for (let step = 0, id = 0; step < steps; step += 1) {
        if (random() < 0.6 || open.length === 0) {
          const mine = id++;
          const oldest = open.length >= max ? open.shift() : undefined;
          let end = (): void => undefined;
          const promise = pool.run(() => new Promise<number>((resolve) => (end = () => resolve(mine))));
          open.push({ id: mine, end: () => end() });
          promise.then(
            () => outcome.set(mine, "done"),
            (error: unknown) => outcome.set(mine, error instanceof PreemptedError ? "stopped" : "done"),
          );
          await flush(5);
          if (oldest !== undefined) expect(outcome.get(oldest.id), `run ${run}: task ${oldest.id} is the oldest`).toBe("stopped");
        } else {
          const index = between(random, 0, open.length - 1);
          const [ended] = open.splice(index, 1);
          ended?.end();
          await flush(5);
          if (ended !== undefined) expect(outcome.get(ended.id)).toBe("done");
        }
        expect(pool.size).toBe(open.length);
        expect(pool.size).toBeLessThanOrEqual(max);
      }
    }
  });
});
