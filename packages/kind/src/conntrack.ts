// The parser of the conntrack table of a node. The agent of each node reads the table with it, and
// the image copies this file, thus it imports nothing.

/** A flow is one conntrack entry of TCP: its state, its life in seconds, its original tuple and the source of its replies. */
export interface ConntrackFlow {
  readonly state: string;
  readonly ttl: number;
  /** This address is the original source of the flow, as `ip:port`. */
  readonly from: string;
  /** This address is the original destination of the flow, as `ip:port`: a ClusterIP before its DNAT. */
  readonly to: string;
  /** This address is the source of the replies, as `ip:port`: the backend that the DNAT of the entry chose. */
  readonly reply: string;
  /** This flag tells that no packet came back on the flow. */
  readonly unreplied: boolean;
}

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

/**
 * These are the lives of an entry in the states of a handshake, in seconds
 * (nf_conntrack_tcp_timeout_syn_sent and _syn_recv). A retransmission of the SYN does not renew the
 * life of SYN_SENT (nf_conntrack_proto_tcp.c at v6.8). Thus the life of such an entry tells the age
 * of its first SYN.
 */
export const HANDSHAKE_LIFE: Readonly<Record<string, number>> = { SYN_SENT: 120, SYN_RECV: 60 };

/** This form is one TCP line of `/proc/net/nf_conntrack`: its timeout and state, the original tuple, its flags and counters, then the reply tuple. */
const LINE = /\btcp\s+\d+\s+(\d+)\s+(\S+)\s+src=(\S+) dst=(\S+) sport=(\d+) dport=(\d+)(.*?)\bsrc=(\S+) dst=\S+ sport=(\d+) dport=\d+/;

/** This function gives the TCP flows of a dump of `/proc/net/nf_conntrack`. */
export const flowsOf = (text: string): ConntrackFlow[] => {
  const out: ConntrackFlow[] = [];
  for (const line of text.split("\n")) {
    const match = LINE.exec(line);
    if (match === null) continue;
    out.push({
      ttl: Number(match[1]),
      state: match[2]!,
      from: `${match[3]}:${match[5]}`,
      to: `${match[4]}:${match[6]}`,
      reply: `${match[8]}:${match[9]}`,
      unreplied: match[7]!.includes("[UNREPLIED]"),
    });
  }
  return out;
};

/** This function gives the TCP entries of a dump of `/proc/net/nf_conntrack` whose original destination is the ClusterIP and port. */
export const entriesOf = (text: string, ip: string, port: number): ConntrackEntry[] =>
  flowsOf(text)
    .filter((flow) => flow.to === `${ip}:${port}`)
    .map((flow) => ({ state: flow.state, ttl: flow.ttl, client: flow.from, backend: flow.reply, unreplied: flow.unreplied }));

/**
 * This function gives the entries that keep their NAT to a pod that is not a backend of the rules.
 * A new SYN from the client port of such an entry goes to that pod, whatever the rules say.
 */
export const staleOf = (entries: readonly ConntrackEntry[], backends: readonly string[]): ConntrackEntry[] =>
  entries.filter((entry) => KEEPS_NAT.has(entry.state) && !backends.includes(entry.backend));

/**
 * This function gives the flows whose handshake stopped `age` seconds ago or more. Such a flow is
 * a SYN with no reply (SYN_SENT), or a SYN and its SYN-ACK with no ACK (SYN_RECV). It is a
 * connection that times out. On the node of the client, its reply address is the backend of its
 * DNAT. On the node of that backend, a SYN_SENT tells that the backend did not answer. There, a
 * SYN_RECV tells that its answer did not come back.
 */
export const stalledOf = (flows: readonly ConntrackFlow[], age: number): ConntrackFlow[] =>
  flows.filter((flow) => {
    const life = HANDSHAKE_LIFE[flow.state];
    if (life === undefined || (flow.state === "SYN_SENT" && !flow.unreplied)) return false;
    return flow.ttl <= life - age;
  });
