import { quantity } from "@mark1russell7/quantity";
import type { Clock } from "./clock.ts";
import type { Controller } from "./description.ts";
import type { Operation } from "./operation.ts";
import { mayReissue } from "./operation.ts";
import type { CompiledPattern, OperationOf } from "./routes.ts";
import { compilePattern } from "./routes.ts";

/**
 * A request end is the one final result of the stream of a request. Its count `delivered` is the
 * number of items that the stream gave before it. An end after the first item is in-band. The
 * transport sent its answer, thus it writes the end as the last line of the stream, not as a status.
 * - `done`: the work gave each of its items.
 * - `failed`: the work failed for a cause of its own. Before the first item, the adapter answers it
 *   as it answers any error of the route.
 * - `refused`: the service did not admit the request. A refused request did not start, thus its
 *   caller can send it again: 503, retryable.
 * - `cut`: the shutdown stopped the request. Before the first item, a route whose callers can send
 *   it again answers 503, retryable, and each other route answers 500. After the first item, the
 *   status is null, and the end is in-band.
 */
export type RequestEnd =
  | { readonly kind: "done"; readonly delivered: number }
  | { readonly kind: "failed"; readonly error: unknown; readonly delivered: number }
  | {
      readonly kind: "refused";
      readonly status: 503;
      readonly retryable: true;
      readonly cause: string;
      readonly delivered: 0;
    }
  | {
      readonly kind: "cut";
      readonly status: 503 | 500 | null;
      readonly retryable: boolean;
      readonly cause: string;
      readonly delivered: number;
    };

/** A request event is one event of the stream of a request: an item, or the one end, which comes last. */
export type RequestEvent<T> = { readonly kind: "item"; readonly value: T } | RequestEnd;

/**
 * A request stream is what a request comes to: its items, then one end. A unary work gives a stream
 * of one item. The stream gives an item only when its reader asks for the next event. Thus a slow
 * reader slows the work, and the request stays in flight until the work ends. When the reader
 * stops before the end, the work gets its abort and the `return()` of its iterator.
 */
export interface RequestStream<T> extends AsyncIterable<RequestEvent<T>> {
  /** This method reads the whole stream, and gives its items and its end. */
  collect(): Promise<{ readonly items: readonly T[]; readonly end: RequestEnd }>;
}

/**
 * A request work is what a request function gives: one value, or a stream of values. A work that
 * gives an async iterable is a stream, also through a promise. Each other value is a stream of one.
 */
export type RequestWork<T> = T | PromiseLike<T> | AsyncIterable<T> | PromiseLike<AsyncIterable<T>>;

/** A request function does the work of one request. It receives a signal that the shutdown aborts. */
export type RequestFn<T> = (signal: AbortSignal) => RequestWork<T>;

/** These options go with one request. */
export interface RequestOptions {
  /** This value goes to the function of a route pattern, for example the metadata of a procedure. */
  readonly detail?: unknown;
}

/** A tracker admits requests, counts the requests in flight, and ends what the shutdown cuts. */
export interface Tracker {
  request<T>(controller: string, route: string, work: RequestFn<T>, options?: RequestOptions): RequestStream<T>;
  inFlight(controller?: string): number;
  /** This method refuses each later request. */
  stopIntake(): void;
  /** This method aborts the signal of each request in flight, and ends each stream through `return()`: the cooperative abort of the drain. */
  cooperativeAbort(): void;
  /** This method waits until no request is in flight, or until `deadline`. Then it cuts each request that is left. */
  drain(deadline: number): Promise<void>;
}

interface InFlight {
  readonly controller: string;
  /** This function aborts the work, and ends its iterator through `return()`. */
  readonly cooperative: () => void;
  /** This function ends the request with a cut, one time. */
  readonly cut: (cause: string) => void;
}

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";
const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  typeof (value as { then?: unknown }).then === "function";

