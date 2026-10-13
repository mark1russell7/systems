# @mark1russell7/quantity

Amounts in typed units, with exact arithmetic. A `Quantity` is `{ value, unit }`, and its unit is always canonical:

```json
{ "value": 7200, "unit": "s" }
{ "value": -84.12, "unit": "USD" }
{ "value": 3, "unit": "{set}/wk" }
```

## What the package does

- **Dimensions.** A dimension is an exponent vector over six bases: time, length, mass, temperature, data and money. Counts and ratios have no dimension, as in SI. Thus a duration times a count is still a duration.
- **Kinds.** A kind names a dimension that a schema can ask for, for example `time`, `money`, `data-rate` and `transfer-rate`. A value of 8 GT/s is a transfer rate, not a clock.
- **Units.** The grammar of a unit is similar to UCUM, with easy symbols: `h`, `min`, `tbsp`, `fl oz`, `kcal/(h·kg)`. A unit has one `/` at most, and all that follows it divides.
- **Annotations.** An annotation names what a unit counts: `{rep}` counts reps, and `%{1RM}` is a percentage of a one-rep max. A conversion joins only units that count the same thing: bpm is not Hz, and `{rep}` is not `count`.
- **Exact conversions.** Each factor is a rational over bigint (`units.ts`). Thus a decimal input converts exactly, and money adds to the cent. `toNanoseconds` gives a whole number of nanoseconds, or it refuses the value. A jiffy depends on the HZ of the kernel, and the package does not guess it.
- **Exact arithmetic.** The package also exports the arithmetic as `rationals` (`add`, `mul`, `div`, `pow`, `floor`, `ceil`, `cmp`). For example, 0.2 s × 1023 is exactly 204.6 s.
- **Canonical spellings.** `unitSchema` and `quantitySchema` refuse an alias, and they give the spelling to write ("write h, not hr"). `canonicalUnit` reads the spellings of other systems, for example `kcal/hr·kg`, `mi/hr` and `dBASPL`.
- **No limit, and unknown.** A value with no limit is `{ "value": "infinite", "unit": "s" }` (`extentSchema`). A value that nobody can give has its reason (`unknownSchema`). A sound level averages by its energy (`mean`).
- **One way to print.** `format` and `formatDuration` print each amount: `$1,234.56`, `72°F`, `8 mph`, `12 reps`, `1 h 30 min`.

`isQuantitySchema` tells if a schema is the schema of a quantity. A generator of SQL can then give the value and the unit a column each.

## Installation

```sh
pnpm add @mark1russell7/quantity zod
```

The package uses `zod` as a peer dependency. The schemas of the package are then parts of the schemas of the application, with one copy of `zod`.

## Example

```ts
import { add, convert, format, quantity, quantitySchema } from "@mark1russell7/quantity";

const idle = quantity(7200, "s");
const probes = quantity(675, "s");
format(convert(add(idle, probes), "min")); // "131.25 min"

quantitySchema("time").parse({ value: 5, unit: "hr" }); // fails: write h, not hr
```

## Tests

`pnpm --filter @mark1russell7/quantity test` starts the tests. `pnpm --filter @mark1russell7/quantity build` writes the package for npm into `build/`.
