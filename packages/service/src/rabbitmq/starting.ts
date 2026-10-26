import { STARTING_POLL } from "../client/core.ts";
import type { Poll } from "../timing.ts";
import type { RabbitKnobs } from "./client.ts";

/**
 * This poll is the poll of the checks that `RABBIT_STARTING_KNOBS` fits. It is `STARTING_POLL` of
 * the core: each 5 s with a jitter of 20 %, and a timeout of 4 s (B6, O12). The poll does not depend on the driver.
 */
export const RABBIT_STARTING_POLL: Poll = STARTING_POLL;

/**
 * These knobs are a declaration to start from, from what the cells of R3 measured on amqplib 2.2.0
 * against RabbitMQ 4.3.6. The runtime has no defaults: a service gives these knobs, or its own.
 * Each value holds the borders that the cells measured:
 * - `connect_bound` 5 s: the connect timeout of DP44. The timer stops when the connection opens.
 *   Thus it does not change a fault with a call in flight. At its defaults, amqplib has no connect timeout.
 * - `request_timeout` 9.5 s: in the slowest poll of 10 s (O13). After a loss of the leader of a quorum
 *   queue, the first confirm came at 6.61 s, 6.68 s and 8.05 s (T11). A later confirm is indeterminate, not lost.
 * - `heartbeat_interval` 15 s: the heartbeat ended a silent connection 45.009 s after the last data,
 *   before the kernel gave up at 53.016 s (O17). The frames each 7.5 s keep a flow through a router
 *   that forgets it at 30 s (O03). At the 60 s of the broker, the heartbeat came at 180.009 s.
 * - `retry_base` 1 s: the cells connected to the next node 1 s after the end of a connection.
 * - `retry_cap` 8 s: no cell measured it. With its jitter of 1 s, the most delay is 9 s, in the slowest poll of 10 s.
 * - `keepalive_idle` "infinite": amqplib sets no keepalive, and the heartbeat refreshes an idle flow.
 *   Linux sends no keepalive probe while data is in flight.
 * - `max_connection_age` "infinite": the client does not replace its connection at an age.
 * - `close_bound` 2 s: behind a black hole, `connection.close` waits for its close-ok with no bound.
 * - `retrans_giveup_time` 924.6 s: the give-up of Linux at `tcp_retries2 = 15`.
 */
export const RABBIT_STARTING_KNOBS: RabbitKnobs = {
  connect_bound: { value: 5, unit: "s" },
  request_timeout: { value: 9.5, unit: "s" },
  heartbeat_interval: { value: 15, unit: "s" },
  retry_base: { value: 1, unit: "s" },
  retry_cap: { value: 8, unit: "s" },
  keepalive_idle: { value: "infinite", unit: "s" },
  max_connection_age: { value: "infinite", unit: "s" },
  close_bound: { value: 2, unit: "s" },
  retrans_giveup_time: { value: 924.6, unit: "s" },
};
