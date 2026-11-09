import { algebraProblems, machineProblems } from "@mark1russell7/algebra";
import { DROP_HANDLING } from "@mark1russell7/harness";
import { SOCKETIO_CLIENT, SOCKETIO_SERVER, nodeEarlySeconds, nodeLateSeconds } from "@mark1russell7/machines";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { ALL, SCHEDULED_CELLS } from "./all.ts";
import { HZ, count } from "./catalog.ts";
import { NODE_IMAGE } from "./http/cells.ts";
import {
  DELIVERY_SPECS,
  PING,
  SOCKETIO,
  SOCKETIO_CELLS,
  SOCKETIO_SPECS,
  STALL,
  STAYING_CLIENT,
  clientValues,
  predictSocketIoAt,
} from "./socketio.ts";

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
      expect(band(name), name).toEqual({ timer: "ping", errno: "DROPPED", from: "pong-sent", low, high, drop: "frame" });
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
    expect(target.command).toEqual(["node", "/srv/server.ts", "--port", "8080", "--ping-interval-ms", "2000", "--ping-timeout-ms", "1000", "--recovery", "off"]);
    expect(cell("client idle, fin of the server, three tries refused").target).toHaveProperty("kill");
    expect(cell("client idle, blackhole, ping 2 s and 1 s").probe.ws?.reconnect).toMatchObject({ multiplier: 2, attempts: 10, jitter: 0 });
    expect(cell("server idle, blackhole, ping 2 s and 1 s").probe.ws?.reconnect).toBeNull();
  });

  it("gives a client with no reconnect no delay, no attempts and no jitter", () => {
    const spec = { ...SOCKETIO_SPECS[0]!, client: STAYING_CLIENT };
    const values = clientValues(spec);
    expect(values("reconnection_delay")).toEqual({ value: "infinite", unit: "ms" });
    expect(values("reconnection_delay_max")).toEqual({ value: "infinite", unit: "ms" });
    expect(values("reconnection_attempts")).toEqual({ value: 0, unit: "count" });
    expect(values("randomization_factor")).toEqual({ value: 0, unit: "count" });
  });

  it("lets the kernel give up a call in flight before a slow ping timer, with ETIMEDOUT from its first retransmission", () => {
    const inflight = SOCKETIO_SPECS.find((each) => each.mode === "inflight")!;
    const spec = { ...inflight, server: { pingInterval: 60_000, pingTimeout: 60_000, recovery: null }, linux: { tcp_retries2: count(3) } };
    const p = predictSocketIoAt(spec, 1);
    expect(p).toMatchObject({ detects: true, errno: "ETIMEDOUT", from: "first-retransmission" });
    if (p.detects !== true) throw new Error("detects");
    expect(p.timer).not.toBe("ping");
    expect(p.high.value).toBeLessThan(120);
  });
});

describe("the delivery cells of Socket.IO", () => {
  const delivery = (name: string) => {
    const p = cell(name).prediction;
    if (p.detects !== true || p.delivery === undefined) throw new Error(`${name} has no delivery law`);
    return p.delivery;
  };
  const D1 = "D1 the server streams, no recovery, stall 5.6 s";
  const D2 = "D2 the server streams, recovery 30 s, stall 5.6 s";
  const D4 = "D4 the server streams, recovery 2 s, stall 5.6 s";
  const U1 = "U1 the client streams, no retries, stall 5.6 s";
  const U2 = "U2 the client streams, 3 retries, stall 5.6 s";
  const U3 = "U3 the client streams, 2 retries, stall 5.6 s";
  const spec = (name: string) => DELIVERY_SPECS.find((each) => each.name === name)!;

  it("streams across a stall of 5.6 s from the signal, and times the drop from the last pong", () => {
    const [low, high] = dropBand(3);
    expect(DELIVERY_SPECS).toHaveLength(6);
    for (const each of DELIVERY_SPECS) {
      const c = cell(each.name);
      expect(c).toMatchObject({ fault: "stall", stall: { value: STALL, unit: "s" } });
      expect(c.probe).toMatchObject({ mode: "stream", count: each.stream!.count, interval: { value: 100, unit: "ms" }, sender: each.stream!.sender });
      expect(band(each.name), each.name).toEqual({ timer: "ping", errno: "DROPPED", from: "pong-sent", low, high, drop: "frame" });
      expect(waits(each.name)).toEqual([nodeBand(0.5)]);
    }
  });

  it("starts the server with its recovery, and gives the retries of a client sender to the client", () => {
    const recoveryOf = (name: string) => cell(name).target.command?.at(-1);
    expect([D1, D2, D4, U1].map(recoveryOf)).toEqual(["off", "30000", "2000", "off"]);
    expect(cell(U1).probe.ws).not.toHaveProperty("retries");
    expect(cell(U2).probe.ws).toMatchObject({ retries: 3, requestTimeout: { value: 1000, unit: "ms" } });
    expect(cell(U3).probe.ws).toMatchObject({ retries: 2 });
  });

  it("loses each event of the server from the fault to the new connection, unless the session is restored", () => {
    const lost = delivery(D1).lost;
    // the fault 0.25 s to 0.6 s after the pong, the join from the fourth SYN at 6.5 s: 5.9 s to 6.6 s of events, one each 100 ms
    expect(lost.low).toBeGreaterThanOrEqual(55);
    expect(lost.high).toBeLessThanOrEqual(70);
    expect(lost.high - lost.low).toBeLessThanOrEqual(10);
    expect(delivery(D1)).toMatchObject({ duplicates: { low: 0, high: 0 }, recovered: false });
    expect(delivery(D2)).toEqual({ lost: { low: 0, high: 0 }, duplicates: { low: 0, high: 0 }, recovered: true });
    // a recovery of 2 s ends near 5 s, before the new connection
    expect(delivery(D4)).toEqual({ ...delivery(D1), recovered: false });
  });

  it("loses each event of the client into the black hole up to its drop, and keeps the later ones in the send buffer", () => {
    const { lost, duplicates } = delivery(U1);
    // from the signal to the drop at 3 s: 2.4 s to 2.75 s of events
    expect(lost.low).toBeGreaterThanOrEqual(20);
    expect(lost.high).toBeLessThanOrEqual(30);
    expect(duplicates).toEqual({ low: 0, high: 0 });
    expect(delivery(U1)).not.toHaveProperty("recovered");
  });

  it("keeps an event through 3 failed tries with 3 retries, and loses it with 2", () => {
    // 2 ack timeouts before the drop, and the drop fails the third try
    expect(delivery(U2).lost).toEqual({ low: 0, high: 0 });
    expect(delivery(U3).lost).toEqual({ low: 1, high: 1 });
  });

  it("refuses a stall that ends in the bounds of a SYN, a session that ends at the new connection, and an ack timeout at the drop", () => {
    expect(() => predictSocketIoAt({ ...spec(D1), stall: 5.1 }, 1)).toThrow(/bounds of a SYN/);
    expect(() => predictSocketIoAt({ ...spec(D2), server: { ...PING, recovery: 3500 } }, 1)).toThrow(/session can end/);
    expect(() => predictSocketIoAt({ ...spec(U2), client: { ...spec(U2).client, requestTimeout: 1300 } }, 1)).toThrow(/ack timeout 2/);
    expect(() => predictSocketIoAt({ ...spec(U3), stream: { ...spec(U3).stream!, count: 1 } }, 1)).toThrow(/last of the stream/);
  });
});
