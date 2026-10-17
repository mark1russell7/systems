import { describe, expect, it } from "vitest";
import { devOf, grownOf, snmpOf, softnetOf, unresolvedOf } from "./drops.ts";

// lines in the format of the files of /proc/net in Linux 6.x
const SNMP = [
  "Ip: Forwarding DefaultTTL InReceives InHdrErrors InAddrErrors ForwDatagrams InUnknownProtos InDiscards InDelivers OutRequests OutDiscards OutNoRoutes",
  "Ip: 1 64 5000 0 0 0 0 0 5000 5100 2 1",
  "Tcp: RtoAlgorithm RtoMin RtoMax MaxConn ActiveOpens PassiveOpens AttemptFails EstabResets",
  "Tcp: 1 200 120000 -1 900 0 3 0",
].join("\n");
const DEV = [
  "Inter-|   Receive                                                |  Transmit",
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
  "    lo:    1200      12    0    0    0     0          0         0     1200      12    0    0    0     0       0          0",
  "  eth0:  900000    4000    0    5    0     0          0         0   800000    3900    0    7    0     0       0          0",
].join("\n");
const SOFTNET = ["0000a1b2 00000003 0000000a 00000000", "0000c3d4 00000001 00000002 00000000"].join("\n");
const ARP = [
  "IP address       HW type     Flags       HW address            Mask     Device",
  "10.244.0.1       0x1         0x2         2a:3b:4c:5d:6e:7f     *        eth0",
  "10.244.0.9       0x1         0x0         00:00:00:00:00:00     *        eth0",
].join("\n");

describe("the counters of the dropped packets", () => {
  it("reads one protocol of /proc/net/snmp by its names", () => {
    expect(snmpOf(SNMP, "Ip")["OutDiscards"]).toBe(2);
    expect(snmpOf(SNMP, "Ip")["OutNoRoutes"]).toBe(1);
    expect(snmpOf(SNMP, "Tcp")["AttemptFails"]).toBe(3);
    expect(snmpOf(SNMP, "Udp")).toEqual({});
  });

  it("reads the drops of each interface of /proc/net/dev, received and sent", () => {
    expect(devOf(DEV)).toEqual({ lo: { rx: 0, tx: 0 }, eth0: { rx: 5, tx: 7 } });
  });

  it("sums the drops of the backlogs and the squeezes of the softirqs over the CPUs, in hexadecimal", () => {
    expect(softnetOf(SOFTNET)).toEqual({ dropped: 4, squeezed: 12 });
  });

  it("counts the neighbors with no address yet", () => {
    expect(unresolvedOf(ARP)).toBe(1);
  });

  it("gives only the counters that grew, by how much", () => {
    expect(grownOf({ a: 1, b: 5, c: 2 }, { a: 1, b: 7, c: 2, d: 9 })).toEqual({ b: 2 });
  });
});
