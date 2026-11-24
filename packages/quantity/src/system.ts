import type { Rational } from "@mark1russell7/rational";
import { ONE, ZERO, add, div, mul, pow, rational, sub, toNumber } from "@mark1russell7/rational";
import type { Atom, Base, Kind, Vector } from "./dimensions.ts";
import { BASES, KINDS } from "./dimensions.ts";

/** A component is one factor of a unit: an atom, a count of a thing named in braces, or an atom with such a name. */
export interface Component {
  readonly atom?: Atom;
  /** The annotation `{rep}` counts reps, and `%{1RM}` is a percentage of a one-rep max. */
  readonly annotation?: string;
  /** The exponent has a sign: what follows the slash divides. */
  readonly exponent: number;
}

/** A unit is a spelling resolved into what arithmetic uses. */
export interface Unit {
  /** The symbol is its canonical spelling: the symbols of the atoms, `·` between factors, and one `/`. */
  readonly symbol: string;
  readonly components: readonly Component[];
  readonly vector: Vector;
  readonly factor: Rational;
  /** Only a lone affine unit (°F, °C) has an offset. A compound of it is a difference. */
  readonly offset?: Rational;
  readonly kind: Kind | "derived";
  /** The counts are what it counts, with exponents: bpm counts beats, and `{set}/wk` counts sets per week. */
  readonly counts: Readonly<Record<string, number>>;
  /**
   * These names keep it apart from the units of the same vector (`Atom.apart`), with exponents: `uSv/h` has a
   * weighted dose, and `nW/(cm^2·sr)` is per steradian. A unit without such a name does not have the field.
   */
  readonly apart?: Readonly<Record<string, number>>;
  readonly log: boolean;
  /** The parameter is what its size changes with: a jiffy needs the HZ of the kernel. */
  readonly param?: "hz";
}

export class UnitError extends Error {
  override readonly name = "UnitError";
}

/** These are the facts about the measured system that a conversion uses. */
export interface MeasuredOn {
  /** The timer frequency of the kernel converts jiffies: at 250, one jiffy is 4 ms. */
  readonly hz?: number | undefined;
}

/**
 * A unit system is a table of atoms and the functions that read and convert the spellings of its
 * units. The root entry has the system of all atoms. The entry `./time` has a system of the times,
 * the frequencies and the counts only. Thus a bundle that converts only times does not get the
 * other tables.
 */
export interface UnitSystem {
  readonly atoms: readonly Atom[];
  readonly atomBySymbol: ReadonlyMap<string, Atom>;
  /** This function gives the atom that a spelling names: its symbol or one of its aliases. */
  readonly lookupAtom: (spelling: string) => Atom | undefined;
  /**
   * This function resolves a unit from its spelling. The spelling has symbols or their aliases,
   * factors joined by `·` or `*`, and one `/` at most. All that follows the slash divides: "kcal/h·kg"
   * is per hour per kilogram. A factor can have a power (`m^2`) and say what it counts (`{rep}`).
   */
  readonly parseUnit: (spelling: string) => Unit;
  /** This function gives the unit of a spelling, or undefined when the spelling names no unit. */
  readonly tryParseUnit: (spelling: string) => Unit | undefined;
  /** This function tells if stored data can have this spelling. Only the canonical spelling is correct. */
  readonly isCanonicalUnit: (spelling: string) => boolean;
  /** This function gives the canonical spelling of a unit, for data from another system: "hr" is "h". */
  readonly canonicalUnit: (spelling: string) => string;
  readonly kindOf: (spelling: string) => Kind | "derived";
  /** This function gives the reason that `from` cannot become `to`, or undefined when it can. */
  readonly whyNotConvertible: (from: string, to: string) => string | undefined;
  readonly convertible: (from: string, to: string) => boolean;
  /** This function converts a value in one unit, exactly, into another unit. */
  readonly convertExact: (value: Rational, from: string, to: string, on?: MeasuredOn) => Rational;
  /**
   * This function gives the number that one `from` is in `to`, as a double: `factorOf("MiB", "B")` is 1048576. The system
   * keeps the factor of each pair, thus a loop over many amounts converts each pair one time. These give a `UnitError`: a
   * pair that does not convert, an absolute temperature and a unit that depends on the HZ of the kernel.
   */
  readonly factorOf: (from: string, to: string) => number;
  /**
   * This function gives the canonical spelling of the product of two units. The exponents of one
   * factor add, and a factor with the exponent 0 cancels: `{request}/s` times `{core}·ms/{request}`
   * is `{core}·ms/s`. A factor does not cancel a different atom: `ms/s` stays.
   */
  readonly multiplyUnits: (a: string, b: string) => string;
  /** This function gives the canonical spelling of the quotient of two units: `a` divided by `b`, as `multiplyUnits` does. */
  readonly divideUnits: (a: string, b: string) => string;
}

