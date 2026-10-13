/**
 * This module is the evaluator of the timer-ordering law. Its decisions are the same as the
 * decisions of the research evaluator. The rules are data, and the caller gives them. Each rule
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

/**
 * This function evaluates each inequality on one binding. "<" holds when lhs + margin < rhs, and
 * ">" holds when lhs > rhs + margin. Only the inequalities with all their symbols bound apply.
 * The others are null.
 */
export const evaluate = (rule: Rule, bind: Binding): Evaluated[] =>
  inequalities(rule).map((inequality, index) => {
    const lhs = sideOf(inequality.lhs, bind);
    const rhs = sideOf(inequality.rhs, bind);
    const margin = marginOf(inequality, index, bind);
    if (lhs === null || rhs === null) return { lhs, rhs, margin, holds: null };
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
  const infinite = applicable.some((index) => {
    const inequality = all[index]!;
    return [...inequality.lhs.terms, ...inequality.rhs.terms].some((term) => {
      const bound = boundOf(bind, keyOf(term));
      return bound !== undefined && value(bound) === Infinity;
    });
  });
  return infinite ? "unbounded" : "holds";
};
