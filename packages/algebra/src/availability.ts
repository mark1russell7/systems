/**
 * These functions give the chance that copies of a service send in time, when the copies share
 * causes of failure. A cause is a provider, a region, a power feed, a network or a channel. A cause
 * can be in other causes: a region is in its provider. A copy needs causes, and it fails when one
 * of them fails. A copy can also fail on its own.
 *
 * - The causes are a list. Each cause names only causes before it. Thus the list is a topological
 *   order, and the causes have no cycle.
 * - Each cause and each copy fails on its own with its chance, independently of the others. A cause
 *   also fails when a cause that contains it fails. Thus two copies that need one region fail
 *   together.
 * - A copy waits for its rank, then it sends after a delay. The points of a CDF give the
 *   distribution of the delay. Between two points, the chance is the chance of the lower point.
 *   Thus the result is a lower bound.
 * - The delays are independent when the state of each cause is known. The model has no shared
 *   cause of delay.
 *
 * `sendChance` gives the chance that at least `k` copies send within `T` seconds. It conditions on
 * each cause that two or more live copies share, and it puts each other cause into the chance of
 * its copy. When the state of each shared cause is known, the copies are independent. Then the
 * Poisson binomial law of `@mark1russell7/rigor-statistics` gives the chance of `k` or more.
 *
 * A chance can be an interval. The system is coherent: a smaller chance of failure does not make
 * the result smaller. Thus the low end of the result comes from the high chances of failure and
 * the low chances of the delays. The high end comes from the other ends.
 */
import { poissonBinomialTest } from "@mark1russell7/rigor-statistics";

/** An interval of chances, from `lo` to `hi`. */
export interface ChanceInterval {
  readonly lo: number;
  readonly hi: number;
}

/** A chance from 0 to 1, or an interval of chances. */
export type Chance = number | ChanceInterval;

/** A cause of failure that copies can share: a provider, a region, a power feed, a network or a channel. */
export interface Cause {
  /** The name of the cause. */
  readonly id: string;
  /** The chance that the cause fails on its own in the window of the query. */
  readonly down: Chance;
  /** The causes that contain this cause. Each one comes before this cause in the list. */
  readonly within?: readonly string[];
}

/** A point of the distribution of a delay: the chance that the delay is `within` seconds or less. */
export interface DelayPoint {
  readonly within: number;
  readonly chance: Chance;
}

/** A copy of a service that can send. */
export interface Copy {
  /** The name of the copy. */
  readonly id: string;
  /** The causes that the copy needs. The copy fails when one of them fails. */
  readonly needs: readonly string[];
  /** The chance that the copy fails on its own: its host or its process. */
  readonly down: Chance;
  /** The wait of the rank of the copy before it sends, in seconds. The default is 0. */
  readonly wait?: number;
  /** The distribution of the delay from the event to the send. The default is a delay of 0. */
  readonly delay?: readonly DelayPoint[];
}

/** The copies of a service and the causes that they share. */
export interface Placement {
  readonly causes: readonly Cause[];
  readonly copies: readonly Copy[];
}

/** A query: at least `atLeast` copies send within `within` seconds. The defaults are 1 copy and no limit of time. */
export interface SendQuery {
  readonly atLeast?: number;
  readonly within?: number;
}

/** The chance of a query when one cause or one copy does not fail on its own. */
export interface NeverDown {
  /** The name of the cause or the copy. */
  readonly id: string;
  /** The kind of the item. */
  readonly of: "cause" | "copy";
  /** The chance of the query when this item does not fail on its own. */
  readonly chance: ChanceInterval;
}

const ends = (chance: Chance): readonly [number, number] =>
  typeof chance === "number" ? [chance, chance] : [chance.lo, chance.hi];

const chanceProblems = (chance: Chance, what: string): string[] => {
  const [lo, hi] = ends(chance);
  if (typeof chance === "number")
    return lo >= 0 && lo <= 1 ? [] : [`${what}: the chance ${String(lo)} is not from 0 to 1`];
  if (!(lo >= 0 && lo <= 1 && hi >= 0 && hi <= 1))
    return [`${what}: the interval ${String(lo)} to ${String(hi)} is not from 0 to 1`];
  return lo <= hi ? [] : [`${what}: the low end ${String(lo)} is above the high end ${String(hi)}`];
};

