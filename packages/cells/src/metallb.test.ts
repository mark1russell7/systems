import { planOf } from "@mark1russell7/kind";
import { describe, expect, it } from "vitest";
import { s } from "./kind.ts";
import { METALLB_CELLS, SPEAKERS, metallbOf } from "./metallb.ts";
import { VIP_CLIENTS, VIP_HOLD, VIP_WORKLOAD } from "./vip.ts";

describe("the S2 cell of MetalLB (SYS-53)", () => {
  it("has one cell in iptables: a zone loss takes away the announcer of the VIP, with clients outside the cluster", () => {
    expect(METALLB_CELLS.map((cell) => cell.id)).toEqual(["S2.T07.iptables.metallb.zone-loss"]);
    const [cell] = METALLB_CELLS;
    expect(cell!.name).toContain("MetalLB");
    expect(cell!.trigger).toEqual({ kind: "zone-loss", hold: VIP_HOLD });
    expect(cell!.vip).toEqual({ clients: VIP_CLIENTS, announcer: "metallb" });
    expect(planOf(cell!).hold).toEqual(VIP_HOLD);
    expect(SPEAKERS).toBe(2);
  });

  it("ends the window 4.98–7 s after the fault: the probe, its deadline, the suspicion timeout of 4 s and the setup", () => {
    const predicted = metallbOf(VIP_WORKLOAD, VIP_HOLD);
    expect(predicted.start).toEqual({ lo: s(0), hi: s(0.52) });
    expect(predicted.probe).toEqual({ lo: s(0), hi: s(1.5) });
    expect(predicted.dead).toEqual({ lo: s(5), hi: s(6.5) });
    expect(predicted.arp).toEqual({ lo: s(5), hi: s(7) });
    expect(predicted.end).toEqual({ lo: s(4.98), hi: s(7) });
    expect(predicted.naive).toEqual({ lo: s(2.908485), hi: s(3.908485) });
    expect(predicted.thaw).toEqual({ lo: s(0), hi: s(0.5) });
    expect(predicted.watch).toEqual(s(10));
    expect(METALLB_CELLS[0]!.prediction).toMatchObject({
      kind: "window",
      certain: true,
      outcomes: ["timeout"],
      start: { from: "fault", band: predicted.start },
      end: { from: "fault", band: predicted.end },
      permits: { from: "heal", band: predicted.thaw, outcomes: ["timeout", "reset"], watch: s(10) },
    });
  });

  it("scales the death with the members: four speakers wait for confirmations, thus 6 × the minimum", () => {
    expect(metallbOf(VIP_WORKLOAD, s(60), 4).dead).toEqual({ lo: s(25), hi: s(26.5) });
  });

  it("refuses a hold that can end before the last failure", () => {
    expect(() => metallbOf(VIP_WORKLOAD, s(8))).toThrow(/more than 7 s/);
    expect(() => metallbOf(VIP_WORKLOAD, s(9))).not.toThrow();
  });
});
