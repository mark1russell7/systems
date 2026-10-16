import type { KnobValues, Machine } from "@mark1russell7/algebra";
import { algebraProblems, evaluate, machineProblems, machineSchema, overValues, timerOf } from "@mark1russell7/algebra";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { HZ, LINUX, LINUX_66, given } from "../catalog.ts";
import type { HttpCell } from "./catalog.ts";
import { HTTP_CELLS, HTTP_LATER, HTTP_OUT_OF_SCOPE, HTTP_SPECS, HTTP_WAITING, raceOf } from "./catalog.ts";
import { GO_TRANSPORT } from "./go-transport.ts";
import { NODE_HTTP_AGENT } from "./node-agent.ts";
import { NODE_HTTP_SERVER, hintOf } from "./node-server.ts";
import type { Race } from "./race.ts";
import { decide, gapOf, outcomeOf, poolExpiry, serverClose, timerInterval, valuesOf } from "./race.ts";
import { goLateSeconds, goTimerLateness, nodeLateSeconds, nodeTimerLateness } from "./timers.ts";
import { UNDICI_CLIENT } from "./undici.ts";

const DOCUMENTS: readonly Machine[] = [NODE_HTTP_SERVER, GO_TRANSPORT, NODE_HTTP_AGENT, UNDICI_CLIENT];

const cell = (name: string): HttpCell => {
  const found = HTTP_CELLS.find((each) => each.name === name);
  if (found === undefined) throw new Error(`no cell ${name}`);
  return found;
};
const band = (each: HttpCell) => {
  const p = each.prediction;
  if (p.detects === true) return { timer: p.timer, errno: p.errno, from: p.from, low: p.low.value, high: p.high.value };
  if (p.detects === false && p.recovers !== undefined) return { firing: p.recovers.firing, low: p.recovers.low.value, high: p.recovers.high.value };
  return p.detects === false ? "silent" : "measured";
};
const linuxOf = (values: Record<string, unknown> = {}): KnobValues =>
  given({ ...LINUX_66, ...values, hz: { value: HZ, unit: "Hz" }, rtt: { value: 1, unit: "ms" } } as never);