const delayProblems = (copy: Copy): string[] => {
  const problems: string[] = [];
  let [last, lastLo, lastHi] = [-1, 0, 0];
  for (const [index, point] of (copy.delay ?? []).entries()) {
    const what = `copy ${copy.id}: delay point ${String(index)}`;
    if (!(point.within >= 0 && Number.isFinite(point.within)))
      problems.push(`${what}: within ${String(point.within)} is not a time of 0 or more`);
    else if (point.within <= last)
      problems.push(`${what}: within ${String(point.within)} is not after the point before it`);
    else last = point.within;
    const found = chanceProblems(point.chance, what);
    problems.push(...found);
    if (found.length > 0) continue;
    const [lo, hi] = ends(point.chance);
    if (lo < lastLo || hi < lastHi) problems.push(`${what}: the chance is less than the chance of the point before it`);
    [lastLo, lastHi] = [Math.max(lo, lastLo), Math.max(hi, lastHi)];
  }
  return problems;
};

/**
 * This function gives each problem of a placement. A placement with no problem has unique names,
 * causes in a topological order, known causes, chances from 0 to 1, and delay points in order.
 *
 * @param placement - The copies and their causes.
 * @returns One text for each problem. An empty list means no problem.
 */
export const placementProblems = (placement: Placement): string[] => {
  const problems: string[] = [];
  const before = new Set<string>();
  for (const cause of placement.causes) {
    if (before.has(cause.id)) problems.push(`cause ${cause.id}: the name is not unique`);
    for (const outer of cause.within ?? [])
      if (!before.has(outer)) problems.push(`cause ${cause.id}: within ${outer}, which is not a cause before it`);
    problems.push(...chanceProblems(cause.down, `cause ${cause.id}: down`));
    before.add(cause.id);
  }
  const copies = new Set<string>();
  for (const copy of placement.copies) {
    if (copies.has(copy.id)) problems.push(`copy ${copy.id}: the name is not unique`);
    copies.add(copy.id);
    for (const need of copy.needs) if (!before.has(need)) problems.push(`copy ${copy.id}: needs ${need}, which is not a cause`);
    problems.push(...chanceProblems(copy.down, `copy ${copy.id}: down`));
    if (copy.wait !== undefined && !(copy.wait >= 0 && Number.isFinite(copy.wait)))
      problems.push(`copy ${copy.id}: the wait ${String(copy.wait)} is not a time of 0 or more`);
    problems.push(...delayProblems(copy));
  }
  return problems;
};

const queryProblems = (query: SendQuery): string[] => {
  const problems: string[] = [];
  const { atLeast = 1, within = Number.POSITIVE_INFINITY } = query;
  if (!(Number.isSafeInteger(atLeast) && atLeast >= 1)) problems.push(`atLeast ${String(atLeast)} is not a whole number of 1 or more`);
  if (!(within >= 0)) problems.push(`within ${String(within)} is not a time of 0 or more`);
  return problems;
};

/** A copy in the solver: its chance to send when no event of `events` occurs, and those events. */
interface Unit {
  readonly p: number;
  readonly events: readonly number[];
}

/**
 * This function gives the chance that `k` or more units send. The event `e` occurs with the chance
 * `q[e]`, and it stops each unit that has it. An event of one unit goes into the chance of that
 * unit. The function conditions on the event that the most units share. An event that all units
 * share costs one step, because its other branch has no unit.
 */
const atLeastOf = (units: readonly Unit[], k: number, q: readonly number[]): number => {
  const live = units.filter((unit) => unit.p > 0);
  if (live.length < k) return 0;
  const counts = new Map<number, number>();
  for (const unit of live) for (const event of unit.events) counts.set(event, (counts.get(event) ?? 0) + 1);
  const folded = live.map((unit) => {
    let p = unit.p;
    const events: number[] = [];
    for (const event of unit.events) {
      if (counts.get(event) === 1) p *= 1 - (q[event] ?? 0);
      else events.push(event);
    }
    return { p, events };
  });
  let [shared, most] = [-1, 1];
  for (const [event, count] of counts) if (count > most) [shared, most] = [event, count];
  if (shared < 0) return poissonBinomialTest(k, folded.map((unit) => unit.p), "greater");
  const chance = q[shared] ?? 0;
  const up = chance < 1 ? atLeastOf(folded.map((unit) => ({ p: unit.p, events: unit.events.filter((event) => event !== shared) })), k, q) : 0;
  const down = chance > 0 ? atLeastOf(folded.filter((unit) => !unit.events.includes(shared)), k, q) : 0;
  return (1 - chance) * up + chance * down;
};

/** The chance that a copy sends within `t` seconds of its wait, from its delay points. A missing table means a delay of 0. */
const delayChance = (points: readonly DelayPoint[] | undefined, t: number, end: 0 | 1): number => {
  if (t < 0) return 0;
  if (points === undefined || points.length === 0) return 1;
  let chance = 0;
  for (const point of points) if (point.within <= t) chance = ends(point.chance)[end];
  return chance;
};

