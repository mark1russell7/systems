import type { Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { Prediction, Stage } from "./cell.ts";
import type { Measured, Reordering } from "./observe.ts";

/** This function gives the words of the outcome of a second request: its connection, a retry, and its end. */
export const requestWords = (outcome: {
  readonly connection: "reused" | "new";
  readonly retried: boolean;
  readonly error: string | null;
  readonly pending?: boolean | undefined;
}): string =>
  `${outcome.connection}${outcome.retried ? ", a retry" : ""}, ${outcome.pending === true ? "pending" : (outcome.error ?? "a reply")}`;

/**
 * This amount is the noise of the pipeline itself, δ_abs, as the calibration measured it. It is
 * the 99.9th percentile of the whole latency of a reset, at the concurrency cap or less. Its
 * minimum is one jiffy. On 2026-10-12 the worst of 60 resets at 1 and 4 environments took
 * 1.141 ms, thus the minimum sets it to 4 ms. The calibration occurs again after each change to
 * the harness, the kernel or Docker.
 */
export const NOISE: Quantity = quantity(4, "ms");

/**
 * This time is how late the injector can commit or lift a fault before the run is void. Stage 0
 * measures the commit apart from δ_abs, and it is longer: on a hosted runner it took up to 2.75 ms
 * at 4 environments, where δ_abs is 1 ms. Thus a cell's δ_abs does not change it.
 */
export const INJECT: Quantity = NOISE;

/** This function gives the δ_abs of a cell: its own, or `NOISE` for a cell that gives none. */
export const noiseOf = (cell: { readonly noise?: Quantity | undefined }): Quantity => cell.noise ?? NOISE;

/**
 * This function tells if a timer firing came late enough to void a run. A firing two jiffies or
 * more behind its wheel slot came late because the host stopped a vCPU. With the HZ of the run,
 * the rule is in time: the delay must also reach δ_abs, because each band already allows that
 * noise. At HZ 250 two jiffies are 8 ms, more than a δ_abs of 4 ms. At HZ 1000 they are 2 ms.
 */
export const delayVoids = (behind: number, hz: number | undefined, noise: Quantity): boolean => {
  if (behind < 2) return false;
  if (hz === undefined || !(hz > 0)) return true;
  return behind / hz >= Math.max(2 / hz, valueIn(noise, "s"));
};
/** This fraction, δ_rel, is how far the median of a cell can be outside the prediction and stay equivalent. */
export const RELATIVE = 0.05;
/** These are the run counts of a cell: 11, then 22 and 44 while its median crosses the edge of the band. */
export const STEPS = [11, 22, 44] as const;

/**
 * A decision is the result of a verdict. A cell whose outcome is a distribution has no band, and
 * its decision is `measured`: a record, not a test.
 */
export type Decision = "holds" | "fails" | "extend" | "inconclusive" | "measured";

/** An interval is a range of times. */
export interface Interval {
  readonly low: Quantity;
  readonly high: Quantity;
}

/** A spread is the distribution of a set of times: its count, its median and its upper quantiles by nearest rank. */
export interface Spread {
  readonly count: number;
  readonly median: Quantity;
  readonly p99: Quantity;
  readonly p999: Quantity;
  readonly max: Quantity;
}

/** A verdict is the judgement of a cell on its runs. */
export interface Verdict {
  readonly decision: Decision;
  readonly counted: number;
  readonly voided: number;
  /** This band is where each run must land: [T_lo − δ_abs, T_hi + δ_abs]. It is null for a silent prediction. */
  readonly band: Interval | null;
  /** These are the runs outside the band, and the reason for each. Each is a finding. */
  readonly outside: ReadonlyArray<{ readonly run: string; readonly why: string }>;
  readonly median: Quantity | null;
  /** This interval is the order-statistic interval of the median at 95 %, or the whole range for fewer than six runs. */
  readonly medianInterval: Interval | null;
  /** This record is the sum of what reordering did in each counted run of a measurement-only cell. */
  readonly reordering?: Reordering;
  /** This record is the time of the proxy of a calibration cell, in each direction. */
  readonly proxy?: { readonly hop: string; readonly up: Spread | null; readonly down: Spread | null };
  /** This record is what the group of a group cell did over the counted runs: its stages, and its writes. */
  readonly group?: GroupVerdict;
  /**
   * These are the outcomes of the second request of an HTTP client over the counted runs, each
   * with its count: for example "reused, a retry, a reply". An outcome other than the predicted
   * one is a finding of its run.
   */
  readonly requests?: Readonly<Record<string, number>>;
  /** This record is what the client did after the detection over the counted runs, for a prediction that says when it reconnects. */
  readonly reconnect?: ReconnectVerdict;
  /** These are the outcomes of the call in flight of a WebSocket client over the counted runs, each with its count. */
  readonly calls?: Readonly<Record<string, number>>;
  /**
   * This record is the time from a drop of the program to the close of its socket by its own side,
   * over the counted runs. It also counts the runs where the socket did not close itself.
   */
  readonly left?: { readonly spread: Spread | null; readonly stayed: number };
  readonly why: string;
}

/**
 * A reconnect verdict sums the reconnect of the client over the counted runs. Each wait before a
 * try gets its spread. A wait outside its band is a finding of its run, thus it is in `outside`.
 * - `syn` is the time from the detection to the first SYN of a new socket.
 * - `established` is the time from the detection to the first new socket that became ESTABLISHED.
 * - `connect` is the time from a `dial` line to the SYN of its socket: the work of the program.
 */
export interface ReconnectVerdict {
  readonly waits: ReadonlyArray<Spread | null>;
  readonly syn: Spread | null;
  readonly established: Spread | null;
  readonly connect: Spread | null;
}

/**
 * A stage verdict is the test of one stage of the timeline of a group against its band. The band
 * is [T_lo − δ_abs, T_hi + the error of the stamps + δ_abs]. A run that did not announce the stage
 * is outside too.
 */
export interface StageVerdict {
  readonly stage: Stage;
  readonly band: Interval;
  readonly median: Quantity | null;
  readonly outside: ReadonlyArray<{ readonly run: string; readonly why: string }>;
  readonly decision: "holds" | "fails";
}

/**
 * A group verdict sums what the group of a group cell did in its counted runs:
 * - `stages` tests each stage that the prediction gives a band.
 * - `medians` is the median of each stage that a run announced, from the fault.
 * - `lost` counts the writes that a primary accepted and the group did not keep, in each run.
 * - `old` counts the writes that the old primary accepted after the fault, in each run.
 * - `unknown` counts the writes whose outcome the client did not see, and how many the group kept.
 * - `errors` are the errors on the way: the runs that met each, and the median of its first time.
 * - `lags` is the spread of the delays of the stamps, for a calibration.
 */
export interface GroupVerdict {
  readonly stages: readonly StageVerdict[];
  readonly medians: Partial<Record<Stage, Quantity>>;
  readonly lost: { readonly runs: number; readonly total: number; readonly median: number | null; readonly max: number | null };
  readonly old: { readonly median: number | null; readonly max: number | null };
  readonly unknown: { readonly total: number; readonly held: number };
  readonly errors: ReadonlyArray<{ readonly name: string; readonly runs: number; readonly first: Quantity }>;
  readonly lags?: Spread | null;
}

const s = (value: number): Quantity => quantity(Math.round(value * 1e6) / 1e6, "s");
const name = (run: Measured): string => `env ${run.environment} run ${run.index}`;

/** This function gives the value at quantile p of sorted values, by nearest rank: x_(⌈p·n⌉). */
export const quantileOf = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length))) - 1]!;

