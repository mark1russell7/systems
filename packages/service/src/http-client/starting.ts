import { STARTING_POLL } from "../client/core.ts";
import type { Poll } from "../timing.ts";
import type { HttpClientKnobs } from "./client.ts";

/**
 * This poll is the poll of the checks that `HTTP_CLIENT_STARTING_KNOBS` fits. It is `STARTING_POLL` of
 * the core: each 5 s with a jitter of 20 %, and a timeout of 4 s (B6, O12). The poll does not depend on the driver.
 */
export const HTTP_CLIENT_STARTING_POLL: Poll = STARTING_POLL;

/**
 * These knobs are a declaration to start from. They come from what the HTTP cells measured on the
 * agent of Node 24.21.0 against a Node server at its defaults. The runtime has no defaults: a service gives
 * these knobs, or its own. Each value holds the borders that the cells measured:
 * - `connect_bound` 5 s: the connect timeout of DP44. The agent has no connect timer.
 * - `request_timeout` 9.5 s: in the slowest poll of 10 s (O13). The agent has no timer of a call.
 *   A frozen server held the call of undici until its headersTimeout, at 10.187 s.
 * - `pool_idle_expiry` 4 s: the free socket timer. The agent then closes a free socket at 4 s, the
 *   hint of 5 s less `hint_buffer`. That is below the idle close of the server.
 * - `hint_buffer` 1 s: the default of the agent.
 * - `server_idle_close` 6 s: a Node server closes an idle connection at its `keepAliveTimeout` of 5 s
 *   plus its buffer of 1 s. The cells measured 6.0003 s. O01 then has a margin of 2 s.
 * - `keepalive_idle` 1 s: the default of the agent. Node truncates it to whole seconds.
 * - `max_connection_age` "infinite": the agent does not replace a connection at an age.
 * - `close_bound` 2 s: a call in flight behind a black hole holds its socket with no bound.
 * - `retrans_giveup_time` 924.6 s: the give-up of Linux at `tcp_retries2 = 15`.
 */
export const HTTP_CLIENT_STARTING_KNOBS: HttpClientKnobs = {
  connect_bound: { value: 5, unit: "s" },
  request_timeout: { value: 9.5, unit: "s" },
  pool_idle_expiry: { value: 4, unit: "s" },
  hint_buffer: { value: 1, unit: "s" },
  server_idle_close: { value: 6, unit: "s" },
  keepalive_idle: { value: 1, unit: "s" },
  max_connection_age: { value: "infinite", unit: "s" },
  close_bound: { value: 2, unit: "s" },
  retrans_giveup_time: { value: 924.6, unit: "s" },
};
