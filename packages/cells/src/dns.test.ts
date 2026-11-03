import { planOf } from "@mark1russell7/kind";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { BY_NAME, DNS_ACT, DNS_CELLS, DNS_DRAIN, DNS_HOLD, MUSL_RESOLVER, RETRY_INTERVAL, THREADPOOL, dnsOf } from "./dns.ts";
import { WORKLOAD, s } from "./kind.ts";

describe("the S2 cells of CoreDNS (SYS-50)", () => {
  it("has two cells in iptables: the black hole with new connections, and its control with kept connections", () => {
    expect(DNS_CELLS.map((cell) => cell.id)).toEqual(["S2.T07.iptables.dns.blackhole", "S2.T07.iptables.dns.kept"]);
    for (const cell of DNS_CELLS) {
      expect(cell.name).toContain("CoreDNS");
      expect(cell.trigger).toEqual({ kind: "dns-blackhole", hold: DNS_HOLD });
      expect(cell.workload.byName).toBe(true);
      expect(planOf(cell).hold).toEqual(DNS_HOLD);
    }
    expect(DNS_CELLS[0]!.workload.connections).toBeUndefined();
    expect(DNS_CELLS[1]!.workload.connections).toBe(2);
    expect(DNS_CELLS[1]!.prediction.kind).toBe("none");
  });

  it("takes the timers of musl, of libuv and of the workload", () => {
    expect(MUSL_RESOLVER).toEqual({ timeout: s(5), sends: 2 });
    expect(RETRY_INTERVAL).toEqual(s(2.5));
    expect(THREADPOOL).toBe(4);
    expect(BY_NAME).toEqual({ ...WORKLOAD, byName: true });
    expect(valueIn(DNS_ACT, "s") + valueIn(DNS_DRAIN, "s")).toBe(1);
  });

  it("ends the window from one timeout before the heal to 2.5 s after it: the retry interval less the timeout, with the drain and the act", () => {
    const predicted = dnsOf(BY_NAME, DNS_HOLD);
    expect(predicted.start).toEqual({ lo: s(0), hi: s(0.52) });
    expect(predicted.end).toEqual({ lo: s(-1), hi: s(2.5) });
    expect(DNS_CELLS[0]!.prediction).toMatchObject({ kind: "window", certain: true, outcomes: ["timeout"], start: { from: "fault", band: predicted.start }, end: { from: "heal", band: predicted.end } });
  });

  it("puts the last failure 0.5–1.5 s after the heal if the threads stay in phase with the fault", () => {
    // the threads are free 7.5 s after the fault: 1.5 s after a heal at 6 s
    expect(dnsOf(BY_NAME, DNS_HOLD).phase).toEqual({ lo: s(0.5), hi: s(1.5) });
    expect(dnsOf(BY_NAME, s(7)).phase).toEqual({ lo: s(-0.5), hi: s(0.5) });
    // the phase is inside the band of the law
    const { phase, end } = dnsOf(BY_NAME, DNS_HOLD);
    expect(valueIn(phase.lo, "s")).toBeGreaterThanOrEqual(valueIn(end.lo, "s"));
    expect(valueIn(phase.hi, "s")).toBeLessThanOrEqual(valueIn(end.hi, "s"));
  });

  it("refuses a hold that does not start a second lookup in each thread, or that passes its next send", () => {
    expect(() => dnsOf(BY_NAME, s(5))).toThrow(/between 5 s and 7.5 s/);
    expect(() => dnsOf(BY_NAME, s(7.5))).toThrow(/between 5 s and 7.5 s/);
  });
});