/** This function gives the spread of a set of times, or null for none. */
export const spreadOf = (times: readonly Quantity[]): Spread | null => {
  if (times.length === 0) return null;
  const sorted = times.map((time) => valueIn(time, "s")).sort((a, b) => a - b);
  return {
    count: sorted.length,
    median: s(middle(sorted)),
    p99: s(quantileOf(sorted, 0.99)),
    p999: s(quantileOf(sorted, 0.999)),
    max: s(sorted.at(-1)!),
  };
};

/** This function adds the reordering records of runs: the counts add, and each largest value is the largest of all. */
const reorderingTotal = (runs: readonly Measured[]): Reordering | undefined => {
  const each = runs.flatMap((run) => (run.reordering === undefined ? [] : [run.reordering]));
  if (each.length === 0) return undefined;
  const sum = (key: "outOfOrder" | "duplicates" | "fast") => each.reduce((total, one) => total + one[key], 0);
  const add = (key: "ooo" | "dsacks" | "seen") =>
    each.some((one) => one[key] !== null) ? each.reduce((total, one) => total + (one[key] ?? 0), 0) : null;
  const top = (key: "sacked" | "lost" | "degree") =>
    each.some((one) => one[key] !== null) ? Math.max(...each.map((one) => one[key] ?? 0)) : null;
  return {
    outOfOrder: sum("outOfOrder"),
    duplicates: sum("duplicates"),
    ooo: add("ooo"),
    sacked: top("sacked"),
    lost: top("lost"),
    dsacks: add("dsacks"),
    fast: sum("fast"),
    degree: top("degree"),
    seen: add("seen"),
  };
};

