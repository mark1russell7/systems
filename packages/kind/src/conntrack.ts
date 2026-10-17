// The parser of the conntrack table of a node, for the flows to one ClusterIP. The agent of each
// node reads the table with it, and the image copies this file, thus it imports nothing.

/** An entry is one conntrack entry of a TCP flow to the ClusterIP. It has a state, a life in seconds, a client and the backend of its NAT. */
export interface ConntrackEntry {
  readonly state: string;
  readonly ttl: number;
  /** This address is the original source of the flow: the client, as `ip:port`. */
  readonly client: string;
  /** This address is the source of the replies: the backend that the DNAT of the entry chose, as `ip:port`. */
  readonly backend: string;
  /** This flag tells that no packet came back on the flow. */
  readonly unreplied: boolean;
}

/**
 * These states keep the NAT of an entry for a new SYN on the same port (nf_conntrack_proto_tcp.c at
 * v6.8). A SYN on an entry in TIME_WAIT removes the entry and looks up again (:1011-1027), thus that
 * SYN gets a backend from the rules. In each other state, the SYN goes to the backend of the entry.
 * A CLOSE that a reset from the server made does not reopen either.
 */
export const KEEPS_NAT: ReadonlySet<string> = new Set(["SYN_SENT", "SYN_SENT2", "SYN_RECV", "ESTABLISHED", "FIN_WAIT", "CLOSE_WAIT", "LAST_ACK", "CLOSE"]);

/** This form is one TCP line of `/proc/net/nf_conntrack`: its timeout and state, the original tuple, its flags and counters, then the reply tuple. */
const LINE = /\btcp\s+\d+\s+(\d+)\s+(\S+)\s+src=(\S+) dst=(\S+) sport=(\d+) dport=(\d+)(.*?)\bsrc=(\S+) dst=\S+ sport=(\d+) dport=\d+/;

/** This function gives the TCP entries of a dump of `/proc/net/nf_conntrack` whose original destination is the ClusterIP and port. */
export const entriesOf = (text: string, ip: string, port: number): ConntrackEntry[] => {
  const out: ConntrackEntry[] = [];
  for (const line of text.split("\n")) {
    const match = LINE.exec(line);
    if (match === null || match[4] !== ip || Number(match[6]) !== port) continue;
    out.push({
      ttl: Number(match[1]),
      state: match[2]!,
      client: `${match[3]}:${match[5]}`,
      backend: `${match[8]}:${match[9]}`,
      unreplied: match[7]!.includes("[UNREPLIED]"),
    });
  }
  return out;
};

/**
 * This function gives the entries that keep their NAT to a pod that is not a backend of the rules.
 * A new SYN from the client port of such an entry goes to that pod, whatever the rules say.
 */
export const staleOf = (entries: readonly ConntrackEntry[], backends: readonly string[]): ConntrackEntry[] =>
  entries.filter((entry) => KEEPS_NAT.has(entry.state) && !backends.includes(entry.backend));
