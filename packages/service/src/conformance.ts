import type { Clock } from "./clock.ts";
import { realClock } from "./clock.ts";
import type { ContractCase } from "./contract.ts";
import { fakeClock } from "./fakes.ts";
import type { Health } from "./health.ts";
import type { Lifecycle, TransportImpl } from "./lifecycle.ts";

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
  /** This method frees what the subject holds outside the transport: its clients and their sockets. */
  dispose?(): Promise<void> | void;
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
  return cases;
};
