import type { Rational } from "./rational.ts";
import { ONE, mul, pow } from "./rational.ts";
import type { Atom, Base, Kind, Vector } from "./units.ts";
import { BASES, KINDS, SPELLINGS, lookupAtom } from "./units.ts";

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
  readonly log: boolean;
  /** The parameter is what its size changes with: a jiffy needs the HZ of the kernel. */
  readonly param?: "hz";
}

export class UnitError extends Error {
  override readonly name = "UnitError";
}

const ANNOTATION = /^[A-Za-z0-9%][A-Za-z0-9 _.%-]*$/;

const parseComponent = (token: string, sign: 1 | -1, whole: string): Component => {
  const match = /^(.*?)(?:\{([^{}]*)\})?(?:\^(\d+))?$/.exec(token);
  const [, spelling = "", annotation, power] = match ?? [];
  const exponent = sign * (power === undefined ? 1 : Number(power));
  const trimmed = spelling.trim();
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
  return body.split(/[·*]/).map((token) => parseComponent(token.trim(), sign, whole));
};

const spell = (component: Component): string => {
  const power = Math.abs(component.exponent);
  return `${component.atom?.symbol ?? ""}${
    component.annotation !== undefined ? `{${component.annotation}}` : ""
  }${power !== 1 ? `^${power}` : ""}`;
};

export const sameVector = (a: Vector, b: Vector): boolean =>
  BASES.every((base) => (a[base] ?? 0) === (b[base] ?? 0));

const isEmpty = (vector: Vector): boolean => BASES.every((base) => (vector[base] ?? 0) === 0);

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

const cache = new Map<string, Unit>();

/**
 * This function resolves a unit from its spelling. The spelling has symbols or their aliases,
 * factors joined by `·` or `*`, and one `/` at most. All that follows the slash divides: "kcal/h·kg"
 * is per hour per kilogram. A factor can have a power (`m^2`) and say what it counts (`{rep}`).
 */
export const parseUnit = (spelling: string): Unit => {
  const hit = cache.get(spelling);
  if (hit !== undefined) return hit;
  const whole = SPELLINGS[spelling.trim()] ?? spelling.trim();
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
    const counted = component.annotation ?? component.atom?.counts;
    // %{1RM} is a percentage OF a one-rep max, not a count of them
    if (counted !== undefined && component.atom?.percent !== true) {
      counts[counted] = (counts[counted] ?? 0) + component.exponent;
    } else if (counted !== undefined) {
      counts[`of ${counted}`] = (counts[`of ${counted}`] ?? 0) + component.exponent;
    }
    if (component.atom?.param !== undefined) param = component.atom.param;
  }
  for (const [name, power] of Object.entries(counts)) if (power === 0) delete counts[name];
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
    log,
    ...(param !== undefined ? { param } : {}),
  };
  cache.set(spelling, unit);
  return unit;
};

/** This function gives the unit of a spelling, or undefined when the spelling names no unit. */
export const tryParseUnit = (spelling: string): Unit | undefined => {
  try {
    return parseUnit(spelling);
  } catch (error) {
    if (error instanceof UnitError) return undefined;
    throw error;
  }
};

/** This function tells if stored data can have this spelling. Only the canonical spelling is correct. */
export const isCanonicalUnit = (spelling: string): boolean =>
  tryParseUnit(spelling)?.symbol === spelling;

/** This function gives the canonical spelling of a unit, for data from another system: "hr" is "h". */
export const canonicalUnit = (spelling: string): string => parseUnit(spelling).symbol;

export const kindOf = (spelling: string): Kind | "derived" => parseUnit(spelling).kind;
