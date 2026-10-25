import { EventEmitter } from "node:events";
import net from "node:net";
import { describe, expect, it } from "vitest";
import { followSocket, gapOf } from "./client-lines.ts";

/** the local port of a socket of Node, as client-grpc.mjs reads it */
const portOf = (socket: net.Socket): number | null => socket.localPort ?? null;

/** a server on the loopback that runs `onSocket` for each connection, and its port */
const serve = async (onSocket: (socket: net.Socket) => void): Promise<{ readonly server: net.Server; readonly port: number }> => {
  const server = net.createServer(onSocket);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as net.AddressInfo).port };
};

/** this function waits for the close of a socket */
const closed = (socket: net.Socket): Promise<void> => new Promise((resolve) => socket.once("close", () => resolve()));

describe("the socket lines of the gRPC client", () => {
  it("writes the connect and the close of a socket with its local port, and no error at a FIN of the peer", async () => {
    const { server, port } = await serve((socket) => socket.end());
    const lines: Array<Record<string, unknown>> = [];
    let clock = 100;
    const socket = net.connect(port, "127.0.0.1");
    followSocket(socket, () => portOf(socket), (line) => lines.push(line), () => (clock += 1));
    await closed(socket);
    server.close();
    expect(lines.map((line) => line["what"])).toEqual(["connect", "close"]);
    const [connect, close] = lines;
    expect(connect).toMatchObject({ ev: "sock", what: "connect", t: 101 });
    expect(typeof connect!["lp"]).toBe("number");
    // the close keeps the port of the connect: a closed handle has none
    expect(close).toEqual({ ev: "sock", what: "close", t: 102, lp: connect!["lp"], err: null });
  });

  it("gives the code of the error of a socket that the peer resets", async () => {
    const { server, port } = await serve((socket) => socket.resetAndDestroy());
    const lines: Array<Record<string, unknown>> = [];
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => {});
    followSocket(socket, () => portOf(socket), (line) => lines.push(line), () => 1);
    // a write after the reset makes the error certain on each platform
    socket.once("connect", () => socket.write("x"));
    await closed(socket);
    server.close();
    expect(lines.at(-1)).toMatchObject({ ev: "sock", what: "close", err: expect.stringMatching(/^E[A-Z]+$/) });
  });

  it("writes a close with no port for a socket that never connects", async () => {
    const { server, port } = await serve(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const lines: Array<Record<string, unknown>> = [];
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => {});
    followSocket(socket, () => null, (line) => lines.push(line), () => 7);
    await closed(socket);
    expect(lines).toEqual([{ ev: "sock", what: "close", t: 7, lp: null, err: "ECONNREFUSED" }]);
  });

  it("gives the local address of a socket at its connect, when it can read it", async () => {
    const { server, port } = await serve((socket) => socket.end());
    const lines: Array<Record<string, unknown>> = [];
    const socket = net.connect(port, "127.0.0.1");
    followSocket(socket, () => portOf(socket), (line) => lines.push(line), () => 1, () => socket.localAddress ?? null);
    await closed(socket);
    server.close();
    expect(lines[0]).toMatchObject({ ev: "sock", what: "connect", la: "127.0.0.1" });
    // the close line has no address
    expect(lines[1]).not.toHaveProperty("la");
  });
});

describe("the gap of the gRPC client", () => {
  it("stops the calls at SIGUSR1 and starts them again at SIGUSR2, with a line at each signal", () => {
    const process = new EventEmitter();
    const lines: Array<Record<string, unknown>> = [];
    let clock = 0;
    const gap = gapOf((signal, listener) => process.on(signal, listener), (line) => lines.push(line), () => (clock += 10));
    expect(gap.stopped).toBe(false);
    process.emit("SIGUSR1");
    expect(gap.stopped).toBe(true);
    // a second stop changes nothing, and it writes its line
    process.emit("SIGUSR1");
    expect(gap.stopped).toBe(true);
    process.emit("SIGUSR2");
    expect(gap.stopped).toBe(false);
    expect(lines).toEqual([
      { ev: "gap", what: "stop", t: 10 },
      { ev: "gap", what: "stop", t: 20 },
      { ev: "gap", what: "start", t: 30 },
    ]);
    // with no channel, SIGHUP has no listener of the gap
    expect(process.listenerCount("SIGHUP")).toBe(0);
  });

  it("closes the channel at SIGHUP, and opens a new one at the next SIGUSR2", () => {
    const process = new EventEmitter();
    const lines: Array<Record<string, unknown>> = [];
    const acts: string[] = [];
    let clock = 0;
    const channel = { close: () => acts.push("close"), open: () => acts.push("open") };
    const gap = gapOf((signal, listener) => process.on(signal, listener), (line) => lines.push(line), () => (clock += 10), channel);
    process.emit("SIGHUP");
    expect(gap).toEqual({ stopped: true, closed: true });
    // a second SIGHUP does not close the channel again
    process.emit("SIGHUP");
    process.emit("SIGUSR2");
    expect(gap).toEqual({ stopped: false, closed: false });
    // a SIGUSR2 with an open channel opens no channel
    process.emit("SIGUSR1");
    process.emit("SIGUSR2");
    expect(acts).toEqual(["close", "open"]);
    expect(lines).toEqual([
      { ev: "gap", what: "close", t: 10 },
      { ev: "gap", what: "close", t: 20 },
      { ev: "gap", what: "start", t: 30, open: true },
      { ev: "gap", what: "stop", t: 40 },
      { ev: "gap", what: "start", t: 50 },
    ]);
  });
});
