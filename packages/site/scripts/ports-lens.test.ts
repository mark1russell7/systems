/**
 * The lenses of the port range agree with the cells PR.1 to PR.8. Each count of the search is a count
 * of the cell. Each band of a held port is inside the band of the cell. The cell adds the waits of
 * its client and the noise of the machine, thus its band holds the band of the page.
 */
import { valueIn, type Quantity } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { HZ, RTT_MS } from "../../cells/src/catalog.ts";
import { PORT_RANGE_SPECS, type PortsSpec } from "../../cells/src/port-range.ts";
import { controlsOf, lanesOf, type Lens } from "../src/model/lens.ts";
import { PORT_DEFAULTS, portLenses, portModel, type PortCopy, type PortSettings } from "../src/model/lenses/ports.ts";
import { TCP } from "../src/model/lenses/tcp.ts";
import { ms, s, type Settings } from "../src/model/path.ts";

/** This function gives the settings of the page for a cell. A round of a cell holds each connection until its reset, thus a reset cell is an open connection. */
const settingsOf = (spec: PortsSpec): PortSettings => ({
  ...PORT_DEFAULTS,
  portRange: spec.size,
  destinations: spec.destinations,
  close: spec.close === "reset" ? "open" : spec.close,
  twReuse: spec.reuse === 1,
  reuseDelay: ms(1000),
  finAckLoss: spec.fault === "fin-ack",
  rtt: ms(RTT_MS),
  hz: HZ,
});

/** This function gives the two ends of a band in seconds. */
const seconds = (band: { readonly low: Quantity; readonly high: Quantity }): { low: number; high: number } => ({ low: valueIn(band.low, "s"), high: valueIn(band.high, "s") });

describe("the lenses of the port range and the cells", () => {
  it.each(PORT_RANGE_SPECS.map((spec) => [spec.plan, spec] as const))("%s: the counts of the search are the counts of the cell", (_, spec) => {
    const { search } = portModel(settingsOf(spec));
    expect(search.counts).toEqual([...spec.ports.counts].sort((a, b) => a - b));
    const share = spec.ports.share;
    if (share !== undefined) {
      expect(search.counts.at(-1)).toBe(share.count);
      expect(search.share).toBeGreaterThanOrEqual(share.low);
      expect(search.share).toBeLessThanOrEqual(share.high);
    }
  });

  it.each(PORT_RANGE_SPECS.filter((spec) => spec.ports.freed !== undefined).map((spec) => [spec.plan, spec] as const))(
    "%s: the band of the held port is inside the band of the cell",
    (_, spec) => {
      const { hold } = portModel(settingsOf(spec));
      const freed = spec.ports.freed;
      if (hold.band === null || freed === undefined) throw new Error(`${spec.plan}: no band`);
      const page = seconds(hold.band);
      const cell = seconds(freed);
      expect(page.low).toBeGreaterThanOrEqual(cell.low);
      expect(page.high).toBeLessThanOrEqual(cell.high);
      expect(page.low).toBeLessThanOrEqual(page.high);
    },
  );

  it.each(PORT_RANGE_SPECS.filter((spec) => spec.ports.retransmissions !== undefined).map((spec) => [spec.plan, spec] as const))(
    "%s: the retransmissions of each close make the count of the cell",
    (_, spec) => {
      const { hold } = portModel(settingsOf(spec));
      expect(hold.retransmissions * spec.size * spec.rounds).toBe(spec.ports.retransmissions);
    },
  );
});

