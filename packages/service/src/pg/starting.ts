import { STARTING_POLL } from "../client/core.ts";
import type { Poll } from "../timing.ts";
import type { PgKnobs } from "./client.ts";

/**
 * This poll is the poll of the checks that `PG_STARTING_KNOBS` fits. It is `STARTING_POLL` of the
 * core: each 5 s with a jitter of 20 %, and a timeout of 4 s (B6, O12). The poll does not depend on the driver.
 */
export const PG_STARTING_POLL: Poll = STARTING_POLL;

/**
 * These knobs are a declaration to start from, from what the cells of S1 measured on node-postgres
 * 8.23.1 against PostgreSQL 17.11. The runtime has no defaults: a service gives these knobs, or its
 * own. Each value holds the borders that the cells measured:
 * - `connect_bound` 5 s: at the defaults pg has no bound, and the kernel gives up on the SYNs only
 *   after 131 s. The timer of the pool fired 7 ms late at most. Thus 5 s is in a startup budget of 30 s (O15).
 * - `request_timeout` 9.5 s: the cells ended a query in a black hole at 9.503 s. That is in the slowest poll of 10 s (O13).
 * - `statement_timeout` 9 s: below `request_timeout`, thus the server ends a slow statement first,
 *   with ERROR 57014 (O07). The cells measured that end 2 ms after the deadline.
 * - `pool_idle_expiry` 10 s: the idle timer of pg-pool at its defaults, measured at 10.004 s. It is
 *   below a router that forgets an idle flow at 12 s (O03), and below a `client_idle_timeout` of PgBouncer at 12 s (O01).
 * - `keepalive_idle` 30 s: at the defaults pg has no keepalive. This value refreshes a held idle
 *   connection through the NAT forms of the cells (240 s and 350 s).
 * - `max_connection_age` "infinite": no cell measured an age, thus the declaration gives none.
 * - `close_bound` 2 s: behind a black hole the end of the pool waits with no bound. The cells saw
 *   the pool emit `remove` only when the socket closes.
 * - `retrans_giveup_time` 924.6 s: the give-up of Linux at `tcp_retries2 = 15`. The cells measured 3.120 s at `tcp_retries2 = 3`.
 */
export const PG_STARTING_KNOBS: PgKnobs = {
  connect_bound: { value: 5, unit: "s" },
  request_timeout: { value: 9.5, unit: "s" },
  statement_timeout: { value: 9, unit: "s" },
  pool_idle_expiry: { value: 10, unit: "s" },
  keepalive_idle: { value: 30, unit: "s" },
  max_connection_age: { value: "infinite", unit: "s" },
  close_bound: { value: 2, unit: "s" },
  retrans_giveup_time: { value: 924.6, unit: "s" },
};
