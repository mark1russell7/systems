import { algebraProblems, machineProblems } from "@mark1russell7/algebra";
import type { Subject } from "@mark1russell7/harness";
import { SUBJECTS } from "@mark1russell7/harness";
import { PROCEDURES_WS_CLIENT, PROCEDURES_WS_SERVER, nodeEarlySeconds, nodeLateSeconds } from "@mark1russell7/machines";
import { describe, expect, it } from "vitest";
import { HZ } from "./catalog.ts";
import { NODE_IMAGE } from "./http/cells.ts";
import { WS_CELLS, WS_SPECS, wsCells } from "./ws.ts";

const round = (value: number) => Math.round(value * 1e9) / 1e9;
const cell = (name: string) => {
  const found = WS_CELLS.find((each) => each.name === `WS ${name}`);
  if (found === undefined) throw new Error(`no cell ${name}`);
  return found;
};
const band = (name: string) => {
  const p = cell(name).prediction;
  if (p.detects === true) return { timer: p.timer, errno: p.errno, from: p.from, low: p.low.value, high: p.high.value, ...(p.drop === undefined ? {} : { drop: p.drop }) };
  if (p.detects === false && p.recovers !== undefined)
    return { firing: p.recovers.firing, low: p.recovers.low.value, high: p.recovers.high.value, window: p.window.value };
  return p.detects === false ? { silent: p.window.value } : "measured";
};
const waits = (name: string) => {
  const p = cell(name).prediction;
  return p.detects === true ? (p.reconnects?.waits ?? []).map((wait) => [wait.low.value, wait.high.value]) : [];
};
/** the band of a Node timer of `seconds`, at the HZ of the cells */
const nodeBand = (seconds: number) => [round(seconds - nodeEarlySeconds(HZ)), round(seconds + nodeLateSeconds(seconds, HZ))];