describe("the law of the first EADDRNOTAVAIL", () => {
  const { search, hold } = portLenses(null);

  it("gives the error at the connect after the cap, for each destination", () => {
    const settings: PortSettings = { ...PORT_DEFAULTS, portRange: 16, destinations: 2, close: "open", connectGap: ms(1) };
    const model = portModel(settings);
    expect(model.error && seconds(model.error)).toEqual({ low: 0.032, high: 0.032 });
    expect(model.sure).toBe(true);
    const [lane] = search.lanes(settings);
    expect(lane?.verdict).toBe("detects");
    expect(lane?.marks.map((mark) => mark.label)).toContain("Connect 33 gets EADDRNOTAVAIL");
    // the 8 even ports of each destination come first
    expect(lane?.marks.find((mark) => mark.kind === "probe")?.t).toEqual(s(0.016));
  });

  it("gives the error of the defaults of Linux after the 28232 ports, inside TIME_WAIT", () => {
    const model = portModel(PORT_DEFAULTS);
    expect(model.error && seconds(model.error).low).toBeCloseTo(28.232, 9);
    expect(model.error && seconds(model.error).high).toBeCloseTo(28.232, 9);
    expect(model.held).toBe(28232);
    expect(valueIn(model.safeGap ?? s(0), "s")).toBeGreaterThan(60 / 28232);
    const [lane] = hold.lanes(PORT_DEFAULTS);
    expect(lane?.verdict).toBe("recovers");
    expect(lane?.band && seconds(lane.band).low).toBeGreaterThan(59.9);
  });

  it("gives no error when the gap is larger than the latest end of the hold over the cap", () => {
    // the wheel of HZ can end TIME_WAIT after 64 s, thus a gap of 16 s can still fail at 64 s
    expect(portModel({ ...PORT_DEFAULTS, portRange: 4, connectGap: s(16) }).error).not.toBeNull();
    const settings: PortSettings = { ...PORT_DEFAULTS, portRange: 4, connectGap: s(17) };
    expect(portModel(settings).error).toBeNull();
    expect(search.lanes(settings)[0]?.verdict).toBe("silent");
    expect(portModel(settings).held).toBe(3);
  });

  it("gives no error with a reset, which holds no port", () => {
    const settings: PortSettings = { ...PORT_DEFAULTS, close: "reset" };
    expect(portModel(settings).error).toBeNull();
    const [lane] = hold.lanes(settings);
    expect(lane?.verdict).toBe("recovers");
    expect(lane?.band && seconds(lane.band)).toEqual({ low: 0, high: 0 });
  });

  it("gives an odd range of 3 two connects, and a large odd range two counts with a warning", () => {
    expect(portModel({ ...PORT_DEFAULTS, portRange: 3 }).search).toEqual({ span: 2, counts: [2], share: null });
    const large = { ...PORT_DEFAULTS, portRange: 1001 };
    expect(portModel(large).search.counts).toEqual([1000, 1001]);
    expect(search.lanes(large)[0]?.warning).toMatch(/16 ports at most/);
  });

  it("takes the delay of tcp_tw_reuse 1 in place of TIME_WAIT", () => {
    const { band } = portModel({ ...PORT_DEFAULTS, twReuse: true }).hold;
    expect(band && seconds(band)).toEqual({ low: 1, high: 1.001 });
  });
});

describe("the measured values of a copy", () => {
  const copy: PortCopy = {
    ranAt: "2026-11-16",
    hz: 250,
    cells: [
      {
        plan: "PR.1",
        name: "an even range",
        settings: { size: 16, close: "reset", destinations: 1, reuse: 2, fault: null },
        result: { decision: "holds", counted: 2, runs: [{ searches: 50, counts: { "16": 50 }, firstFreed: null, retransmissions: 0 }, { searches: 50, counts: { "16": 50 }, firstFreed: null, retransmissions: 0 }] },
      },
      {
        plan: "PR.5",
        name: "the client closes first",
        settings: { size: 4, close: "client", destinations: 1, reuse: 2, fault: null },
        result: { decision: "holds", counted: 3, runs: [60.01, 60.03, 60.02].map((firstFreed) => ({ searches: 1, counts: { "4": 1 }, firstFreed, retransmissions: 0 })) },
      },
    ],
  };
  const { search, hold } = portLenses(copy);

  it("shows the counts of a cell with the size and the destinations of the page", () => {
    const [lane] = search.lanes({ ...PORT_DEFAULTS, portRange: 16 });
    expect(lane?.measured).toEqual([expect.objectContaining({ cell: "PR.1 an even range", measured: "16 in each of 100 searches", at: null })]);
    expect(search.lanes(PORT_DEFAULTS)[0]?.measured).toEqual([]);
  });

  it("shows the median of a held port at the HZ of the copy only", () => {
    const [lane] = hold.lanes({ ...PORT_DEFAULTS, hz: 250 });
    expect(lane?.measured[0]?.at).toEqual(s(60.02));
    expect(hold.lanes(PORT_DEFAULTS)[0]?.measured).toEqual([]);
  });
});

describe("a page of the port range and TCP", () => {
  it("shows one control for each knob that two lenses share", () => {
    const { search, hold } = portLenses(null);
    const lenses: ReadonlyArray<Lens<Settings & PortSettings>> = [TCP, search, hold];
    const controls = controlsOf(lenses);
    expect(controls.get("tcp")).toContain("rtt");
    expect(controls.get("hold")).not.toContain("rtt");
    expect(controls.get("hold")).not.toContain("hz");
    expect(lanesOf([search, hold], PORT_DEFAULTS).map((lane) => lane.id)).toEqual(["search", "hold"]);
  });
});