/** This function says a reordering record in words. */
const reorderingWords = (total: Reordering): string =>
  [
    `${total.outOfOrder} arrivals out of order and ${total.duplicates} duplicate arrivals at the client`,
    ...(total.ooo === null ? [] : [`its kernel counted ${total.ooo} segments out of order`]),
    ...(total.sacked === null ? [] : [`the server held up to ${total.sacked} segments SACKed`]),
    ...(total.dsacks === null ? [] : [`got ${total.dsacks} DSACKs`]),
    `sent ${total.fast} fast retransmissions`,
    ...(total.seen === null ? [] : [`saw ${total.seen} reorderings`]),
    ...(total.degree === null ? [] : [`and its reordering degree went to ${total.degree}`]),
  ].join(", ");

/** This function says a spread in words, in milliseconds. */
const spreadWords = (spread: Spread | null): string => {
  if (spread === null) return "no time";
  const ms = (time: Quantity) => Math.round(valueIn(time, "s") * 1e6) / 1e3;
  return `median ${ms(spread.median)} ms, p99 ${ms(spread.p99)} ms, p99.9 ${ms(spread.p999)} ms, max ${ms(spread.max)} ms of ${spread.count}`;
};

/** This function gives P(X ≤ j) for X ~ Binomial(n, 1/2), exactly. */
const below = (n: number, j: number): number => {
  let term = 1;
  let sum = 0;
  for (let i = 0; i <= j; i += 1) {
    sum += term;
    term = (term * (n - i)) / (i + 1);
  }
  return sum / 2 ** n;
};

/**
 * This function gives the distribution-free interval of a median: [x_(k), x_(n+1−k)], for the
 * largest k whose two tails each hold 2.5 % or less. For eleven runs, it gives [x_(2), x_(10)],
 * at 98.8 %.
 */
export const medianInterval = (sorted: readonly number[]): [number, number] => {
  const n = sorted.length;
  let k = 0;
  while (k + 1 <= n / 2 && below(n, k) <= 0.025) k += 1;
  return k === 0 ? [sorted[0]!, sorted[n - 1]!] : [sorted[k - 1]!, sorted[n - k]!];
};

const middle = (sorted: readonly number[]): number => {
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
};

/**
 * This function gives the verdict of a cell, from two tests:
 * - Containment: each run lands in [T_lo − δ_abs, T_hi + δ_abs]. A run outside is a finding.
 * - Median equivalence: the interval of the median is in the band, made wider by δ_rel. An
 *   interval outside the band fails. An interval across its edge extends the cell to 22 runs, then
 *   44, and then the verdict is inconclusive.
 *
 * A silent prediction holds only if no run detected the fault in its window. After a stall, the
 * return of the reply gets the same test as a detection, by its interval, and a detection is a
 * finding. The distribution test (a DKW band) needs a predicted distribution from a simulator,
 * which does not exist at this time.
 */
export const verdictOf = (prediction: Prediction, runs: readonly Measured[], noise: Quantity = NOISE): Verdict => {
  const band = verdictOfBand(prediction, runs, noise);
  const counted = runs.filter((run) => run.void === null);
  const asked = counted.some((run) => run.request !== undefined) ? withRequests(band, counted) : band;
  const verdict = withProgram(asked, counted);
  if (prediction.group === undefined && !counted.some((run) => run.group !== undefined)) return verdict;
  return { ...verdict, group: groupVerdictOf(prediction, counted, noise) };
};

/**
 * This function adds the reconnect of the client and the outcomes of its call in flight to a
 * verdict. Its reason gets a sentence for each. A verdict whose runs have neither stays as it is.
 */
