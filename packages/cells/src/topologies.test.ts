import { describe, expect, it } from "vitest";
import { ALL } from "./all.ts";
import { CAL_CELLS, PROXY_TIMES } from "./calibration.ts";
import { CELLS } from "./catalog.ts";
import { T02_CELLS } from "./t02.ts";
import { T03_CELLS, T03_SPECS, keepaliveOn, o03Of } from "./t03.ts";
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

  it("refreshes nothing from a socket without keepalive: O03 does not hold for a client in flight", () => {
    // the namespace has the keepalive sysctls of Linux 6.6 (7200 s), but the socket has no SO_KEEPALIVE
    for (const spec of T03_SPECS.filter((each) => each.mode === "inflight")) {
      expect(keepaliveOn(spec), spec.name).toBe(false);
      expect(o03Of(spec), spec.name).toEqual({ holds: false, refresh: "inf", forget: 5, margin: 0.005 });
      expect(named(T03_CELLS, `T03 ${spec.name}`).probe.keepalive, spec.name).toBe(false);
    }
    // the same spec with a keepalive of 4 s would refresh the flow in time
    const inFlight = T03_SPECS.find((each) => each.name === "client in flight after 8 s idle, reset-next")!;
    expect(o03Of({ ...inFlight, keepidle: 4 })).toMatchObject({ holds: true, refresh: 4.256 });
  });

  it("predicts DV-12's three cases from conntrack and Linux TCP when O03 does not hold", () => {
    for (const form of ["reset-both", "reset-next", "silent-drop"])
      expect(band(T03_CELLS, `T03 client idle, ${form}, keepidle 4 s`)).toBe("silent");
    // a reset to both ends at the forget: 5 s, late by the pump, two listings and the slack of the pump at most. The router
    // counts from the ACK of the last reply, at once or 40 ms and a jiffy later at HZ 250
    expect(band(T03_CELLS, "T03 client idle, reset-both, keepidle 6 s")).toEqual({
      timer: "expire_established",
      errno: "ECONNRESET",
      from: "last-received",
      low: 5,
      high: 5.139,
    });
    // a reset to the next packet: the first keepalive probe, at 6 s on the wheel, one round trip later
    expect(band(T03_CELLS, "T03 client idle, reset-next, keepidle 6 s")).toMatchObject({ errno: "ECONNRESET", low: 5.996, high: 6.257 });
    // a silent drop: the whole keepalive window of the client, 6 s and 3 probes 1 s apart
    expect(band(T03_CELLS, "T03 client idle, silent-drop, keepidle 6 s")).toMatchObject({ errno: "ETIMEDOUT", low: 8.996, high: 9.352 });
    expect(band(T03_CELLS, "T03 client in flight after 8 s idle, reset-next")).toMatchObject({ from: "request-sent", low: 0, high: 0.001 });
    expect(band(T03_CELLS, "T03 client in flight after 8 s idle, silent-drop, tcp_retries2 = 3")).toMatchObject({ low: 3, high: 6.616 });
    expect(band(T03_CELLS, "T03 client in flight after 8 s idle, recreate")).toEqual({ replies: [0, 0.001] });
    // the server: both ends reset, a dropped probe from outside, or the reset of the router's own stack.
    // The last segment is the client's ACK of the reply, at once or 40 ms and a jiffy late
    expect(band(T03_CELLS, "T03 server idle, reset-both, tcp-keepalive 6 s")).toMatchObject({ low: 5, high: 5.139 });
    expect(band(T03_CELLS, "T03 server idle, reset-next, tcp-keepalive 6 s")).toMatchObject({ errno: "ETIMEDOUT", low: 11.996, high: 12.352 });
    expect(band(T03_CELLS, "T03 server idle, none, tcp-keepalive 6 s")).toMatchObject({ errno: "ECONNRESET", low: 5.996 });
    expect(band(T03_CELLS, "T03 server idle, reset-both, tcp-keepalive 4 s")).toBe("silent");
    for (const each of T03_CELLS) expect(each.concurrency, each.name).toBe(1);
  });

  it("predicts each leg of T02 with Linux TCP, and timeout server from HAPROXY_TCP; Redis gives no FIN back in its document", () => {
    // timeout server: the FIN goes to the client at once. No keepalive probe resets the timer: the band counts from the last data
    expect(band(T02_CELLS, "T02 client idle, keepalive 2 s, HAProxy timeout server 5 s, Redis tcp-keepalive 2 s")).toEqual({
      timer: "timeout_server",
      errno: "EOF",
      from: "last-data",
      low: 4.989,
      high: 5.011,
    });
    // timeout client: the FIN to the client follows the FIN of Redis, and REDIS_CLIENT gives none
    expect(band(T02_CELLS, "T02 client idle, keepalive 2 s, HAProxy timeout client 5 s")).toBe("measured");
    const client = named(T02_CELLS, "T02 client idle, keepalive 2 s, HAProxy timeout client 5 s").prediction;
    expect(client.detects === null ? client.why : "").toBe(
      "timeout_client sends a FIN to the target, and the document redis-client of the target gives no FIN back. Thus the cell measures when the FIN reaches the client",
    );
    expect(band(T02_CELLS, "T02 client idle, keepalive 5 s, blackhole at HAProxy toward the client")).toMatchObject({ low: 10.996, high: 11.352 });
    expect(band(T02_CELLS, "T02 HAProxy toward the client idle, blackhole at the client")).toMatchObject({ low: 5.996, high: 6.352 });
    expect(band(T02_CELLS, "T02 server idle, tcp-keepalive 5 s, blackhole at HAProxy toward the target")).toMatchObject({ low: 7.996, high: 8.352 });
    expect(named(T02_CELLS, "T02 HAProxy toward the target idle, blackhole at the target").observer).toEqual({ hop: "haproxy", toward: "target" });
  });

  it("predicts each toxic from the documentation of Toxiproxy, and its close translation not at all", () => {
    const { up, down } = PROXY_TIMES.toxiproxy;
    const ms = (term: typeof up) => term.time.value * 1000;
    const near = (value: number) => Math.round(value * 1e6) / 1e6;
    // the request crosses Toxiproxy toward Redis, and the reply crosses it back after the delay
    expect(band(TOX_CELLS, "TOX client in flight, toxic latency 100 ms downstream")).toEqual({
      replies: [0.1, near(0.101 + (ms(up) + ms(down)) / 1000)],
    });
    expect(named(TOX_CELLS, "TOX client in flight, toxic latency 100 ms downstream").prediction).toMatchObject({
      through: [up, down],
      rtt: { low: { value: 0 }, high: { value: 5 } },
    });
    expect(band(TOX_CELLS, "TOX client idle, toxic timeout 2000 ms downstream")).toMatchObject({
      errno: "EOF",
      from: "fault",
      low: 2,
      high: near(2.001 + ms(down) / 1000),
    });
    expect(band(TOX_CELLS, "TOX client idle, toxic timeout 0 downstream")).toBe("silent");
    // a toxic on a live connection gets no linger: its close is FINs, one crossing each way
    expect(band(TOX_CELLS, "TOX client in flight, toxic reset_peer 0 upstream on a live connection")).toMatchObject({
      errno: "EOF",
      high: near(0.001 + (ms(up) + ms(down)) / 1000),
    });
    expect(band(TOX_CELLS, "TOX client in flight, toxic limit_data 1000 bytes downstream, a 500000-byte reply")).toMatchObject({
      high: near(0.001 + (ms(up) + ms(down)) / 1000),
    });
    expect(band(TOX_CELLS, "TOX client in flight, rst at the server, through Toxiproxy")).toBe("measured");
    expect(band(TOX_CELLS, "TOX direct, client in flight, rst")).toMatchObject({ errno: "ECONNRESET", from: "request-sent" });
    expect(named(TOX_CELLS, "TOX direct, client in flight, rst").topology).toBeUndefined();
    // the direct netem cell reads the round trip with its delay in it: 101 ms, give or take δ_abs
    expect(named(TOX_CELLS, "TOX direct, client in flight, netem delay 100 ms").prediction).toMatchObject({
      rtt: { low: { value: 97 }, high: { value: 105 } },
    });
  });

  it("predicts a fault at the router from the manifestation that the client meets", () => {
    const at = (name: string) => named(T03_CELLS, `T03 ${name}`);
    // the band of the direct pair's black hole: the router keeps the flow, or a late probe meets the fault
    expect(band(T03_CELLS, "T03 client idle, blackhole at the router, keepidle 5 s, none")).toEqual(
      band(CELLS, "T01 client idle, blackhole"),
    );
    // RFC 6069 from an ICMP of the router: the revert does not ask where the ICMP came from
    expect(band(T03_CELLS, "T03 client in flight, unreachable-host at the router toward the client, tcp_retries2 = 3")).toEqual(
      band(CELLS, "T01 client in flight, unreachable-host, tcp_retries2 = 3"),
    );
    expect(at("client in flight, unreachable-host at the router toward the client, tcp_retries2 = 3")).toMatchObject({
      fault: "unreachable",
      icmp: "host",
      faultAt: { hop: "nat", toward: "client" },
      topology: { hops: [{ kind: "router", form: "none", sysctls: { "net.ipv4.icmp_ratelimit": "0" } }] },
    });
    expect(band(T03_CELLS, "T03 client in flight, unreachable-port at the router toward the client, tcp_retries2 = 3")).toMatchObject({
      errno: "ECONNREFUSED",
      high: 6.616,
    });
    expect(band(T03_CELLS, "T03 client in flight, rst at the router toward the client")).toMatchObject({ errno: "ECONNRESET", high: 0.001 });
    expect(at("client in flight, simplex-to-client at the router toward the client, tcp_retries2 = 3").drops).toBe("to-client");
    expect(at("client in flight, netem delay 100 ms at the router toward the target")).toMatchObject({
      fault: "netem",
      netem: "delay 100ms",
      faultAt: { hop: "nat", toward: "target" },
    });
    // the router forgets the flow behind its own black hole: a plain NAT changes nothing, and
    // the reset of both ends leaves from the stack of the router
    expect(band(T03_CELLS, "T03 client idle, blackhole at the router, keepidle 6 s, none, the router forgets the flow")).toMatchObject({
      errno: "ETIMEDOUT",
      low: 8.996,
      high: 9.352,
    });
    expect(band(T03_CELLS, "T03 client idle, blackhole at the router, keepidle 6 s, reset-both, the router forgets the flow")).toMatchObject({
      errno: "ECONNRESET",
      low: 5,
      high: 5.139,
    });
    // in flight, each retransmission refreshes the flow, until a wait of 6.528 s: then one idle timeout later
    expect(
      band(T03_CELLS, "T03 client in flight, blackhole at the router, tcp_retries2 = 8, reset-both, the router forgets the flow"),
    ).toEqual({ timer: "expire_established", errno: "ECONNRESET", from: "request-sent", low: 11.504, high: 11.983 });
  });

  it("names the first round trips that each band assumes", () => {
    // a ladder of the RTO is 51 jiffies for each round trip up to 4 ms at HZ 250
    expect(named(CELLS, "T01 client in flight, a 1 s stall").prediction).toMatchObject({
      rtt: { low: { value: 0.001, unit: "ms" }, high: { value: 4, unit: "ms" } },
    });
    expect(named(CELLS, "T01 client in flight, blackhole, tcp_retries2 = 3, 100 ms latency").prediction).toMatchObject({
      rtt: { high: { value: 104 } },
    });
    // keepalive does not read the round trip, and a reset reads it once
    expect(named(CELLS, "T01 client idle, blackhole").prediction).not.toHaveProperty("rtt");
    expect(named(T03_CELLS, "T03 client in flight after 8 s idle, reset-next").prediction).toMatchObject({ rtt: { high: { value: 5 } } });
  });

  it("calibrates each proxy with a stream through it and nothing injected", () => {
    expect(CAL_CELLS.map((each) => each.calibrates)).toEqual(["haproxy", "toxiproxy"]);
    for (const each of CAL_CELLS)
      expect(each).toMatchObject({ fault: "none", probe: { mode: "stream", count: 100 }, concurrency: 1, prediction: { detects: null } });
  });
});
