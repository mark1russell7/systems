import type { BacklogTerm } from "@mark1russell7/kind";
import { WORKERS, ms } from "./kind.ts";

/**
 * These are the backlog terms of C in the stall. The cells of `backlog.ts` test them, and the stall cells
 * of C in `callers.ts` use the term of SYS-45. The module `backlog.ts` imports `callers.ts`. Thus the
 * terms are in this module, and the two modules import them from here.
 */

/** This count is the sessions of each client. Three clients have 6, thus the cell with 6 sessions on the target has each session there. */
export const BACKLOG_CONNECTIONS = 2;

/**
 * The backlog band of SYS-42 is the second band of the stall of C. The first band stays as
 * committed. The cells of SYS-40 found two biases of the first band.
 *
 * - The drain of a session after the resume is 10 ms to 45 ms (a fit gave approximately 26 ms), not
 *   40 ms to 70 ms. The overshoot is linear in n.
 * - The failed requests come from the measured period of the clients, not from `every`. The timer of
 *   a client of 10 ms fired each 10.10 ms to 10.26 ms. Thus the band counts from the mean period
 *   of the run, not from its median. The mean period is `period` of the facts (SYS-41).
 *
 * The term is in the window of the cell (`backlog`), thus the judge applies it to each run. The value
 * n is the sessions on the target at the fault (`sessions` of the facts), not the placement.
 */
export const BACKLOG_TERM: BacklogTerm = { drain: { lo: ms(10), hi: ms(45) }, requests: { lo: 0, hi: 3 }, most: (WORKERS + 1) * BACKLOG_CONNECTIONS };

/**
 * The drain band of SYS-43 is the third band of the stall of C. The first two bands stay as committed.
 * The cells of SYS-42 found one bias of the second band: the count was high, in each run with 6
 * sessions. The window band held in 19 of 20 runs.
 *
 * The second band did not have this term: a session fails a request each turn until the window
 * closes. The window closes up to n × d.hi after the band end. Thus each session fails 0 to
 * ceil(n × d.hi / turn) more requests in the drain, and the total grows as n² × d / turn. The turn
 * is c × p: the kept connections of a client times the mean period of the run. The values d and r
 * are the values of SYS-42. They are not fitted again.
 */
export const BACKLOG_DRAIN_TERM: BacklogTerm = { ...BACKLOG_TERM, drains: true };

/**
 * The terms band of SYS-45 is the fourth band of the stall of C. The first three bands stay as committed.
 * In SYS-42 and SYS-43, the window band missed 4 runs, each with 1 session. One was below n × d.lo
 * (9 ms), and 3 were above n × d.hi (50 ms, 58 ms and 90 ms). The signs differ, thus they are not a bias.
 * This band tests two terms.
 *
 * - The early start (`early`): the last failed request can start up to one turn before the window
 *   closes. The end band of the judge opens one turn before the band end, but the overshoot band
 *   of SYS-42 opened at n × d.lo. Thus its low end goes down by one turn, 20 ms at the setting.
 * - The slow session (`slowest`): one session can drain for more than d.hi. With n sessions, the
 *   other sessions average it out, thus it shows best with 1 session. The largest drain of one session
 *   was 90 ms in 15 runs with 1 session, in SYS-40, SYS-42 and SYS-43. The term rounds it up to 100 ms.
 *
 * The values d and r stay as in SYS-42. The cells have 1 and 2 sessions on the target, because the
 * zones of the two terms are largest there, and 10 runs each.
 */
export const BACKLOG_TERMS_TERM: BacklogTerm = { ...BACKLOG_DRAIN_TERM, slowest: ms(100), early: true };