const withProgram = (verdict: Verdict, counted: readonly Measured[]): Verdict => {
  const reconnects = counted.flatMap((run) => (run.reconnect === undefined ? [] : [run.reconnect]));
  const calls = counted.flatMap((run) => (run.call === undefined ? [] : [run.call]));
  const lefts = counted.flatMap((run) => (run.left === undefined ? [] : [run.left]));
  if (reconnects.length === 0 && calls.length === 0 && lefts.length === 0) return verdict;
  const ms = (spread: Spread | null) => (spread === null ? "none" : `${Math.round(valueIn(spread.median, "s") * 1e6) / 1e3} ms`);
  const tries = Math.max(0, ...reconnects.map((each) => each.waits.length));
  const reconnect: ReconnectVerdict | undefined =
    reconnects.length === 0
      ? undefined
      : {
          waits: Array.from({ length: tries }, (_, at) =>
            spreadOf(reconnects.flatMap((each) => (each.waits[at] === undefined ? [] : [each.waits[at]!]))),
          ),
          syn: spreadOf(reconnects.flatMap((each) => (each.syn === null ? [] : [each.syn]))),
          established: spreadOf(reconnects.flatMap((each) => (each.established === null ? [] : [each.established]))),
          connect: spreadOf(reconnects.flatMap((each) => each.connects)),
        };
  const outcomes: Record<string, number> = {};
  for (const call of calls) outcomes[call.outcome] = (outcomes[call.outcome] ?? 0) + 1;
  const gone = lefts.flatMap((each) => (each === null ? [] : [each]));
  const left = lefts.length === 0 ? undefined : { spread: spreadOf(gone), stayed: lefts.length - gone.length };
  const said = [
    ...(left === undefined
      ? []
      : [
          `After the drop, the program closed its socket in ${gone.length} runs, median ${ms(left.spread)} after its drop line${left.stayed === 0 ? "" : `, and it did not close it in ${left.stayed}`}.`,
        ]),
    ...(reconnect === undefined
      ? []
      : [
          `Reconnect: the waits before each try, median ${reconnect.waits.map(ms).join(", ")}; the first SYN median ${ms(reconnect.syn)} and ESTABLISHED median ${ms(reconnect.established)} after the detection.`,
        ]),
    ...(calls.length === 0
      ? []
      : [`Calls in flight: ${Object.entries(outcomes).map(([outcome, n]) => `${n} ${outcome}`).join("; ")}.`]),
  ];
  return {
    ...verdict,
    ...(reconnect === undefined ? {} : { reconnect }),
    ...(calls.length === 0 ? {} : { calls: outcomes }),
    ...(left === undefined ? {} : { left }),
    why: `${verdict.why.endsWith(".") ? verdict.why : `${verdict.why}.`} ${said.join(" ")}`,
  };
};

/**
 * This function adds the outcomes of the second request of an HTTP client to a verdict. A cell
 * whose outcome is a distribution gets them in its reason too.
 */
const withRequests = (verdict: Verdict, counted: readonly Measured[]): Verdict => {
  const requests: Record<string, number> = {};
  for (const run of counted) {
    const words = run.request === null || run.request === undefined ? "no second request" : requestWords(run.request);
    requests[words] = (requests[words] ?? 0) + 1;
  }
  const listed = Object.entries(requests)
    .map(([words, n]) => `${n} ${words}`)
    .join("; ");
  return {
    ...verdict,
    requests,
    why: verdict.decision === "measured" ? `${verdict.why} Second requests: ${listed}.` : verdict.why,
  };
};

/** This function gives the median of some counts, or null for none. */
const medianCount = (values: readonly number[]): number | null =>
  values.length === 0 ? null : middle([...values].sort((a, b) => a - b));

