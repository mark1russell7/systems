// @mark1russell7/service/channel: channels in the style of Go, on the clock of the service. It
// imports only ./clock.ts and @mark1russell7/collections: no `node:` module and no zod. Thus a
// client in a browser can use it, as it uses ./clock.
//
// The code came from @mark1russell7/collections 0.7 (the review of its API, C12, S2). The changes:
// `timeout` and `ticker` take a clock, `ticker` does not drift, the functions that start work give
// each failure to `onError` and write nothing to the console, and `fanIn` and `merge` take an array.

import { asyncQueue, type AsyncQueue } from "@mark1russell7/collections";
import { realClock, type Cancel, type Clock } from "./clock.ts";

/** This function gets a failure of the work that a function of this entry started. */
export type ErrorHandler = (error: unknown) => void;

/** These options are for a function that starts work and gives an output channel. */
export interface FlowOptions {
  /** The size of the buffer of each output channel. The default is 0: a send waits for a receiver. */
  readonly bufferSize?: number | undefined;
  /**
   * This function gets each failure of the work. The output closes after a failure. Without it,
   * the failure is lost, but the output also closes.
   */
  readonly onError?: ErrorHandler | undefined;
}

/**
 * A channel carries values from senders to receivers, as a channel of Go does. A channel with a
 * buffer of 0 is a rendezvous: each send waits for a receiver.
 */
export class Channel<T> {
  private readonly queue: AsyncQueue<T>;
  private closed = false;

  /** This constructor makes a channel with a buffer of `bufferSize` values. The default is 0. */
  constructor(bufferSize = 0) {
    // A buffer of 0 makes a send wait for a receiver (before, `bufferSize || 1` gave it a buffer of 1: BUGS-2026-07 L17)
    this.queue = asyncQueue<T>({ capacity: bufferSize });
  }

  /**
   * This method sends a value. It waits while the buffer is full and no receiver waits.
   *
   * @throws Error when the channel is closed.
   */
  async send(value: T): Promise<void> {
    if (this.closed) throw new Error("Cannot send on closed channel");
    await this.queue.put(value);
  }

  /**
   * This method receives a value. It waits while the channel has no value.
   *
   * @throws Error when the channel is closed and empty.
   */
  async receive(): Promise<T> {
    return await this.queue.take();
  }

  /**
   * This method waits for one value, as `receive` does, and gives it to `onValue`. When the
   * channel is closed and empty, it calls `onClosed`. These calls are synchronous: they occur in
   * the call that sends the value or closes the channel.
   *
   * @returns A function that withdraws the wait. It gives true when the wait had no value yet.
   */
  waitReceive(onValue: (value: T) => void, onClosed: (error: Error) => void): () => boolean {
    return this.queue.waitTake(onValue, onClosed);
  }

  /** This method sends a value if a receiver or the buffer takes it at once. It gives false when not. */
  trySend(value: T): boolean {
    if (this.closed) return false;
    return this.queue.tryPut(value);
  }

  /** This method receives a value if the channel has one at once. It gives undefined when not. */
  tryReceive(): T | undefined {
    return this.queue.tryTake();
  }

  /** This method closes the channel. A send then fails, but a receiver can take the values that stay. */
  close(): void {
    this.closed = true;
    this.queue.close();
  }

  /** This value is true after `close`. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** This value is the count of values in the buffer. */
  get size(): number {
    return this.queue.size;
  }

  /** This method makes a case of `select` for this channel. `handler` gets the value of the case. */
  case<R>(handler: (value: T) => R): SelectCase<R> {
    return {
      // The value of each call comes from this channel, so it has the type T
      handler: (value) => handler(value as T),
      wait: (onValue, onClosed) => this.waitReceive(onValue, onClosed),
    };
  }

  /** This iteration receives each value. It stops when the channel is closed and empty. */
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      let value: T;
      try {
        value = await this.receive();
      } catch {
        // The channel is closed and empty
        return;
      }
      yield value;
    }
  }
}

/** A wait for one value that can be withdrawn, as `Channel.waitReceive` gives it. */
export type Wait = (onValue: (value: unknown) => void, onClosed: (error: Error) => void) => () => boolean;

