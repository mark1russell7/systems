import { planOf } from "@mark1russell7/kind";
import { describe, expect, it } from "vitest";
import { s } from "./kind.ts";
import { ELECTION, VIP_CELLS, VIP_CLIENTS, VIP_HOLD, VIP_WORKLOAD, vipOf } from "./vip.ts";

describe("the S2 cell of kube-vip (SYS-51)", () => {
  it("has one cell in iptables: a zone loss takes away the holder of the VIP, with clients outside the cluster", () => {
    expect(VIP_CELLS.map((cell) => cell.id)).toEqual(["S2.T07.iptables.vip.zone-loss"]);
    const [cell] = VIP_CELLS;
    expect(cell!.name).toContain("kube-vip");
    expect(cell!.trigger).toEqual({ kind: "zone-loss", hold: VIP_HOLD });
    expect(cell!.vip).toEqual({ clients: VIP_CLIENTS });
    expect(cell!.workload.connections).toBeUndefined();
    expect(planOf(cell!).hold).toEqual(VIP_HOLD);
  });

  it("takes the defaults of the election of kube-vip and the jitter of client-go", () => {
    expect(ELECTION).toEqual({ lease: s(15), retry: s(2), jitter: 1.2 });
  });

  it("ends the window 12.98–27.3 s after the fault: the take of the Lease, the tick of the ARP manager and the setup", () => {
    const predicted = vipOf(VIP_WORKLOAD, VIP_HOLD);
    expect(predicted.take).toEqual({ lo: s(13), hi: s(23.8) });
    expect(predicted.arp).toEqual({ lo: s(13), hi: s(27.3) });
    expect(predicted.start).toEqual({ lo: s(0), hi: s(0.52) });
    expect(predicted.end).toEqual({ lo: s(12.98), hi: s(27.3) });
    expect(predicted.naive).toEqual({ lo: s(13), hi: s(17) });
    expect(predicted.thaw).toEqual({ lo: s(0), hi: s(3.5) });
    expect(VIP_CELLS[0]!.prediction).toMatchObject({
      kind: "window",
      certain: true,
      outcomes: ["timeout"],
      start: { from: "fault", band: predicted.start },
      end: { from: "fault", band: predicted.end },
      permits: { from: "heal", band: predicted.thaw, outcomes: ["timeout", "reset"] },
    });
  });

  it("refuses a hold that can end before the last failure", () => {
    expect(() => vipOf(VIP_WORKLOAD, s(28))).toThrow(/more than 27.3 s/);
    expect(() => vipOf(VIP_WORKLOAD, s(29))).not.toThrow();
  });
});
