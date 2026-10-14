import type { Expr, Manifestation } from "@mark1russell7/algebra";

/** These are the knobs that the models of the retransmission timer read, by their names in the Linux TCP document. */
const WAIT_KNOBS = ["fired", "tcp_rto_min", "tcp_rto_max", "rtt", "hz"];
const STEP_KNOBS = ["tcp_retries2", "tcp_rto_min", "tcp_rto_max", "rtt", "hz"];
const model = (name: string, knobs: readonly string[]): Expr => ({ model: name, knobs: [...knobs], unit: "s" });

/**
 * These replacements tell how an ICMP host or net unreachable for each retransmission changes the
 * timers of Linux TCP. The revert of RFC 6069 (tcp_ld_RTO_revert) takes back the doubling of the
 * backoff for each one. Thus each wait is one RTO, and the give-up comes at most one RTO after its
 * budget. The budget itself does not change (retransmits_timed_out reads tcp_model_timeout).
 */
const REVERTED: Manifestation["replaces"] = {
  retransmit: { duration: model("linux.rto-wait-reverted", WAIT_KNOBS) },
  retrans_giveup: { lateness: model("linux.retrans-step-reverted", STEP_KNOBS) },
};

/**
 * This function gives the soft error of an ICMP: the timers whose give-up reports it. Only a
 * segment in the window draws an ICMP that counts (tcp_v4_err): a retransmission does. A keepalive
 * probe has the sequence number before snd_una, thus keepalive gives up with ETIMEDOUT.
 */
const soft = (errno: string) => ({ errno, timers: ["retrans_giveup", "user_timeout"] }) as const;

/**
 * These are the manifestations of the T01 cells, as Linux TCP at the observer meets them. Each
 * tells what continues to arrive (`passes`) and what the failure sends one time (`delivers`). It
 * also tells the errno that replaces a timeout (`errno`), and the durations that it changes
 * (`replaces`).
 *
 * The ICMP cells set the ICMP rate limit of the sender of the ICMP to 0, thus each retransmission
 * draws one ICMP. With the default limit of 1000 ms, only some retransmissions are reverted.
 */
export const MANIFESTATIONS = {
  blackhole: { name: "blackhole", passes: [] },
  "freeze-process": { name: "freeze-process", passes: ["rx.ack"] },
  "unreachable-host": {
    name: "unreachable-host",
    passes: [],
    errno: soft("EHOSTUNREACH"),
    replaces: REVERTED,
  },
  "unreachable-net": {
    name: "unreachable-net",
    passes: [],
    errno: soft("ENETUNREACH"),
    replaces: REVERTED,
  },
  // port unreachable and admin prohibited do not revert the backoff: only codes 0 and 1 do
  "unreachable-port": { name: "unreachable-port", passes: [], errno: soft("ECONNREFUSED") },
  "unreachable-admin": { name: "unreachable-admin", passes: [], errno: soft("EHOSTUNREACH") },
  // in one direction or the other, nothing that the observer can use comes back
  "simplex-to-server": { name: "simplex-to-server", passes: [] },
  "simplex-to-client": { name: "simplex-to-client", passes: [] },
  // the kernel of a killed process closes its socket with a FIN, when nothing unread is in its queue
  fin: { name: "fin", passes: [], delivers: ["rx.fin"] },
  // the long segments drop, and the receiver acknowledges nothing new
  "mtu-blackhole": { name: "mtu-blackhole", passes: [] },
} as const satisfies Readonly<Record<string, Manifestation>>;

/** A manifestation name is the name of one manifestation of the T01 cells. */
export type ManifestationName = keyof typeof MANIFESTATIONS;
