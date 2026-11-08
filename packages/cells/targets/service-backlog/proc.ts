// The reads of the queue from the text of the kernel. These functions are pure, thus a test reads
// them on samples of each text (packages/cells/src/accept-queue.test.ts).
//
// - The count. /proc/net/tcp gives the count of the queue of a listener as its rx_queue: the
//   field sk_ack_backlog (net/ipv4/tcp_ipv4.c of Linux v7.0, lines 2880-2881).
// - The limit. inet_diag gives the limit as idiag_wqueue: the field sk_max_ack_backlog
//   (net/ipv4/tcp_diag.c, lines 27-28). `ss` of iproute2 shows it as the Send-Q of the listener.
// - The counters. /proc/net/netstat gives the counters of the namespace, as the native target reads them.

/** These are the counters of the namespace that a record of the queue keeps. A type, not an interface, fits a line of JSON. */
export type Counters = {
  readonly overflows: number;
  readonly drops: number;
  readonly cookies: number;
  readonly timeouts: number;
  readonly resets: number;
};

/** These are the names of the counters in the lines `TcpExt:` of /proc/net/netstat. */
const NAMES: Readonly<Record<string, keyof Counters>> = {
  ListenOverflows: "overflows",
  ListenDrops: "drops",
  TCPReqQFullDoCookies: "cookies",
  TCPTimeouts: "timeouts",
  EmbryonicRsts: "resets",
};

/** The state LISTEN in /proc/net/tcp. */
const LISTEN = "0A";

/** This function gives the local address of a listener on 0.0.0.0 in /proc/net/tcp: the port is in hexadecimal. */
export const localOf = (port: number): string => `00000000:${port.toString(16).toUpperCase().padStart(4, "0")}`;

/** This function gives the count of the queue of the listener on `port`, or undefined when no listener is open. */
export const countIn = (tcp: string, port: number): number | undefined => {
  const local = localOf(port);
  for (const line of tcp.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const queues = fields[4]?.split(":");
    if (fields[1] === local && fields[3] === LISTEN && queues?.[1] !== undefined) return Number.parseInt(queues[1], 16);
  }
  return undefined;
};

/** This function gives the limit of the queue from the output of `ss -Hltn`, or undefined when no listener is open. */
export const limitIn = (ss: string): number | undefined => {
  const fields = ss.trim().split(/\s+/);
  return fields[0] === "LISTEN" && fields[2] !== undefined ? Number(fields[2]) : undefined;
};

/** This function reads the counters from the text of /proc/net/netstat: a line of names, then a line of values. */
export const countersIn = (netstat: string): Counters => {
  const found = { overflows: 0, drops: 0, cookies: 0, timeouts: 0, resets: 0 };
  const lines = netstat.split("\n");
  for (let at = 0; at + 1 < lines.length; at += 2) {
    const head = lines[at] ?? "";
    if (!head.startsWith("TcpExt:")) continue;
    const keys = head.trim().split(/\s+/);
    const values = (lines[at + 1] ?? "").trim().split(/\s+/);
    keys.forEach((key, index) => {
      const name = NAMES[key];
      if (name !== undefined) found[name] = Number(values[index]);
    });
  }
  return found;
};
