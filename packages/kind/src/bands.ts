import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Band } from "./cell.ts";

/** This module makes and prints the bands of the predictions. It imports only the amounts. */

/** This function gives a time in seconds as a quantity. */
export const seconds = (value: number): Quantity => ({ value, unit: "s" });

/** This function gives a band from its two ends in seconds. */
export const bandOf = (lo: number, hi: number): Band => ({ lo: seconds(lo), hi: seconds(hi) });

/** This function gives the two ends of a band as numbers of seconds, for arithmetic. */
export const secondsOf = (band: Band): { readonly lo: number; readonly hi: number } => ({
  lo: valueIn(band.lo, "s"),
  hi: valueIn(band.hi, "s"),
});

/** This function gives a band in a short form for a name or a table: `[28, 49] s`. */
export const showBand = (band: Band): string => {
  const { lo, hi } = secondsOf(band);
  return `[${lo}, ${hi}] s`;
};
