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
 * This function gives the largest time after the band end at which the window of n sessions closes,
 * in seconds. Each session drains in d, thus it is n × d.hi. With `slowest` (SYS-45), one of the n
 * sessions can drain up to that time, thus it is (n − 1) × d.hi + the larger of `slowest` and d.hi.
 */
const closingOf = (term: Pick<BacklogTerm, "drain"> & Partial<Pick<BacklogTerm, "slowest">>, sessions: number): number => {
  const hi = valueIn(term.drain.hi, "s");
  if (term.slowest === undefined || sessions < 1) return sessions * hi;
  return (sessions - 1) * hi + Math.max(valueIn(term.slowest, "s"), hi);
};

/**
 * This function gives the end band of a window with the backlog term (`BacklogTerm`). It adds n × d
 * to each end of `end`, the end band without the term. The value n is the sessions on the target.
 * A term with `slowest` (SYS-45) adds (n − 1) × d.hi + `slowest` to the high end instead.
 */
export const backlogEnd = (end: Band, term: Pick<BacklogTerm, "drain"> & Partial<Pick<BacklogTerm, "slowest">>, sessions: number): Band => {
  const ends = secondsOf(end);
  const drain = secondsOf(term.drain);
  return bandOf(us(ends.lo + sessions * drain.lo), us(ends.hi + closingOf(term, sessions)));
};

/**
 * This function gives the band of the start of the last failed request of a window with the backlog
 * term, from the band end (the high end of `end`). This is the overshoot of a run. Its high end is
 * the high end of `backlogEnd`. Without `early`, its low end is n × d.lo (SYS-42). With `early`
 * (SYS-45), the last failed request can start up to one turn before the window closes. Thus its low end
 * is the low end of `end` plus n × d.lo: one turn less, because the end band opens one turn before the band end.
 */
export const overshootBand = (end: Band, term: Pick<BacklogTerm, "drain"> & Partial<Pick<BacklogTerm, "slowest" | "early">>, sessions: number): Band => {
  const ends = secondsOf(end);
  const closes = secondsOf(backlogEnd(end, term, sessions));
  const drain = secondsOf(term.drain);
  const lo = term.early === true ? closes.lo - ends.hi : sessions * drain.lo;
  return bandOf(us(lo), us(closes.hi - ends.hi));
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
 * (`connections`). The term r is not in this band. With `slowest` (SYS-45), the window closes up to
 * (n − 1) × d.hi + `slowest` after the band end, thus one session fails up to that time over the turn.
 */
export const drainBand = (term: Pick<BacklogTerm, "drain"> & Partial<Pick<BacklogTerm, "slowest">>, mean: Quantity, connections: number, sessions: number): CountBand => {
  const turn = turnOf(mean, connections);
  return { lo: 0, hi: Math.ceil(counted(closingOf(term, sessions) / turn)) };
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
  term: Pick<BacklogTerm, "requests"> & Partial<Pick<BacklogTerm, "drain" | "drains" | "slowest">>,
  span: Quantity,
  mean: Quantity,
  connections: number,
  sessions: number,
): CountBand => {
  const turn = turnOf(mean, connections);
  const each = counted(valueIn(span, "s") / turn);
  if (term.drains === true && term.drain === undefined) throw new RangeError("a term with drains has no drain time d");
  const drained = term.drains === true ? drainBand({ drain: term.drain!, slowest: term.slowest }, mean, connections, sessions) : { lo: 0, hi: 0 };
  return { lo: sessions * (Math.floor(each) - 1 + term.requests.lo + drained.lo), hi: sessions * (Math.ceil(each) + 1 + term.requests.hi + drained.hi) };
};
