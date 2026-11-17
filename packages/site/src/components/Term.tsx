/**
 * A term with its definition in a tooltip. The tooltip opens on a pointer over the term, and on the
 * focus of the term, thus a tap on a phone opens it too. It is CSS only, thus it also operates in a
 * page that Astro renders without JavaScript.
 */
import { useId, type ReactElement, type ReactNode } from "react";

/** The definitions of the words of the page, in plain words. */
export const TERMS = {
  "black hole": "A fault that drops each packet without an answer. The peer seems to be there, but nothing comes back.",
  stall: "The process of the peer stops, for example in a long pause of its event loop. Its kernel still answers each packet.",
  partition: "The network between two nodes breaks for a time, then it heals.",
  deadline: "The time that a program waits for one reply before it stops the call.",
  retry: "A new attempt of the same call after a deadline, after a wait that doubles each time.",
  socket: "The handle of a program on one TCP connection. The program writes to it and reads from it.",
  "send buffer": "The memory of the kernel that keeps the data that the peer did not acknowledge.",
  ETIMEDOUT: "The error that the kernel gives to the socket when TCP stops a connection on a timer.",
  RTO: "Retransmission timeout. TCP sends a segment again if no ACK comes in this time. Each new try waits two times longer.",
  TLP: "Tail loss probe. The first send again, before the first RTO, to find a lost last segment sooner.",
  tcp_retries2: "A sysctl: the number of RTO retransmissions before TCP stops the connection. The default is 15, approximately 15 min.",
  keepalive: "Probes that TCP sends on an idle connection. If no probe gets an answer, TCP stops the connection.",
  SO_KEEPALIVE: "The socket option that turns on keepalive. It is off on a socket by default.",
  TCP_USER_TIMEOUT: "A socket option: the longest time that sent data can stay without an ACK. 0 turns it off.",
  "delayed ACK": "The receiver waits a short time before it sends an ACK, to send one ACK for two segments.",
  sysctl: "A setting of the Linux kernel, for example net.ipv4.tcp_retries2.",
  HZ: "The clock of the kernel: the ticks in each second. A timer fires on a tick, thus it can be late by one tick or more.",
  conntrack: "The table of the kernel that remembers each connection through a NAT, for example the address of the pod behind a Service.",
  NAT: "Network address translation. The node rewrites the address of the Service to the address of one pod.",
  "kube-proxy": "The program on each node that writes the rules that send the traffic of a Service to its pods.",
  iptables: "A mode of kube-proxy: a chain of rules that the kernel reads in sequence.",
  ipvs: "A mode of kube-proxy: a load balancer in the kernel, with a hash table of the pods.",
  nftables: "A mode of kube-proxy: the newer rule engine of the kernel, with maps of the pods.",
  Cilium: "A network plugin that replaces kube-proxy with eBPF programs in the kernel.",
  "readiness probe": "The kubelet asks the pod a question each period. After a number of failures in a row, the pod leaves the Service.",
  kubelet: "The agent of Kubernetes on each node. It starts the pods and probes them.",
  EndpointSlice: "The list of the ready pods of a Service. kube-proxy reads it to write its rules.",
  NIC: "Network interface card: the hardware that puts the packets on the wire.",
  txqueuelen: "The length of the queue of packets in front of the NIC, in packets.",
  MTU: "Maximum transmission unit: the largest packet on the link, in bytes.",
  qdisc: "A queueing discipline: the queue of a network device in the kernel. It holds each packet until the device sends it, and it drops a packet when it is full.",
  netem: "A qdisc that adds a delay, a loss or a rate to each packet. It imitates a slow or a bad network.",
  tbf: "The token bucket filter: a qdisc that sends at a rate. Its bucket holds the tokens of a burst, thus a burst of that size leaves at once.",
  ENOBUFS: "The error of a send when the kernel has no room for the data. A UDP socket with IP_RECVERR gets it when a qdisc drops its datagram.",
  IP_RECVERR: "A socket option. With it, a UDP socket gets the errors of its sends, and a drop at the qdisc gives ENOBUFS to the send. Linux sets it off.",
  SndbufErrors: "A counter of UDP in /proc/net/snmp. It counts each send that found no room, also each datagram that a qdisc dropped.",
  ip_local_port_range: "A sysctl: the local ports that a connect can take. The default is 32768 to 60999, thus 28232 ports.",
  EADDRNOTAVAIL: "The error of a connect when no local port is free for its destination. No SYN leaves.",
  TIME_WAIT: "The state of a closed connection at the side that closed first. It holds the port for 60 s, thus a late segment cannot reach a new connection.",
  tcp_tw_reuse: "A sysctl: 1 lets a new connect take a port in TIME_WAIT after tcp_tw_reuse_delay. The default 2 does this on loopback only.",
  LAST_ACK: "The state of the side that closed second, until the ACK of its FIN arrives.",
  backlog: "The length of the accept queue that a program asks for in listen(2). The queue keeps each connection that the program did not accept.",
  somaxconn: "A sysctl: the largest backlog. A larger backlog in listen(2) gets this value. The default is 4096.",
  tcp_syn_retries: "A sysctl: the count of SYNs that a connect sends again before ETIMEDOUT. The default 6 gives 131 s.",
  tcp_synack_retries: "A sysctl: the count of SYN-ACKs that the target sends again for a request. The default 5 keeps a request for 63 s.",
  tcp_abort_on_overflow: "A sysctl: 1 answers a final ACK at a full queue with a reset. The default 0 drops the ACK and keeps the request.",
  "SYN-ACK": "The answer of the target to a SYN, the second packet of the handshake.",
  "challenge ACK": "The answer of a connected client to a SYN-ACK that comes again: an ACK that tells the target the state of the client.",
  "SYN cookie": "An answer to a SYN when the queue of requests is full. The target keeps no request and finds the connection in the final ACK.",
  ECONNRESET: "The error that the kernel gives to the socket when a reset from the peer ends the connection.",
} as const satisfies Record<string, string>;

export type TermName = keyof typeof TERMS;

export default function Term(props: { readonly name: TermName; readonly children?: ReactNode }): ReactElement {
  const id = useId();
  return (
    <span className="rp-term">
      <button type="button" className="rp-term-word" aria-describedby={id}>
        {props.children ?? props.name}
      </button>
      <span role="tooltip" id={id} className="rp-term-tip">
        {TERMS[props.name]}
      </span>
    </span>
  );
}
