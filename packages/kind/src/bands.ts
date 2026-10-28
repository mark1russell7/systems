import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { BacklogTerm, Band } from "./cell.ts";

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

/** This function rounds a time to the microsecond, thus a band has no float residue. */
const us = (value: number): number => Math.round(value * 1e6) / 1e6;

/**
 * This function gives the end band of a window with the backlog term (`BacklogTerm`). It adds n × d
 * to each end of `end`, the end band without the term. The value n is the sessions on the target.
 */
export const backlogEnd = (end: Band, term: Pick<BacklogTerm, "drain">, sessions: number): Band => {
  const ends = secondsOf(end);
  const drain = secondsOf(term.drain);
  return bandOf(us(ends.lo + sessions * drain.lo), us(ends.hi + sessions * drain.hi));
};

/** A count band is a range of counts of requests. */
export interface CountBand {
  readonly lo: number;
  readonly hi: number;
}

/** This function gives a count rounded to six places, thus 10 s / 20 ms gives 500 and not 499.99999. */
const counted = (value: number): number => Math.round(value * 1e6) / 1e6;

/** This function gives the turn of a session in seconds: the mean period of a client times its sessions. */
const turnOf = (mean: Quantity, connections: number): number => {
  const turn = valueIn(mean, "s") * connections;
  if (!(turn > 0)) throw new RangeError(`a turn of ${turn} s cannot count requests`);
  return turn;
};

/**
 * This function gives the drain failures of one session on the target (SYS-43). A session fails a
 * request each turn until the window closes. With n sessions on the target, the window closes up to
 * n × d.hi after the band end (`backlogEnd`). Thus one session fails 0 to ceil(n × d.hi / turn)
 * requests in the drain. The turn is the mean period of a client (`mean`) times its sessions
 * (`connections`). The term r is not in this band.
 */
export const drainBand = (term: Pick<BacklogTerm, "drain">, mean: Quantity, connections: number, sessions: number): CountBand => {
  const turn = turnOf(mean, connections);
  return { lo: 0, hi: Math.ceil(counted((sessions * valueIn(term.drain.hi, "s")) / turn)) };
};

/**
 * This function gives the failed requests that the backlog term predicts (`BacklogTerm`). Each of
 * the n sessions on the target gets a request each turn. The turn is the measured mean period of a
 * client (`mean`) times the sessions of the client (`connections`). The requests of a session fail
 * from the start of the window to the band end (`span`). That span holds `span / turn` requests, one
 * less at its low edge and one more at its high edge. Each session fails r more requests in its drain time.
 *
 * A term with `drains` (SYS-43) also adds the drain failures of each session (`drainBand`).
 */
export const requestBand = (
  term: Pick<BacklogTerm, "requests"> & Partial<Pick<BacklogTerm, "drain" | "drains">>,
  span: Quantity,
  mean: Quantity,
  connections: number,
  sessions: number,
): CountBand => {
  const turn = turnOf(mean, connections);
  const each = counted(valueIn(span, "s") / turn);
  if (term.drains === true && term.drain === undefined) throw new RangeError("a term with drains has no drain time d");
  const drained = term.drains === true ? drainBand({ drain: term.drain! }, mean, connections, sessions) : { lo: 0, hi: 0 };
  return { lo: sessions * (Math.floor(each) - 1 + term.requests.lo + drained.lo), hi: sessions * (Math.ceil(each) + 1 + term.requests.hi + drained.hi) };
};