export const sameVector = (a: Vector, b: Vector): boolean =>
  BASES.every((base) => (a[base] ?? 0) === (b[base] ?? 0));

const isEmpty = (vector: Vector): boolean => BASES.every((base) => (vector[base] ?? 0) === 0);

const ANNOTATION = /^[A-Za-z0-9%][A-Za-z0-9 _.%-]*$/;

const spell = (component: Component): string => {
  const power = Math.abs(component.exponent);
  return `${component.atom?.symbol ?? ""}${
    component.annotation !== undefined ? `{${component.annotation}}` : ""
  }${power !== 1 ? `^${power}` : ""}`;
};

const NAMED: ReadonlyArray<readonly [Kind, Vector]> = (
  Object.entries(KINDS) as Array<[Kind, Vector]>
).filter(([kind]) => !["count", "ratio", "level", "frequency", "transfer-rate"].includes(kind));

const resolveKind = (
  vector: Vector,
  components: readonly Component[],
  counts: Readonly<Record<string, number>>,
): Kind | "derived" => {
  if (isEmpty(vector)) {
    if (components.some((c) => c.atom?.log === true)) return "level";
    if (components.some((c) => c.atom?.percent === true)) return "ratio";
    return "count";
  }
  if (sameVector(vector, KINDS.frequency)) {
    return (counts["transfer"] ?? 0) > 0 ? "transfer-rate" : "frequency";
  }
  return NAMED.find(([, named]) => sameVector(named, vector))?.[0] ?? "derived";
};

const factorOn = (unit: Unit, on: MeasuredOn | undefined): Rational => {
  if (unit.param !== "hz") return unit.factor;
  const hz = on?.hz;
  if (hz === undefined || !Number.isInteger(hz) || hz <= 0) {
    throw new UnitError(`${unit.symbol} depends on the kernel's HZ: say which, as { hz: 250 }`);
  }
  const jiffies = unit.components
    .filter((component) => component.atom?.param === "hz")
    .reduce((sum, component) => sum + component.exponent, 0);
  return mul(unit.factor, pow(rational(1n, BigInt(hz)), jiffies));
};

const counted = (unit: Unit): string => {
  const names = Object.entries(unit.counts).map(([name, power]) =>
    power === 1 ? name : `${name}^${power}`,
  );
  return names.length === 0 ? "nothing in particular" : names.join(" and ");
};

/** This function gives the text of the names that keep a unit apart: "weighted dose", "per steradian", "plain". */
const apartText = (unit: Unit): string => {
  const names = Object.entries(unit.apart ?? {}).map(
    ([name, power]) => `${power < 0 ? "per " : ""}${name}${Math.abs(power) === 1 ? "" : `^${Math.abs(power)}`}`,
  );
  return names.length === 0 ? "plain" : names.join(" and ");
};

/** This function gives the names of `apart` in one order, thus two units with the same names give the same text. */
const apartKey = (unit: Unit): string => JSON.stringify(Object.entries(unit.apart ?? {}).sort());

/**
 * This function divides a factor at each `.` outside braces: UCUM writes `cm^2.sr` for `cm^2·sr`. The caller
 * divides a factor only when the whole factor is not a spelling of the table, thus `fl. oz` stays one atom.
 */
const ucumFactors = (token: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < token.length; at += 1) {
    const char = token[at];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === "." && depth === 0) {
      parts.push(token.slice(start, at));
      start = at + 1;
    }
  }
  parts.push(token.slice(start));
  return parts;
};

