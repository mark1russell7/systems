# @mark1russell7/quantity

Amounts in typed units, with exact arithmetic. A `Quantity` is `{ value, unit }`, and its unit is always canonical:

```json
{ "value": 7200, "unit": "s" }
{ "value": -84.12, "unit": "USD" }
{ "value": 3, "unit": "{set}/wk" }
```

## What the package does

- **Dimensions.** A dimension is an exponent vector over seven bases: time, length, mass, temperature, data, money and electric current. Counts and ratios have no dimension, as in SI. Thus a duration times a count is still a duration.
- **Units that stay apart.** Some units have the same vector, but a conversion between them has no meaning. Each currency is money with its own name, because currencies have no fixed rate: `EUR` does not convert to `USD`. A sievert is a weighted dose, thus `Sv` is not `Gy`. A radiance per steradian (`nW/(cm^2·sr)`) is not an irradiance. `whyNotConvertible` gives the reason.
- **Kinds.** A kind names a dimension that a schema can ask for, for example `time`, `money`, `data-rate` and `transfer-rate`. A value of 8 GT/s is a transfer rate, not a clock.
- **Electricity.** The kinds `current` (`A`), `voltage` (`V`), `charge` (`Ah`) and `resistance` (`ohm`) measure a circuit. A volt times an ampere is a watt, exactly. The kind `energy-price` is a price of energy, for example `USD/kWh`.
- **Units.** The grammar of a unit is similar to UCUM, with easy symbols: `h`, `min`, `tbsp`, `fl oz`, `kcal/(h·kg)`. A unit has one `/` at most, and all that follows it divides. The UCUM `.` between two factors is a `·`, thus `nW/(cm^2.sr)` is `nW/(cm^2·sr)`, and `Cel` is `degC`.
- **Units of public data.** The table has the units of feeds of public data: `MW`, `GWh`, `uSv/h`, `ug/m^3`, `hPa`, `Bq/m^3`, `ppm`, `ppb`, `mHz`, `nT` and `dB`. Its currencies are `USD`, `EUR`, `GBP`, `CHF`, `SEK` and `JPY`. The micro of a unit is `u` in its symbol, and the table reads `µ`, `μ` and `mcg` too. Each prefixed unit is an atom of its own.
- **Energy of fuel.** The table has the megajoule `MJ` and the international British thermal unit `BTU`, which is 1055.05585262 J exactly. It reads `Btu` too. Thus `BTU/h` converts to `W`, and `MJ/kg` converts to `kJ/kg`.
- **Two families of heat units.** `cal` and `kcal` are thermochemical (4.184 J), and `BTU` is the international (IT) unit. Each is the usual unit of its trade. Thus 1 BTU is 0.252164 kcal here, and a handbook that uses one family gives 0.251996.
- **BTU in UCUM.** UCUM gives the code `[Btu_IT]` to this unit, and the table reads it as `BTU`. A different BTU is a new atom, for example `BTU_th`. A change of the factor of `BTU` is a breaking change.
- **UCUM codes of customary units.** The table reads the UCUM code of each customary unit as an alias., with the same factor by the definitions of UCUM. The codes are `[in_i]`, `[ft_i]`, `[yd_i]` and `[mi_i]` for length, and `[oz_av]` and `[lb_av]` for mass. For volume, they are `[tsp_us]`, `[tbs_us]`, `[foz_us]`, `[cup_us]`, `[pt_us]`, `[qt_us]` and `[gal_us]`. The code `[degF]` is `degF`. Thus `USD/[lb_av]` is `USD/lb`.
- **Annotations.** An annotation names what a unit counts: `{rep}` counts reps, and `%{1RM}` is a percentage of a one-rep max. A conversion joins only units that count the same thing: bpm is not Hz, and `{rep}` is not `count`.
- **Exact conversions.** Each factor is a rational over bigint (`units.ts`). Thus a decimal input converts exactly, and money adds to the cent. `toNanoseconds` gives a whole number of nanoseconds, or it refuses the value. A jiffy depends on the HZ of the kernel, and the package does not guess it.
- **Exact arithmetic.** The package also exports the arithmetic of [`@mark1russell7/rational`](https://www.npmjs.com/package/@mark1russell7/rational) as `rationals` (`add`, `mul`, `div`, `pow`, `floor`, `ceil`, `cmp`). For example, 0.2 s × 1023 is exactly 204.6 s. `toNumber` gives the nearest double, thus each conversion rounds correctly.
- **Products of units.** `multiplyUnits` and `divideUnits` give the canonical spelling of a product and of a quotient. The exponents of one factor add, and a factor with the exponent 0 cancels. Thus `{request}/s` times `{core}·ms/{request}` is `{core}·ms/s`, and that unit converts to `{core}`. `multiply` and `divide` do the same for two amounts, exactly for decimal inputs. A product refuses an absolute temperature and a level.
- **The atom above the slash.** `atomAbove(unit, base)` gives the one atom above the slash of a unit when its dimension is the base alone. Thus it gives `USD` for `USD/wk` with the base `money`, and undefined for `USD^2` or `USD·kg/lb`. It takes a parsed unit of any unit system, or a spelling.
- **Canonical spellings.** `unitSchema` and `quantitySchema` refuse an alias, and they give the spelling to write ("write h, not hr"). `canonicalUnit` reads the spellings of other systems, for example `kcal/hr·kg`, `mi/hr` and `dBASPL`.
- **No limit, and unknown.** A value with no limit is `{ "value": "infinite", "unit": "s" }` (`extentSchema`). A value that nobody can give has its reason (`unknownSchema`). A sound level averages by its energy (`mean`).
- **One way to print.** `format` and `formatDuration` print each amount: `$1,234.56`, `€42.50/MWh`, `12.50 CHF`, `72°F`, `410 ppm`, `8 mph`, `12 reps`, `1 h 30 min`. A currency without a symbol prints its code after the number.
- **Scales.** `formatOnScale` prints an amount in the unit of a scale that fits it: `1.5 KiB`, `3.5 ms`, `2 min 5 s`. A scale is data. `BYTES_1024`, `BYTES_1000` and `DURATION_MS` are three scales. The text shows the symbol of each unit, so 1024 bytes print as `KiB`, and `KB` is 1000 bytes.

`isQuantitySchema` tells if a schema is the schema of a quantity. A generator of SQL can then give the value and the unit a column each.

## Installation

```sh
pnpm add @mark1russell7/quantity
```

The root entry has the amounts, the units and the arithmetic. It does not import `zod`.

The schemas are in the entry `@mark1russell7/quantity/schema`. That entry uses `zod` as an optional peer dependency. The schemas of the package are then parts of the schemas of the application, with one copy of `zod`.

```sh
pnpm add @mark1russell7/quantity zod
```

The entry `@mark1russell7/quantity/time` has a smaller table: the times, the frequencies and the units with no dimension (`count`, `%`, `ppm`, `ppb`, `dBA`, `dB`). It converts these units exactly, as the root entry does. A bundle for a browser that converts only times and counts uses this entry. Its code is 3.8 kB smaller than the code of the full table before gzip, and 1.2 kB smaller after gzip. A unit outside the table, for example `m` or `USD`, gives a `UnitError`.

`unitSystem(atoms, spellings)` makes the functions of the units (`parseUnit`, `convertExact` and the others) over a table that you choose. `UNITS` is the system of the full table, and `TIME_UNITS` is the system of the entry of the times.

## Example

```ts
import { add, convert, format, quantity } from "@mark1russell7/quantity";
import { quantitySchema } from "@mark1russell7/quantity/schema";

const idle = quantity(7200, "s");
const probes = quantity(675, "s");
format(convert(add(idle, probes), "min")); // "131.25 min"

quantitySchema("time").parse({ value: 5, unit: "hr" }); // fails: write h, not hr
```

## Tests

`pnpm --filter @mark1russell7/quantity test` starts the tests. `pnpm --filter @mark1russell7/quantity build` writes the package for npm into `build/`.