describe("the machine documents of the HTTP systems", () => {
  it("parse, and name only states, events, timers and knobs that they have", () => {
    for (const doc of DOCUMENTS) {
      expect(machineSchema.parse(doc), doc.id).toBeTruthy();
      expect(machineProblems(doc), doc.id).toEqual([]);
      expect(algebraProblems(doc), doc.id).toEqual([]);
    }
  });

  it("give the keep-alive timer of the Node server from its response: 5000 + 1000 ms, 1 ms early, late by the slack of epoll", () => {
    expect(timerInterval(NODE_HTTP_SERVER, "keep_alive", valuesOf(NODE_HTTP_SERVER, {}))).toEqual({ low: 5.999, high: 6.007 });
    expect(serverClose({ keepAliveTimeout: 6000, keepAliveTimeoutBuffer: 0 })).toEqual({ low: 5.999, high: 6.007 });
    // a keep-alive timeout of 0 turns the timer and the hint off
    expect(serverClose({ keepAliveTimeout: 0 })).toBeNull();
    expect(hintOf({})).toBe(5);
    expect(hintOf({ keepAliveTimeout: 1500 })).toBe(1);
    expect(hintOf({ keepAliveTimeout: 0 })).toBeNull();
    // the headers timeout is a sweep each 30 s, late by the timer of the sweep: [60, 90.031] s
    expect(timerInterval(NODE_HTTP_SERVER, "headers", valuesOf(NODE_HTTP_SERVER, {}))).toEqual({ low: 60, high: 90.031 });
  });

  it("give a Node timer one more jiffy on each bound at HZ 1000, where libuv reads the coarse clock", () => {
    expect(timerInterval(NODE_HTTP_SERVER, "keep_alive", valuesOf(NODE_HTTP_SERVER, { hz: 1000 }))).toEqual({ low: 5.998, high: 6.008 });
    expect(timerInterval(NODE_HTTP_SERVER, "keep_alive", valuesOf(NODE_HTTP_SERVER, { hz: 250 }))).toEqual({ low: 5.999, high: 6.007 });
    expect(timerInterval(UNDICI_CLIENT, "headers", valuesOf(UNDICI_CLIENT, { headersTimeout: 10_000, hz: 1000 }))).toEqual({
      low: 9.978,
      high: 10.531479,
    });
    expect(gapOf("agent", 3, 1000)).toEqual({ low: 2.998, high: 3.006 });
  });

  it("give the free socket timeout of the agent as the smaller of its timeout and the hint less the buffer", () => {
    expect(poolExpiry("agent", {}, 5)).toEqual({ low: 3.999, high: 4.005 });
    expect(poolExpiry("agent", { timeout: 10_000 }, 60)).toEqual({ low: 9.999, high: 10.011 });
    // no timeout: no timer, and then the hint does not apply
    expect(poolExpiry("agent", { timeout: 0 }, 5)).toBeNull();
    // a hint of 1 less a buffer of 1000 ms is 0: no reuse
    expect(poolExpiry("agent", {}, 1)).toEqual({ low: 0, high: 0 });
    expect(poolExpiry("agent", {}, null)).toEqual({ low: 4.999, high: 5.006 });
  });

  it("give the keep-alive timeout of undici as the hint less the threshold, capped by the maximum", () => {
    expect(poolExpiry("undici", {}, 5)).toEqual({ low: 2.999, high: 3.004 });
    expect(poolExpiry("undici", {}, 2)).toEqual({ low: 0, high: 0 });
    expect(poolExpiry("undici", {}, 3)).toEqual({ low: 0.999, high: 1.002 });
    // without a hint, keepAliveTimeout: 4 s
    expect(poolExpiry("undici", {}, null)).toEqual({ low: 3.999, high: 4.005 });
  });

  it("give the headers timeout of undici on its fast timers: ticks of 499 ms", () => {
    // 10 s: it fires after 20 ticks and a part of the 21st, and each tick is a Node timer of 499 ms
    expect(timerInterval(UNDICI_CLIENT, "headers", valuesOf(UNDICI_CLIENT, { headersTimeout: 10_000, hz: 250 }))).toEqual({
      low: 9.979,
      high: 10.510479,
    });
  });

  it("give the idle timeout of Go, exact for the reuse and late by a Go timer for the close", () => {
    expect(poolExpiry("go", {}, 5)).toEqual({ low: 90, high: 90 });
    expect(timerInterval(GO_TRANSPORT, "idle_conn", valuesOf(GO_TRANSPORT, {}))).toEqual({ low: 90, high: 90.091 });
  });

  it("agree with the number forms of the lateness of a timer", () => {
    for (const [seconds, hz] of [[0.01, 250], [0.4, 1000], [3, 250], [6, 1000], [90, 300], [300, 100]] as const) {
      const doc = { ...NODE_HTTP_SERVER, knobs: { ...NODE_HTTP_SERVER.knobs, d: { key: "d", scope: "test", unit: "ms", default: seconds * 1000 } } };
      const node = evaluate(doc, nodeTimerLateness("d"), valuesOf(doc, { hz }));
      expect(valueIn(node as never, "s")).toBeCloseTo(nodeLateSeconds(seconds, hz), 12);
      const goDoc = { ...GO_TRANSPORT, knobs: { ...GO_TRANSPORT.knobs, d: { key: "d", scope: "test", unit: "s", default: seconds } } };
      const go = evaluate(goDoc, goTimerLateness("d"), valuesOf(goDoc, {}));
      expect(valueIn(go as never, "s")).toBeCloseTo(goLateSeconds(seconds), 12);
    }
  });

  it("compose the keepalive of each client over Linux TCP: Go 165 s, the agent 11 s, undici 70 s", () => {
    const windowOf = (doc: Machine, values: KnobValues): number =>
      valueIn(timerOf(LINUX, "keepalive", overValues(doc, values, linuxOf())).duration as never, "s");
    expect(windowOf(GO_TRANSPORT, valuesOf(GO_TRANSPORT, {}))).toBe(165);
    expect(windowOf(NODE_HTTP_AGENT, valuesOf(NODE_HTTP_AGENT, {}))).toBe(11);
    expect(windowOf(UNDICI_CLIENT, valuesOf(UNDICI_CLIENT, {}))).toBe(70);
    // Go rounds a keepalive of 1.5 s up to 2 s, as the kernel counts whole seconds
    expect(windowOf(GO_TRANSPORT, valuesOf(GO_TRANSPORT, { KeepAlive: 3, KeepAliveInterval: 1.5 }))).toBe(21);
  });
});

