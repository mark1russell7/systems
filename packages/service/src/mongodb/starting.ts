import { STARTING_POLL } from "../client/core.ts";
import type { Poll } from "../timing.ts";
import type { MongoKnobs } from "./client.ts";

/**
 * This poll is the poll of the checks that `MONGO_STARTING_KNOBS` fits. It is `STARTING_POLL` of
 * the core: each 5 s with a jitter of 20 %, and a timeout of 4 s (B6, O12). The poll does not depend on the driver.
 */
export const MONGO_STARTING_POLL: Poll = STARTING_POLL;

/**
 * These knobs are a declaration to start from, from what the cells of S1 measured on the driver
 * 7.7.0 on Node 24.21.0 against mongod 9.0.4. The runtime has no defaults: a service gives these
 * knobs, or its own. Each value holds the borders that the cells measured:
 * - `connect_bound` 5 s and `heartbeat_interval` 2 s: the write-off of a silent server came 7 s after
 *   its last answer, and the cells T01.border-off.75 and .76 held. At the defaults it came at 40.002 s.
 * - `request_timeout` 9.5 s: in the slowest poll of 10 s (O13). At the defaults the driver has no
 *   bound on a read, and only the write-off ends the command.
 * - `statement_timeout` 9 s: below `request_timeout`, thus the server ends a slow command first,
 *   with error 50 (O07).
 * - `client_retry_window` 30 s: after an election, the first write took 17 s to 18 s, and the band
 *   ended at 26.58 s (T11.defaults.10). The default of the driver, 30 s, holds that band.
 * - `checkout_timeout` 5 s: a full pool fails a checkout in a startup budget. At the defaults the wait has no bound.
 * - `pool_idle_expiry` 10 s: no cell measured it. It is the bound of O03 and O01 that the pg client
 *   uses: below a router that forgets an idle flow at 12 s. The driver applies it at the next checkout.
 * - `keepalive_idle` 30 s: the driver always turns keepalive on, at 120 s by default. This value
 *   refreshes a held idle connection through the NAT forms of the cells (240 s and 350 s).
 * - `max_connection_age` "infinite": the driver has no age for a connection.
 * - `close_bound` 2 s: behind a black hole the close of the driver waits for `endSessions`.
 * - `retrans_giveup_time` 924.6 s: the give-up of Linux at `tcp_retries2 = 15`. The cells measured 12.936 s at `tcp_retries2 = 5`.
 */
export const MONGO_STARTING_KNOBS: MongoKnobs = {
  connect_bound: { value: 5, unit: "s" },
  request_timeout: { value: 9.5, unit: "s" },
  statement_timeout: { value: 9, unit: "s" },
  heartbeat_interval: { value: 2, unit: "s" },
  client_retry_window: { value: 30, unit: "s" },
  checkout_timeout: { value: 5, unit: "s" },
  pool_idle_expiry: { value: 10, unit: "s" },
  keepalive_idle: { value: 30, unit: "s" },
  max_connection_age: { value: "infinite", unit: "s" },
  close_bound: { value: 2, unit: "s" },
  retrans_giveup_time: { value: 924.6, unit: "s" },
};
