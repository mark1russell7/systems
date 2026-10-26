import { STARTING_POLL } from "../client/core.ts";
import type { Poll } from "../timing.ts";
import type { GrpcKnobs } from "./client.ts";

/**
 * This poll is the poll of the checks that `GRPC_CLIENT_STARTING_KNOBS` fits. It is `STARTING_POLL` of
 * the core: each 5 s with a jitter of 20 %, and a timeout of 4 s (B6, O12). The poll does not depend on the driver.
 */
export const GRPC_CLIENT_STARTING_POLL: Poll = STARTING_POLL;

/**
 * This value tells if the keepalive sends a PING with no call in flight, to start from: false. The
 * grpc-go server refuses such a PING at its defaults (`PermitWithoutStream` false). It answers with GOAWAY too_many_pings (O26).
 */
export const GRPC_CLIENT_STARTING_WITHOUT_CALLS = false;

/**
 * These knobs are a declaration to start from, from what the gRPC cells measured on grpc-js 1.14.6.
 * The runtime has no defaults: a service gives these knobs, or its own. Each value holds the borders that the cells measured:
 * - `connect_bound` 5 s: the connect timeout of DP44. The grpc-js driver has no connect timeout, thus this bounds the wait of the startup.
 * - `request_timeout` 9.5 s: in the slowest poll of 10 s (O13). In DP44 a deadline of 4 s ended each
 *   call at 4.003 s to 4.004 s. The race of the two deadlines gave CANCELLED to 2 to 4 calls of 11.
 * - `keepalive_time` 300 s and `keepalive_timeout` 20 s: DP24. The PING must not come before the
 *   `MinTime` of the server, 5 min at the defaults of grpc-go (O26). The transport ended at 320.005 s.
 *   Against etcd, with a `MinTime` of 5 s, 60 s ended it at 80.012 s. A PING each 4 s against 5 s got GOAWAY at the 4th PING.
 * - `server_keepalive_min_time` 300 s: the `MinTime` of grpc-go v1.84.0 at its defaults.
 * - `client_idle_timeout` 60 s and `server_idle_close` 75 s: the proxies of the cells sent GOAWAY to an idle connection.
 *   They did that at 75 s (nginx), 180 s (Traefik), 300 s (Caddy) and 1 h (Envoy). The client closes first (O01).
 *   The default of grpc-js is 30 min.
 * - `retry_base` 1 s: the first backoff of grpc-js in T07, with no jitter. `retry_cap` 4 s: the most
 *   delay is 4.8 s with the jitter of 20 %, in the slowest poll of 10 s. The default of grpc-js is 120 s.
 * - `keepalive_idle` "infinite": grpc-js sets no TCP keepalive, and the PING is its keepalive.
 * - `max_connection_age` "infinite": the client does not replace its connection at an age.
 * - `close_bound` 2 s: the calls in flight, then RST_STREAM CANCEL for each call that stays.
 * - `retrans_giveup_time` 924.6 s: the give-up of Linux at `tcp_retries2 = 15`.
 */
export const GRPC_CLIENT_STARTING_KNOBS: GrpcKnobs = {
  connect_bound: { value: 5, unit: "s" },
  request_timeout: { value: 9.5, unit: "s" },
  keepalive_time: { value: 300, unit: "s" },
  keepalive_timeout: { value: 20, unit: "s" },
  server_keepalive_min_time: { value: 300, unit: "s" },
  client_idle_timeout: { value: 60, unit: "s" },
  server_idle_close: { value: 75, unit: "s" },
  retry_base: { value: 1, unit: "s" },
  retry_cap: { value: 4, unit: "s" },
  keepalive_idle: { value: "infinite", unit: "s" },
  max_connection_age: { value: "infinite", unit: "s" },
  close_bound: { value: 2, unit: "s" },
  retrans_giveup_time: { value: 924.6, unit: "s" },
};
