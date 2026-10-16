import { describe, expect, it } from "vitest";
import { ALL } from "./all.ts";
import { T02_CELLS } from "./t02.ts";
import { T03_CELLS, T03_SPECS, o03Of } from "./t03.ts";
import { TOX_CELLS } from "./toxiproxy.ts";

const named = (cells: typeof ALL, name: string) => {
  const found = cells.find((each) => each.name === name);
  if (found === undefined) throw new Error(`no cell ${name}`);
  return found;
};
const band = (cells: typeof ALL, name: string) => {
  const p = named(cells, name).prediction;
  if (p.detects === true) return { timer: p.timer, errno: p.errno, from: p.from, low: p.low.value, high: p.high.value };
  if (p.detects === false && p.replies !== undefined) return { replies: [p.replies.low.value, p.replies.high.value] };
  return p.detects === false ? "silent" : "measured";
};

describe("the catalogs of the topologies", () => {
  it("names each cell of each catalog once", () => {
    expect(new Set(ALL.map((each) => each.name)).size).toBe(ALL.length);
    for (const each of [...T03_CELLS, ...T02_CELLS, ...TOX_CELLS]) {
      const p = each.prediction;
      if (p.detects === null) expect(p.why.length, each.name).toBeGreaterThan(20);
      if (p.detects === true) expect(p.high.value, each.name).toBeGreaterThanOrEqual(p.low.value);
    }
  });

  it("puts the keepalive of each end on each side of the border of O03: 4 s holds and 6 s does not, against 5 s", () => {
    const at = (name: string) => o03Of(T03_SPECS.find((spec) => spec.name === name)!);
    expect(at("client idle, reset-both, keepidle 4 s")).toEqual({ holds: true, refresh: 4.256, forget: 5, margin: 0.005 });
    expect(at("client idle, reset-both, keepidle 6 s")).toMatchObject({ holds: false, refresh: 6.256 });
    expect(at("server idle, reset-both, tcp-keepalive 4 s")).toMatchObject({ holds: true, refresh: 4.256 });
    expect(at("server idle, none, tcp-keepalive 6 s")).toMatchObject({ holds: false });
  });

  it("predicts DV-12's three cases from conntrack and Linux TCP when O03 does not hold", () => {
    for (const form of ["reset-both", "reset-next", "silent-drop"])
      expect(band(T03_CELLS, `T03 client idle, ${form}, keepidle 4 s`)).toBe("silent");
    // a reset to both ends at the forget: 5 s, late by the pump and two listings at most
    expect(band(T03_CELLS, "T03 client idle, reset-both, keepidle 6 s")).toEqual({
      timer: "expire_established",
      errno: "ECONNRESET",
      from: "last-received",
      low: 5,
      high: 5.09,
    });
    // a reset to the next packet: the first keepalive probe, at 6 s on the wheel, one round trip later
    expect(band(T03_CELLS, "T03 client idle, reset-next, keepidle 6 s")).toMatchObject({ errno: "ECONNRESET", low: 5.996, high: 6.257 });
    // a silent drop: the whole keepalive window of the client, 6 s and 3 probes 1 s apart
    expect(band(T03_CELLS, "T03 client idle, silent-drop, keepidle 6 s")).toMatchObject({ errno: "ETIMEDOUT", low: 8.996, high: 9.352 });
    expect(band(T03_CELLS, "T03 client in flight after 8 s idle, reset-next")).toMatchObject({ from: "request-sent", low: 0, high: 0.001 });
    expect(band(T03_CELLS, "T03 client in flight after 8 s idle, silent-drop, tcp_retries2 = 3")).toMatchObject({ low: 3, high: 6.616 });
    expect(band(T03_CELLS, "T03 client in flight after 8 s idle, recreate")).toEqual({ replies: [0, 0.001] });
    // the server: both ends reset, a dropped probe from outside, or the reset of the router's own stack
    expect(band(T03_CELLS, "T03 server idle, reset-both, tcp-keepalive 6 s")).toMatchObject({ low: 5, high: 5.09 });
    expect(band(T03_CELLS, "T03 server idle, reset-next, tcp-keepalive 6 s")).toMatchObject({ errno: "ETIMEDOUT", low: 11.996, high: 12.352 });
    expect(band(T03_CELLS, "T03 server idle, none, tcp-keepalive 6 s")).toMatchObject({ errno: "ECONNRESET", low: 5.996 });
    expect(band(T03_CELLS, "T03 server idle, reset-both, tcp-keepalive 4 s")).toBe("silent");
    for (const each of T03_CELLS) expect(each.concurrency, each.name).toBe(1);
  });

  it("predicts each leg of T02 with Linux TCP, and leaves the idle timers of HAProxy to measurement", () => {
    expect(band(T02_CELLS, "T02 client idle, keepalive 2 s, HAProxy timeout client 5 s")).toBe("measured");
    expect(band(T02_CELLS, "T02 client idle, keepalive 5 s, blackhole at HAProxy toward the client")).toMatchObject({ low: 10.996, high: 11.352 });
    expect(band(T02_CELLS, "T02 HAProxy toward the client idle, blackhole at the client")).toMatchObject({ low: 5.996, high: 6.352 });
    expect(band(T02_CELLS, "T02 server idle, tcp-keepalive 5 s, blackhole at HAProxy toward the target")).toMatchObject({ low: 7.996, high: 8.352 });
    expect(named(T02_CELLS, "T02 HAProxy toward the target idle, blackhole at the target").observer).toEqual({ hop: "haproxy", toward: "target" });
  });

  it("predicts each toxic from the documentation of Toxiproxy, and its close translation not at all", () => {
    expect(band(TOX_CELLS, "TOX client in flight, toxic latency 100 ms downstream")).toEqual({ replies: [0.1, 0.101] });
    expect(band(TOX_CELLS, "TOX client idle, toxic timeout 2000 ms downstream")).toMatchObject({ errno: "EOF", from: "fault", low: 2 });
    expect(band(TOX_CELLS, "TOX client idle, toxic timeout 0 downstream")).toBe("silent");
    expect(band(TOX_CELLS, "TOX client in flight, toxic reset_peer 0 upstream on a live connection")).toMatchObject({ errno: "ECONNRESET" });
    expect(band(TOX_CELLS, "TOX client in flight, rst at the server, through Toxiproxy")).toBe("measured");
    expect(band(TOX_CELLS, "TOX direct, client in flight, rst")).toMatchObject({ errno: "ECONNRESET", from: "request-sent" });
    expect(named(TOX_CELLS, "TOX direct, client in flight, rst").topology).toBeUndefined();
  });
});
