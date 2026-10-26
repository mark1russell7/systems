import type { Detector, Meeting } from "../client/meets.ts";
import { WHAT, immediate, keepaliveAnswered, keepaliveReset, keepaliveSilent, kernelGiveUp } from "../client/meets.ts";
import type { PgKnobs } from "./client.ts";

/**
 * This function gives the manifestations that a pg client can meet, and the detectors of each, from
 * its knobs. The cells of S1 measured each one on node-postgres 8.23.1:
 * - A reset of a query gives ECONNRESET in 0.6 ms, and a FIN to an idle client gives EOF in 18 µs.
 * - A frozen server and a black hole have no detector in 60 s at the defaults: pg has no timer on a query and no keepalive.
 * - `query_timeout` ends a query in a black hole on time (9.503 s for 9.5 s).
 * - `statement_timeout` ends a slow statement on the server with ERROR 57014 (10.002 s for 10 s).
 *
 * pg has no watchdog and does not test an idle client. In place of a watchdog, the pool ends an
 * idle client at its idle timer. A later checkout then opens a new connection, which `connect_bound` bounds.
 */
export const pgMeetings = (name: string, knobs: PgKnobs): Meeting[] => {
  const query: Detector = {
    by: "request_timeout",
    within: knobs.request_timeout,
    situation: "in flight",
    effect: `the query fails as indeterminate, and ${name} gives the client back with an error, thus the pool ends it`,
  };
  const idleExpiry: Detector = {
    by: "pool_idle_expiry",
    within: knobs.pool_idle_expiry,
    situation: "idle",
    effect: "the pool ends the idle client, thus no checkout gets the dead connection",
  };
  const giveUp = kernelGiveUp(knobs.retrans_giveup_time, "the query fails with its error");
  const silent = (manifestation: "blackhole" | "freeze-host"): Meeting => ({
    manifestation,
    what: WHAT[manifestation],
    detectors: [query, giveUp, idleExpiry, keepaliveSilent(knobs.keepalive_idle)],
  });
  return [
    {
      manifestation: "rst",
      what: WHAT.rst,
      detectors: [
        immediate("in flight", "the query fails with ECONNRESET, and each new connect is refused"),
        idleExpiry,
        keepaliveReset(knobs.keepalive_idle),
      ],
    },
    {
      manifestation: "fin",
      what: WHAT.fin,
      detectors: [
        immediate("in flight", "the query fails: 'Connection terminated unexpectedly'"),
        immediate("idle", "the pool removes the idle client, and emits error"),
      ],
    },
    silent("blackhole"),
    silent("freeze-host"),
    {
      manifestation: "freeze-process",
      what: WHAT["freeze-process"],
      detectors: [query, idleExpiry, keepaliveAnswered()],
    },
    {
      manifestation: "app-stall",
      what: "the server stops its replies for a time, for example behind a lock, and its kernel stays up",
      detectors: [
        {
          by: "statement_timeout",
          within: knobs.statement_timeout,
          situation: "in flight",
          effect: "the server ends the statement with ERROR 57014, a certain outcome, and the client stays",
        },
        query,
        idleExpiry,
        keepaliveAnswered(),
      ],
    },
  ];
};