/**
 * This function makes a unit system from a table of atoms and the whole spellings of other
 * systems. Each spelling of an atom (its symbol and its aliases) names one atom only, or the
 * function throws.
 */
export const unitSystem = (
  atoms: readonly Atom[],
  spellings: Readonly<Record<string, string>> = {},
): UnitSystem => {
  const bySpelling = new Map<string, Atom>();
  for (const a of atoms) {
    for (const spelling of [a.symbol, ...(a.aliases ?? [])]) {
      const taken = bySpelling.get(spelling);
      if (taken !== undefined && taken !== a) {
        throw new Error(`unit spelling ${spelling} names both ${taken.symbol} and ${a.symbol}`);
      }
      bySpelling.set(spelling, a);
    }
  }
  const atomBySymbol: ReadonlyMap<string, Atom> = new Map(atoms.map((a) => [a.symbol, a]));
  const lookupAtom = (spelling: string): Atom | undefined => bySpelling.get(spelling);

  const parseComponent = (token: string, sign: 1 | -1, whole: string): Component => {
    const match = /^(.*?)(?:\{([^{}]*)\})?(?:\^(\d+))?$/.exec(token);
    const [, text = "", annotation, power] = match ?? [];
    const exponent = sign * (power === undefined ? 1 : Number(power));
    const trimmed = text.trim();
    if (annotation !== undefined && !ANNOTATION.test(annotation.trim())) {
      throw new UnitError(`unit ${whole}: {${annotation}} is not a name of what it counts`);
    }
    if (trimmed === "") {
      if (annotation === undefined) throw new UnitError(`unit ${whole}: an empty factor`);
      return { annotation: annotation.trim(), exponent };
    }
    const atom = lookupAtom(trimmed);
    if (atom === undefined) throw new UnitError(`unknown unit ${trimmed} in ${whole}`);
    return {
      atom,
      exponent,
      ...(annotation !== undefined ? { annotation: annotation.trim() } : {}),
    };
  };

  const side = (text: string, sign: 1 | -1, whole: string): Component[] => {
    let body = text.trim();
    if (body.startsWith("(") && body.endsWith(")")) body = body.slice(1, -1).trim();
    if (body === "") return [];
    if (/[()]/.test(body)) throw new UnitError(`unit ${whole}: parentheses only around a divisor`);
    return body.split(/[·*]/).flatMap((token) => {
      const trimmed = token.trim();
      try {
        return [parseComponent(trimmed, sign, whole)];
      } catch (error) {
        const factors = ucumFactors(trimmed);
        if (!(error instanceof UnitError) || factors.length === 1) throw error;
        return factors.map((factor) => parseComponent(factor.trim(), sign, whole));
      }
    });
  };

  const cache = new Map<string, Unit>();

  const parseUnit = (spelling: string): Unit => {
    const hit = cache.get(spelling);
    if (hit !== undefined) return hit;
    const trimmed = spelling.trim();
    // an own key only: "toString" names no spelling, though a plain object has it
    const whole = Object.hasOwn(spellings, trimmed) ? (spellings[trimmed] as string) : trimmed;
    if (whole === "") throw new UnitError("an empty unit");
    const parts = whole.split("/");
    if (parts.length > 2) throw new UnitError(`unit ${spelling}: at most one /`);
    const [numerator = "", denominator] = parts;
    const components = [
      ...side(numerator, 1, spelling),
      ...(denominator === undefined ? [] : side(denominator, -1, spelling)),
    ];
    if (components.length === 0) throw new UnitError(`unit ${spelling}: nothing to measure in`);

    const vector: Partial<Record<Base, number>> = {};
    const counts: Record<string, number> = {};
    const apart: Record<string, number> = {};
    let factor: Rational = ONE;
    let param: "hz" | undefined;
    for (const component of components) {
      for (const [base, power] of Object.entries(component.atom?.vector ?? {}) as Array<
        [Base, number]
      >) {
        vector[base] = (vector[base] ?? 0) + power * component.exponent;
      }
      if (component.atom !== undefined)
        factor = mul(factor, pow(component.atom.factor, component.exponent));
      const what = component.annotation ?? component.atom?.counts;
      // %{1RM} is a percentage OF a one-rep max, not a count of them
      if (what !== undefined && component.atom?.percent !== true) {
        counts[what] = (counts[what] ?? 0) + component.exponent;
      } else if (what !== undefined) {
        counts[`of ${what}`] = (counts[`of ${what}`] ?? 0) + component.exponent;
      }
      if (component.atom?.param !== undefined) param = component.atom.param;
      const kept = component.atom?.apart;
      if (kept !== undefined) apart[kept] = (apart[kept] ?? 0) + component.exponent;
    }
    for (const [name, power] of Object.entries(counts)) if (power === 0) delete counts[name];
    for (const [name, power] of Object.entries(apart)) if (power === 0) delete apart[name];
    for (const base of BASES) if (vector[base] === 0) delete vector[base];

    const log = components.some((c) => c.atom?.log === true);
    if (log && (components.length !== 1 || components[0]?.exponent !== 1)) {
      throw new UnitError(`unit ${spelling}: a logarithmic level cannot be part of a compound`);
    }
    const lone = components.length === 1 ? components[0] : undefined;
    const offset =
      lone?.atom?.offset !== undefined && lone.exponent === 1 && lone.annotation === undefined
        ? lone.atom.offset
        : undefined;

    const numeratorSymbols = components.filter((c) => c.exponent > 0).map(spell);
    const denominatorSymbols = components.filter((c) => c.exponent < 0).map(spell);
    const symbol =
      denominatorSymbols.length === 0
        ? numeratorSymbols.join("·")
        : `${numeratorSymbols.join("·")}/${
            denominatorSymbols.length > 1
              ? `(${denominatorSymbols.join("·")})`
              : denominatorSymbols.join("")
          }`;

    const unit: Unit = {
      symbol,
      components,
      vector,
      factor,
      ...(offset !== undefined ? { offset } : {}),
      kind: resolveKind(vector, components, counts),
      counts,
      ...(Object.keys(apart).length > 0 ? { apart } : {}),
      log,
      ...(param !== undefined ? { param } : {}),
    };
    cache.set(spelling, unit);
    return unit;
  };

  const tryParseUnit = (spelling: string): Unit | undefined => {
    try {
      return parseUnit(spelling);
    } catch (error) {
      if (error instanceof UnitError) return undefined;
      throw error;
    }
  };

  // The reason of each pair of spellings. A pair can have no reason, thus the cache uses `has`.
  const reasons = new Map<string, string | undefined>();
  const whyNotConvertible = (from: string, to: string): string | undefined => {
    const key = `${from}\n${to}`;
    if (reasons.has(key)) return reasons.get(key);
    const why = reasonOf(from, to);
    reasons.set(key, why);
    return why;
  };

  const reasonOf = (from: string, to: string): string | undefined => {
    const a = parseUnit(from);
    const b = parseUnit(to);
    if (!sameVector(a.vector, b.vector)) {
      return `${a.symbol} is a ${a.kind} and ${b.symbol} is a ${b.kind}`;
    }
    const aCounts = JSON.stringify(Object.entries(a.counts).sort());
    const bCounts = JSON.stringify(Object.entries(b.counts).sort());
    if (aCounts !== bCounts) return `${a.symbol} counts ${counted(a)} and ${b.symbol} ${counted(b)}`;
    if (apartKey(a) !== apartKey(b)) {
      return `${a.symbol} (${apartText(a)}) and ${b.symbol} (${apartText(b)}) stay apart`;
    }
    if ((a.log || b.log) && a.symbol !== b.symbol) {
      return `${a.symbol} and ${b.symbol} are levels, and a level converts only to itself`;
    }
    return undefined;
  };

  const convertExact = (value: Rational, from: string, to: string, on?: MeasuredOn): Rational => {
    const why = whyNotConvertible(from, to);
    if (why !== undefined) throw new UnitError(`cannot convert ${from} to ${to}: ${why}`);
    const a = parseUnit(from);
    const b = parseUnit(to);
    const base = mul(add(value, a.offset ?? ZERO), factorOn(a, on));
    return sub(div(base, factorOn(b, on)), b.offset ?? ZERO);
  };

  /**
   * This function joins the factors of `a` and of `b` to the power `sign`. The factors keep their
   * order: the factors of `a`, then the new factors of `b`. Thus the product of two units is the same
   * amount in each order, and its spelling can change with the order.
   */
  const productOf = (from: string, by: string, sign: 1 | -1): string => {
    const what = `${sign === 1 ? "the product" : "the quotient"} of ${from} and ${by}`;
    const a = parseUnit(from);
    const b = parseUnit(by);
    for (const unit of [a, b]) {
      if (unit.offset !== undefined) {
        throw new UnitError(`${what}: ${unit.symbol} alone is an absolute temperature, and it has no product`);
      }
    }
    const order: string[] = [];
    const factors = new Map<string, Component>();
    const join = (component: Component, power: number): void => {
      const key = JSON.stringify([component.atom?.symbol ?? null, component.annotation ?? null]);
      const held = factors.get(key);
      if (held === undefined) order.push(key);
      factors.set(key, { ...component, exponent: (held?.exponent ?? 0) + power * component.exponent });
    };
    for (const component of a.components) join(component, 1);
    for (const component of b.components) join(component, sign);
    const kept = order.flatMap((key) => {
      const component = factors.get(key);
      return component === undefined || component.exponent === 0 ? [] : [component];
    });
    if (kept.length === 0) {
      const count = lookupAtom("count");
      if (count === undefined) throw new UnitError(`${what}: each factor cancels, and the table has no unit count`);
      return count.symbol;
    }
    const [lone] = kept;
    if (kept.length === 1 && lone?.atom?.offset !== undefined && lone.exponent === 1 && lone.annotation === undefined) {
      // a compound of degC is a difference of temperatures, and degC alone is an absolute temperature
      throw new UnitError(`${what}: it leaves ${lone.atom.symbol} alone, and ${lone.atom.symbol} alone is an absolute temperature`);
    }
    const top = kept.filter((component) => component.exponent > 0).map(spell);
    const bottom = kept.filter((component) => component.exponent < 0).map(spell);
    const spelling =
      bottom.length === 0 ? top.join("·") : `${top.join("·")}/${bottom.length > 1 ? `(${bottom.join("·")})` : bottom.join("")}`;
    return parseUnit(spelling).symbol;
  };

  const factors = new Map<string, number>();
  const factorOf = (from: string, to: string): number => {
    const key = `${from}\n${to}`;
    const known = factors.get(key);
    if (known !== undefined) return known;
    const why = whyNotConvertible(from, to);
    if (why !== undefined) throw new UnitError(`cannot convert ${from} to ${to}: ${why}`);
    const a = parseUnit(from);
    const b = parseUnit(to);
    for (const unit of [a, b]) {
      if (unit.offset !== undefined) throw new UnitError(`${unit.symbol} is an absolute temperature, and it has no factor: use convert`);
      if (unit.param === "hz") throw new UnitError(`${unit.symbol} depends on the kernel's HZ, and it has no factor: use convert with { hz }`);
    }
    const factor = a.symbol === b.symbol ? 1 : toNumber(div(a.factor, b.factor));
    factors.set(key, factor);
    return factor;
  };

  // The product and the quotient of each pair of spellings.
  const products = new Map<string, string>();
  const productKept = (from: string, by: string, sign: 1 | -1): string => {
    const key = `${from}\n${by}\n${sign}`;
    const known = products.get(key);
    if (known !== undefined) return known;
    const made = productOf(from, by, sign);
    products.set(key, made);
    return made;
  };

  return {
    atoms,
    atomBySymbol,
    lookupAtom,
    parseUnit,
    tryParseUnit,
    isCanonicalUnit: (spelling) => tryParseUnit(spelling)?.symbol === spelling,
    canonicalUnit: (spelling) => parseUnit(spelling).symbol,
    kindOf: (spelling) => parseUnit(spelling).kind,
    whyNotConvertible,
    convertible: (from, to) => whyNotConvertible(from, to) === undefined,
    multiplyUnits: (a, b) => productKept(a, b, 1),
    divideUnits: (a, b) => productKept(a, b, -1),
    convertExact,
    factorOf,
  };
};
