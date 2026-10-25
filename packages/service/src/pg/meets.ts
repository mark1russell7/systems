import type { Extent, Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { Detector, Meeting, Situation } from "../client/meets.ts";
import type { PgKnobs } from "./client.ts";

const never: Extent = { value: "infinite", unit: "s" };
const s = (value: number): Quantity => quantity(Math.round(value * 1e6) / 1e6, "s");
const seconds = (amount: Extent): number =>
  amount.value === "infinite" ? Number.POSITIVE_INFINITY : valueIn(amount as Quantity, "s");
const plus = (amount: Extent, more: number): Extent => (amount.value === "infinite" ? never : s(seconds(amount) + more));

/** Node gives keepalive 10 probes, 1 s apart, after its idle time: a silent peer is found 10 s after the idle time. */
const NODE_PROBES = 10;
const NODE_INTERVAL = 1;

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
  const keepalive = plus(knobs.keepalive_idle, NODE_PROBES * NODE_INTERVAL);
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
  const giveUp: Detector = {
    by: "retrans_giveup_time",
    within: knobs.retrans_giveup_time,
    situation: "in flight",
    effect: "the kernel gives up the retransmissions and closes the socket, and the query fails with its error",
  };
  const immediate = (situation: Situation, effect: string): Detector => ({ by: "the next segment", within: s(0), situation, effect });
  const silent = (manifestation: string, what: string): Meeting => ({
    manifestation,
    what,
    detectors: [
      query,
      giveUp,
      idleExpiry,
      { by: "keepalive_idle", within: keepalive, situation: "idle", effect: "TCP keepalive gives up, and the socket closes" },
    ],
  });
  return [
    {
      manifestation: "rst",
      what: "the server answers each segment with a reset, and refuses each new connection",
      detectors: [
        immediate("in flight", "the query fails with ECONNRESET, and each new connect is refused"),
        idleExpiry,
        { by: "keepalive_idle", within: knobs.keepalive_idle, situation: "idle", effect: "the first probe gets a reset" },
      ],
    },
    {
      manifestation: "fin",
      what: "the process of the server ends, and its kernel closes the connection",
      detectors: [
        immediate("in flight", "the query fails: 'Connection terminated unexpectedly'"),
        immediate("idle", "the pool removes the idle client, and emits error"),
      ],
    },
    silent("blackhole", "the network drops each segment in the two directions"),
    silent("freeze-host", "the host of the server stops, without a close: the death without a close"),
    {
      manifestation: "freeze-process",
      what: "the process of the server stops, and its kernel stays up",
      detectors: [
        query,
        idleExpiry,
        { by: "keepalive_idle", within: never, situation: "idle", effect: "the kernel of the server answers each probe" },
      ],
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
        { by: "keepalive_idle", within: never, situation: "idle", effect: "the kernel of the server answers each probe" },
      ],
    },
  ];
};
