import { algebraProblems, machineProblems } from "@mark1russell7/algebra";
import { DROP_HANDLING } from "@mark1russell7/harness";
import { SOCKETIO_CLIENT, SOCKETIO_SERVER, nodeEarlySeconds, nodeLateSeconds } from "@mark1russell7/machines";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { ALL, SCHEDULED_CELLS } from "./all.ts";
import { HZ } from "./catalog.ts";
import { NODE_IMAGE } from "./http/cells.ts";
import { SOCKETIO, SOCKETIO_CELLS, SOCKETIO_SPECS } from "./socketio.ts";

const round = (value: number) => Math.round(value * 1e9) / 1e9;
const cell = (name: string) => {
  const found = SOCKETIO_CELLS.find((each) => each.name === `SIO ${name}`);
  if (found === undefined) throw new Error(`no cell ${name}`);
  return found;
};
const band = (name: string) => {
  const p = cell(name).prediction;
  if (p.detects !== true) throw new Error(`${name} detects`);
  return { timer: p.timer, errno: p.errno, from: p.from, low: p.low.value, high: p.high.value, ...(p.drop === undefined ? {} : { drop: p.drop }) };
};
const waits = (name: string) => {
  const p = cell(name).prediction;
  return p.detects === true ? (p.reconnects?.waits ?? []).map((wait) => [wait.low.value, wait.high.value]) : [];
};
/** the band of a Node timer of `seconds`, at the HZ of the cells */
const nodeBand = (seconds: number) => [round(seconds - nodeEarlySeconds(HZ)), round(seconds + nodeLateSeconds(seconds, HZ))];
/** the band of a drop on a Node timer of `seconds`: the band of the timer, and the handling on its high bound */
const dropBand = (seconds: number) => {
  const [low, high] = nodeBand(seconds);
  return [low!, round(high! + valueIn(DROP_HANDLING, "s"))];
};

describe("the Socket.IO catalog", () => {
  it("reads two documents that the algebra accepts", () => {
    for (const doc of [SOCKETIO_CLIENT, SOCKETIO_SERVER]) {
      expect(machineProblems(doc), doc.id).toEqual([]);
      expect(algebraProblems(doc), doc.id).toEqual([]);
    }
  });

  it("gives each cell a prediction and a name of its own, outside the nightly selection of the WS catalog", () => {
    expect(SOCKETIO_CELLS).toHaveLength(SOCKETIO_SPECS.length);
    expect(new Set(SOCKETIO_CELLS.map((each) => each.name)).size).toBe(SOCKETIO_CELLS.length);
    for (const each of SOCKETIO_CELLS) {
      expect(each.name.startsWith("SIO ")).toBe(true);
      expect(SCHEDULED_CELLS["night"]?.test(each.name), each.name).toBe(false);
      expect(ALL).toContain(each);
      expect(each.client).toEqual({ image: SOCKETIO.image, command: ["node", "/srv/client.ts"] });
      expect(each.target).toMatchObject({ image: NODE_IMAGE, subject: SOCKETIO.image, lines: true });
      expect(each.probe.ws).toMatchObject({ socket: "ws", heartbeat: null });
    }
  });

  it("builds the subject from the folder of its lockfile, on the Node image of the catalogs", () => {
    expect(SOCKETIO.base).toBe(NODE_IMAGE);
    expect(SOCKETIO.image).toMatchObject({ kind: "build", name: "socketio" });
    if (SOCKETIO.image.kind !== "build") throw new Error("a build");
    expect(SOCKETIO.image.files).toEqual(["Dockerfile", "package.json", "npm-lock.json", "lines.ts", "client.ts", "server.ts"]);
  });

  it("predicts the drop by the client pingInterval + pingTimeout after the last ping, where the kernel waits", () => {
    const [low, high] = dropBand(3);
    for (const name of [
      "client idle, blackhole, ping 2 s and 1 s",
      "client, a call in flight, blackhole, ping 2 s and 1 s",
      // the kernel of a frozen server acknowledges each write: only the ping timer finds it
      "client idle, freeze-process of the server, ping 2 s and 1 s",
    ])
      expect(band(name), name).toEqual({ timer: "ping", errno: "DROPPED", from: "last-data", low, high, drop: "frame" });
    // 3 s less 1 ms, and 3 s with 1 ms of slack per second, 1 ms for the loop clock and 1.5 ms of handling
    if (HZ === 250) expect([low, high]).toEqual([2.999, 3.0055]);
  });

  it("predicts the drop by the server pingTimeout after its first ping without an answer", () => {
    const [low, high] = dropBand(1);
    expect(band("server idle, blackhole, ping 2 s and 1 s")).toEqual({ timer: "pong", errno: "DROPPED", from: "ping-sent", low, high, drop: "frame" });
    expect(cell("server idle, blackhole, ping 2 s and 1 s").prediction).not.toHaveProperty("exits");
    expect(cell("server idle, blackhole, ping 2 s and 1 s")).toMatchObject({ observer: "server", sysctls: {} });
  });

  it("tells the harness that the client process ends with the run, thus its end is not a close by the program", () => {
    for (const each of SOCKETIO_CELLS) {
      const p = each.prediction;
      if (p.detects !== true || p.drop === undefined) continue;
      expect(p.exits, each.name).toBe(each.observer === "server" ? undefined : true);
    }
  });

  it("predicts a FIN at once, and each wait of the reconnect from its backoff: 0.5 s, then 1 s and 2 s after each refusal", () => {
    expect(band("client idle, fin of the server, three tries refused")).toMatchObject({ from: "peer-closed", low: 0, high: 0.001 });
    expect(waits("client idle, fin of the server, three tries refused")).toEqual([nodeBand(0.5), nodeBand(1), nodeBand(2)]);
    expect(waits("client idle, blackhole, ping 2 s and 1 s")).toEqual([nodeBand(0.5)]);
    expect(waits("server idle, blackhole, ping 2 s and 1 s")).toEqual([]);
    expect(cell("client idle, fin of the server, three tries refused").environments).toBe(cell("client idle, fin of the server, three tries refused").runs);
  });

  it("starts the server with the times of the ping, and the client with each setting of its reconnect", () => {
    const target = cell("client idle, blackhole, ping 2 s and 1 s").target;
    expect(target.command).toEqual(["node", "/srv/server.ts", "--port", "8080", "--ping-interval-ms", "2000", "--ping-timeout-ms", "1000"]);
    expect(cell("client idle, fin of the server, three tries refused").target).toHaveProperty("kill");
    expect(cell("client idle, blackhole, ping 2 s and 1 s").probe.ws?.reconnect).toMatchObject({ multiplier: 2, attempts: 10, jitter: 0 });
    expect(cell("server idle, blackhole, ping 2 s and 1 s").probe.ws?.reconnect).toBeNull();
  });
});
