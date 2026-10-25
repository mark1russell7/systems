import type { Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { fakeClock } from "../fakes.ts";
import type { HttpKnobs, RequestHandler } from "../http.ts";
import { httpTransport } from "../http.ts";
import { detachedLifecycle } from "../testing.ts";

/**
 * SYS-33: the idle close of the transport on real sockets of the loopback. Node counts a connection
 * idle when its response calls `end()`, while the bytes of the body still go to the client. These
 * tests wait for events and measure no time, thus they run with the unit tests, and http.yml runs
 * them on each version of Node.
 *
 * On Linux and macOS, the bytes that the kernel does not take wait in the write queue of libuv, and
 * a destroy of the socket cancels them. On Windows, the kernel of the loopback takes the whole body:
 * no byte waits in the process, and the tests do not run.
 */

const HOST = "127.0.0.1";
const s = (value: number) => ({ value, unit: "s" });
const KNOBS: HttpKnobs = { server_idle_close: s(65), server_idle_sweep_interval: s(1), server_retry_after: s(2) };
// the body is larger than the buffers of the two sockets in the kernel: its last bytes wait for the client
const BODY = Buffer.alloc(64 * 1024 * 1024, 0x61);

const portOf = (server: Server): number => (server.address() as AddressInfo).port;

/** This function sends a request on a new connection, and the client then does not read its socket. */
const slowClient = async (port: number): Promise<Socket> => {
  const socket = connect({ port, host: HOST });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  socket.on("error", () => {});
  socket.pause();
  socket.write("GET /large HTTP/1.1\r\nHost: test\r\n\r\n");
  return socket;
};

/** This function starts the reads of the client. It gives the count of body bytes at the end of the body, or at the close. */
const readBody = (socket: Socket): Promise<number> =>
  new Promise((resolve) => {
    let head: Buffer | null = Buffer.alloc(0);
    let body = 0;
    const done = (): void => {
      socket.off("data", take);
      resolve(body);
    };
    const take = (chunk: Buffer): void => {
      if (head === null) body += chunk.length;
      else {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        body = head.length - end - 4;
        head = null;
      }
      if (body >= BODY.length) done();
    };
    socket.on("data", take);
    socket.once("close", done);
    socket.resume();
  });

/** This handler ends a large body at once, or after its release, and gives its response. */
const largeAnswer = (held: boolean) => {
  let release: () => void = () => {};
  let arrived: () => void = () => {};
  let ended: (res: ServerResponse) => void = () => {};
  const handler: RequestHandler = async (_req, res) => {
    arrived();
    if (held) await new Promise<void>((resolve) => (release = resolve));
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(BODY.length) });
    res.end(BODY);
    ended(res);
    return true;
  };
  return {
    handler,
    release: () => release(),
    arrived: new Promise<void>((resolve) => (arrived = resolve)),
    ended: new Promise<ServerResponse>((resolve) => (ended = resolve)),
  };
};

const started = async () => {
  const server = createServer();
  const clock = fakeClock();
  const transport = httpTransport(server, KNOBS, { listen: { port: 0, host: HOST }, clock });
  await transport.start(new AbortController().signal, detachedLifecycle());
  return { server, clock, transport };
};

describe.skipIf(process.platform === "win32")("the idle close keeps each connection whose answer still goes (SYS-33)", () => {
  it("gives the whole body to a slow client when the intake stops after the end of the response", async () => {
    const { server, transport } = await started();
    const answer = largeAnswer(false);
    transport.mount(answer.handler);
    const client = await slowClient(portOf(server));
    try {
      const res = await answer.ended;
      // the precondition: the response ended, and its bytes did not all go
      expect([res.writableEnded, res.writableFinished]).toEqual([true, false]);
      transport.stopIntake();
      expect(await readBody(client)).toBe(BODY.length);
    } finally {
      client.destroy();
      await transport.close();
    }
  });

  it("gives the whole body to a slow client when a sweep comes after the end of the response", async () => {
    const { server, clock, transport } = await started();
    const answer = largeAnswer(true);
    transport.mount(answer.handler);
    const client = await slowClient(portOf(server));
    try {
      await answer.arrived;
      transport.stopIntake();
      answer.release();
      const res = await answer.ended;
      expect([res.writableEnded, res.writableFinished]).toEqual([true, false]);
      // the sweep after the stop of the intake
      await clock.advance(1000);
      expect(await readBody(client)).toBe(BODY.length);
    } finally {
      client.destroy();
      await transport.close();
    }
  });
});