describe("the arithmetic of the keep-alive race", () => {
  const race = (gap: number, extra: Partial<Race> = {}): Race => ({
    gap: { low: gap, high: gap + 0.002 },
    server: { low: 5.999, high: 6.007 },
    pool: { low: 90, high: 90 },
    rtt: { low: 0, high: 0.001 },
    notice: 0.001,
    ...extra,
  });

  it("gives each ordering of the gap against S and C", () => {
    expect(decide(race(3))).toEqual({ ordering: "kept" });
    expect(decide(race(6.5))).toEqual({ ordering: "fin-first" });
    expect(decide(race(5.5, { pool: { low: 5, high: 5.006 } }))).toEqual({ ordering: "dropped" });
    // the request crosses the FIN: it leaves before the FIN arrives, and arrives after the close
    expect(decide(race(5.95, { rtt: { low: 0.1, high: 0.101 } }))).toEqual({ ordering: "crossed" });
  });

  it("makes the crossing window one round trip wide, less the bounds of S", () => {
    const rtt = { low: 0.1, high: 0.1 };
    const crossed = (gap: number) => {
      const decision = decide({ ...race(gap, { rtt }), gap: { low: gap, high: gap } });
      return "ordering" in decision && decision.ordering === "crossed";
    };
    // crossed exactly for S.high - RTT < g < S.low
    expect(crossed(5.907)).toBe(false);
    expect(crossed(5.908)).toBe(true);
    expect(crossed(5.998)).toBe(true);
    expect(crossed(5.999)).toBe(false);
  });

  it("gives a border, not an ordering, where the bounds overlap", () => {
    // at S itself, on a bridge: the window of one round trip is narrower than the bounds of S
    expect(decide(race(6))).toHaveProperty("border");
    expect(decide(race(4.999, { pool: { low: 4.999, high: 5.005 } }))).toHaveProperty("border");
  });

  it("gives the first end of a connection that is gone before the send", () => {
    // S at 0.4 s, C at 6 s: the FIN of the server ends it
    expect(decide(race(25, { server: { low: 0.399, high: 0.402 }, pool: { low: 6, high: 6 } }))).toEqual({ ordering: "fin-first" });
    // C at 4 s, S at 6 s: the pool ends it
    expect(decide(race(14, { pool: { low: 3.999, high: 4.005 } }))).toEqual({ ordering: "dropped" });
  });

  it("gives the outcome that each client gives its caller for a crossed request", () => {
    expect(outcomeOf("go", "crossed", "GET")).toEqual({ connection: "reused", retried: true, error: null });
    expect(outcomeOf("go", "crossed", "POST")).toEqual({ connection: "reused", retried: false, error: "EOF" });
    expect(outcomeOf("agent", "crossed", "GET")).toEqual({ connection: "reused", retried: false, error: "ECONNRESET" });
    expect(outcomeOf("undici", "crossed", "GET")).toEqual({ connection: "reused", retried: false, error: "UND_ERR_SOCKET" });
    expect(outcomeOf("undici", "fin-first", "GET")).toEqual({ connection: "new", retried: false, error: null });
  });

  it("never inverts the agent or undici against a Node server that sends its hint, with a buffer of 100 ms or more", () => {
    for (const kat of [2000, 2500, 3000, 5000, 5999, 6000, 6500, 60_000]) {
      for (const serverBuffer of [0, 1000]) {
        const server = serverClose({ keepAliveTimeout: kat, keepAliveTimeoutBuffer: serverBuffer })!;
        const hint = hintOf({ keepAliveTimeout: kat });
        for (const buffer of [100, 500, 1000, 2000]) {
          const agent = poolExpiry("agent", { timeout: 600_000, agentKeepAliveTimeoutBuffer: buffer }, hint);
          const undici = poolExpiry("undici", { keepAliveTimeoutThreshold: buffer }, hint);
          for (const pool of [agent, undici]) if (pool !== null) expect(pool.high + 0.001, `${kat} ${buffer}`).toBeLessThan(server.low);
        }
      }
    }
  });

  it("gives the gap of each client: a Go sleep is never early, and a Node sleep can be 1 ms early", () => {
    expect(gapOf("go", 3)).toEqual({ low: 3, high: 3.005 });
    expect(gapOf("agent", 3)).toEqual({ low: 2.999, high: 3.005 });
  });
});

