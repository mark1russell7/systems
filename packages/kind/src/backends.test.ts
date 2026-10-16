import { describe, expect, it } from "vitest";
import { backendsOf } from "./backends.ts";

const RULE = { ns: "lab-x", svc: "lab", ip: "10.96.12.34", port: 80 };

const IPTABLES = [
  "*nat",
  ":KUBE-SEP-AAA - [0:0]",
  '-A KUBE-SERVICES -d 10.96.12.34/32 -p tcp -m comment --comment "lab-x/lab:http cluster IP" -m tcp --dport 80 -j KUBE-SVC-XYZ',
  '-A KUBE-SVC-XYZ ! -s 10.244.0.0/16 -d 10.96.12.34/32 -p tcp -m comment --comment "lab-x/lab:http cluster IP" -m tcp --dport 80 -j KUBE-MARK-MASQ',
  '-A KUBE-SVC-XYZ -m comment --comment "lab-x/lab:http -> 10.244.1.3:8080" -m statistic --mode random --probability 0.50000000000 -j KUBE-SEP-AAA',
  '-A KUBE-SVC-XYZ -m comment --comment "lab-x/lab:http -> 10.244.2.4:8080" -j KUBE-SEP-BBB',
  '-A KUBE-SVC-OTHER -m comment --comment "lab-x/labx:http -> 10.244.2.9:8080" -j KUBE-SEP-CCC',
  '-A KUBE-SEP-AAA -s 10.244.1.3/32 -m comment --comment "lab-x/lab:http" -j KUBE-MARK-MASQ',
  '-A KUBE-SEP-AAA -p tcp -m comment --comment "lab-x/lab:http" -m tcp -j DNAT --to-destination 10.244.1.3:8080',
  '-A KUBE-SEP-BBB -p tcp -m comment --comment "lab-x/lab:http" -m tcp -j DNAT --to-destination 10.244.2.4:8080',
  '-A KUBE-SEP-CCC -p tcp -m comment --comment "lab-x/labx:http" -m tcp -j DNAT --to-destination 10.244.2.9:8080',
  "COMMIT",
].join("\n");

const NFTABLES = [
  "table ip kube-proxy {",
  "\tchain service-ULMVA6XW-lab-x/lab/tcp/http {",
  "\t\tip daddr 10.96.12.34 tcp dport 80 ip saddr != 10.244.0.0/16 jump mark-for-masquerade",
  "\t\tnumgen random mod 2 vmap { 0 : goto endpoint-5OJB2KTY-lab-x/lab/tcp/http__10.244.1.3/8080 , 1 : goto endpoint-ZJXSMTPV-lab-x/lab/tcp/http__10.244.2.4/8080 }",
  "\t}",
  "\tchain endpoint-ZZZZZZZZ-lab-x/lab/tcp/http__10.244.9.9/8080 {",
  "\t\tmeta l4proto tcp dnat to 10.244.9.9:8080",
  "\t}",
  "\tchain service-AAAAAAAA-lab-x/labx/tcp/http {",
  "\t\tnumgen random mod 1 vmap { 0 : goto endpoint-QQQQQQQQ-lab-x/labx/tcp/http__10.244.2.9/8080 }",
  "\t}",
  "}",
].join("\n");

const IPVS = [
  "IP Virtual Server version 1.2.1 (size=4096)",
  "Prot LocalAddress:Port Scheduler Flags",
  "  -> RemoteAddress:Port Forward Weight ActiveConn InActConn",
  "TCP  0A600C22:0050 rr",
  "  -> 0AF40103:1F90      Masq    1      0          3",
  "  -> 0AF40204:1F90      Masq    0      0          1",
  "TCP  0A600001:01BB rr",
  "  -> AC120002:192B      Masq    1      0          0",
].join("\n");

describe("the backends of a Service in the rules of kube-proxy", () => {
  it("follows the jumps of the KUBE-SVC chain of the Service to the DNAT of each KUBE-SEP chain", () => {
    expect(backendsOf("iptables", IPTABLES, RULE)).toEqual(["10.244.1.3:8080", "10.244.2.4:8080"]);
  });

  it("reads each endpoint chain that the service chain of nftables names, and not the chains of another Service", () => {
    expect(backendsOf("nftables", NFTABLES, RULE)).toEqual(["10.244.1.3:8080", "10.244.2.4:8080"]);
  });

  it("reads the real servers of the virtual service in /proc/net/ip_vs, and a weight of zero is not a backend", () => {
    expect(backendsOf("ipvs", IPVS, RULE)).toEqual(["10.244.1.3:8080"]);
  });

  it("gives no backend for a Service without rules", () => {
    for (const mode of ["iptables", "nftables", "ipvs"] as const) expect(backendsOf(mode, "", RULE)).toEqual([]);
  });
});
