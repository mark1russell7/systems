import type { Clock } from "./clock.ts";
import { realClock } from "./clock.ts";
import type { ContractCase } from "./contract.ts";
import { ownStream } from "./drains.ts";
import { fakeClock } from "./fakes.ts";
import type { Health } from "./health.ts";
import { pushedSource } from "./http/fake-server.ts";
import type { Lifecycle, TransportImpl } from "./lifecycle.ts";
import type { RequestEnd, RequestFn, Tracker } from "./requests.ts";
import { tracker } from "./requests.ts";

/** A held work is one unit of work that stays in flight until the test releases it. */
export interface HeldWork {
  /** This method lets the work end. Its promise ends when the caller of the work has its answer, or its error. */
  release(): Promise<void>;
  /** This flag tells if the work got the cooperative abort of the drain. */
  readonly aborted: boolean;
}

/**
 * A transport subject is a transport and the client side of its work. The kit offers work through
 * it, holds work in flight through it, and reads the count of the transport.
 */
export interface TransportSubject {
  readonly impl: TransportImpl;
  /** This lifecycle goes to `start()`. Without it, the kit gives a detached lifecycle. */
  readonly life?: Lifecycle | undefined;
  /** This method offers one unit of new work. It gives true when the transport took it, and false when it refused it. */
  offer(): Promise<boolean>;
  /** This method starts one unit of work that stays in flight until its release. The promise ends when the transport has it. */
  hold(): Promise<HeldWork>;
  /**
   * This method sends one call through the transport, for the stream cases (option `streams`). The
   * handler of the call gives `call.work` to `life.request(call.controller, call.route, ...)` of the
   * lifecycle of the start, and writes its stream to the caller. It gives what the caller sees.
   */
  call?(call: StreamCall): CallerView | Promise<CallerView>;
  /** This method frees what the subject holds outside the transport: its clients and their sockets. */
  dispose?(): Promise<void> | void;
}

/** A stream call is one request of the stream cases. The kit gives its work, and the subject sends it. */
export interface StreamCall {
  /** This name is the controller of the request in the lifecycle of the kit. */
  readonly controller: string;
  /** This name is the route of the request in the lifecycle of the kit. */
  readonly route: string;
  /** This function is the work of the request: one value, or a stream of values. */
  readonly work: RequestFn<unknown>;
  /** True tells that the answer is a stream of items. False tells that the answer is unary: one status and one value. */
  readonly stream: boolean;
}

/** A seen end is the end of a call, as its caller read it. */
export interface SeenEnd {
  readonly kind: RequestEnd["kind"];
  /**
   * True tells that the end came in the body of the answer, after its status, for example as the
   * last line of a stream. False tells that the end came as the status of the answer.
   */
  readonly inBand: boolean;
}

/** A caller view is what the caller of a call has read so far. The kit reads it again until it changes. */
export interface CallerView {
  /** These values are the items that the caller read, in their sequence. */
  readonly items: readonly unknown[];
  /** This end is the end that the caller read, or null while the call is open. */
  readonly end: SeenEnd | null;
}

/**
 * This function gives a detached lifecycle: a lifecycle with no service, for the start of a
 * transport in a test. Its state is `running`, it keeps each connection, and nothing is in flight. Each request
 * and each use of its health throws, because no service declares a route.
 */
export const detachedLifecycle = (): Lifecycle => {
  const none = (): never => {
    throw new Error("a detached lifecycle has no service: give the transport the lifecycle of a service");
  };
  const health = { verdict: none, probe: none, metrics: none, subscribe: none, forceFail: none, drain: none, stop: none } as Health;
  return {
    health,
    state: "running",
    exitCode: null,
    errors: [],
    started: Promise.resolve(),
    done: new Promise<number>(() => {}),
    signal: new AbortController().signal,
    shutdown: none,
    request: none,
    inFlight: () => 0,
    keepAlive: () => true,
  };
};

/** These names are the controller and the route of each call of the stream cases. */
const CALLS = { controller: "conformance", route: "call" } as const;

/**
 * This function gives a lifecycle with request tracking for the stream cases, and its tracker. The
 * kit uses the tracker for the stages of the shutdown, as the lifecycle of a service does. Its
 * requests are not idempotent, and it admits each request until the stop of its intake.
 */
