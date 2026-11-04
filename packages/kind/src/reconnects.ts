import { valueIn } from "@mark1russell7/quantity";
import type { Backoff, ReconnectsPrediction } from "./cell.ts";
import type { Line } from "./observe.ts";

/**
 * This module judges the return of the producers of a message broker after the stop of the broker
 * that owns their topic (SYS-56). It knows the backoff of a client and the lines of the lab, and
 * nothing of Pulsar. Each time is in milliseconds, on the clock of the lines.
 *
 * The backoff is the law of `Backoff::next` of the C++ client of Pulsar 4.2.0 (lib/Backoff.cc,
 * lines 33–57). The first delay is the initial delay, and each next delay is two times the last, up
 * to the most. The first call keeps its time. If a later call ends after the mandatory stop, it
 * gets the rest of the time to that stop, once. Then the call takes a random share of up to the
 * jitter from the delay. The delay is not below the initial delay at any time.
 */

/** A try is the earliest and the latest time of one try to connect, after the first delay starts. */
export interface Try {
  readonly lo: number;
  readonly hi: number;
}

/** This is a backoff in milliseconds. */
interface Delays {
  readonly initial: number;
  readonly max: number;
  readonly stop: number;
  readonly jitter: number;
}

const delaysOf = (backoff: Backoff): Delays => ({
  initial: valueIn(backoff.initial, "ms"),
  max: valueIn(backoff.max, "ms"),
  stop: valueIn(backoff.mandatoryStop, "ms"),
  jitter: backoff.jitter,
});

/**
 * This function gives the times of the tries of one path: each delay times `share`, and `latency`
 * from each try to the next call. The tries end with the first one after `until`.
 */
const pathOf = (delays: Delays, share: number, latency: number, until: number): number[] => {
  const tries: number[] = [];
  let next = delays.initial;
  let call = 0;
  let made = false;
  for (let count = 0; count < 1000; count += 1) {
    let current = next;
    next = Math.min(2 * next, delays.max);
    if (!made && call + current > delays.stop) {
      current = Math.max(delays.initial, delays.stop - call);
      made = true;
    }
    const at = call + Math.max(delays.initial, current * share);
    tries.push(at);
    if (at > until) break;
    call = at + latency;
  }
  return tries;
};

/**
 * This function gives the band of each try after the first delay starts, up to the first try whose
 * earliest time is after `until`. The earliest path has the most jitter and no time for a try. The
 * latest path has no jitter and `attempt` for each failed try. A later call gets a delay that ends no
 * earlier, thus each try of a path between them is in the band.
 */
export const triesOf = (backoff: Backoff, until: number): Try[] => {
  const delays = delaysOf(backoff);
  const late = pathOf(delays, 1, valueIn(backoff.attempt, "ms"), Number.POSITIVE_INFINITY);
  const early = pathOf(delays, 1 - delays.jitter, 0, until);
  return early.map((lo, index) => ({ lo, hi: late[index] ?? Number.POSITIVE_INFINITY }));
};

/**
 * This function gives the latest return of a producer after the fault, from the bands of the
 * prediction. It adds three terms. The first is the first delay at its latest. The second is the
 * latest time of the first try that cannot come before the latest change of the owner. The third
 * is the latest setup.
 */
export const latestReturn = (prediction: ReconnectsPrediction): number => {
  const disconnect = { lo: valueIn(prediction.disconnect.lo, "ms"), hi: valueIn(prediction.disconnect.hi, "ms") };
  const flip = valueIn(prediction.flip.hi, "ms");
  const tries = triesOf(prediction.backoff, flip - disconnect.lo);
  const after = tries.find((each) => each.lo >= flip - disconnect.lo) ?? tries.at(-1)!;
  return disconnect.hi + after.hi + valueIn(prediction.setup.hi, "ms");
};

/** This function gives the delay of each call of a backoff, as an interval, with `elapsed` from the first call to this one. */
const delayBand = (delays: Delays, index: number, elapsed: number, made: boolean, noise: number): { lo: number; hi: number; made: boolean; either: boolean } => {
  const nominal = Math.min(delays.initial * 2 ** index, delays.max);
  const band = (current: number) => ({ lo: Math.max(delays.initial, current * (1 - delays.jitter)), hi: Math.max(delays.initial, current) });
  if (made) return { ...band(nominal), made, either: false };
  const clamped = band(Math.max(delays.initial, delays.stop - elapsed));
  const plain = band(nominal);
  // the clock of the client and the clock of the lines differ by up to the noise: near the stop, each branch agrees
  if (Math.abs(elapsed + nominal - delays.stop) <= noise) return { lo: Math.min(clamped.lo, plain.lo), hi: Math.max(clamped.hi, plain.hi), made: false, either: true };
  return elapsed + nominal > delays.stop ? { ...clamped, made: true, either: false } : { ...plain, made: false, either: false };
};

