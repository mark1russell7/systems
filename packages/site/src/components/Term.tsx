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