const trackedLifecycle = (clock: Clock): { readonly life: Lifecycle; readonly requests: Tracker } => {
  const requests = tracker([{ name: CALLS.controller, requires: [], routes: { [CALLS.route]: { idempotent: false } } }], clock, () => null);
  const life: Lifecycle = {
    ...detachedLifecycle(),
    // the lifecycle owns each stream that it makes, thus the drain of the transport waits for the end of its cut
    request: (controller, route, work, options) => ownStream(requests.request(controller, route, work, options), life),
    inFlight: (controller) => requests.inFlight(controller),
  };
  return { life, requests };
};

/** A subject factory makes a new subject for each case, on the clock of the case. */
export type SubjectFactory = (clock: Clock) => TransportSubject | Promise<TransportSubject>;

/** A conformance record is one measurement of a case, for the raw records of a run in CI. */
export interface ConformanceRecord {
  readonly case: string;
  readonly what: string;
  /** This time is the limit of the contract, in milliseconds. */
  readonly expected: number;
  /** This time is what the case measured, in milliseconds of the real clock. */
  readonly measured: number;
}

/** These options tune the conformance kit. */
export interface ConformanceOptions {
  /** This name goes before the name of each case. */
  readonly name?: string | undefined;
  /** This clock moves the cases: `fake` gives exact and fast cases, and `real` measures the timing. The default is `fake`. */
  readonly clock?: "fake" | "real" | undefined;
  /** This time is the cap of each drain of the cases, in milliseconds. The default is 1000. */
  readonly cap?: number | undefined;
  /** This time is the most that a close can take, in milliseconds of the real clock. The default is 1000. */
  readonly closeBound?: number | undefined;
  /** This time is the most that an event can take to reach the transport, in real milliseconds. The default is 100. */
  readonly slack?: number | undefined;
  /** False tells that the work of the transport cannot see the cooperative abort. The default is true. */
  readonly cooperative?: boolean | undefined;
  /** This count is the number of works that the count case holds. The default is 3. */
  readonly holds?: number | undefined;
  /**
   * True adds the stream cases (S6 D4). Then the subject gives `call`, and the kit gives the
   * transport a lifecycle with request tracking. The default is false.
   */
  readonly streams?: boolean | undefined;
  /** This function receives each measurement, for the raw records of a run. */
  readonly record?: ((record: ConformanceRecord) => void) | undefined;
}

interface Time {
  readonly clock: Clock;
  pass(ms: number): Promise<void>;
}

interface Tracked {
  readonly settled: boolean;
  readonly error: unknown;
  readonly failed: boolean;
}

const realNow = (): number => performance.now();
const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** This function waits on the real clock, until the test is true or the bound ends. It gives the test at the end. */
const within = async (bound: number, test: () => boolean): Promise<boolean> => {
  const end = realNow() + bound;
  for (;;) {
    if (test()) return true;
    if (realNow() > end) return test();
    await turn();
  }
};

/** This function lets the events that are ready reach the transport, with no move of the clock of the case. */
const quiet = async (): Promise<void> => {
  for (let at = 0; at < 8; at += 1) await turn();
};

/** This function uses a method of the transport, and gives a throw of the method as a rejection. */
const attempt = (call: () => Promise<void> | void): Promise<void> => {
  try {
    return Promise.resolve(call());
  } catch (error) {
    return Promise.reject(error);
  }
};

const track = (promise: Promise<unknown>): Tracked => {
  const state = { settled: false, error: undefined as unknown, failed: false };
  promise.then(
    () => {
      state.settled = true;
    },
    (error: unknown) => {
      state.settled = true;
      state.failed = true;
      state.error = error;
    },
  );
  return state;
};