/** A case of `select`: a wait for one value, and the function that gets the value. `Channel.case` makes one. */
export interface SelectCase<R> {
  /** This function gets the value of the case, when the case wins. */
  readonly handler: (value: unknown) => R;
  /** This function waits for one value of the case. `select` withdraws it when another case wins. */
  readonly wait: Wait;
}

/**
 * This function gives the first value of the waits, with the index of its wait. It rejects with
 * the error of the first wait whose channel is closed and empty. It withdraws each other wait in
 * the same call, so a later value stays in its channel (before, the receives of the cases that
 * lost stayed in their channels and dropped the next value of each: audit O56).
 */
const firstOf = (waits: readonly Wait[]): Promise<{ index: number; value: unknown }> =>
  new Promise((resolve, reject) => {
    const withdraws: Array<() => boolean> = [];
    let settled = false;
    const end = (): void => {
      settled = true;
      for (const withdraw of withdraws) withdraw();
    };
    // A wait can call back at once, in its own call, when its channel has a value or is closed
    try {
      for (let index = 0; index < waits.length && !settled; index++) {
        withdraws.push(
          waits[index]!(
            (value) => {
              if (settled) return;
              end();
              resolve({ index, value });
            },
            (error) => {
              if (settled) return;
              end();
              reject(error);
            },
          ),
        );
      }
    } catch (error) {
      // A wait that throws: the waits before it are withdrawn
      if (!settled) end();
      reject(error);
    }
  });

/**
 * This function waits for the first case with a value, as the `select` of Go does, and gives the
 * result of its handler. A case that loses keeps no receive: a later value stays in its channel.
 * When the channel of a case is closed and empty, the promise rejects.
 *
 * @example
 * const result = await select(data.case((v) => `data ${v}`), timeout(1000).case(() => "late"));
 */
export const select = async <R>(...cases: readonly SelectCase<R>[]): Promise<R> => {
  const { index, value } = await firstOf(cases.map((c) => c.wait));
  // The handler runs after the race, not in the call of the sender
  return cases[index]!.handler(value);
};

/**
 * This function makes a channel that gets one value after `ms` milliseconds of `clock`, and then
 * closes. A case of it in `select` is a time limit.
 */
export const timeout = (ms: number, clock: Clock = realClock): Channel<void> => {
  const ch = new Channel<void>();
  clock.after(ms, () => {
    // The value waits for a receiver. The close lets the receivers after it fail at once.
    ch.send(undefined).catch(() => undefined);
    ch.close();
  });
  return ch;
};

/** A ticker is a channel of the numbers of its ticks. `stop` stops its timer and closes it. */
export type Ticker = Channel<number> & { readonly stop: () => void };

/**
 * This function makes a channel that gets a tick each `ms` milliseconds of `clock`. Tick k (from 0)
 * comes due at start + (k + 1) * ms, so the ticks do not drift. A late timer gives the number of
 * the last tick that came due, and skips the ticks that it missed. The buffer has 1 value: a slow
 * receiver loses ticks, as with the ticker of Go.
 */
