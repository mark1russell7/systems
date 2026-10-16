// The entry "@mark1russell7/quantity/schema": the zod schemas of the amounts. The root entry of
// the package does not import zod.
import { z } from "zod";
import { tryParseUnit } from "./parse.ts";
import type { Extent, Quantity, Unknown } from "./quantity.ts";
import { STATISTICS } from "./quantity.ts";
import type { Kind } from "./units.ts";

export type KindOrDerived = Kind | "derived";

const checkUnit =
  (kinds: readonly KindOrDerived[]) =>
  (unit: string, ctx: z.RefinementCtx): void => {
    const parsed = tryParseUnit(unit);
    if (parsed === undefined) {
      ctx.addIssue({ code: "custom", message: `${unit} is not a known unit` });
    } else if (parsed.symbol !== unit) {
      ctx.addIssue({ code: "custom", message: `write ${parsed.symbol}, not ${unit}` });
    } else if (kinds.length > 0 && !kinds.includes(parsed.kind)) {
      ctx.addIssue({
        code: "custom",
        message: `${unit} is a ${parsed.kind}, and this is a ${kinds.join(" or ")}`,
      });
    }
  };

type Kinds = KindOrDerived | readonly KindOrDerived[];
const listOf = (kinds: Kinds | undefined): readonly KindOrDerived[] =>
  kinds === undefined ? [] : typeof kinds === "string" ? [kinds] : kinds;
const named = (kinds: readonly KindOrDerived[]): string =>
  kinds.length === 0 ? "any" : kinds.join("|");

/** This schema accepts a canonical unit, of one of these kinds when it names kinds. */
export const unitSchema = (kinds?: Kinds): z.ZodType<string, string> =>
  z
    .string()
    .superRefine(checkUnit(listOf(kinds)))
    .meta({ unit: named(listOf(kinds)) });

export interface QuantityOptions {
  /** The amount is more than zero: the duration of a visit, a price. */
  readonly positive?: boolean;
  /** The amount is zero or more: the fat in a food. */
  readonly nonnegative?: boolean;
}

const quantities = new WeakSet<z.ZodType>();

/**
 * This schema accepts `{ value, unit }`: a finite amount in a canonical unit of these kinds, or of
 * all kinds when it names none. Its input type is its output type, thus a schema that contains it
 * keeps a typed input.
 */
export const quantitySchema = (
  kinds?: Kinds,
  options: QuantityOptions = {},
): z.ZodType<Quantity, Quantity> => {
  const value =
    options.positive === true
      ? z.number().positive()
      : options.nonnegative === true
        ? z.number().nonnegative()
        : z.number();
  const schema = z
    .strictObject({ value, unit: unitSchema(kinds) })
    .meta({ quantity: named(listOf(kinds)) });
  quantities.add(schema);
  return schema;
};

/** This schema accepts a quantity, or no limit at all: `{ "value": "infinite", "unit": "s" }`. */
export const extentSchema = (kinds?: Kinds): z.ZodType<Extent, Extent> => {
  const schema = z
    .strictObject({ value: z.union([z.number(), z.literal("infinite")]), unit: unitSchema(kinds) })
    .meta({ quantity: named(listOf(kinds)), unbounded: true });
  quantities.add(schema);
  return schema;
};

/** This schema accepts a value that nobody can give, and the reason. */
export const unknownSchema: z.ZodType<Unknown, Unknown> = z.strictObject({
  unknown: z.string().min(1),
  unit: unitSchema().optional(),
});

export const statisticSchema: z.ZodEnum<{ [K in (typeof STATISTICS)[number]]: K }> =
  z.enum(STATISTICS);

const WRAPPERS = new Set(["optional", "nullable", "default", "readonly", "nonoptional"]);

interface WrapperDef {
  readonly type: string;
  readonly innerType?: z.ZodType;
}

/**
 * This function tells if a schema, under any optional or nullable, is the schema of a quantity.
 * Generated SQL can then give it a number column and a unit column, not one JSON column.
 */
export const isQuantitySchema = (schema: z.ZodType): boolean => {
  let current: z.ZodType | undefined = schema;
  while (current !== undefined) {
    if (quantities.has(current)) return true;
    const def: WrapperDef = (current as unknown as { def: WrapperDef }).def;
    current = WRAPPERS.has(def.type) ? def.innerType : undefined;
  }
  return false;
};