/** This text is the start of the line of the C++ client that schedules a try: "Schedule reconnection in 0.1 s". */
const SCHEDULE = /Schedule reconnection in ([0-9.]+) s/;

/** A schedule is one call of the backoff of a producer: when, and its delay in milliseconds. */
export interface Schedule {
  readonly t: number;
  readonly delay: number;
}

/** A return is the facts of one producer in one run. */
export interface Return {
  readonly pod: string;
  /** This time is the first call of the backoff after the fault, from the fault. */
  readonly disconnect: number | null;
  /** These are the calls of the backoff from the fault to the producer on the new owner. */
  readonly schedules: readonly Schedule[];
  /** This time is the producer on the new owner, from the fault, or null. */
  readonly back: number | null;
  /** This time is from the try that succeeded to the producer on the new owner. */
  readonly setup: number | null;
  /** This count is the tries up to the one that succeeded. */
  readonly tries: number;
  readonly ok: boolean;
  readonly why: string;
}

/** A judgement is the facts of one run: the change of the owner, each producer, and the failed sends. */
export interface Reconnects {
  readonly ok: boolean;
  readonly why: string;
  /** This time is the first lookup that names another owner, from the fault, or null. */
  readonly flip: number | null;
  /** This time is from the last lookup before that change to it. */
  readonly gap: number | null;
  readonly returns: readonly Return[];
  /** This count is the sends of the producers that failed, by outcome. */
  readonly failures: Readonly<Record<string, number>>;
  /** This time is the median return of the producers, from the fault, or null. */
  readonly value: number | null;
}

const text = (line: Line, field: string): string | null => (typeof line[field] === "string" ? (line[field] as string) : null);

/**
 * This function judges one run: the fault at `fault`, the broker `broker` that owned the topic, and
 * the lines of the run. A lookup line is `{ev: "lookup", t, o, owner}`, a line of the client is
 * `{ev: "pulsar", t, p, m}`, and a send is `{ev: "send", t, d, o, p}`. `timeout` and `every` are the
 * timeout and the interval of the sends. Each check has a margin of `noise`.
 *
 * For each producer, the delays of its backoff follow the law, from the observed time of each call.
 * Its last try comes after the last lookup that named the old owner. The try before it comes no
 * later than the first lookup that named another. Then the setup is in its band. Each failed send
 * starts between the fault and the return, with an outcome of the prediction. At least one fails.
 *
 * With `owner: "either"`, the lookups can name the old owner for the whole run, because it started
 * again and took the topic back. Then the last try comes after the start of the band `flip`, and
 * the try before it comes no later than the end of that band.
 */
