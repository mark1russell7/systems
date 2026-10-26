/**
 * This module is the evaluator of the timer-ordering law. Its decisions are the same as the
 * decisions of the research evaluator, except when absent timers leave no order (`evaluate`). The
 * rules are data, and the caller gives them. Each rule
 * is one or more linear inequalities over symbols at a hop (`readiness_detection_window@pod`),
 * with a margin. A binding maps `symbol@hop` to seconds, or to "inf" for a timer that is absent.
 */

/** A term is a coefficient times one symbol, at a hop when it has one. */
export interface Term {
  readonly knob: string;
  readonly coef: number;
  readonly at?: string | undefined;
}

/** A side is a sum of terms, plus a constant. */
export interface Side {
  readonly terms: readonly Term[];
  readonly const?: number | undefined;
}

/** An inequality compares two sides, with a margin. */
export interface Inequality {
  readonly lhs: Side;
  readonly op: "<" | "<=" | ">" | ">=";
  readonly rhs: Side;
  /** The margin is in seconds, or it is words for a margin that no binding gives ("a factor of several"). Words count as 0. */
  readonly margin?: number | string | undefined;
}

/** A rule is one or more inequalities, with their statement in words. */
export interface Rule {
  readonly id: string;
  /** This text is the rule in words. */
  readonly rule: string;
  /** This text is the window that a violation opens. */
  readonly window?: string | undefined;
  readonly expr: Inequality;
  readonly expr_more?: readonly Inequality[] | undefined;
}

/** A bound is in seconds, or it is "inf" for an absent timer, or "off" for a disabled feature. The last two have no limit. */
export type Bound = number | "inf" | "off";

/**
 * A binding maps `symbol@hop` to its bound. Its "margin" replaces the margin of each inequality.
 * Its "margins" replace them one by one, in sequence, as the binding of a chain can.
 */
export type Binding = Readonly<Record<string, Bound | readonly number[] | undefined>> & {
  readonly margin?: number | undefined;
  readonly margins?: readonly number[] | undefined;
};

/** A verdict is "holds", "violated", "unbounded" (it holds only because a timer is absent) or "depends" (nothing is bound). */
export type Verdict = "holds" | "violated" | "unbounded" | "depends";

/** An evaluation is the value of each side of one inequality, its margin, and if it holds. */
export interface Evaluated {
  readonly lhs: number | null;
  readonly rhs: number | null;
  readonly margin: number;
  readonly holds: boolean | null;
}

const value = (bound: Bound): number =>
  bound === "inf" || bound === "off" ? Infinity : Number(bound);
const keyOf = (term: Term): string =>
  term.at !== undefined ? `${term.knob}@${term.at}` : term.knob;
/** This function gives the bound of a symbol, or undefined when the symbol has no bound. */
const boundOf = (bind: Binding, key: string): Bound | undefined => {
  const bound = bind[key];
  return typeof bound === "number" || bound === "inf" || bound === "off" ? bound : undefined;
};

/** This function gives the inequalities of a rule: its expr, then the others. */
export const inequalities = (rule: Rule): readonly Inequality[] => [
  rule.expr,
  ...(rule.expr_more ?? []),
];

/** This function gives the symbols that a rule reads, as `symbol@hop`. */
export const symbolsOf = (rule: Rule): string[] => {
  const out: string[] = [];
  for (const inequality of inequalities(rule)) {
    for (const term of [...inequality.lhs.terms, ...inequality.rhs.terms]) {
      const key = keyOf(term);
      if (!out.includes(key)) out.push(key);
    }
  }
  return out;
};

/** This function gives the value of a side, Σ coef × symbol + const, or null when a symbol has no bound. */
const sideOf = (side: Side, bind: Binding): number | null => {
  let total = side.const ?? 0;
  for (const term of side.terms) {
    const bound = boundOf(bind, keyOf(term));
    if (bound === undefined) return null;
    total += term.coef * value(bound);
  }
  return total;
};

/** This function gives the margin of an inequality: from the binding (one for all, or one each), else from the rule, else 0. */
const marginOf = (inequality: Inequality, index: number, bind: Binding): number => {
  if (Array.isArray(bind.margins)) return Number(bind.margins[index] ?? 0);
  if (typeof bind.margin === "number") return bind.margin;
  return typeof inequality.margin === "number" ? inequality.margin : 0;
};

/** This function tells if an inequality reads a symbol with no limit: "inf", "off" or an infinite number. */
const readsAbsent = (inequality: Inequality, bind: Binding): boolean =>
  [...inequality.lhs.terms, ...inequality.rhs.terms].some((term) => {
    const bound = boundOf(bind, keyOf(term));
    return bound !== undefined && value(bound) === Infinity;
  });

/**
 * This function evaluates each inequality on one binding. "<" holds when lhs + margin < rhs, and
 * ">" holds when lhs > rhs + margin. Only the inequalities with all their symbols bound apply.
 * The others are null. Absent timers can leave no order: the same infinity on each side, or both
 * signs of infinity on one side. Then the inequality holds only because a timer is absent.
 */
export const evaluate = (rule: Rule, bind: Binding): Evaluated[] =>
  inequalities(rule).map((inequality, index) => {
    const lhs = sideOf(inequality.lhs, bind);
    const rhs = sideOf(inequality.rhs, bind);
    const margin = marginOf(inequality, index, bind);
    if (lhs === null || rhs === null) return { lhs, rhs, margin, holds: null };
    const unordered = Number.isNaN(lhs) || Number.isNaN(rhs) || (lhs === rhs && !Number.isFinite(lhs));
    if (unordered && readsAbsent(inequality, bind)) return { lhs, rhs, margin, holds: true };
    const holds =
      inequality.op === "<"
        ? lhs + margin < rhs
        : inequality.op === "<="
          ? lhs + margin <= rhs
          : inequality.op === ">"
            ? lhs > rhs + margin
            : lhs >= rhs + margin;
    return { lhs, rhs, margin, holds };
  });