describe("the HTTP catalog", () => {
  it("gives each spec a cell, with a unique name and a prediction or its reason", () => {
    expect(HTTP_CELLS).toHaveLength(HTTP_SPECS.length);
    expect(new Set(HTTP_CELLS.map((each) => each.name)).size).toBe(HTTP_CELLS.length);
    for (const each of HTTP_CELLS) {
      const p = each.prediction;
      if (p.detects === null) expect(p.why.length, each.name).toBeGreaterThan(20);
      if (p.detects === true) expect(p.high.value, each.name).toBeGreaterThanOrEqual(p.low.value);
    }
  });

  it("covers each plan cell of the defaults stage with the Node HTTP server in T01 and T03, or says why not", () => {
    const named = new Set([
      ...HTTP_CELLS.map((each) => each.plan),
      ...HTTP_WAITING.map((each) => each.plan),
      ...HTTP_OUT_OF_SCOPE.map((each) => each.plan),
      ...HTTP_LATER.map((each) => each.plan),
    ]);
    const plan = [
      ...[4, 20, 24, 30, 34, 76, 77, 78, 79, 80, 81, 82, 83, 146].map((n) => `T01.defaults.${n}`),
      ...[121, 122, 123, 124, 129, 130, 133, 134, 135, 136, 143, 144, 169, 170, 201, 202, 223, 224].map((n) => `T01.border-off.${n}`),
      ...[12, 24, 30, 33, 37, 62, 63, 64, 65].map((n) => `T03.defaults.${n}`),
    ];
    expect(plan.filter((id) => !named.has(id))).toEqual([]);
  });

  it("predicts the race of Go at its defaults by the ordering of the gap", () => {
    const at = (name: string) => cell(`T01.defaults.77 go, ${name}`);
    expect(at("a GET 3 s after the reply")).toMatchObject({ ordering: "kept", request: { connection: "reused", error: null } });
    expect(band(at("a GET 3 s after the reply"))).toBe("silent");
    expect(at("a GET 5.95 s after the reply, 100 ms latency")).toMatchObject({
      ordering: "crossed",
      request: { connection: "reused", retried: true, error: null },
    });
    expect(at("a POST 5.95 s after the reply, 100 ms latency").request).toEqual({ connection: "reused", retried: false, error: "EOF" });
    // the first connection meets the FIN of the server at S, from its last received segment
    expect(band(at("a GET 6.5 s after the reply"))).toEqual({ timer: "keep_alive", errno: "EOF", from: "last-received", low: 5.999, high: 6.007 });
    expect(at("a GET 6.5 s after the reply").request).toEqual({ connection: "new", retried: false, error: null });
    // at S, without the latency, the window of one round trip is narrower than the bounds of S
    expect(band(at("a GET 6 s after the reply"))).toBe("measured");
  });

  it("finds no race on each side of the O01 border: the documents leave a margin of a few ms, not 0.26 s", () => {
    for (const each of HTTP_CELLS.filter((c) => c.plan?.startsWith("T01.border-off.1") === true)) {
      expect(["kept", "dropped"], each.name).toContain(each.ordering);
      expect(each.request?.error, each.name).toBeNull();
    }
    expect(cell("T01.border-off.122 agent, agentKeepAliveTimeoutBuffer 100 ms against a hint of 6 (outside O01), a GET 5.95 s after the reply")).toMatchObject({
      ordering: "dropped",
      request: { connection: "new" },
    });
  });

  it("gives no reuse when the hint is at or below the buffer of the client", () => {
    expect(cell("T01 agent, keepAliveTimeout 1500 ms (a hint of 1), a GET 1 s after the reply").request).toEqual({ connection: "new", retried: false, error: null });
    expect(cell("T01 undici, keepAliveTimeout 2500 ms (a hint of 2), a GET 1 s after the reply").ordering).toBe("dropped");
  });

  it("predicts the fault cells from the client over Linux TCP", () => {
    expect(band(cell("T01.defaults.4 go, a GET in flight, unreachable-host, tcp_retries2 = 3"))).toMatchObject({ errno: "EHOSTUNREACH", low: 3, high: 3.268 });
    // Go sends the GET again on a new connection, and its SYN meets the ICMP error
    expect(cell("T01.defaults.4 go, a GET in flight, unreachable-host, tcp_retries2 = 3").request).toEqual({ connection: "reused", retried: true, error: "EHOSTUNREACH" });
    expect(cell("T01.defaults.146 agent, a GET in flight, unreachable-host, tcp_retries2 = 3").request).toEqual({ connection: "reused", retried: false, error: "EHOSTUNREACH" });
    expect(band(cell("T01.defaults.30 agent idle, fin"))).toEqual({ timer: "rx.fin", errno: "EOF", from: "peer-closed", low: 0, high: 0.001 });
    expect(cell("T01.defaults.30 agent, a held reply in flight, fin").request).toEqual({ connection: "reused", retried: false, error: "ECONNRESET" });
    expect(band(cell("T01.defaults.34 undici, a GET in flight, freeze-process, headersTimeout 10 s"))).toEqual({
      timer: "headers",
      errno: "UND_ERR_HEADERS_TIMEOUT",
      from: "request-sent",
      low: 9.979,
      high: 10.510479,
    });
    expect(band(cell("T01.defaults.76 go, a GET in flight, a 1 s stall"))).toEqual({ firing: 3, low: 1.616, high: 1.705 });
    expect(cell("T01.defaults.79 go, a GET in flight, rst").request).toEqual({ connection: "reused", retried: true, error: "ECONNREFUSED" });
    expect(band(cell("T01.defaults.80 go, app-stall: a reply that the server holds for 60 s"))).toBe("silent");
  });

  it("predicts the T03 cells, with a router that forgets nothing in their windows", () => {
    expect(band(cell("T03.defaults.12 server, a long reply to a go GET, mtu-blackhole at the router toward the client, tcp_retries2 = 3"))).toMatchObject({
      errno: "ETIMEDOUT",
      low: 3,
      high: 6.616,
    });
    // the pool of Go closes the idle connection at 9 s, before its keepalive window of 21 s ends
    expect(band(cell("T03.defaults.63 go idle, blackhole at the router toward the client, Go timers scaled by 10"))).toEqual({
      timer: "idle_conn",
      errno: "CLOSED",
      from: "last-received",
      low: 9,
      high: 9.01,
    });
    expect(cell("T03.defaults.63 go, a GET in flight, blackhole at the router toward the client, tcp_retries2 = 3, DialTimeout 3 s").request).toEqual({
      connection: "reused",
      retried: true,
      error: "TIMEOUT",
    });
    // the chain retires the connection before the router can forget it
    expect(cell("T03.defaults.62 go, a GET 25 s after the reply, all timers scaled by 15")).toMatchObject({ ordering: "fin-first", request: { connection: "new" } });
    expect(cell("T03.defaults.24 agent, a GET 14 s after the reply, the router idle 12 s")).toMatchObject({ ordering: "dropped", request: { connection: "new" } });
    expect(raceOf(HTTP_SPECS.find((each) => each.plan === "T03.defaults.62")!).server).toEqual({ low: 0.399, high: 0.4014 });
  });
});