/**
 * This function generates the conformance cases of a transport (S6 A9). `make` gives a new subject
 * for each case. Each case throws on a failure, and its message names the part of the contract.
 * - The start: nothing is in flight, and the transport takes work.
 * - The count: it follows each work from its events, with no move of the clock.
 * - `stopIntake` refuses new work, keeps the work in flight, and a second stop has no effect.
 * - `drain` ends at once with no work, ends with the last work, and holds to its deadline and not
 *   past it. It gives the cooperative abort to the work, and it does not throw.
 * - `close` ends the work in flight in its bound, and a second close has no effect.
 * - The stages in their sequence, as the lifecycle does them.
 *
 * The option `streams` adds the cases of the streams (S6 D4). Each request is a stream, and a
 * unary call is a stream of one item. The kit gives the transport a lifecycle with request
 * tracking. It also does the stages of the shutdown on the tracker, as the lifecycle does them.
 * - A unary call gives one value, and its end comes as the status of the answer.
 * - A stream stays in flight until its end, not until its first item.
 * - A failure after the first item ends the stream with an error line in the body, not a status.
 *   A failure before the first item gets a status.
 * - `drain` waits for an open stream. The cooperative abort ends the stream, and its caller gets the end.
 * - At the deadline of the drain, the cut ends an open stream, and its caller gets the end.
 */