/**
 * This function gives the verdict of an evaluation. When an applicable inequality fails, the
 * verdict is "violated". When all hold only because a timer is absent, the verdict is "unbounded",
 * because nothing then limits the window. Otherwise the verdict is "holds". When no inequality
 * applies, the arithmetic cannot decide, and the verdict is "depends".
 */
export const verdictOf = (rule: Rule, bind: Binding, evaluated: readonly Evaluated[]): Verdict => {
  const applicable = evaluated.flatMap((entry, index) => (entry.holds === null ? [] : [index]));
  if (applicable.length === 0) return "depends";
  if (applicable.some((index) => evaluated[index]?.holds === false)) return "violated";
  const all = inequalities(rule);
  const infinite = applicable.some((index) => readsAbsent(all[index]!, bind));
  return infinite ? "unbounded" : "holds";
};

/**
 * A mark tells how a timer moves when a compression scales time by k (E10). A "scalable" timer
 * becomes k times its value. A "fixed" timer keeps its value. A "stepped" timer takes only
 * multiples of its step, thus it rounds up. A "floored" timer has a floor that a peer sets, for
 * example the minimum retransmission timeout of the kernel. The step and the floor are in seconds.
 */
export type TimerMark =
  | { readonly kind: "scalable" }
  | { readonly kind: "fixed" }
  | { readonly kind: "stepped"; readonly step: number }
  | { readonly kind: "floored"; readonly floor: number; readonly by: string };

/** The marks map `symbol@hop` to a mark. A bare symbol marks the symbol at each hop. */
export type TimerMarks = Readonly<Record<string, TimerMark | undefined>>;

/** A compressed binding, and the symbols that have no mark. */
export interface Compressed {
  readonly bind: Binding;
  /** These symbols have no mark. They keep their values, thus the compression proves nothing about them. */
  readonly unmarked: readonly string[];
}

/** A change is a rule whose verdict a compression changes. */
export interface Change {
  readonly rule: string;
  readonly before: Verdict;
  readonly after: Verdict;
}

/** The result of a compression: the rules whose verdict it changes, and the symbols of the rules that have no mark. */
export interface Compression {
  readonly changed: readonly Change[];
  readonly unmarked: readonly string[];
}

/** This function gives the mark of a symbol: its mark at its hop, else the mark of the bare symbol. */
const markOf = (marks: TimerMarks, key: string): TimerMark | undefined =>
  marks[key] ?? marks[key.split("@")[0] ?? key];

// a step absorbs the error of the float product, thus 0.3 s at k = 10 stays 3 s with a step of 1 s
const STEP_EPSILON = 1e-9;

const scaled = (seconds: number, k: number, mark: TimerMark): number => {
  switch (mark.kind) {
    case "scalable":
      return seconds * k;
    case "fixed":
      return seconds;
    case "stepped":
      // Math.max keeps 0 s at 0 s, not at -0
      return Math.max(Math.ceil((seconds * k) / mark.step - STEP_EPSILON), 0) * mark.step;
    case "floored":
      return Math.max(seconds * k, mark.floor);
  }
};

/**
 * This function scales each timer of a binding by k, by its mark (E10). An absent timer ("inf" or
 * "off") stays absent. A chain scales each value. The margins of the binding and the constants of
 * the rules do not scale: they are tolerances, not timers. A symbol with no mark keeps its value.
 */
export const compress = (bind: Binding, k: number, marks: TimerMarks): Compressed => {
  if (!Number.isFinite(k) || k <= 0) throw new RangeError(`a compression scales time by a finite factor above 0, not ${k}`);
  const out: Record<string, Bound | readonly number[] | undefined> = {};
  const unmarked: string[] = [];
  for (const [key, bound] of Object.entries(bind)) {
    if (key === "margin" || key === "margins") continue;
    const mark = markOf(marks, key);
    if (mark === undefined) {
      if (bound !== undefined) unmarked.push(key);
      out[key] = bound;
    } else if (typeof bound === "number") out[key] = scaled(bound, k, mark);
    else if (Array.isArray(bound)) out[key] = bound.map((seconds) => scaled(seconds, k, mark));
    else out[key] = bound;
  }
  const margins = {
    ...(bind.margin !== undefined ? { margin: bind.margin } : {}),
    ...(bind.margins !== undefined ? { margins: bind.margins } : {}),
  };
  return { bind: { ...out, ...margins }, unmarked };
};

/**
 * This function tells which rules a compression by k changes. A compression keeps each ordering
 * when no verdict changes. A change in either direction counts: a violation that the compression
 * hides is as wrong as one that it makes. The unmarked symbols are the symbols that the rules read.
 */
export const compression = (rules: readonly Rule[], bind: Binding, k: number, marks: TimerMarks): Compression => {
  const compressed = compress(bind, k, marks);
  const changed = rules.flatMap((rule): Change[] => {
    const before = verdictOf(rule, bind, evaluate(rule, bind));
    const after = verdictOf(rule, compressed.bind, evaluate(rule, compressed.bind));
    return before === after ? [] : [{ rule: rule.id, before, after }];
  });
  const read = new Set(rules.flatMap(symbolsOf));
  return { changed, unmarked: compressed.unmarked.filter((symbol) => read.has(symbol)) };
};
