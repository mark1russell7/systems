import { realizationOf, timerOf } from "@mark1russell7/algebra";
import type { Subject } from "@mark1russell7/harness";
import { DROP_HANDLING, latestEndOf } from "@mark1russell7/harness";
import { PROCEDURES_WS_CLIENT, PROCEDURES_WS_SERVER, nodeEarlySeconds, nodeLateSeconds } from "@mark1russell7/machines";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { HZ } from "./catalog.ts";
import { PROCEDURES } from "./subjects.ts";
import { T02_CELLS } from "./t02.ts";
import { haproxyIdle } from "./topologies.ts";
import { clientValues, CLIENT, SILENT_CLIENT, serverValues } from "./ws.ts";
import { FIRST_REPLY, WST_CELLS, WST_SPECS, beatOf, forgetOf, forgetterOf, o03Server, o03Ws, o03Wst, predictWstAt, wstCells } from "./ws-topologies.ts";

const round = (value: number) => Math.round(value * 1e9) / 1e9;
const cell = (name: string) => {
  const found = WST_CELLS.find((each) => each.name === `WST ${name}`);
  if (found === undefined) throw new Error(`no cell ${name}`);
  return found;
};
const band = (name: string) => {
  const p = cell(name).prediction;
  if (p.detects === true) return { timer: p.timer, errno: p.errno, from: p.from, low: p.low.value, high: p.high.value, ...(p.drop === undefined ? {} : { drop: p.drop }) };
  return p.detects === false ? { silent: p.window.value } : { measured: p.window.value, from: p.from };
};
const waits = (name: string) => {
  const p = cell(name).prediction;
  return p.detects === false ? [] : (p.reconnects?.waits ?? []).map((wait) => [wait.low.value, wait.high.value]);
};
/** the band of a Node timer of `seconds`, at the HZ of the cells */
const nodeBand = (seconds: number) => [round(seconds - nodeEarlySeconds(HZ)), round(seconds + nodeLateSeconds(seconds, HZ))];
/** the handling time of the program, from the firing of its timer to the kernel's stamp of its drop */
const HANDLED = valueIn(DROP_HANDLING, "s");
/** the band of a drop on a Node timer of `seconds`: the band of the timer, and the handling on its high bound */
const dropBand = (seconds: number) => {
  const [low, high] = nodeBand(seconds);
  return [low!, round(high! + HANDLED)];
};
const heartbeat = (interval: number) => ({ ...CLIENT, heartbeat: { interval, timeout: 1000, misses: 1 } });