/** This function gives a stream of events from a function that gives the next event. */
const streamOf = <T>(next: () => Promise<RequestEvent<T> | null>, stop: () => void): RequestStream<T> => {
  let chain: Promise<unknown> = Promise.resolve();
  const iterator: AsyncIterator<RequestEvent<T>> = {
    next() {
      // a reader that asks again before an answer gets the events in their sequence
      const step = chain.then(next).then((event): IteratorResult<RequestEvent<T>> =>
        event === null ? { value: undefined, done: true } : { value: event, done: false },
      );
      chain = step.catch(() => {});
      return step;
    },
    return() {
      stop();
      return Promise.resolve({ value: undefined, done: true });
    },
  };
  return {
    [Symbol.asyncIterator]: () => iterator,
    async collect() {
      const items: T[] = [];
      for (;;) {
        const step = await iterator.next();
        if (step.done === true) throw new Error("the stream ended without its end");
        if (step.value.kind === "item") items.push(step.value.value);
        else return { items, end: step.value };
      }
    },
  };
};

/**
 * This function makes a tracker. `refuses` gives the reason that the service refuses a new request
 * for a controller at this time, or null when it admits it. `choices` gives the function of each
 * route pattern, by controller and by pattern.
 */
export const tracker = (
  controllers: readonly Controller[],
  clock: Clock,
  refuses: (controller: string) => string | null,
  choices: ReadonlyMap<string, ReadonlyMap<string, OperationOf>> = new Map(),
): Tracker => {
  const byName = new Map(
    controllers.map((controller) => [
      controller.name,
      {
        controller,
        patterns: (controller.patterns ?? []).map((declared) => ({ declared, compiled: compilePattern(declared.pattern) as CompiledPattern })),
      },
    ]),
  );
  const flights = new Set<InFlight>();
  const idle = new Set<() => void>();
  let intake = true;

  /** This function gives the operation of a request: its exact route, else the first pattern that matches it. */
  const operationOf = (controller: string, route: string, detail: unknown): Operation => {
    const held = byName.get(controller);
    if (held === undefined) throw new Error(`there is no controller ${controller}`);
    const exact = held.controller.routes[route];
    if (exact !== undefined) return exact;
    for (const { declared, compiled } of held.patterns) {
      const found = compiled.match(route);
      if (found === null) continue;
      const names = Object.keys(declared.operations);
      const choose = choices.get(controller)?.get(declared.pattern);
      const name = choose === undefined ? names[0]! : choose({ controller, route, ...found, detail });
      const operation = declared.operations[name];
      if (operation === undefined)
        throw new Error(`the pattern ${declared.pattern} of ${controller} declares no operation ${String(name)} for ${route}`);
      return operation;
    }
    // a route that nobody declared has no idempotency: the runtime has no defaults
    throw new Error(`controller ${controller} does not declare the route ${route}`);
  };

  const settle = (flight: InFlight): void => {
    if (!flights.delete(flight)) return;
    if (flights.size === 0) for (const done of [...idle]) done();
  };

  /** This function starts the work of an admitted request, and gives its stream. */
  const open = <T>(controller: string, operation: Operation, work: RequestFn<T>): RequestStream<T> => {
    const started = clock.now();
    const abort = new AbortController();
    let delivered = 0;
    let end: RequestEnd | null = null;
    let ended = false;
    let returned = false;
    let source: AsyncIterator<T> | null = null;
    // a unary work keeps its value until the reader asks for it
    let unary: { readonly value: T } | null = null;
    let interrupt: () => void = () => {};
    const interrupted = new Promise<"interrupted">((resolve) => {
      interrupt = () => resolve("interrupted");
    });

    const cutEnd = (cause: string): RequestEnd => {
      const since = quantity(Math.max(0, clock.now() - started) / 1000, "s");
      const retryable = mayReissue(operation, since);
      return { kind: "cut", status: delivered > 0 ? null : retryable ? 503 : 500, retryable, cause, delivered };
    };
    /** This function ends the work of the request: the end is known, and the request leaves the flights. */
    const finish = (given: RequestEnd): void => {
      if (end !== null) return;
      end = given;
      settle(flight);
      interrupt();
    };
    /** This function ends the work after a throw: a failure after the shutdown aborted it is a cut. */
    const failed = (error: unknown): void =>
      finish(abort.signal.aborted ? cutEnd("the shutdown aborted it, and it failed") : { kind: "failed", error, delivered });
    const closeSource = (): void => {
      if (source === null || returned) return;
      returned = true;
      try {
        void Promise.resolve(source.return?.()).catch(() => {});
      } catch {
        // an iterator whose return() throws has ended
      }
    };
    const flight: InFlight = {
      controller,
      cooperative: () => {
        abort.abort(new Error("the cooperative abort of the drain"));
        closeSource();
      },
      cut: (cause) => {
        abort.abort(new Error(cause));
        finish(cutEnd(cause));
        closeSource();
      },
    };
    flights.add(flight);

    /** This function takes the result of the work: a stream, or one value. */
    const take = (result: unknown): void => {
      if (end !== null) return;
      if (isAsyncIterable(result)) {
        source = (result as AsyncIterable<T>)[Symbol.asyncIterator]();
        // a stream that comes after the cooperative abort ends at once
        if (abort.signal.aborted) closeSource();
      } else {
        unary = { value: result as T };
        // the unary work has ended: its value waits for the reader
        settle(flight);
      }
    };
    let ready: Promise<void>;
    try {
      const result = work(abort.signal);
      if (isAsyncIterable(result) || !isPromiseLike(result)) {
        take(result);
        ready = Promise.resolve();
      } else ready = Promise.resolve(result).then(take, failed);
    } catch (error) {
      failed(error);
      ready = Promise.resolve();
    }

    const next = async (): Promise<RequestEvent<T> | null> => {
      if (ended) return null;
      if (end === null) await Promise.race([ready, interrupted]);
      if (end === null && unary !== null) {
        const { value } = unary;
        unary = null;
        delivered = 1;
        end = { kind: "done", delivered };
        return { kind: "item", value };
      }
      if (end === null && source !== null) {
        const pending = source.next();
        let step: IteratorResult<T> | "interrupted";
        try {
          step = await Promise.race([pending, interrupted]);
        } catch (error) {
          failed(error);
          step = "interrupted";
        }
        if (step !== "interrupted") {
          if (step.done !== true) {
            delivered += 1;
            return { kind: "item", value: step.value };
          }
          // a stream that ends after the abort of the shutdown is a cut
          finish(abort.signal.aborted ? cutEnd("the shutdown ended the stream") : { kind: "done", delivered });
        }
      }
      ended = true;
      return end!;
    };
    const stop = (): void => {
      // the reader stopped before the end: the work stops too
      if (end === null) {
        abort.abort(new Error("the reader stopped the stream"));
        finish({ kind: "done", delivered });
        closeSource();
      }
      ended = true;
    };
    return streamOf(next, stop);
  };

  return {
    request<T>(controller: string, route: string, work: RequestFn<T>, options: RequestOptions = {}) {
      const operation = operationOf(controller, route, options.detail);
      const refusal = intake ? refuses(controller) : "the service stopped its intake";
      if (refusal !== null) {
        let given = false;
        const refused: RequestEnd = { kind: "refused", status: 503, retryable: true, cause: refusal, delivered: 0 };
        return streamOf<T>(
          () => {
            if (given) return Promise.resolve(null);
            given = true;
            return Promise.resolve(refused);
          },
          () => {
            given = true;
          },
        );
      }
      return open(controller, operation, work);
    },
    inFlight(controller) {
      let count = 0;
      for (const flight of flights) if (controller === undefined || flight.controller === controller) count += 1;
      return count;
    },
    stopIntake() {
      intake = false;
    },
    cooperativeAbort() {
      for (const flight of [...flights]) flight.cooperative();
    },
    drain(deadline) {
      if (flights.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let finished = false;
        const done = (): void => {
          if (finished) return;
          finished = true;
          idle.delete(done);
          cancel();
          resolve();
        };
        idle.add(done);
        const cancel = clock.after(Math.max(0, deadline - clock.now()), () => {
          for (const flight of [...flights]) flight.cut("the drain reached its deadline");
          done();
        });
      });
    },
  };
};