export const transportConformance = (make: SubjectFactory, options: ConformanceOptions = {}): ContractCase[] => {
  const name = options.name ?? "transport";
  const fake = (options.clock ?? "fake") === "fake";
  const cap = options.cap ?? 1000;
  const closeBound = options.closeBound ?? 1000;
  const slack = options.slack ?? 100;
  const cooperative = options.cooperative ?? true;
  const holds = options.holds ?? 3;

  const timeOf = (): Time => {
    if (!fake) return { clock: realClock, pass: sleep };
    const clock = fakeClock();
    return { clock, pass: (ms) => clock.advance(ms) };
  };

  const check = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(`${name}: ${what}`);
  };

  const each = (title: string, body: (subject: TransportSubject, time: Time, title: string) => Promise<void>): ContractCase => ({
    name: `${name}: ${title}`,
    async run() {
      const time = timeOf();
      const subject = await make(time.clock);
      try {
        await subject.impl.start(new AbortController().signal, subject.life ?? detachedLifecycle());
        await body(subject, time, title);
      } finally {
        try {
          await subject.impl.close();
        } finally {
          await subject.dispose?.();
        }
      }
    },
  });

  const count = (subject: TransportSubject, expected: number, what: string): Promise<void> =>
    within(slack, () => subject.impl.inFlight() === expected).then((ok) =>
      check(ok, `${what}: inFlight() gives ${subject.impl.inFlight()}, not ${expected}`),
    );

  const closes = async (subject: TransportSubject, title: string): Promise<void> => {
    const began = realNow();
    const closed = track(attempt(() => subject.impl.close()));
    const inBound = await within(closeBound, () => closed.settled);
    const took = realNow() - began;
    options.record?.({ case: title, what: "close", expected: closeBound, measured: took });
    check(inBound, `close did not end in its bound of ${closeBound} ms`);
    check(!closed.failed, `close threw: ${String(closed.error)}`);
  };

  const cases: ContractCase[] = [
    each("nothing is in flight after the start, and it takes new work", async (subject) => {
      check(subject.impl.inFlight() === 0, `inFlight() gives ${subject.impl.inFlight()} after the start, not 0`);
      check(await subject.offer(), "the transport refused new work after its start");
      await count(subject, 0, "the work ended");
    }),

    each("the count follows each work in flight from its events, with no move of the clock", async (subject) => {
      const held: HeldWork[] = [];
      for (let at = 1; at <= holds; at += 1) {
        held.push(await subject.hold());
        await count(subject, at, `${at} works are in flight`);
      }
      for (let at = holds - 1; at >= 0; at -= 1) {
        await held[at]!.release();
        await count(subject, at, `${at} works are in flight after a release`);
      }
    }),

    each("stopIntake refuses new work, keeps the work in flight, and a second stop has no effect", async (subject) => {
      const work = await subject.hold();
      await subject.impl.stopIntake();
      check(!(await subject.offer()), "the transport took new work after stopIntake");
      await count(subject, 1, "stopIntake cut the work in flight");
      await subject.impl.stopIntake();
      check(!(await subject.offer()), "the transport took new work after a second stopIntake");
      await work.release();
      await count(subject, 0, "the work in flight ended after stopIntake");
    }),

    each("drain ends at once when nothing is in flight", async (subject, time) => {
      await subject.impl.stopIntake();
      const drained = track(attempt(() => subject.impl.drain(time.clock.now() + cap, new AbortController().signal)));
      check(await within(slack, () => drained.settled), "drain did not end with nothing in flight");
      check(!drained.failed, `drain threw: ${String(drained.error)}`);
    }),

    each("drain ends when the last work ends, before its deadline", async (subject, time) => {
      const work = await subject.hold();
      await subject.impl.stopIntake();
      const deadline = time.clock.now() + cap;
      const drained = track(attempt(() => subject.impl.drain(deadline, new AbortController().signal)));
      await time.pass(cap / 4);
      await quiet();
      check(!drained.settled, "drain ended while work was in flight, before its deadline");
      await work.release();
      check(await within(slack, () => drained.settled), "drain did not end when the last work ended");
      check(!drained.failed, `drain threw: ${String(drained.error)}`);
      check(time.clock.now() < deadline, "drain waited until its deadline after the last work ended");
    }),

    each("drain holds to its deadline and not past it, and does not throw", async (subject, time, title) => {
      await subject.hold();
      await subject.impl.stopIntake();
      const began = realNow();
      const deadline = time.clock.now() + cap;
      const drained = track(attempt(() => subject.impl.drain(deadline, new AbortController().signal)));
      if (fake) {
        await time.pass(cap - 1);
        await quiet();
        check(!drained.settled, "drain ended before its deadline, with work in flight");
        await time.pass(1);
        check(await within(slack, () => drained.settled), "drain did not end at its deadline");
      } else {
        const ended = await within(cap + slack, () => drained.settled);
        const took = realNow() - began;
        options.record?.({ case: title, what: "drain to its deadline", expected: cap, measured: took });
        check(ended, `drain did not end in ${cap + slack} ms, with a deadline at ${cap} ms`);
        check(took >= cap - slack, `drain ended after ${Math.round(took)} ms, before its deadline at ${cap} ms`);
      }
      check(!drained.failed, `drain threw at its deadline: ${String(drained.error)}`);
    }),

    ...(cooperative
      ? [
          each("drain gives the cooperative abort to the work in flight", async (subject, time) => {
            const work = await subject.hold();
            await subject.impl.stopIntake();
            const abort = new AbortController();
            const drained = track(attempt(() => subject.impl.drain(time.clock.now() + cap, abort.signal)));
            await time.pass(cap / 2);
            await quiet();
            check(!work.aborted, "the work got an abort before the signal of the drain aborted");
            abort.abort(new Error("the cooperative abort of the conformance kit"));
            check(await within(slack, () => work.aborted), "the work did not get the cooperative abort");
            await time.pass(cap / 2);
            check(await within(slack, () => drained.settled), "drain did not end at its deadline after the cooperative abort");
            check(!drained.failed, `drain threw after the cooperative abort: ${String(drained.error)}`);
          }),
        ]
      : []),

    each("drain with an aborted signal and a deadline in the past ends at once", async (subject, time) => {
      const work = await subject.hold();
      await subject.impl.stopIntake();
      const abort = new AbortController();
      abort.abort(new Error("the cooperative abort of the conformance kit"));
      const drained = track(attempt(() => subject.impl.drain(time.clock.now() - 1, abort.signal)));
      check(await within(slack, () => drained.settled), "drain did not end at once with its deadline in the past");
      check(!drained.failed, `drain threw: ${String(drained.error)}`);
      if (cooperative) check(await within(slack, () => work.aborted), "the work did not get an abort that came before the drain");
    }),

    each("close ends the work in flight, in its bound", async (subject, _time, title) => {
      for (let at = 0; at < holds; at += 1) await subject.hold();
      await count(subject, holds, "the works are in flight before the close");
      await closes(subject, title);
      await count(subject, 0, "close left work in flight");
    }),

    each("close is idempotent: a second close has no effect", async (subject, _time, title) => {
      await subject.hold();
      const first = track(attempt(() => subject.impl.close()));
      const second = track(attempt(() => subject.impl.close()));
      check(await within(closeBound, () => first.settled && second.settled), "two closes did not end in the bound");
      check(!first.failed && !second.failed, `a close threw: ${String(first.error ?? second.error)}`);
      await closes(subject, title);
      await count(subject, 0, "the closes left work in flight");
    }),

    each("close right after the start ends in its bound", async (subject, _time, title) => {
      await closes(subject, title);
      check(subject.impl.inFlight() === 0, "inFlight() is not 0 after a close with no work");
    }),

    each("the stages in their sequence: stop intake, drain with its cooperative abort, close", async (subject, time, title) => {
      const short = await subject.hold();
      const long = await subject.hold();
      await subject.impl.stopIntake();
      check(!(await subject.offer()), "the transport took new work after stopIntake");
      const abort = new AbortController();
      const drained = track(attempt(() => subject.impl.drain(time.clock.now() + cap, abort.signal)));
      await short.release();
      await count(subject, 1, "one work ended in the drain");
      await time.pass(cap / 2);
      abort.abort(new Error("the cooperative abort of the conformance kit"));
      if (cooperative) check(await within(slack, () => long.aborted), "the long work did not get the cooperative abort");
      await time.pass(cap / 2);
      check(await within(slack, () => drained.settled), "drain did not end at its deadline");
      await closes(subject, title);
      await count(subject, 0, "close left work in flight");
    }),
  ];
  if (!(options.streams ?? false)) return cases;

  /** A fed stream is a stream call whose items, end and failure the case gives. */
  interface Fed {
    readonly view: CallerView;
    push(value: unknown): void;
    finish(): void;
    fail(error: Error): void;
    /** This flag tells if the work got the abort of its signal. */
    readonly aborted: boolean;
  }

  const eachStream = (
    title: string,
    body: (subject: TransportSubject, time: Time, requests: Tracker) => Promise<void>,
  ): ContractCase => ({
    name: `${name}: ${title}`,
    async run() {
      const time = timeOf();
      const subject = await make(time.clock);
      const { life, requests } = trackedLifecycle(time.clock);
      try {
        await subject.impl.start(new AbortController().signal, life);
        check(subject.call !== undefined, "the option streams needs a subject that gives call()");
        await body(subject, time, requests);
      } finally {
        // each work of the case ends, thus no stream stays open after the case
        requests.stopIntake();
        requests.cooperativeAbort();
        try {
          await subject.impl.close();
        } finally {
          await subject.dispose?.();
        }
      }
    },
  });

  const call = (subject: TransportSubject, given: StreamCall): Promise<CallerView> => Promise.resolve(subject.call!(given));

  const openStream = async (subject: TransportSubject): Promise<Fed> => {
    const source = pushedSource<unknown>();
    let started = false;
    let signal: AbortSignal | null = null;
    const view = await call(subject, {
      ...CALLS,
      stream: true,
      work: (given) => {
        started = true;
        signal = given;
        return source.iterable;
      },
    });
    check(await within(slack, () => started), "the work of a stream call did not start");
    return {
      view,
      push: (value) => source.push(value),
      finish: () => source.finish(),
      fail: (error) => source.fail(error),
      get aborted() {
        return (signal as AbortSignal | null)?.aborted === true;
      },
    };
  };

  const pushes = async (fed: Fed, value: number, what: string): Promise<void> => {
    const before = fed.view.items.length;
    fed.push(value);
    check(await within(slack, () => fed.view.items.length > before), `${what}: the caller did not get the item ${value}`);
  };

  const ends = async (view: CallerView, kind: RequestEnd["kind"], inBand: boolean, what: string): Promise<void> => {
    check(await within(slack, () => view.end !== null), `${what}: the caller got no end`);
    const end = view.end!;
    const where = (body: boolean): string => (body ? "in the body" : "as a status");
    check(
      end.kind === kind && end.inBand === inBand,
      `${what}: the caller got the end ${end.kind} ${where(end.inBand)}, not ${kind} ${where(inBand)}`,
    );
  };

  /** This function stops the intake of the tracker and of the transport, as the stage `stop intake` does. */
  const stopBoth = async (subject: TransportSubject, requests: Tracker): Promise<void> => {
    requests.stopIntake();
    await subject.impl.stopIntake();
  };

  /**
   * This function starts the drain of the transport and of the tracker, as the stage `drain` does.
   * The abort of `signal` is also the cooperative abort of the tracker. It tracks the drain of the transport.
   */
  const drainBoth = (subject: TransportSubject, requests: Tracker, deadline: number, signal: AbortSignal): Tracked => {
    if (signal.aborted) requests.cooperativeAbort();
    else signal.addEventListener("abort", () => requests.cooperativeAbort(), { once: true });
    void requests.drain(deadline);
    return track(attempt(() => subject.impl.drain(deadline, signal)));
  };

  const failure = (): Error => new Error("the failure of the conformance kit");

  const streamCases: ContractCase[] = [
    eachStream("a unary call is a stream of one item: one value, and its end as the status", async (subject) => {
      let started = false;
      let give: (value: unknown) => void = () => {};
      const view = await call(subject, {
        ...CALLS,
        stream: false,
        work: () => {
          started = true;
          return new Promise<unknown>((resolve) => {
            give = resolve;
          });
        },
      });
      check(await within(slack, () => started), "the work of a unary call did not start");
      await count(subject, 1, "a unary call is in flight");
      give(7);
      await ends(view, "done", false, "a unary call");
      check(view.items.length === 1 && view.items[0] === 7, `a unary call gave the items ${JSON.stringify(view.items)}, not [7]`);
      await count(subject, 0, "a unary call ended");
    }),

    eachStream("a stream stays in flight until its end, not until its first item", async (subject) => {
      const fed = await openStream(subject);
      await count(subject, 1, "a stream is open");
      for (const value of [1, 2]) {
        await pushes(fed, value, "an open stream");
        await count(subject, 1, `a stream is open after its item ${value}`);
      }
      check(fed.view.end === null, "the caller got an end before the end of the stream");
      fed.finish();
      await ends(fed.view, "done", true, "a stream that ended");
      check(JSON.stringify(fed.view.items) === "[1,2]", `a stream gave the items ${JSON.stringify(fed.view.items)}, not [1,2]`);
      await count(subject, 0, "a stream ended");
    }),

    eachStream("a failure after the first item ends the stream with an error line, not a status", async (subject) => {
      const fed = await openStream(subject);
      await pushes(fed, 1, "a stream before its failure");
      fed.fail(failure());
      await ends(fed.view, "failed", true, "a stream that failed after its first item");
      await count(subject, 0, "a stream failed");
    }),

    eachStream("a failure before the first item gets a status, not an error line", async (subject) => {
      const fed = await openStream(subject);
      fed.fail(failure());
      await ends(fed.view, "failed", false, "a stream that failed before its first item");
      check(fed.view.items.length === 0, `a stream that failed before its first item gave ${fed.view.items.length} items`);
      await count(subject, 0, "a stream failed");
    }),

    eachStream("drain waits for an open stream, and the cooperative abort ends the stream with its end", async (subject, time, requests) => {
      const fed = await openStream(subject);
      await pushes(fed, 1, "a stream before the drain");
      await stopBoth(subject, requests);
      const abort = new AbortController();
      const deadline = time.clock.now() + cap;
      const drained = drainBoth(subject, requests, deadline, abort.signal);
      await time.pass(cap / 4);
      await quiet();
      check(!drained.settled, "drain ended while a stream was open, before its deadline");
      check(fed.view.end === null, "the caller got an end before the cooperative abort");
      await count(subject, 1, "a stream is open in the drain");
      abort.abort(new Error("the cooperative abort of the conformance kit"));
      check(await within(slack, () => fed.aborted), "the work of the stream did not get the cooperative abort");
      await ends(fed.view, "cut", true, "a stream after the cooperative abort");
      check(await within(slack, () => drained.settled), "drain did not end when the stream ended");
      check(!drained.failed, `drain threw: ${String(drained.error)}`);
      check(time.clock.now() < deadline, "drain waited until its deadline after the stream ended");
      await count(subject, 0, "the cooperative abort left a stream in flight");
    }),

    eachStream("drain cuts an open stream at its deadline, and the caller gets the end of the cut", async (subject, time, requests) => {
      const fed = await openStream(subject);
      await pushes(fed, 1, "a stream before the drain");
      await stopBoth(subject, requests);
      const drained = drainBoth(subject, requests, time.clock.now() + cap, new AbortController().signal);
      await time.pass(cap);
      await ends(fed.view, "cut", true, "a stream at the deadline of the drain");
      check(await within(slack, () => drained.settled), "drain did not end after the cut of the stream");
      check(!drained.failed, `drain threw at its deadline: ${String(drained.error)}`);
      await count(subject, 0, "the cut left a stream in flight");
    }),
  ];
  return [...cases, ...streamCases];
};