/** This function sums what the group of a group cell did in its counted runs, and tests each stage that has a band. */
export const groupVerdictOf = (prediction: Prediction, counted: readonly Measured[], delta: Quantity = NOISE): GroupVerdict => {
  const noise = valueIn(delta, "s");
  const stamps = prediction.group?.stamps === undefined ? 0 : valueIn(prediction.group.stamps, "s");
  const stages = (prediction.group?.stages ?? []).map((band): StageVerdict => {
    const interval = { low: s(valueIn(band.low, "s") - noise), high: s(valueIn(band.high, "s") + stamps + noise) };
    const outside: Array<{ run: string; why: string }> = [];
    const values: number[] = [];
    for (const run of counted) {
      const at = run.group?.stages[band.stage];
      if (at === undefined) {
        // a stage of a Sentinel starts with +: a Sentinel announces it. The members and the client of a replica set mark the others
        const who = band.stage.startsWith("+") ? "no Sentinel announced" : "no member or client marked";
        outside.push({ run: name(run), why: `${who} ${band.stage}` });
        continue;
      }
      const value = valueIn(at, "s");
      values.push(value);
      if (value < valueIn(interval.low, "s") || value > valueIn(interval.high, "s"))
        outside.push({ run: name(run), why: `${band.stage} at ${value} s is outside [${interval.low.value}, ${interval.high.value}] s` });
    }
    values.sort((a, b) => a - b);
    return {
      stage: band.stage,
      band: interval,
      median: values.length === 0 ? null : s(middle(values)),
      outside,
      decision: outside.length === 0 && values.length > 0 ? "holds" : "fails",
    };
  });
  const medians: Partial<Record<Stage, Quantity>> = {};
  const seen = new Set(counted.flatMap((run) => Object.keys(run.group?.stages ?? {}) as Stage[]));
  for (const stage of seen) {
    const values = counted.flatMap((run) => {
      const at = run.group?.stages[stage];
      return at === undefined ? [] : [valueIn(at, "s")];
    });
    medians[stage] = s(middle(values.sort((a, b) => a - b)));
  }
  const lostCounts = counted.flatMap((run) => (run.group?.writes.lost === null || run.group === undefined ? [] : [run.group.writes.lost.length]));
  const oldCounts = counted.flatMap((run) => (run.group === undefined ? [] : [run.group.writes.old]));
  const unknown = counted.flatMap((run) => run.group?.writes.unknown ?? []);
  const errors = new Map<string, number[]>();
  for (const run of counted)
    for (const error of run.group?.errors ?? []) errors.set(error.name, [...(errors.get(error.name) ?? []), valueIn(error.first, "s")]);
  const lags = counted.flatMap((run) => run.group?.lags ?? []);
  return {
    stages,
    medians,
    lost: {
      runs: lostCounts.length,
      total: lostCounts.reduce((sum, n) => sum + n, 0),
      median: medianCount(lostCounts),
      max: lostCounts.length === 0 ? null : Math.max(...lostCounts),
    },
    old: { median: medianCount(oldCounts), max: oldCounts.length === 0 ? null : Math.max(...oldCounts) },
    unknown: { total: unknown.length, held: unknown.filter((each) => each.held === true).length },
    errors: [...errors].map(([error, firsts]) => ({ name: error, runs: firsts.length, first: s(middle(firsts.sort((a, b) => a - b))) })),
    ...(lags.length === 0 ? {} : { lags: spreadOf(lags) }),
  };
};

