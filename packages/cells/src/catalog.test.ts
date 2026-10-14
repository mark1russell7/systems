import { describe, expect, it } from "vitest";
import { CELLS, SPECS, predict } from "./catalog.ts";
import { MANIFESTATIONS } from "./manifestations.ts";

const cell = (name: string) => {
  const found = CELLS.find((each) => each.name === `T01 ${name}`);
  if (found === undefined) throw new Error(`no cell ${name}`);
  return found;
};
const band = (name: string) => {
  const p = cell(name).prediction;
  if (p.detects === true) return { timer: p.timer, errno: p.errno, from: p.from, low: p.low.value, high: p.high.value };
  if (p.detects === false && p.recovers !== undefined)
    return { firing: p.recovers.firing, low: p.recovers.low.value, high: p.recovers.high.value };
  return p.detects === false ? "silent" : "measured";
};

describe("the T01 catalog", () => {
  it("gives each cell a prediction, or the reason that it has none", () => {
    expect(CELLS).toHaveLength(SPECS.length);
    expect(new Set(CELLS.map((each) => each.name)).size).toBe(CELLS.length);
    for (const each of CELLS) {
      const p = each.prediction;
      if (p.detects === null) expect(p.why.length, each.name).toBeGreaterThan(20);
      if (p.detects === true) expect(p.high.value, each.name).toBeGreaterThanOrEqual(p.low.value);
    }
  });

  it("covers each manifestation, each observer, each workload and each latency", () => {
    const used = new Set(SPECS.map((spec) => spec.manifestation));
    expect([...Object.keys(MANIFESTATIONS)].filter((name) => !used.has(name as never))).toEqual([]);
    expect(new Set(SPECS.map((spec) => spec.observer))).toEqual(new Set(["client", "server"]));
    expect(new Set(SPECS.map((spec) => spec.mode))).toEqual(new Set(["idle", "inflight", "stream"]));
    expect(new Set(SPECS.map((spec) => spec.latency ?? 0))).toEqual(new Set([0, 20, 100]));
  });

  it("predicts the bands that the cells of S1 already hold", () => {
    expect(band("client idle, blackhole")).toEqual({
      timer: "keepalive",
      errno: "ETIMEDOUT",
      from: "last-received",
      low: 10.996,
      high: 11.352,
    });
    expect(band("client in flight, blackhole, tcp_retries2 = 3")).toMatchObject({ low: 3, high: 6.616 });
    expect(band("client in flight, blackhole, tcp_retries2 = 5")).toMatchObject({ low: 12.6, high: 26.52 });
    expect(band("server idle, blackhole")).toMatchObject({ low: 7.996, high: 8.352 });
    expect(band("server, a reply in flight, blackhole, tcp_retries2 = 3")).toMatchObject({
      low: 3,
      high: 6.616,
    });
    expect(band("client in flight, a 1 s stall")).toEqual({ firing: 3, low: 1.616, high: 1.705 });
    expect(band("client in flight, a 3.5 s stall")).toEqual({ firing: 5, low: 6.504, high: 6.889 });
    expect(band("client in flight, freeze-process")).toBe("silent");
  });

  it("carries the soft errno of an ICMP to the timeout, and reverts the backoff for host and net (RFC 6069)", () => {
    // a keepalive probe quotes snd_una − 1, outside the window: its ICMP does not count (found by the first run)
    expect(band("client idle, unreachable-host")).toMatchObject({ errno: "ETIMEDOUT", low: 10.996 });
    expect(band("client idle, unreachable-port")).toMatchObject({ errno: "ETIMEDOUT", low: 10.996 });
    expect(band("server idle, unreachable-host")).toMatchObject({ errno: "ETIMEDOUT", low: 7.996 });
    // 3.0 s budget, then at most one RTO of 51 jiffies, and 16 firings each one jiffy late at most
    expect(band("client in flight, unreachable-host, tcp_retries2 = 3")).toMatchObject({
      errno: "EHOSTUNREACH",
      low: 3,
      high: 3.268,
    });
    expect(band("client in flight, unreachable-net, tcp_retries2 = 3")).toMatchObject({ errno: "ENETUNREACH", high: 3.268 });
    // port unreachable and admin prohibited do not revert: the band of a black hole
    expect(band("client in flight, unreachable-port, tcp_retries2 = 3")).toMatchObject({ errno: "ECONNREFUSED", high: 6.616 });
    expect(band("client in flight, unreachable-admin, tcp_retries2 = 3")).toMatchObject({ errno: "EHOSTUNREACH", high: 6.616 });
    // 12.6 s budget, at most one RTO, and 63 firings
    expect(band("client in flight, unreachable-host, tcp_retries2 = 5")).toMatchObject({ low: 12.6, high: 13.056 });
  });

  it("moves the ladder with the latency: at 100 ms the RTO is 76 jiffies, not 51", () => {
    expect(band("client in flight, blackhole, tcp_retries2 = 3, 100 ms latency")).toMatchObject({ low: 3, high: 8.44 });
    expect(band("client in flight, blackhole, tcp_retries2 = 3, 20 ms latency")).toMatchObject({ low: 3 });
  });

  it("predicts a FIN one way after the close of the peer, with no errno", () => {
    expect(band("client idle, fin")).toEqual({ timer: "rx.fin", errno: "EOF", from: "peer-closed", low: 0, high: 0.001 });
    expect(band("server idle, fin")).toMatchObject({ errno: "EOF", from: "peer-closed" });
  });

  it("gives a distribution no band", () => {
    const spec = SPECS.find((each) => each.netem === "loss 5%")!;
    expect(predict(spec)).toMatchObject({ detects: null });
    expect(band("client stream, netem loss 5%")).toBe("measured");
  });

  it("sets each knob that the prediction reads in the namespace of the observer", () => {
    expect(cell("client in flight, blackhole, tcp_retries2 = 3").sysctls).toMatchObject({
      "net.ipv4.tcp_retries2": "3",
      "net.ipv4.tcp_keepalive_time": "5",
      "net.ipv4.tcp_keepalive_intvl": "2",
      "net.ipv4.tcp_keepalive_probes": "3",
    });
    const server = cell("server, a reply in flight, unreachable-host, tcp_retries2 = 3");
    expect(server.targetSysctls).toMatchObject({ "net.ipv4.tcp_retries2": "3" });
    // the client sends the ICMP to the server, thus its namespace has the rate limit of 0
    expect(server.sysctls).toEqual({ "net.ipv4.icmp_ratelimit": "0" });
    expect(server.targetSettings).toEqual({ "tcp-keepalive": "5", timeout: "0" });
    expect(cell("client idle, fin").environments).toBe(11);
  });
});
