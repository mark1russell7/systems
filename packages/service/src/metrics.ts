import { valueIn } from "@mark1russell7/quantity";
import type { Check } from "./description.ts";
import type { LifecycleEvent } from "./events.ts";
import type { Result } from "./latch.ts";

/**
 * A histogram of durations counts the polls of a check by how long each one took (B18). Each bound
 * is a fraction of the timeout of the poll, thus the last bound is the timeout. A poll that failed
 * at its timeout goes into `timedOut`, not into a bucket. Thus the histogram marks the timeouts.
 */
export interface DurationHistogram {
  /** These bounds are in milliseconds, from the smallest. A bucket counts each poll that took more than the bound before it, up to its own bound. */
  readonly le: readonly number[];
  /** These counts are not cumulative: one count for each bound. */
  readonly counts: readonly number[];
  readonly timedOut: number;
}

/** An episode of failure starts at the first error of a sequence, and ends at the next pass (B18). */
export interface Episode {
  /** This time is the first error, in milliseconds on the monotonic clock. */
  readonly start: number;
  /** This time is the pass that ended the episode, or null while the episode continues. */
  readonly end: number | null;
  /** This count is the polls that failed in the episode. */
  readonly failures: number;
  /** This cause is the cause of the first error, with each secret removed. */
  readonly cause: string | null;
}

/** The metrics of one check: the count of each outcome, its durations and its last episodes. */
export interface CheckMetrics {
  readonly outcomes: { readonly ok: number; readonly error: number; readonly indeterminate: number };
  readonly thrown: number;
  readonly forced: number;
  readonly durations: DurationHistogram;
  /** These are the last episodes, from the oldest. The runtime keeps `EPISODES_KEPT` of them. */
  readonly episodes: readonly Episode[];
}

/** The metrics of a health runtime. Nothing in them starts a check. */
export interface HealthMetrics {
  readonly checks: Readonly<Record<string, CheckMetrics>>;
  /** Each count is the transitions of one machine of the runtime, by the key `machine instance from -> to`. */
  readonly transitions: Readonly<Record<string, number>>;
}

/** These fractions of the timeout of a poll are the bounds of its histogram. */
export const DURATION_FRACTIONS: readonly number[] = [0.05, 0.1, 0.25, 0.5, 0.75, 1];

/** The runtime keeps this many episodes of each check. */
export const EPISODES_KEPT = 8;

/**
 * This function removes the secrets that a cause can hold. These are the user and the password of a
 * URL, and the value of a key, for example `password=`. A driver error can hold a connection string.
 */
export const redact = (cause: string): string =>
  cause
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, "$1***@")
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|auth)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1$2***");

interface Counted {
  ok: number;
  error: number;
  indeterminate: number;
  thrown: number;
  forced: number;
  readonly le: readonly number[];
  readonly counts: number[];
  timedOut: number;
  readonly episodes: Episode[];
  open: { start: number; failures: number; cause: string | null } | null;
}

/** A meter counts the results of the checks and the transitions of the machines of a runtime. */
export interface Meter {
  add(check: Check): void;
  poll(check: Check, result: Result): void;
  event(event: LifecycleEvent): void;
  metrics(): HealthMetrics;
}

/** This function makes a meter. */
export const meter = (): Meter => {
  const checks = new Map<string, Counted>();
  const transitions = new Map<string, number>();

  const add = (check: Check): void => {
    if (checks.has(check.name)) return;
    const timeout = valueIn(check.poll.timeout, "ms");
    checks.set(check.name, {
      ok: 0,
      error: 0,
      indeterminate: 0,
      thrown: 0,
      forced: 0,
      le: DURATION_FRACTIONS.map((fraction) => fraction * timeout),
      counts: DURATION_FRACTIONS.map(() => 0),
      timedOut: 0,
      episodes: [],
      open: null,
    });
  };

  const close = (counted: Counted, end: number | null): Episode | null => {
    if (counted.open === null) return null;
    return { start: counted.open.start, end, failures: counted.open.failures, cause: counted.open.cause };
  };

  const poll = (check: Check, result: Result): void => {
    add(check);
    const counted = checks.get(check.name) as Counted;
    counted[result.outcome] += 1;
    if (result.thrown) counted.thrown += 1;
    if (result.forced) counted.forced += 1;
    if (result.timedOut) counted.timedOut += 1;
    else {
      const at = counted.le.findIndex((bound) => result.took <= bound);
      // a poll that took longer than its timeout and did not time out goes into the last bucket
      const bucket = at === -1 ? counted.counts.length - 1 : at;
      counted.counts[bucket] = (counted.counts[bucket] ?? 0) + 1;
    }
    // an indeterminate poll measured nothing, thus it moves no episode
    if (result.outcome === "error") {
      if (counted.open === null) counted.open = { start: result.at, failures: 0, cause: result.cause === null ? null : redact(result.cause) };
      counted.open.failures += 1;
    } else if (result.outcome === "ok" && counted.open !== null) {
      counted.episodes.push(close(counted, result.at) as Episode);
      counted.open = null;
      if (counted.episodes.length > EPISODES_KEPT) counted.episodes.shift();
    }
  };

  const event = (event: LifecycleEvent): void => {
    const key = `${event.machine} ${event.instance} ${event.from} -> ${event.to}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
  };

  const metrics = (): HealthMetrics => {
    const out: Record<string, CheckMetrics> = {};
    for (const [name, counted] of checks) {
      const open = close(counted, null);
      out[name] = {
        outcomes: { ok: counted.ok, error: counted.error, indeterminate: counted.indeterminate },
        thrown: counted.thrown,
        forced: counted.forced,
        durations: { le: [...counted.le], counts: [...counted.counts], timedOut: counted.timedOut },
        episodes: open === null ? [...counted.episodes] : [...counted.episodes, open].slice(-EPISODES_KEPT),
      };
    }
    return { checks: out, transitions: Object.fromEntries(transitions) };
  };

  return { add, poll, event, metrics };
};
