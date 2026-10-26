import type { ClientHttp2Session, IncomingHttpHeaders } from "node:http2";
import { connect, createServer } from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { realClock } from "../clock.ts";
import type { HttpKnobs, HttpTransport, RequestHandler } from "../http.ts";
import { httpTransport } from "../http.ts";
import { detachedLifecycle } from "../testing.ts";

/**
 * The ./http entry on a server of node:http2 without TLS (h2c), on real sockets of the loopback,
 * opt-in with HTTP_IT=1 (.github/workflows/http.yml). HTTP/2 has no Connection header, thus each close
 * of a connection is a GOAWAY on its session. These tests do not measure time.
 */

const RUN = process.env["HTTP_IT"] === "1";
const HOST = "127.0.0.1";
const s = (value: number) => ({ value, unit: "s" });
const ms = (value: number) => ({ value, unit: "ms" });
const KNOBS: HttpKnobs = { server_idle_close: s(5), server_idle_sweep_interval: ms(200), server_retry_after: s(1) };

const now = (): number => performance.now();
const sleep = (time: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, time));
const until = async (test: () => boolean, bound = 2000, what = "the condition"): Promise<void> => {
  const end = now() + bound;
  while (!test()) {
    if (now() > end) throw new Error(`${what} did not come in ${bound} ms`);
    await sleep(2);
  }
};

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** This function sends one GET on a session, and gives its answer. */
const get = (session: ClientHttp2Session, path = "/work"): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const stream = session.request({ ":path": path });
    let headers: IncomingHttpHeaders = {};
    let body = "";
    stream.setEncoding("utf8");
    stream.on("response", (given) => {
      headers = given;
    });
    stream.on("data", (chunk: string) => {
      body += chunk;
    });
    stream.on("end", () => resolve({ status: Number(headers[":status"]), headers, body }));
    stream.on("error", reject);
    stream.end();
  });

/** A session of the client with the GOAWAY frames that it got. */
interface Followed {
  readonly session: ClientHttp2Session;
  readonly goaways: Array<{ readonly code: number; readonly last: number }>;
  closed: boolean;
}

const opened: ClientHttp2Session[] = [];
const transports: HttpTransport<ReturnType<typeof createServer>>[] = [];
const warnings: string[] = [];
const onWarning = (warning: Error): void => {
  warnings.push(warning.message);
};
process.on("warning", onWarning);

afterEach(async () => {
  for (const session of opened.splice(0)) session.destroy();
  for (const transport of transports.splice(0)) await transport.close();
});

/** This function starts a transport on a server of node:http2 with one handler, on a free port. */
const started = async (handler: RequestHandler, keepAlive?: () => boolean) => {
  const server = createServer();
  const transport = httpTransport(server, KNOBS, { listen: { port: 0, host: HOST }, ...(keepAlive === undefined ? {} : { keepAlive }) });
  transports.push(transport);
  transport.mount(handler);
  await transport.start(new AbortController().signal, detachedLifecycle());
  const { port } = server.address() as AddressInfo;
  const follow = (): Followed => {
    const session = connect(`http://${HOST}:${port}`);
    opened.push(session);
    const followed: Followed = { session, goaways: [], closed: false };
    session.on("goaway", (code, last) => followed.goaways.push({ code, last }));
    session.on("close", () => {
      followed.closed = true;
    });
    session.on("error", () => {});
    return followed;
  };
  return { server, transport, follow };
};

const ok: RequestHandler = (_req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("served");
  return true;
};

describe.runIf(RUN)("a transport on a server of HTTP/2 (h2c)", () => {
  it("answers each stream of one session through its mount, and the session stays open", async () => {
    const { follow, transport } = await started(ok);
    const client = follow();
    const answers = [await get(client.session), await get(client.session), await get(client.session)];
    expect(answers.map((answer) => [answer.status, answer.body])).toEqual([
      [200, "served"],
      [200, "served"],
      [200, "served"],
    ]);
    expect(client.goaways).toEqual([]);
    expect(transport.connections).toBe(1);
  });

  it("sends GOAWAY while the transport cannot keep the connection, and the stream of that answer still ends", async () => {
    let keeps = true;
    const { follow } = await started(ok, () => keeps);
    const client = follow();
    expect((await get(client.session)).status).toBe(200);
    keeps = false;
    const answer = await get(client.session);
    // the answer comes on the stream that the GOAWAY names as the last one, with no Connection header
    expect([answer.status, answer.body, answer.headers["connection"]]).toEqual([200, "served", undefined]);
    await until(() => client.goaways.length > 0, 2000, "the GOAWAY");
    expect(client.goaways[0]).toEqual({ code: 0, last: 3 });
    await until(() => client.closed, 2000, "the close of the session");
    // a new session goes through the listener again
    keeps = true;
    const next = follow();
    expect((await get(next.session)).status).toBe(200);
    expect(warnings.filter((warning) => /connection header/i.test(warning))).toEqual([]);
  });

  it("gives Connection: close of a handler as a GOAWAY, and each 503 keeps its Retry-After", async () => {
    const failing: RequestHandler = (_req, res) => {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      res.end("cannot serve");
      return true;
    };
    const { follow } = await started(failing);
    const client = follow();
    const answer = await get(client.session);
    expect([answer.status, answer.headers["retry-after"], answer.headers["connection"]]).toEqual([503, "1", undefined]);
    await until(() => client.goaways.length > 0, 2000, "the GOAWAY");
    expect(client.goaways[0]?.code).toBe(0);
    expect(warnings.filter((warning) => /connection header/i.test(warning))).toEqual([]);
  });

  it("sends GOAWAY on each session at the stop of the intake, the busy ones too, and the drain waits for their streams", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: RequestHandler = async (req, res) => {
      if (req.url === "/slow") await held;
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("served");
      return true;
    };
    const { follow, transport } = await started(slow);
    const idle = follow();
    const busy = follow();
    expect((await get(idle.session)).status).toBe(200);
    const pending = get(busy.session, "/slow");
    await until(() => transport.inFlight() === 1, 2000, "the slow stream");
    transport.stopIntake();
    await until(() => idle.goaways.length > 0 && busy.goaways.length > 0, 2000, "the GOAWAY of each session");
    await until(() => idle.closed, 2000, "the close of the idle session");
    let drained = false;
    const drain = Promise.resolve(transport.drain(realClock.now() + 5000, new AbortController().signal)).then(() => {
      drained = true;
    });
    await sleep(50);
    expect(drained).toBe(false);
    release();
    expect((await pending).status).toBe(200);
    await drain;
    expect(transport.inFlight()).toBe(0);
    await until(() => busy.closed, 2000, "the close of the busy session");
  });

  it("destroys each session at the close, and the count of connections goes to 0", async () => {
    const { follow, transport } = await started(ok);
    const client = follow();
    expect((await get(client.session)).status).toBe(200);
    expect(transport.connections).toBe(1);
    await transport.close();
    await until(() => client.closed, 2000, "the close of the session");
    expect(transport.connections).toBe(0);
  });
});