export const judgeReconnects = (
  prediction: ReconnectsPrediction,
  run: { readonly fault: number; readonly broker: string; readonly lines: readonly Line[] },
  sends: { readonly timeout: number; readonly every: number },
  noise: number,
): Reconnects => {
  const { fault, broker, lines } = run;
  const ms = (band: { readonly lo: Parameters<typeof valueIn>[0]; readonly hi: Parameters<typeof valueIn>[0] }) => ({ lo: valueIn(band.lo, "ms"), hi: valueIn(band.hi, "ms") });
  const inBand = (value: number, band: { lo: number; hi: number }) => value >= band.lo - noise && value <= band.hi + noise;
  const lookups = lines.filter((line) => line.ev === "lookup" && line.t >= fault).sort((a, b) => a.t - b.t);
  const changed = lookups.findIndex((line) => line["o"] === "ok" && text(line, "owner") !== null && text(line, "owner") !== broker);
  const fail = (why: string, more: Partial<Reconnects> = {}): Reconnects => ({ ok: false, why, flip: null, gap: null, returns: [], failures: {}, value: null, ...more });
  if (changed === -1 && prediction.owner !== "either") return fail(`no lookup after the fault names an owner other than ${broker}`);
  const band = ms(prediction.flip);
  // the lookups name one broker before and after the change: only the band of the change bounds the tries
  const same = changed === -1;
  const flipAt = same ? fault + band.hi : lookups[changed]!.t;
  const before = same ? fault + band.lo : changed === 0 ? fault : lookups[changed - 1]!.t;
  const flip = same ? null : flipAt - fault;
  const gap = same ? null : flipAt - before;
  if (flip !== null && !inBand(flip, band)) return fail(`the first lookup with another owner is ${flip.toFixed(0)} ms after the fault, outside the band`, { flip, gap });
  if (gap !== null && gap > valueIn(prediction.probe, "ms") + noise) return fail(`the lookups have a gap of ${gap.toFixed(0)} ms before the change of the owner`, { flip, gap });
  const delays = delaysOf(prediction.backoff);
  const setup = ms(prediction.setup);
  const disconnect = ms(prediction.disconnect);
  const pods = [...new Set(lines.filter((line) => line.ev === "send").map((line) => String(line["p"])))].sort();
  if (pods.length === 0) return fail("the run has no sends", { flip, gap });
  const returns: Return[] = pods.map((pod) => {
    const own = lines.filter((line) => line.ev === "pulsar" && line["p"] === pod && line.t >= fault - noise).sort((a, b) => a.t - b.t);
    const created = own.find((line) => (text(line, "m") ?? "").includes("Created producer on broker"));
    const back = created === undefined ? null : created.t - fault;
    const schedules: Schedule[] = own
      .filter((line) => created === undefined || line.t <= created.t)
      .flatMap((line) => {
        const found = SCHEDULE.exec(text(line, "m") ?? "");
        return found === null ? [] : [{ t: line.t, delay: Number(found[1]) * 1000 }];
      });
    const first = schedules[0];
    const facts = { pod, disconnect: first === undefined ? null : first.t - fault, schedules, back, tries: schedules.length };
    const no = (why: string, more: Partial<Return> = {}): Return => ({ ...facts, setup: null, ...more, ok: false, why: `${pod}: ${why}` });
    if (created === undefined) return no("the producer is not back on a broker after the fault");
    if (first === undefined) return no("the producer schedules no try after the fault");
    if (!inBand(first.t - fault, disconnect)) return no(`its first try is scheduled ${(first.t - fault).toFixed(0)} ms after the fault, outside the band`);
    let made = false;
    for (const [index, schedule] of schedules.entries()) {
      const band = delayBand(delays, index, schedule.t - first.t, made, noise);
      // the line gives the delay in whole milliseconds
      if (schedule.delay < band.lo - 1 || schedule.delay > band.hi + 1)
        return no(`the delay ${index + 1} is ${schedule.delay} ms, not in ${band.lo.toFixed(0)}–${band.hi.toFixed(0)} ms of the backoff`);
      // near the stop, a delay below the plain band shows that the client took the rest to the stop
      made = band.either ? schedule.delay < Math.min(delays.initial * 2 ** index, delays.max) * (1 - delays.jitter) - 1 : band.made;
    }
    const tries = schedules.map((schedule) => schedule.t + schedule.delay);
    const last = tries.at(-1)!;
    const earlier = tries.at(-2);
    if (last < before - noise) return no(`its last try at ${(last - fault).toFixed(0)} ms comes before the last lookup of the old owner`);
    if (earlier !== undefined && earlier > flipAt + noise) return no(`its try at ${(earlier - fault).toFixed(0)} ms comes after the change of the owner, and it did not succeed`);
    const took = created.t - last;
    if (!inBand(took, setup)) return no(`its setup takes ${took.toFixed(0)} ms, outside the band`, { setup: took });
    return { ...facts, setup: took, ok: true, why: `${pod}: back ${(created.t - fault).toFixed(0)} ms after the fault, at try ${tries.length}` };
  });
  const failed = lines.filter((line) => line.ev === "send" && line["o"] !== "ok").sort((a, b) => a.t - b.t);
  const failures: Record<string, number> = {};
  for (const line of failed) failures[String(line["o"])] = (failures[String(line["o"])] ?? 0) + 1;
  const backs = returns.flatMap((each) => (each.back === null ? [] : [each.back])).sort((a, b) => a - b);
  const value = backs.length === 0 ? null : backs.length % 2 === 1 ? backs[(backs.length - 1) / 2]! : (backs[backs.length / 2 - 1]! + backs[backs.length / 2]!) / 2;
  const done = (ok: boolean, why: string): Reconnects => ({ ok, why, flip, gap, returns, failures, value });
  const wrong = returns.find((each) => !each.ok);
  if (wrong !== undefined) return done(false, wrong.why);
  const other = failed.find((line) => !prediction.outcomes.includes(String(line["o"])));
  if (other !== undefined) return done(false, `a send of ${String(other["p"])} ended ${String(other["o"])}, not ${prediction.outcomes.join(" or ")}`);
  if (failed.length === 0) return done(false, "no send failed");
  for (const each of returns) {
    const own = failed.filter((line) => line["p"] === each.pod);
    const back = fault + each.back!;
    const outside = own.find((line) => line.t < fault - sends.timeout - noise || line.t > back + noise);
    if (outside !== undefined) return done(false, `a send of ${each.pod} at ${(outside.t - fault).toFixed(0)} ms failed outside the time to its return`);
    const latest = own.at(-1);
    if (latest === undefined) return done(false, `no send of ${each.pod} failed`);
    if (latest.t < back - sends.timeout - sends.every - noise) return done(false, `the last failed send of ${each.pod} is ${(back - latest.t).toFixed(0)} ms before its return`);
  }
  return done(true, `${flip === null ? "the stopped broker owns the topic again" : `another owner ${flip.toFixed(0)} ms after the fault`}; ${returns.map((each) => `${each.pod} back at try ${each.tries}`).join(", ")}`);
};