export const ticker = (ms: number, clock: Clock = realClock): Ticker => {
  if (!(Number.isFinite(ms) && ms > 0)) throw new RangeError(`The period of a ticker is a finite number above 0, not ${ms}`);
  const ch = new Channel<number>(1);
  const start = clock.now();
  let cancel: Cancel | undefined;
  const arm = (tick: number): void => {
    cancel = clock.after(Math.max(0, start + (tick + 1) * ms - clock.now()), () => {
      const due = Math.max(tick, Math.floor((clock.now() - start) / ms) - 1);
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

/** This function starts `work`. It gives a failure to `onError`, and it calls `end` after the work in each case. */
const run = (work: () => Promise<void>, end: () => void, onError: ErrorHandler | undefined): void => {
  void work()
    .catch((error: unknown) => onError?.(error))
    .finally(end);
};

/**
 * This function gives a channel of `transform` of each value of `input`. The output closes when
 * `input` is closed and empty, or after a failure of `transform`.
 */
export const pipeline = <T, U>(input: Channel<T>, transform: (value: T) => U | Promise<U>, options: FlowOptions = {}): Channel<U> => {
  const output = new Channel<U>(options.bufferSize);
  run(
    async () => {
      for await (const value of input) await output.send(await transform(value));
    },
    () => output.close(),
    options.onError,
  );
  return output;
};

/**
 * This function gives `count` channels. Each one gets each value of `input`. The outputs close when
 * `input` is closed and empty, or after a failed send.
 */
export const fanOut = <T>(input: Channel<T>, count: number, options: FlowOptions = {}): Channel<T>[] => {
  const outputs = Array.from({ length: count }, () => new Channel<T>(options.bufferSize));
  run(
    async () => {
      for await (const value of input) await Promise.all(outputs.map((ch) => ch.send(value)));
    },
    () => {
      for (const ch of outputs) ch.close();
    },
    options.onError,
  );
  return outputs;
};

/**
 * This function gives one channel with the values of all `inputs`. The output closes when each
 * input is closed and empty. A failed send of one input goes to `onError`.
 */
export const fanIn = <T>(inputs: readonly Channel<T>[], options: FlowOptions = {}): Channel<T> => {
  const output = new Channel<T>(options.bufferSize);
  const workers = inputs.map(async (input) => {
    for await (const value of input) await output.send(value);
  });
  // All the workers settle, then the output closes, also after a failed send
  void Promise.allSettled(workers).then((results) => {
    output.close();
    for (const result of results) if (result.status === "rejected") options.onError?.(result.reason);
  });
  return output;
};

/**
 * This function gives one channel with the values of `inputs`, as `fanIn` does, but it closes when
 * the first input is closed and empty. It takes one value at a time, from the inputs in turn, and
 * keeps no receive on an input while it waits for the reader. Thus each value reaches the output
 * one time, in the order of its input, or stays in its input. With no input, the output is closed.
 */
export const merge = <T>(inputs: readonly Channel<T>[]): Channel<T> => {
  const output = new Channel<T>();
  // With no input, no input can give a value, so the output is closed at once, as with fanIn
  if (inputs.length === 0) {
    output.close();
    return output;
  }
  void (async () => {
    // The input after the input of the last value comes first, so a busy input starves no other
    let start = 0;
    while (true) {
      const order = inputs.map((_, offset) => (start + offset) % inputs.length);
      let next: { index: number; value: unknown };
      try {
        next = await firstOf(order.map((index): Wait => (onValue, onClosed) => inputs[index]!.waitReceive(onValue, onClosed)));
      } catch {
        // An input is closed and empty
        break;
      }
      const index = order[next.index]!;
      start = (index + 1) % inputs.length;
      try {
        // The value came from inputs[index], so it has the type T
        await output.send(next.value as T);
      } catch {
        // The reader closed the output
        break;
      }
    }
    output.close();
  })();
  return output;
};

/** This function makes a channel with a buffer of `capacity` values. */
export const buffered = <T>(capacity: number): Channel<T> => new Channel<T>(capacity);

/** This function makes a channel with no buffer: each send waits for a receiver. */
export const unbuffered = <T>(): Channel<T> => new Channel<T>(0);

/** This function makes a channel with a buffer of `bufferSize` values. The default is 0. */
export const channel = <T>(bufferSize = 0): Channel<T> => new Channel<T>(bufferSize);

/** These options are for `workerPool`. */
export interface WorkerPoolOptions<T> {
  /** The count of workers. The default is 1. */
  readonly workers?: number | undefined;
  /** The size of the buffer of the results. The default is 0. */
  readonly bufferSize?: number | undefined;
  /** This function gets each failure of a job, with the job. The other jobs continue. */
  readonly onError?: ((error: unknown, job: T) => void) | undefined;
}

/**
 * This function starts `workers` workers. Each one takes a job from `jobs`, gives the job to
 * `worker`, and sends the result. The results close when `jobs` is closed and empty and each
 * worker is done. A failed job goes to `onError`, and its worker takes the next job.
 */
export const workerPool = <T, R>(jobs: Channel<T>, worker: (job: T) => Promise<R>, options: WorkerPoolOptions<T> = {}): Channel<R> => {
  const results = new Channel<R>(options.bufferSize);
  const workers = Array.from({ length: options.workers ?? 1 }, async () => {
    for await (const job of jobs) {
      try {
        await results.send(await worker(job));
      } catch (error) {
        options.onError?.(error, job);
      }
    }
  });
  void Promise.all(workers).then(() => results.close());
  return results;
};
