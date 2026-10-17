import { describe, expect, it } from "vitest";
import { entriesOf, staleOf } from "./conntrack.ts";

// lines in the format of /proc/net/nf_conntrack: one with the counters of nf_conntrack_acct
const DUMP = [
  "ipv4     2 tcp      6 117 TIME_WAIT src=10.244.1.20 dst=10.96.163.119 sport=48042 dport=80 src=10.244.2.24 dst=10.244.1.20 sport=8080 dport=48042 [ASSURED] mark=0 zone=0 use=2",
  "ipv4     2 tcp      6 119 SYN_SENT src=10.244.1.20 dst=10.96.163.119 sport=46952 dport=80 packets=2 bytes=120 [UNREPLIED] src=10.244.2.24 dst=10.244.1.20 sport=8080 dport=46952 packets=0 bytes=0 mark=0 zone=0 use=2",
  "ipv4     2 tcp      6 86399 ESTABLISHED src=10.244.0.8 dst=10.96.163.119 sport=37436 dport=80 src=10.244.1.17 dst=10.244.0.8 sport=8080 dport=37436 [ASSURED] mark=0 zone=0 use=2",
  "ipv4     2 tcp      6 9 CLOSE src=10.244.0.8 dst=10.96.163.119 sport=37500 dport=80 src=10.244.2.24 dst=10.244.0.8 sport=8080 dport=37500 [ASSURED] mark=0 zone=0 use=2",
  "ipv4     2 tcp      6 86399 ESTABLISHED src=10.244.0.8 dst=10.96.0.1 sport=40000 dport=443 src=172.18.0.2 dst=10.244.0.8 sport=6443 dport=40000 [ASSURED] mark=0 zone=0 use=2",
  "ipv4     2 udp      17 29 src=10.244.0.8 dst=10.96.0.10 sport=53000 dport=53 src=10.244.0.3 dst=10.244.0.8 sport=53 dport=53000 mark=0 zone=0 use=2",
].join("\n");

describe("the conntrack entries of a ClusterIP", () => {
  it("reads each TCP entry to the ClusterIP and its port, with the backend of its NAT", () => {
    const entries = entriesOf(DUMP, "10.96.163.119", 80);
    expect(entries.map((each) => [each.state, each.client, each.backend, each.unreplied])).toEqual([
      ["TIME_WAIT", "10.244.1.20:48042", "10.244.2.24:8080", false],
      ["SYN_SENT", "10.244.1.20:46952", "10.244.2.24:8080", true],
      ["ESTABLISHED", "10.244.0.8:37436", "10.244.1.17:8080", false],
      ["CLOSE", "10.244.0.8:37500", "10.244.2.24:8080", false],
    ]);
    expect(entries[1]!.ttl).toBe(119);
  });

  it("gives the entries that keep their NAT to a pod that the rules dropped, but not one in TIME_WAIT", () => {
    const stale = staleOf(entriesOf(DUMP, "10.96.163.119", 80), ["10.244.1.17:8080", "10.244.3.7:8080"]);
    // a SYN on the TIME_WAIT entry reopens it with a new lookup; the SYN_SENT and the CLOSE keep 10.244.2.24
    expect(stale.map((each) => [each.state, each.client])).toEqual([
      ["SYN_SENT", "10.244.1.20:46952"],
      ["CLOSE", "10.244.0.8:37500"],
    ]);
  });
});
