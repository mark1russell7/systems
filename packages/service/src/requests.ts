import { quantity } from "@mark1russell7/quantity";
import type { Clock } from "./clock.ts";
import type { Controller } from "./description.ts";
import { mayReissue } from "./operation.ts";

/**
 * A request outcome is what a request of a controller came to, for any HTTP framework or none:
 * - `done`: the work gave a value.
 * - `failed`: the work failed for a cause of its own. The adapter answers it as it answers any
 *   error of the route.
 * - `refused`: the service did not admit the request. A refused request did not start, thus its
 *   caller can send it again: 503, retryable.
 * - `cut`: the shutdown stopped the request. A route whose callers can send it again answers 503,
 *   retryable. Each other route answers 500, not retryable, because the work can have had its
 *   effect.
 */
export type RequestOutcome<T> =
  | { readonly kind: "done"; readonly value: T }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "refused"; readonly status: 503; readonly retryable: true; readonly cause: string }
  | {
      readonly kind: "cut";
      readonly status: 503 | 500;
      readonly retryable: boolean;
      readonly cause: string;
    };

/** A request function does the work of one request. It receives a signal that the shutdown aborts. */
export type RequestFn<T> = (signal: AbortSignal) => Promise<T> | T;

interface InFlight {
  readonly controller: string;
  readonly route: string;
  readonly started: number;
  readonly abort: AbortController;
  /** This function answers the request with an outcome, one time. */
  readonly answer: (outcome: RequestOutcome<never>) => void;
}

/** A tracker admits requests, counts the requests in flight, and answers what the shutdown cuts. */
export interface Tracker {
  request<T>(controller: string, route: string, work: RequestFn<T>): Promise<RequestOutcome<T>>;
  inFlight(controller?: string): number;
  /** This method refuses each later request. */
  stopIntake(): void;
  /** This method aborts the signal of each request in flight: the cooperative abort of the drain. */
  cooperativeAbort(): void;
  /** This method waits until no request is in flight, or until `deadline`. Then it cuts each request that is left. */
  drain(deadline: number): Promise<void>;
}

/**
 * This function makes a tracker. `refuses` gives the reason that the service refuses a new request
 * for a controller at this time, or null when it admits it.
 */
export const tracker = (
  controllers: readonly Controller[],
  clock: Clock,
  refuses: (controller: string) => string | null,
): Tracker => {
  const byName = new Map(controllers.map((controller) => [controller.name, controller]));
  const flights = new Set<InFlight>();
  const idle = new Set<() => void>();
  let intake = true;

  const settle = (flight: InFlight): void => {
    flights.delete(flight);
    if (flights.size === 0) for (const done of [...idle]) done();
  };
  /** This function answers a request that the shutdown stopped, by the idempotency of its route. */
  const cut = (flight: InFlight, cause: string): RequestOutcome<never> => {
    const operation = byName.get(flight.controller)!.routes[flight.route]!;
    const since = quantity(Math.max(0, clock.now() - flight.started) / 1000, "s");
    const retryable = mayReissue(operation, since);
    return { kind: "cut", status: retryable ? 503 : 500, retryable, cause };
  };

  return {
    request<T>(controller: string, route: string, work: RequestFn<T>) {
      const held = byName.get(controller);
      if (held === undefined) throw new Error(`there is no controller ${controller}`);
      // a route that nobody declared has no idempotency: the runtime has no defaults
      if (held.routes[route] === undefined)
        throw new Error(`controller ${controller} does not declare the route ${route}`);
      const refusal = intake ? refuses(controller) : "the service stopped its intake";
      if (refusal !== null)
        return Promise.resolve({ kind: "refused", status: 503, retryable: true, cause: refusal });
      return new Promise<RequestOutcome<T>>((resolve) => {
        let answered = false;
        const flight: InFlight = {
          controller,
          route,
          started: clock.now(),
          abort: new AbortController(),
          answer: (outcome) => {
            if (answered) return;
            answered = true;
            settle(flight);
            resolve(outcome);
          },
        };
        flights.add(flight);
        let promise: Promise<T>;
        try {
          promise = Promise.resolve(work(flight.abort.signal));
        } catch (error) {
          promise = Promise.reject(error);
        }
        promise.then(
          (value) => {
            if (answered) return;
            answered = true;
            settle(flight);
            resolve({ kind: "done", value });
          },
          (error: unknown) => {
            if (answered) return;
            // a failure after the shutdown aborted the request is a failure that the shutdown caused
            const outcome = flight.abort.signal.aborted
              ? cut(flight, "the shutdown aborted it, and it failed")
              : ({ kind: "failed", error } as const);
            answered = true;
            settle(flight);
            resolve(outcome);
          },
        );
      });
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
      for (const flight of flights) flight.abort.abort(new Error("the cooperative abort of the drain"));
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
          for (const flight of [...flights]) {
            flight.abort.abort(new Error("the drain reached its deadline"));
            flight.answer(cut(flight, "the drain reached its deadline"));
          }
          done();
        });
      });
    },
  };
};