describe("the WST catalog", () => {
  it("gives each cell a hop, the client and the server of the WS catalog, and one environment at a time", () => {
    expect(WST_CELLS).toHaveLength(WST_SPECS.length);
    expect(new Set(WST_CELLS.map((each) => each.name)).size).toBe(WST_CELLS.length);
    for (const each of WST_CELLS) {
      expect(each.name.startsWith("WST "), each.name).toBe(true);
      expect(each.client).toEqual({ image: PROCEDURES.image, command: PROCEDURES.programs["client"] });
      expect(each.target).toMatchObject({ subject: PROCEDURES.image, lines: true, port: 8080 });
      expect(each.topology?.hops, each.name).toHaveLength(1);
      expect(each.concurrency, each.name).toBe(1);
      expect(each.probe).toMatchObject({ mode: "idle", keepalive: false });
      // the namespace of the observer gets the knobs of Linux TCP: the client, or the server
      const namespace = each.observer === "server" ? each.targetSysctls : each.sysctls;
      expect(namespace, each.name).toMatchObject({ "net.ipv4.tcp_retries2": "8" });
      const p = each.prediction;
      if (p.detects === null) expect(p.why.length, each.name).toBeGreaterThan(20);
      if (p.detects === true) expect(p.high.value, each.name).toBeGreaterThanOrEqual(p.low.value);
    }
  });

  it("lets the ping of the heartbeat realize the idle refresh of O03", () => {
    const values = clientValues(heartbeat(4000));
    expect(realizationOf(PROCEDURES_WS_CLIENT, "systems.mechanism.idle-refresh-interval", values)).toEqual(timerOf(PROCEDURES_WS_CLIENT, "ping", values));
  });

  it("puts the heartbeat on each side of the border of O03: 4 s holds and 6 s does not, against 5 s", () => {
    // the refresh is the ping at its latest; the keepalive of undici at 60 s comes later, and decides nothing
    expect(o03Ws(heartbeat(4000))).toEqual({ holds: true, refresh: round(4 + nodeLateSeconds(4, HZ)), forget: 5, margin: round(0.001 + 1 / HZ) });
    expect(o03Ws(heartbeat(6000))).toMatchObject({ holds: false, refresh: round(6 + nodeLateSeconds(6, HZ)) });
    // without the heartbeat, the keepalive of the socket is the refresh: 60 s for undici, none for ws
    const undici = o03Ws({ ...CLIENT, heartbeat: null });
    expect(undici.holds).toBe(false);
    expect(undici.refresh).toBeGreaterThan(60);
    expect(o03Ws({ ...CLIENT, heartbeat: null, socket: "ws" })).toMatchObject({ holds: false, refresh: "inf" });
  });

  it("predicts what the client sees when the router forgets the flow before the ping", () => {
    expect(band("client idle, router reset-both at 5 s, heartbeat 4 s and 1 s")).toEqual({ silent: 15 });
    // the forget: the delayed ACK of the last reply, then 5 s, late by the pump, two listings and the slack of the pump
    const forget = forgetOf(1);
    expect(forget.lo).toBe(5);
    expect(forget.hi).toBeCloseTo(0.04 + 1 / HZ + 5.095, 9);
    expect(band("client idle, router reset-both at 5 s, heartbeat 6 s and 1 s")).toEqual({
      timer: "expire_established",
      errno: "ECONNRESET",
      from: "last-received",
      low: 5,
      high: round(forget.hi),
    });
    // the first ping comes after the latest forget, even with a first reply FIRST_REPLY after the open
    expect(6 - nodeEarlySeconds(HZ) - FIRST_REPLY).toBeGreaterThan(forget.hi);
    // the ping meets a reset from the router, one round trip at most
    expect(band("client idle, router reset-next at 5 s, heartbeat 6 s and 1 s")).toEqual({ timer: "rx.rst", errno: "ECONNRESET", from: "ping-sent", low: 0, high: 0.001 });
    // the ping goes into nothing: the pong timeout drops the connection, with a close frame of the global WebSocket
    const [low, high] = dropBand(1);
    expect(band("client idle, router silent-drop at 5 s, heartbeat 6 s and 1 s")).toEqual({ timer: "pong", errno: "DROPPED", from: "ping-sent", low, high, drop: "frame" });
    for (const form of ["reset-both", "reset-next", "silent-drop"]) {
      const name = `client idle, router ${form} at 5 s, heartbeat 6 s and 1 s`;
      expect(waits(name), name).toEqual([nodeBand(0.5)]);
      expect(cell(name).topology?.hops[0]).toMatchObject({ kind: "router", form, idle: { value: 5, unit: "s" } });
      expect(cell(name).fault).toBe("middlebox-forget");
    }
  });

  it("gives each idle timeout of HAProxy a band from its document, and the bands of the reconnect", () => {
    // O03 with HAProxy as the middlebox: the ping at its latest against 5 s at its earliest, one ms and one step early
    const step = 0.001 + 0.01;
    expect(o03Ws(heartbeat(4000), 1, forgetterOf({ kind: "proxy", timeouts: { client: 5, server: 5 } }))).toEqual({
      holds: true,
      refresh: round(4 + nodeLateSeconds(4, HZ)),
      forget: round(5 - step),
      margin: round(0.001 + 1 / HZ),
    });
    // only bytes reset the timers of HAProxy: without the heartbeat, the keepalive of undici refreshes nothing
    expect(o03Ws({ ...CLIENT, heartbeat: null }, 1, forgetterOf({ kind: "proxy", timeouts: { client: 5, server: 5 } }))).toMatchObject({ holds: false, refresh: "inf" });
    expect(band("client idle, HAProxy timeouts 5 s, heartbeat 4 s and 1 s")).toEqual({ silent: 15 });
    expect(waits("client idle, HAProxy timeouts 5 s, heartbeat 4 s and 1 s")).toEqual([]);
    // timeout server: a FIN to the client at once, 5 s after the last data at the timer of HAProxy
    expect(band("client idle, HAProxy timeout server 5 s, heartbeat 6 s and 1 s")).toEqual({
      timer: "timeout_server",
      errno: "EOF",
      from: "last-data",
      low: round(5 - step),
      high: round(5 + step),
    });
    // timeout client: a FIN to the target, the FIN of ws back, then a FIN to the client, one round trip and one step later
    expect(band("client idle, HAProxy timeout client 5 s, heartbeat 6 s and 1 s")).toEqual({
      timer: "timeout_client",
      errno: "EOF",
      from: "last-data",
      low: round(5 - step),
      high: round(5 + step + 0.001 + 0.01),
    });
    expect(haproxyIdle({ client: 5, server: 30 }, 0.001)).toEqual({ why: "timeout_client sends a FIN to the target, and no document tells what the target does then" });
    expect(haproxyIdle({ client: 5, server: 5 }, 0.001)).toEqual({ why: "the two idle timeouts of HAProxy can fire in either sequence" });
    for (const name of ["client idle, HAProxy timeout client 5 s, heartbeat 6 s and 1 s", "client idle, HAProxy timeout server 5 s, heartbeat 6 s and 1 s"]) {
      expect(waits(name), name).toEqual([nodeBand(0.5)]);
      expect(cell(name).fault).toBe("proxy-idle");
      // the first ping comes after the latest FIN, even with a first reply FIRST_REPLY after the open
      expect(6 - nodeEarlySeconds(HZ) - FIRST_REPLY, name).toBeGreaterThan(5 + 2 * step + 0.001);
    }
    const config = (name: string) => {
      const hop = cell(name).topology?.hops[0];
      return hop?.kind === "proxy" ? hop.files?.["/usr/local/etc/haproxy/haproxy.cfg"] : undefined;
    };
    expect(config("client idle, HAProxy timeout client 5 s, heartbeat 6 s and 1 s")).toContain("timeout client 5s\n  timeout server 30s");
    expect(config("client idle, HAProxy timeout server 5 s, heartbeat 6 s and 1 s")).toContain("timeout client 30s\n  timeout server 5s");
    expect(config("client idle, HAProxy timeouts 5 s, heartbeat 4 s and 1 s")).toContain("bind :8080\n  default_backend procedures\nbackend procedures\n  server procedures {{next}}");
    // T02 keeps its configuration: Redis on 6379
    const t02 = T02_CELLS[0]!.topology?.hops[0];
    expect(t02?.kind === "proxy" ? t02.files?.["/usr/local/etc/haproxy/haproxy.cfg"] : undefined).toContain("frontend redis\n  bind :6379");
  });

  it("predicts a black hole on each leg of HAProxy by the heartbeat: the kernel of HAProxy acknowledges the ping on the client leg", () => {
    const [low, high] = dropBand(1);
    for (const toward of ["client", "target"]) {
      const name = `client idle, blackhole at HAProxy toward the ${toward}, heartbeat 2 s and 1 s`;
      expect(band(name), name).toEqual({ timer: "pong", errno: "DROPPED", from: "ping-sent", low, high, drop: "frame" });
      expect(cell(name).faultAt).toEqual({ hop: "haproxy", toward });
      expect(waits(name), name).toEqual([nodeBand(0.5)]);
    }
  });

  it("gives each cell of the global WebSocket a twin with the ws class: the same bands, and a close at the drop", () => {
    const globals = WST_CELLS.filter((each) => each.observer === undefined && each.probe.ws?.socket === "global");
    const twins = WST_CELLS.filter((each) => each.probe.ws?.socket === "ws");
    expect(globals).toHaveLength(9);
    expect(twins).toHaveLength(globals.length);
    for (const each of globals) {
      const twin = cell(`${each.name.slice("WST ".length)}, the ws class`);
      expect(twin.topology, twin.name).toEqual(each.topology);
      expect(twin.fault, twin.name).toBe(each.fault);
      expect(twin.faultAt, twin.name).toEqual(each.faultAt);
      expect(twin.probe.ws, twin.name).toEqual({ ...each.probe.ws, socket: "ws" });
      // terminate() ends the socket of ws at once, where the global WebSocket writes a close frame
      const p = each.prediction;
      expect(twin.prediction, twin.name).toEqual(p.detects === true && p.drop !== undefined ? { ...p, drop: "close" } : p);
    }
    const [low, high] = dropBand(1);
    for (const name of [
      "client idle, router silent-drop at 5 s, heartbeat 6 s and 1 s, the ws class",
      "client idle, blackhole at HAProxy toward the client, heartbeat 2 s and 1 s, the ws class",
      "client idle, blackhole at HAProxy toward the target, heartbeat 2 s and 1 s, the ws class",
    ])
      expect(band(name), name).toEqual({ timer: "pong", errno: "DROPPED", from: "ping-sent", low, high, drop: "close" });
  });

  it("lets only the heartbeat refresh a flow of the ws class: the ws package sets no keepalive", () => {
    const ws = { ...heartbeat(4000), socket: "ws" as const };
    expect(o03Ws(ws)).toEqual(o03Ws(heartbeat(4000)));
    expect(o03Ws({ ...heartbeat(6000), socket: "ws" })).toMatchObject({ holds: false, refresh: round(6 + nodeLateSeconds(6, HZ)) });
    expect(band("client idle, router reset-both at 5 s, heartbeat 4 s and 1 s, the ws class")).toEqual({ silent: 15 });
  });

  it("lets a beat of the server refresh the flow: its heartbeat timer at one miss, 4 s holds and 6 s does not", () => {
    const below = { heartbeat: { interval: 4000, misses: 2 } };
    const above = { heartbeat: { interval: 6000, misses: 2 } };
    expect(beatOf(below)).toEqual(timerOf(PROCEDURES_WS_SERVER, "heartbeat", serverValues({ heartbeat: { interval: 4000, misses: 1 } })));
    expect(o03Server(below)).toEqual({ holds: true, refresh: round(4 + nodeLateSeconds(4, HZ)), forget: 5, margin: round(0.001 + 1 / HZ) });
    expect(o03Server(above)).toMatchObject({ holds: false, refresh: round(6 + nodeLateSeconds(6, HZ)) });
    expect(o03Server({ heartbeat: null })).toBeUndefined();
    // a client without a heartbeat refreshes at the keepalive of undici, 60 s: the beat of the server decides
    const spec = { name: "o03", hop: { kind: "router", form: "reset-both" }, fault: "middlebox-forget", client: SILENT_CLIENT } as const;
    expect(o03Wst({ ...spec, server: below })).toEqual(o03Server(below));
    expect(o03Wst(spec)).toEqual(o03Ws(SILENT_CLIENT));
  });

  it("predicts what the server sees when the router forgets the flow before its next beat, from its first ping without an answer", () => {
    expect(band("server idle, router reset-both at 5 s, server heartbeat 4 s and 2 misses")).toEqual({ silent: 15 });
    // reset-next drops a ping from outside: the heartbeat drops the connection two beats after it
    expect(band("server idle, router reset-next at 5 s, server heartbeat 6 s and 2 misses")).toEqual({
      timer: "heartbeat",
      errno: "DROPPED",
      from: "ping-sent",
      low: round(12 - 2 * nodeEarlySeconds(HZ)),
      high: round(12 + 2 * nodeLateSeconds(6, HZ) + HANDLED),
      drop: "close",
    });
    // none answers the ping with a reset from the stack of the router, in one round trip
    expect(band("server idle, router none at 5 s, server heartbeat 6 s and 2 misses")).toEqual({
      timer: "rx.rst",
      errno: "ECONNRESET",
      from: "ping-sent",
      low: 0,
      high: 0.001,
    });
    // the next beat comes after the latest forget after the pong of the beat before it
    expect(6 - nodeEarlySeconds(HZ)).toBeGreaterThan(forgetOf(1).hi + 0.001);
    // a beat before the forget refreshes the flow: the first ping without an answer comes at most a
    // forget and a beat after the reply, and the run waits for it, past the 10 s of a short band
    for (const name of ["server idle, router reset-next at 5 s, server heartbeat 6 s and 2 misses", "server idle, router none at 5 s, server heartbeat 6 s and 2 misses"]) {
      const p = cell(name).prediction;
      expect(p.detects === true ? p.startsBy?.value : undefined, name).toBeCloseTo(forgetOf(1).hi + 6 + nodeLateSeconds(6, HZ) + 0.001, 9);
      // the latest detection: the latest first ping without an answer, then the band
      expect(p.detects === true ? latestEndOf(p) : 0, name).toBeCloseTo((p.detects === true ? p.high.value : 0) + forgetOf(1).hi + 6 + nodeLateSeconds(6, HZ) + 0.001, 9);
    }
    expect(cell("server idle, router reset-both at 5 s, server heartbeat 4 s and 2 misses").prediction).not.toHaveProperty("startsBy");
    for (const name of [
      "server idle, router reset-both at 5 s, server heartbeat 4 s and 2 misses",
      "server idle, router reset-next at 5 s, server heartbeat 6 s and 2 misses",
      "server idle, router none at 5 s, server heartbeat 6 s and 2 misses",
    ]) {
      const each = cell(name);
      expect(each, name).toMatchObject({ observer: "server", sysctls: {}, fault: "middlebox-forget" });
      expect(each.probe.ws, name).toMatchObject({ heartbeat: null, reconnect: null });
      expect(each.target.command, name).toEqual(expect.arrayContaining(["--heartbeat", "on", "--heartbeat-misses", "2"]));
      expect(each.prediction, name).not.toHaveProperty("exits");
      expect(waits(name), name).toEqual([]);
    }
    expect(cell("server idle, router none at 5 s, server heartbeat 6 s and 2 misses").target.command).toEqual([
      "node",
      "/opt/subject/server-ws.mjs",
      "--port",
      "8080",
      "--tcp-keepalive",
      "off",
      "--heartbeat",
      "on",
      "--heartbeat-interval-ms",
      "6000",
      "--heartbeat-misses",
      "2",
    ]);
    // a reset of both ends counts from the last segment of the flow: the harness has no such reference after a beat
    const both = {
      name: "server, reset-both",
      hop: { kind: "router", form: "reset-both" },
      fault: "middlebox-forget",
      observer: "server",
      client: SILENT_CLIENT,
      server: { heartbeat: { interval: 6000, misses: 2 } },
    } as const;
    expect(() => predictWstAt(both, 1)).toThrow(/no reference/);
  });
});

describe("the subject of the WST catalog", () => {
  it("runs each cell on a subject that a caller gives, with the same hop and the same predictions", () => {
    const caller: Subject = { ...PROCEDURES, name: "procedures", image: { kind: "build", name: "caller", context: "subject" } };
    expect(wstCells(PROCEDURES)).toEqual(WST_CELLS);
    for (const [at, each] of wstCells(caller).entries()) {
      const shipped = WST_CELLS[at]!;
      expect(each.client, each.name).toEqual({ image: caller.image, command: PROCEDURES.programs["client"] });
      expect(each.target, each.name).toEqual({ ...shipped.target, subject: caller.image });
      expect({ ...each, client: shipped.client, target: shipped.target }, each.name).toEqual(shipped);
    }
  });
});