describe("the WS catalog", () => {
  it("reads two documents that the algebra accepts", () => {
    for (const doc of [PROCEDURES_WS_CLIENT, PROCEDURES_WS_SERVER]) {
      expect(machineProblems(doc), doc.id).toEqual([]);
      expect(algebraProblems(doc), doc.id).toEqual([]);
    }
  });

  it("gives each cell a prediction, and each cell a name of its catalog", () => {
    expect(WS_CELLS).toHaveLength(WS_SPECS.length);
    expect(new Set(WS_CELLS.map((each) => each.name)).size).toBe(WS_CELLS.length);
    for (const each of WS_CELLS) {
      expect(each.name.startsWith("WS ")).toBe(true);
      expect(each.client).toBe("procedures-ws");
      expect(each.target).toMatchObject({ image: NODE_IMAGE, subject: { kind: "shipped", name: "procedures" }, lines: true });
      expect(each.target).not.toHaveProperty("harness");
      if (each.prediction.detects === true) expect(each.prediction.high.value, each.name).toBeGreaterThanOrEqual(each.prediction.low.value);
    }
  });

  it("predicts the drop by the heartbeat one pong timeout after the ping that got no answer, where the kernel waits", () => {
    const [low, high] = nodeBand(1);
    for (const name of [
      "client idle, blackhole, heartbeat 2 s and 1 s",
      "client, a call in flight, blackhole, heartbeat 2 s and 1 s",
      // the kernel of a frozen server acknowledges the ping: only the heartbeat finds it
      "client idle, freeze-process of the server, heartbeat 2 s and 1 s",
    ])
      expect(band(name), name).toEqual({ timer: "pong", errno: "DROPPED", from: "ping-sent", low, high, drop: "frame" });
    // the band does not read the round trip
    expect(cell("client idle, blackhole, heartbeat 2 s and 1 s").prediction).not.toHaveProperty("rtt");
  });

  it("tells the harness that the client process ends with the run, thus its end is not a close by the program", () => {
    for (const each of WS_CELLS) {
      const p = each.prediction;
      if (p.detects !== true || p.drop === undefined) continue;
      // the client exits at the end of each run; the server does not
      expect(p.exits, each.name).toBe(each.observer === "server" ? undefined : true);
    }
    expect(cell("server idle, blackhole, server heartbeat 1 s and 2 misses").prediction).not.toHaveProperty("exits");
  });

  it("predicts the drop of the ws class at the same time, as a close of its socket at once", () => {
    const [low, high] = nodeBand(1);
    expect(band("client idle, blackhole, heartbeat 2 s and 1 s, the ws class: terminate()")).toEqual({
      timer: "pong",
      errno: "DROPPED",
      from: "ping-sent",
      low,
      high,
      drop: "close",
    });
    expect(cell("client idle, blackhole, heartbeat 2 s and 1 s, the ws class: terminate()").probe.ws?.socket).toBe("ws");
  });

  it("predicts each wait of the reconnect from its backoff: 0.5 s, then 1 s and 2 s after each refusal", () => {
    expect(waits("client idle, blackhole, heartbeat 2 s and 1 s")).toEqual([nodeBand(0.5)]);
    expect(waits("client idle, fin of the server, three tries refused")).toEqual([nodeBand(0.5), nodeBand(1), nodeBand(2)]);
    // a cell on the server side has a client that does not reconnect
    expect(waits("server, a reply in flight, blackhole, tcp_retries2 = 3, server heartbeat off")).toEqual([]);
  });

  it("lets the kernel win where its timer is shorter: the give-up at tcp_retries2 = 3, and the keepalive of undici without a heartbeat", () => {
    expect(band("client idle, blackhole, tcp_retries2 = 3, heartbeat 2 s and 10 s")).toMatchObject({
      timer: "retrans_giveup",
      errno: "ETIMEDOUT",
      from: "first-retransmission",
      low: 3,
    });
    // undici sets 60 s on the socket, and libuv 10 probes 1 s apart: 70 s from the last segment
    expect(band("client idle, blackhole, heartbeat off")).toMatchObject({ timer: "keepalive", errno: "ETIMEDOUT", from: "last-received" });
    const keepalive = band("client idle, blackhole, heartbeat off") as { low: number; high: number };
    expect(keepalive.low).toBeCloseTo(70, 1);
    expect(keepalive.high).toBeGreaterThan(70);
  });

  it("predicts a reset and a FIN at once, and a stall that the heartbeat outlasts", () => {
    expect(band("client idle, rst, heartbeat 2 s and 1 s")).toEqual({ timer: "rx.rst", errno: "ECONNRESET", from: "ping-sent", low: 0, high: 0.001 });
    expect(band("client idle, fin of the server, three tries refused")).toEqual({ timer: "rx.fin", errno: "EOF", from: "peer-closed", low: 0, high: 0.001 });
    // the ping goes into a 1 s stall: its third firing gets through, and the pong comes back before the 3 s timeout
    expect(band("client idle, a 1 s stall, heartbeat 2 s and 3 s")).toMatchObject({ firing: 3, window: 5 });
    expect(cell("client idle, a 1 s stall, heartbeat 2 s and 3 s").stall).toEqual({ value: 1, unit: "s" });
  });

  it("predicts the heartbeat of the server two beats after its first ping without an answer, and the kernel without it", () => {
    const beats = band("server idle, blackhole, server heartbeat 1 s and 2 misses");
    expect(beats).toEqual({
      timer: "heartbeat",
      errno: "DROPPED",
      from: "ping-sent",
      low: round(2 - 2 * nodeEarlySeconds(HZ)),
      high: round(2 + 2 * nodeLateSeconds(1, HZ)),
      drop: "close",
    });
    expect(cell("server idle, blackhole, server heartbeat 1 s and 2 misses").target.command).toEqual([
      "node",
      "/opt/harness/procedures/server-ws.mjs",
      "--port",
      "8080",
      "--tcp-keepalive",
      "off",
      "--heartbeat",
      "on",
      "--heartbeat-interval-ms",
      "1000",
      "--heartbeat-misses",
      "2",
    ]);
    expect(band("server idle, blackhole, server heartbeat off")).toEqual({ silent: 20 });
    expect(band("server, a reply in flight, blackhole, tcp_retries2 = 3, server heartbeat off")).toMatchObject({ timer: "retrans_giveup", errno: "ETIMEDOUT", low: 3 });
  });

  it("gives each setting of the client, of the server, and each knob of Linux TCP at the observer", () => {
    const idle = cell("client idle, blackhole, heartbeat 2 s and 1 s");
    expect(idle.probe.ws).toEqual({
      socket: "global",
      heartbeat: { interval: { value: 2000, unit: "ms" }, timeout: { value: 1000, unit: "ms" }, misses: 1 },
      reconnect: { initialDelay: { value: 500, unit: "ms" }, multiplier: 2, maxDelay: { value: 4000, unit: "ms" }, attempts: 10, jitter: 0 },
      requestTimeout: { value: 60_000, unit: "ms" },
      connectionTimeout: { value: 10_000, unit: "ms" },
    });
    expect(idle.sysctls).toMatchObject({ "net.ipv4.tcp_retries2": "8" });
    expect(idle.target.command).toContain("--heartbeat");
    const server = cell("server, a reply in flight, blackhole, tcp_retries2 = 3, server heartbeat off");
    expect(server).toMatchObject({ observer: "server", targetSysctls: { "net.ipv4.tcp_retries2": "3" }, sysctls: {} });
    expect(server.probe.ws).toMatchObject({ heartbeat: null, reconnect: null, hold: { value: 2000, unit: "ms" } });
    // a FIN of the server ends its environment: each run has its own, and a shell holds the server
    const fin = cell("client idle, fin of the server, three tries refused");
    expect(fin.environments).toBe(11);
    expect(fin.target.kill).toBeDefined();
  });
});

describe("the subject of the WS catalog", () => {
  const caller: Subject = {
    name: "procedures",
    image: { kind: "pinned", image: `ghcr.io/owner/procedures-subject:0.8.0@sha256:${"ab".repeat(32)}` },
    base: NODE_IMAGE,
    programs: { client: ["node", "/opt/subject/client-ws.mjs"], server: ["node", "/opt/subject/server-ws.mjs"] },
  };

  it("runs on the subject that the harness ships, whose base is the Node image of the catalogs", () => {
    expect(SUBJECTS.procedures.base).toBe(NODE_IMAGE);
    expect(wsCells(SUBJECTS.procedures)).toEqual(WS_CELLS);
  });

  it("runs each cell on a subject that a caller gives, with the same settings and the same predictions", () => {
    const cells = wsCells(caller);
    expect(cells.map((each) => each.name)).toEqual(WS_CELLS.map((each) => each.name));
    for (const [at, each] of cells.entries()) {
      const shipped = WS_CELLS[at]!;
      expect(each.client, each.name).toEqual({ image: caller.image, command: ["node", "/opt/subject/client-ws.mjs"] });
      expect(each.target.subject, each.name).toEqual(caller.image);
      expect(each.target.image, each.name).toBe(NODE_IMAGE);
      // the server of the caller gets the settings of the cell, as the shipped server does
      const command = (each.target.command ?? []).join(" ");
      expect(command, each.name).toBe((shipped.target.command ?? []).join(" ").replaceAll("/opt/harness/procedures/", "/opt/subject/"));
      expect({ ...each, client: shipped.client, target: shipped.target }, each.name).toEqual(shipped);
    }
  });
});
