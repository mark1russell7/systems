import { STARTING_POLL } from "../client/core.ts";
import type { Poll } from "../timing.ts";
import type { WsKnobs } from "./client.ts";

/**
 * This poll is the poll of the checks that `WS_CLIENT_STARTING_KNOBS` fits. It is `STARTING_POLL` of
 * the core: each 5 s with a jitter of 20 %, and a timeout of 4 s (B6, O12). The poll does not depend on the driver.
 */
export const WS_CLIENT_STARTING_POLL: Poll = STARTING_POLL;

/** This count is the heartbeat misses to start from: 1, as in the WS cells. The drop came 0.999 s to 1.0035 s after the ping with no pong. */
export const WS_CLIENT_STARTING_MISSES = 1;

/**
 * These knobs are a declaration to start from, from what the WS cells measured on ws 8. The runtime
 * has no defaults: a service gives these knobs, or its own. Each value holds the borders that the cells measured:
 * - `connect_bound` 5 s: the connect timeout of DP44. ws sets no handshake timeout by default.
 * - `request_timeout` 9.5 s: in the slowest poll of 10 s (O13).
 * - `heartbeat_interval` 4 s: in the WST cells, a ping each 4 s kept a flow through a router that
 *   forgets it at 5 s. A ping each 6 s did not (O03).
 * - `heartbeat_timeout` 3 s: a stall of 1 s with a pong timeout of 3 s dropped nothing. The detection is 4 s + 3 s = 7 s.
 * - `retry_base` 0.5 s and `retry_cap` 4 s: the reconnect of the cells, from 500 ms, doubling to 4 s.
 *   The client adds a jitter up to the base. Thus the most delay is 4.5 s, in the slowest poll of 10 s.
 * - `keepalive_idle` "infinite": ws sets no keepalive, and the heartbeat refreshes an idle flow.
 * - `max_connection_age` "infinite": the client does not replace its connection at an age.
 * - `close_bound` 2 s: a close frame to a silent server gets no answer. The `closeTimeout` of ws is 30 s.
 * - `retrans_giveup_time` 924.6 s: the give-up of Linux at `tcp_retries2 = 15`.
 */
export const WS_CLIENT_STARTING_KNOBS: WsKnobs = {
  connect_bound: { value: 5, unit: "s" },
  request_timeout: { value: 9.5, unit: "s" },
  heartbeat_interval: { value: 4, unit: "s" },
  heartbeat_timeout: { value: 3, unit: "s" },
  retry_base: { value: 0.5, unit: "s" },
  retry_cap: { value: 4, unit: "s" },
  keepalive_idle: { value: "infinite", unit: "s" },
  max_connection_age: { value: "infinite", unit: "s" },
  close_bound: { value: 2, unit: "s" },
  retrans_giveup_time: { value: 924.6, unit: "s" },
};