/** This function gives the verdict of the band of a cell: its containment and the equivalence of its median. */
const verdictOfBand = (prediction: Prediction, runs: readonly Measured[], delta: Quantity = NOISE): Verdict => {
  const counted = runs.filter((run) => run.void === null);
  const voided = runs.length - counted.length;
  const outside = counted
    .filter((run) => run.finding !== null)
    .map((run) => ({ run: name(run), why: run.finding! }));
  const empty = { counted: counted.length, voided, median: null, medianInterval: null };
  if (counted.length === 0)
    return { ...empty, decision: "inconclusive", band: null, outside, why: "no run counted" };

  if (prediction.detects === null) {
    // a calibration of a proxy: its time in each direction, over all the requests of the runs
    const crossed = counted.flatMap((run) => (run.crossings === undefined ? [] : [run.crossings]));
    if (crossed.length > 0) {
      const hop = crossed[0]!.hop;
      const up = spreadOf(crossed.flatMap((each) => each.up));
      const down = spreadOf(crossed.flatMap((each) => each.down));
      return {
        ...empty,
        decision: "measured",
        band: null,
        outside: [],
        median: up?.median ?? null,
        proxy: { hop, up, down },
        why: `${counted.length} runs measured ${hop}: toward the target ${spreadWords(up)}; toward the client ${spreadWords(down)}. ${prediction.why}`,
      };
    }
    // a measurement-only cell with a reference: the outcomes, and the times from the reference
    if (prediction.from !== undefined) {
      const times = counted
        .flatMap((run) => (run.elapsed === null ? [] : [valueIn(run.elapsed, "s")]))
        .sort((a, b) => a - b);
      const kinds = new Map<string, number>();
      for (const run of counted) {
        const kind = run.outcome.kind === "error" ? run.outcome.errno : run.outcome.kind;
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      }
      const outcomes = [...kinds].map(([kind, n]) => `${n} ${kind}`).join(", ");
      const timed =
        times.length === 0
          ? "no time"
          : `median ${s(middle(times)).value} s from ${prediction.from}, range [${s(times[0]!).value}, ${s(times.at(-1)!).value}] s`;
      return {
        ...empty,
        decision: "measured",
        band: null,
        outside: [],
        median: times.length === 0 ? null : s(middle(times)),
        why: `${counted.length} runs measured: ${outcomes}; ${timed}. ${prediction.why}`,
      };
    }
    const samples = counted
      .flatMap((run) => (run.samples ?? []).map((sample) => valueIn(sample, "s")))
      .sort((a, b) => a - b);
    const retransmissions = counted.reduce((sum, run) => sum + run.retransmissions, 0);
    const ended = counted.filter((run) => run.outcome.kind === "error" || run.outcome.kind === "eof");
    const reordering = reorderingTotal(counted);
    // a run in which nothing came out of order, twice or SACKed says nothing about reordering
    const anything =
      reordering !== undefined &&
      [reordering.outOfOrder, reordering.duplicates, reordering.ooo, reordering.sacked, reordering.dsacks, reordering.fast, reordering.seen].some(
        (count) => (count ?? 0) > 0,
      );
    const reordered = anything ? ` Reordering: ${reorderingWords(reordering)}.` : "";
    const why =
      samples.length === 0
        ? `${counted.length} runs measured, with no reply: ${prediction.why}`
        : `${counted.length} runs, ${samples.length} replies: median ${s(middle(samples)).value} s, p99 ${s(quantileOf(samples, 0.99)).value} s, slowest ${s(samples.at(-1)!).value} s, ${retransmissions} retransmissions, ${ended.length} connections ended.${reordered} ${prediction.why}`;
    return {
      ...empty,
      decision: "measured",
      band: null,
      outside: [],
      median: samples.length === 0 ? null : s(middle(samples)),
      ...(reordering === undefined ? {} : { reordering }),
      why,
    };
  }

  if (!prediction.detects && prediction.recovers === undefined && prediction.replies === undefined) {
    const decision = outside.length === 0 ? "holds" : "fails";
    const why =
      decision === "holds"
        ? `nothing detected it in ${counted.length} runs of ${valueIn(prediction.window, "s")} s`
        : `${outside.length} of ${counted.length} runs detected it`;
    return { ...empty, decision, band: null, outside, why };
  }

  // the interval of a detection, of the return of the reply after a stall, or of a reply in its band
  const timed = prediction.detects ? prediction : (prediction.recovers ?? prediction.replies)!;
  const noise = valueIn(delta, "s");
  const low = valueIn(timed.low, "s");
  const high = valueIn(timed.high, "s");
  const band = { low: s(low - noise), high: s(high + noise) };
  const values: number[] = [];
  for (const run of counted) {
    if (run.elapsed === null) continue;
    const value = valueIn(run.elapsed, "s");
    values.push(value);
    if (value < low - noise || value > high + noise)
      outside.push({
        run: name(run),
        why: `${value} s is outside [${band.low.value}, ${band.high.value}] s`,
      });
  }
  values.sort((a, b) => a - b);
  if (values.length === 0)
    return { ...empty, decision: "fails", band, outside, why: "no run measured its time" };
  const [from, to] = medianInterval(values);
  const median = s(middle(values));
  const interval = { low: s(from), high: s(to) };
  const wide = { low: low * (1 - RELATIVE), high: high * (1 + RELATIVE) };
  const inside = from >= wide.low && to <= wide.high;
  const disjoint = to < wide.low || from > wide.high;
  // a run can be outside for its time and for a finding: it counts once
  const off = new Set(outside.map((each) => each.run)).size;
  const counts = `${counted.length - off} of ${counted.length} runs inside [${band.low.value}, ${band.high.value}] s`;
  const centre = `median ${median.value} s, its interval [${interval.low.value}, ${interval.high.value}] s`;
  const result = {
    counted: counted.length,
    voided,
    band,
    outside,
    median,
    medianInterval: interval,
  };
  if (outside.length > 0 || disjoint)
    return { ...result, decision: "fails", why: `${counts}; ${centre}` };
  if (inside) return { ...result, decision: "holds", why: `${counts}; ${centre}` };
  const decision = counted.length < STEPS[2] ? "extend" : "inconclusive";
  return { ...result, decision, why: `${counts}; ${centre} straddles the band` };
};