/** The closure of each cause: its own index and the index of each cause that contains it. */
const closures = (causes: readonly Cause[]): Map<string, readonly number[]> => {
  const result = new Map<string, readonly number[]>();
  for (const [index, cause] of causes.entries()) {
    const closure = new Set<number>([index]);
    for (const outer of cause.within ?? []) for (const event of result.get(outer) ?? []) closure.add(event);
    result.set(cause.id, [...closure].sort((a, b) => a - b));
  }
  return result;
};

/** The two point problems of a placement: the pessimistic end (index 0) and the optimistic end (index 1). */
interface Ends {
  readonly q: readonly [number[], number[]];
  readonly units: readonly [Unit[], Unit[]];
}

const endsOf = (placement: Placement, within: number): Ends => {
  const closure = closures(placement.causes);
  // the pessimistic end takes the high chance of failure of each cause, and the optimistic end the low chance
  const q: [number[], number[]] = [placement.causes.map((cause) => ends(cause.down)[1]), placement.causes.map((cause) => ends(cause.down)[0])];
  const unitsAt = (end: 0 | 1): Unit[] =>
    placement.copies.map((copy) => {
      const events = new Set<number>();
      for (const need of copy.needs) for (const event of closure.get(need) ?? []) events.add(event);
      const up = 1 - ends(copy.down)[end === 0 ? 1 : 0];
      return { p: up * delayChance(copy.delay, within - (copy.wait ?? 0), end), events: [...events].sort((a, b) => a - b) };
    });
  return { q, units: [unitsAt(0), unitsAt(1)] };
};

const same = (a: Ends): boolean =>
  a.q[0].every((value, index) => value === a.q[1][index]) && a.units[0].every((unit, index) => unit.p === a.units[1][index]?.p);

const solve = (problem: Ends, k: number): ChanceInterval => {
  const lo = atLeastOf(problem.units[0], k, problem.q[0]);
  const hi = same(problem) ? lo : atLeastOf(problem.units[1], k, problem.q[1]);
  return { lo, hi };
};

const checked = (name: string, placement: Placement, query: SendQuery): { problem: Ends; k: number } => {
  const problems = [...placementProblems(placement), ...queryProblems(query)];
  if (problems.length > 0) throw new RangeError(`${name}: ${problems.join(", ")}`);
  return { problem: endsOf(placement, query.within ?? Number.POSITIVE_INFINITY), k: query.atLeast ?? 1 };
};

/**
 * This function gives the chance that at least `atLeast` copies send within `within` seconds. A
 * copy sends in time when it and each cause that it needs do not fail. Its wait plus its delay
 * must also be the time or less.
 *
 * The function counts each copy that sends. A copy with a rank wait does not send when a copy of a
 * lower rank sends first. Thus use the rank waits with `atLeast` 1. For 2 or more, give each copy
 * the wait 0.
 *
 * The time grows with 2 to the count of the causes that two or more copies share in part. A cause
 * that each live copy shares costs one step.
 *
 * @param placement - The copies and their causes.
 * @param query - The count of copies and the limit of time.
 * @returns The interval of the chance. The two ends are equal when each chance is a number.
 * @throws RangeError when the placement or the query has a problem.
 */
export const sendChance = (placement: Placement, query: SendQuery = {}): ChanceInterval => {
  const { problem, k } = checked("sendChance", placement, query);
  return solve(problem, k);
};

/**
 * This function gives the chance of the query when one item does not fail on its own, for each
 * cause and each copy. The gap to `sendChance` is the gain of a perfect item. A shared cause with a
 * large gain limits the gain of more copies.
 *
 * A cause that does not fail on its own still fails when a cause that contains it fails.
 *
 * @param placement - The copies and their causes.
 * @param query - The count of copies and the limit of time.
 * @returns One result for each cause, then one result for each copy, in the order of the placement.
 * @throws RangeError when the placement or the query has a problem.
 */
export const neverDownChances = (placement: Placement, query: SendQuery = {}): readonly NeverDown[] => {
  const { problem, k } = checked("neverDownChances", placement, query);
  const causes = placement.causes.map((cause, index): NeverDown => {
    const without = (chances: readonly number[]): number[] => chances.map((value, at) => (at === index ? 0 : value));
    const q: [number[], number[]] = [without(problem.q[0]), without(problem.q[1])];
    return { id: cause.id, of: "cause", chance: solve({ q, units: problem.units }, k) };
  });
  const copies = placement.copies.map((copy, index): NeverDown => {
    const perfect = (end: 0 | 1): Unit[] =>
      problem.units[end].map((unit, at) =>
        at === index ? { p: delayChance(copy.delay, (query.within ?? Number.POSITIVE_INFINITY) - (copy.wait ?? 0), end), events: unit.events } : unit,
      );
    const units: [Unit[], Unit[]] = [perfect(0), perfect(1)];
    return { id: copy.id, of: "copy", chance: solve({ q: problem.q, units }, k) };
  });
  return [...causes, ...copies];
};
