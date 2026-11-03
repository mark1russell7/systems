import { recovery, timerOf } from "@mark1russell7/algebra";
import { LINUX_TCP } from "@mark1russell7/machines";
import { quantity, valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { DEFAULTS, PRESETS, requestPath, say, tcpValues, type LayerId, type Settings } from "./request.ts";

const preset = (id: string): Settings => {
  const found = PRESETS.find((p) => p.id === id);
  if (found === undefined) throw new Error(`no preset ${id}`);
  return found.settings;
};
const layer = (settings: Settings, id: LayerId) => {
  const found = requestPath(settings).layers.find((l) => l.id === id);
  if (found === undefined) throw new Error(`no layer ${id}`);
  return found;
};
const seconds = (band: { low: { value: number; unit: string }; high: { value: number; unit: string } } | null): [number, number] => {
  if (band === null) throw new Error("no band");
  return [valueIn(band.low, "s"), valueIn(band.high, "s")];
};

describe("the readiness probe of the kubelet, from @mark1russell7/machines", () => {
  const probes = (settings: Settings) =>
    layer(settings, "kube")
      .marks.filter((mark) => mark.kind === "probe")
      .map((mark) => valueIn(mark.t, "s"));

  it("gives the band of the defaults of 1.37.0: 21 s to 31 s", () => {
    const stalled: Settings = { ...DEFAULTS, fault: "stall", dataplane: "cilium" };
    expect(seconds(layer(stalled, "kube").band)).toEqual([21, 31]);
    expect(probes(stalled)).toEqual([1, 11, 21]);
  });

  it("starts the next probe at once after a probe longer than a period, as the kubelet does", () => {
    const slow: Settings = { ...DEFAULTS, fault: "stall", dataplane: "cilium", period: quantity(2, "s"), probeTimeout: quantity(5, "s") };
    // 2 + 2 × 5 + 5 = 17 s, and one period early. The page before the move gave 3 × 2 + 5 = 11 s.
    expect(seconds(layer(slow, "kube").band)).toEqual([15, 17]);
    expect(probes(slow)).toEqual([5, 10, 15]);
  });
});

describe("the TCP layer against the cells", () => {
  it("Q1: keepalive finds an idle black hole in the band of the cell", () => {
    const tcp = layer(preset("q1"), "tcp");
    expect(tcp.verdict).toBe("detects");
    const [low, high] = seconds(tcp.band);
    expect(low).toBeCloseTo(10.996, 3);
    expect(high).toBeCloseTo(11.352, 3);
    expect(tcp.measured.map((m) => m.cell)).toEqual(["Q1 idle, black hole"]);
  });
  it("Q2: the retransmission give-up, from the first retransmission, is the band of the cell", () => {
    const tcp = layer(preset("q2"), "tcp");
    expect(tcp.verdict).toBe("detects");
    expect(tcp.measured).toHaveLength(1);
    expect(tcp.measured[0]!.computed).toContain("from the first retransmission");
    const giveUp = timerOf(LINUX_TCP, "retrans_giveup", tcpValues(preset("q2")));
    expect(valueIn(giveUp.duration as never, "s")).toBeCloseTo(3, 3);
  });
  it("Q3: no TCP timer fires when the process of the peer is frozen", () => {
    const tcp = layer(preset("q3"), "tcp");
    expect(tcp.verdict).toBe("silent");
    expect(tcp.band).toBeNull();
  });
  // The cell assumes a range of round trips, and the page assumes one round trip of 1 ms. Thus the two bands agree to 5 ms.
  it("Q4: the request recovers from a 3.5 s partition in the band of the cell", () => {
    const tcp = layer(preset("q4"), "tcp");
    expect(tcp.verdict).toBe("recovers");
    const [low, high] = seconds(tcp.band);
    expect(low).toBeCloseTo(6.504, 2);
    expect(high).toBeCloseTo(6.889, 2);
  });
  it("Q4: the request recovers from a 1 s partition in the band of the cell", () => {
    const back = recovery(LINUX_TCP, "retransmit", tcpValues({ ...preset("q4"), heal: quantity(1, "s") }), quantity(1, "s"));
    if ("unknown" in back) throw new Error(back.unknown);
    expect(valueIn(back.low, "s")).toBeCloseTo(1.616, 2);
    expect(valueIn(back.high, "s")).toBeCloseTo(1.705, 2);
  });
});

describe("the whole path", () => {
  it("with the defaults, the deadline of the program knows first", () => {
    const path = requestPath(DEFAULTS);
    expect(path.first?.layer).toBe("process");
    expect(valueIn(path.first!.band.low, "s")).toBe(10);
  });
  it("without a deadline, TCP knows first and the program waits for it", () => {
    const path = requestPath(preset("q2"));
    expect(path.first?.layer).toBe("tcp");
    expect(layer(preset("q2"), "process").verdict).toBe("detects");
  });
  it("T18: the stalled pod leaves the Service in the band of the kind cell", () => {
    const kube = layer(preset("t18"), "kube");
    const [low, high] = seconds(kube.band);
    expect(low).toBeCloseTo(21.027, 3);
    expect(high).toBeCloseTo(31.092, 3);
    expect(kube.measured.some((m) => m.cell.startsWith("T18.defaults.4"))).toBe(true);
  });
  it("a black hole is past the NIC and past the probes of the kubelet", () => {
    expect(layer(DEFAULTS, "nic").verdict).toBe("blind");
    expect(layer(DEFAULTS, "kube").verdict).toBe("blind");
  });
  it("warns when keepalive starts after conntrack forgets the flow", () => {
    expect(layer({ ...DEFAULTS, ctEstablished: quantity(3600, "s") }, "kube").warning).not.toBeNull();
    expect(layer(DEFAULTS, "kube").warning).toBeNull();
  });
  it("an idle connection without SO_KEEPALIVE is found by no layer", () => {
    const path = requestPath({ ...DEFAULTS, inFlight: false, keepaliveOn: false });
    expect(path.first).toBeNull();
  });
  it("every preset computes a path with a headline", () => {
    for (const p of PRESETS) expect(requestPath(p.settings).headline.length).toBeGreaterThan(10);
  });
});

describe("say", () => {
  it("prints each amount through the quantity package", () => {
    expect(say(quantity(0.2, "s"))).toBe("200 ms");
    expect(say(quantity(6.616, "s"))).toBe("6.616 s");
    expect(say({ value: "infinite", unit: "s" })).toBe("never");
    expect(say(quantity(7875, "s"))).toContain("h");
  });
});
