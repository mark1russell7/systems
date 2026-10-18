import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Controller } from "../description.ts";
import { fakeClock } from "../fakes.ts";
import { endRecord, handle, httpTransport, ndjson, outcomeResponse, pathOf, sse, writeOutcome } from "../http.ts";
import type { HttpKnobs, MountContext, OutcomeOptions, RequestHandler } from "../http.ts";
import type { Lifecycle } from "../lifecycle.ts";
import { detachedLifecycle } from "../testing.ts";
import type { RequestEnd, RequestStream } from "../requests.ts";
import { tracker } from "../requests.ts";
import { FakeResponse, FakeServer, FakeSocket, pushedSource } from "./fake-server.ts";

/** SYS-3: the stream of a request as a response: a status, Retry-After, Connection: close and a body, unary or a stream. */

const s = (value: number) => ({ value, unit: "s" });
const OPTIONS: OutcomeOptions<unknown> = { keepAlive: true, retryAfter: s(1.2) };
const done = (delivered: number): RequestEnd => ({ kind: "done", delivered });

const controllers: Controller[] = [
  { name: "api", requires: [], routes: { "GET /work": { idempotent: true }, "POST /once": { idempotent: false } } },
];
const hang = (): Promise<never> => new Promise<never>(() => {});
const turns = async (count = 6): Promise<void> => {
  for (let at = 0; at < count; at += 1) await new Promise((resolve) => setImmediate(resolve));
};

const pushed = pushedSource;

describe("outcomeResponse: a unary request as a response", () => {
  it("gives 200 and JSON for a value, text for a string, bytes for bytes, and 204 for no value", () => {
    expect(outcomeResponse([{ id: 1 }], done(1), OPTIONS)).toEqual({
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: '{"id":1}',
    });
    expect(outcomeResponse(["pod-a"], done(1), OPTIONS).headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(outcomeResponse([new Uint8Array([1])], done(1), OPTIONS).headers["content-type"]).toBe("application/octet-stream");
    expect(outcomeResponse([undefined], done(1), OPTIONS)).toEqual({ status: 204, headers: {}, body: "" });
    expect(outcomeResponse([], done(0), OPTIONS)).toEqual({ status: 204, headers: {}, body: "" });
  });

  it("gives 500 with no detail for a failure of the route, and the failed hook can change it", () => {
    const failed: RequestEnd = { kind: "failed", error: new Error("the password is hunter2"), delivered: 0 };
    const plain = outcomeResponse([], failed, OPTIONS);
    expect([plain.status, plain.body, plain.headers["retry-after"]]).toEqual([500, '{"end":"failed","delivered":0}', undefined]);
    const hooked = outcomeResponse([], failed, { ...OPTIONS, failed: () => ({ status: 502, body: "upstream" }) });
    expect([hooked.status, hooked.body]).toEqual([502, "upstream"]);
  });

  it("gives 500 to a unary route whose work gave more than one value", () => {
    const many = outcomeResponse([1, 2], done(2), OPTIONS);
    expect([many.status, many.headers["retry-after"]]).toEqual([500, undefined]);
  });

  it("adds Connection: close while the service cannot keep the connection, and reads a function each time", () => {
    let keep = true;
    const options: OutcomeOptions<string> = { keepAlive: () => keep, retryAfter: s(0) };
    expect(outcomeResponse(["x"], done(1), options).headers["connection"]).toBeUndefined();
    keep = false;
    expect(outcomeResponse(["x"], done(1), options).headers["connection"]).toBe("close");
  });

  it("lets the done hook give the status, the headers and the body of a value", () => {
    const response = outcomeResponse([7], done(1), { ...OPTIONS, done: (value) => ({ status: 201, headers: { location: `/v/${String(value)}` } }) });
    expect(response).toEqual({ status: 201, headers: { "content-type": "application/json; charset=utf-8", location: "/v/7" }, body: "7" });
  });

  it("gives each 503 of a hook Retry-After, and takes Retry-After from each 500 of a hook", () => {
    const failed: RequestEnd = { kind: "failed", error: new Error("x"), delivered: 0 };
    expect(outcomeResponse([], failed, { ...OPTIONS, failed: () => ({ status: 503 }) }).headers["retry-after"]).toBe("2");
    expect(outcomeResponse([], failed, { ...OPTIONS, failed: () => ({ headers: { "retry-after": "9" } }) }).headers["retry-after"]).toBeUndefined();
  });
});

describe("Retry-After on each 503 and on no 500, from the streams of the request tracker (RFC 9110, S6 A12)", () => {
  /** This function gives the real end of each path, from a tracker on the fake clock. */
  const paths = async (): Promise<Array<[string, { items: readonly unknown[]; end: RequestEnd }]>> => {
    const clock = fakeClock();
    const starting = tracker(controllers, clock, () => "the service has not started");
    const startup = await starting.request("api", "GET /work", () => "x").collect();
    const running = tracker(controllers, clock, () => null);
    const again = running.request("api", "GET /work", hang).collect();
    const once = running.request("api", "POST /once", hang).collect();
    const source = pushed<string>();
    const streamed = running.request("api", "GET /work", () => source.iterable);
    const reader = streamed[Symbol.asyncIterator]();
    source.push("first");
    const first = await reader.next();
    running.stopIntake();
    const stopped = await running.request("api", "GET /work", () => "x").collect();
    const drained = running.drain(clock.now() + 1000);
    await clock.advance(1000);
    await drained;
    const late = await reader.next();
    const failing = tracker(controllers, clock, () => null);
    const failed = await failing
      .request("api", "POST /once", () => {
        throw new Error("the route failed");
      })
      .collect();
    return [
      ["the refusal at the startup", startup],
      ["the refusal after the intake stopped", stopped],
      ["the retryable cut of an idempotent route", await again],
      ["the cut of a route that is not idempotent", await once],
      ["a failure of the route", failed],
      [
        "a cut of a stream after its first item, in a unary response",
        { items: [(first.value as { value: string }).value], end: late.value as RequestEnd },
      ],
    ];
  };

  it("gives each path the status and the Retry-After of its rule", async () => {
    const answers = (await paths()).map(([path, { items, end }]) => {
      const response = outcomeResponse(items, end, OPTIONS);
      return [path, response.status, response.headers["retry-after"]];
    });
    expect(answers).toEqual([
      ["the refusal at the startup", 503, "2"],
      ["the refusal after the intake stopped", 503, "2"],
      ["the retryable cut of an idempotent route", 503, "2"],
      ["the cut of a route that is not idempotent", 500, undefined],
      ["a failure of the route", 500, undefined],
      // no byte went before the end, thus the cut of an idempotent route gets its status and Retry-After
      ["a cut of a stream after its first item, in a unary response", 503, "2"],
    ]);
  });

  it("writes the same header to the response of node:http on each path", async () => {
    for (const [path, { items, end }] of await paths()) {
      const res = new FakeResponse(new FakeSocket());
      const stream: RequestStream<unknown> = {
        async *[Symbol.asyncIterator]() {
          for (const value of items) yield { kind: "item" as const, value };
          yield end;
        },
        collect: async () => ({ items, end }),
      };
      await writeOutcome(res as unknown as ServerResponse, stream, OPTIONS);
      expect(res.getHeader("retry-after"), path).toBe(res.statusCode === 503 ? "2" : undefined);
    }
  });
});

describe("writeOutcome: the stream of a request on a response of node:http", () => {
  const response = () => {
    const socket = new FakeSocket();
    return { socket, res: new FakeResponse(socket) };
  };
  const write = <T>(res: FakeResponse, stream: RequestStream<T>, options: OutcomeOptions<T>) =>
    writeOutcome(res as unknown as ServerResponse, stream, options);

  it("writes a unary value with its status, its headers and the length of its body", async () => {
    const { res } = response();
    const end = await write(res, tracker(controllers, fakeClock(), () => null).request("api", "GET /work", () => "héllo"), OPTIONS);
    expect(end).toEqual(done(1));
    expect([res.statusCode, res.getHeader("content-length"), res.chunks.join("")]).toEqual([200, "6", "héllo"]);
  });

  it("writes each item of a stream as it comes, and its end in-band with no status of its own", async () => {
    const { res } = response();
    const source = pushed<{ row: number }>();
    const writing = write(res, tracker(controllers, fakeClock(), () => null).request("api", "GET /work", () => source.iterable), { ...OPTIONS, stream: ndjson });
    source.push({ row: 1 });
    await turns();
    // the status goes with the first item, and the first item goes before the second comes
    expect([res.statusCode, res.headersSent, res.getHeader("content-type"), res.chunks]).toEqual([200, true, "application/x-ndjson; charset=utf-8", ['{"row":1}\n']]);
    source.push({ row: 2 });
    source.finish();
    expect(await writing).toEqual(done(2));
    expect(res.chunks).toEqual(['{"row":1}\n', '{"row":2}\n', '{"end":"done","delivered":2}\n']);
  });

  it("ends a stream that the shutdown cuts after its first item in-band: the status stays 200, with no Retry-After", async () => {
    const { res } = response();
    const clock = fakeClock();
    const requests = tracker(controllers, clock, () => null);
    const source = pushed<string>();
    const writing = write(res, requests.request("api", "GET /work", () => source.iterable), { ...OPTIONS, stream: ndjson });
    source.push("a");
    await turns();
    requests.stopIntake();
    const drained = requests.drain(clock.now() + 1000);
    await clock.advance(1000);
    await drained;
    const end = await writing;
    expect(end).toMatchObject({ kind: "cut", status: null, retryable: true, delivered: 1 });
    expect([res.statusCode, res.getHeader("retry-after")]).toEqual([200, undefined]);
    expect(res.chunks.at(-1)).toBe('{"end":"cut","delivered":1,"retryable":true,"cause":"the drain reached its deadline"}\n');
    expect(source.returned).toBe(true);
  });

  it("ends a stream whose work fails after its first item in-band, with no detail", async () => {
    const { res } = response();
    const source = pushed<string>();
    const writing = write(res, tracker(controllers, fakeClock(), () => null).request("api", "GET /work", () => source.iterable), { ...OPTIONS, stream: sse });
    source.push("a");
    await turns();
    source.fail(new Error("a secret"));
    expect(await writing).toMatchObject({ kind: "failed", delivered: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.chunks).toEqual(['data: "a"\n\n', 'event: end\ndata: {"end":"failed","delivered":1}\n\n']);
  });

  it("gives a stream refused before its first item a status: 503 with Retry-After", async () => {
    const { res } = response();
    const end = await write(res, tracker(controllers, fakeClock(), () => "the service has not started").request("api", "GET /work", () => "x"), {
      ...OPTIONS,
      stream: ndjson,
    });
    expect(end).toMatchObject({ kind: "refused", delivered: 0 });
    expect([res.statusCode, res.getHeader("retry-after"), res.getHeader("content-type")]).toEqual([503, "2", "application/json; charset=utf-8"]);
  });

  it("gives an empty stream 200 and its end", async () => {
    const { res } = response();
    const source = pushed<string>();
    source.finish();
    await write(res, tracker(controllers, fakeClock(), () => null).request("api", "GET /work", () => source.iterable), { ...OPTIONS, stream: ndjson });
    expect([res.statusCode, res.chunks.join("")]).toEqual([200, '{"end":"done","delivered":0}\n']);
  });

  it("stops the work through return() when the client goes away, and gives null", async () => {
    const { res } = response();
    const source = pushed<string>();
    let aborted = false;
    const writing = write(
      res,
      tracker(controllers, fakeClock(), () => null).request("api", "GET /work", (signal) => {
        signal.addEventListener("abort", () => (aborted = true));
        return source.iterable;
      }),
      { ...OPTIONS, stream: ndjson },
    );
    source.push("a");
    await turns();
    res.emit("close");
    expect(await writing).toBeNull();
    expect([source.returned, aborted]).toEqual([true, true]);
  });

  it("closes the connection of a stream while the service cannot keep it", async () => {
    const { res } = response();
    const source = pushed<string>();
    const writing = write(res, tracker(controllers, fakeClock(), () => null).request("api", "GET /work", () => source.iterable), {
      keepAlive: false,
      retryAfter: s(1),
      stream: ndjson,
    });
    source.push("a");
    source.finish();
    await writing;
    expect([res.shouldKeepAlive, res.getHeader("connection")]).toEqual([false, "close"]);
  });

  it("destroys a response whose headers went already, because it cannot give a second status", async () => {
    const { socket, res } = response();
    res.writeHead(200);
    await write(res, tracker(controllers, fakeClock(), () => "the service has not started").request("api", "GET /work", () => "x"), OPTIONS);
    expect(socket.destroyed).toBe(true);
  });

  it("gives an end as a record: its kind and its count, and the cause of a cut or a refusal", () => {
    expect(endRecord({ kind: "failed", error: new Error("private"), delivered: 3 })).toEqual({ end: "failed", delivered: 3 });
    expect(endRecord({ kind: "cut", status: null, retryable: false, cause: "c", delivered: 2 })).toEqual({ end: "cut", delivered: 2, retryable: false, cause: "c" });
  });
});

describe("handle: a request of node:http through life.request", () => {
  const KNOBS: HttpKnobs = { server_idle_close: s(65), server_idle_sweep_interval: s(1), server_retry_after: s(3) };
  const lifeOf = (refuses: () => string | null = () => null, keep = true): Lifecycle => {
    const requests = tracker(controllers, fakeClock(), refuses);
    return { ...detachedLifecycle(), request: requests.request, keepAlive: () => keep };
  };
  const served = async (life: Lifecycle, ...handlers: RequestHandler[]) => {
    const server = new FakeServer();
    const transport = httpTransport(server.asServer, KNOBS, { listen: { port: 1 } });
    for (const handler of handlers) transport.mount(handler);
    await transport.start(new AbortController().signal, life);
    return server;
  };

  it("takes a request whose method and path are its route, and lets each other request fall through", async () => {
    const server = await served(lifeOf(), handle("api", "GET /work", () => "worked"));
    expect((await server.request("/work?x=1")).body).toBe("worked");
    expect((await server.request("/work", "POST")).status).toBe(404);
    expect((await server.request("/other")).status).toBe(404);
  });

  it("takes the name of a route from a function, and gives the work the request and its signal", async () => {
    let signal: AbortSignal | undefined;
    const server = await served(
      lifeOf(),
      handle(
        "api",
        (req) => (pathOf(req.url).startsWith("/once/") ? "POST /once" : null),
        (req, given) => {
          signal = given;
          return { url: req.url };
        },
      ),
    );
    expect(JSON.parse((await server.request("/once/7", "POST")).body)).toEqual({ url: "/once/7" });
    expect(signal?.aborted).toBe(false);
    expect((await server.request("/twice")).status).toBe(404);
  });

  it("gives a refusal of the lifecycle 503 with the Retry-After of server_retry_after, and closes the connection while the service is not ready", async () => {
    const server = await served(lifeOf(() => "the service has not started", false), handle("api", "GET /work", () => "x"));
    const answer = await server.request("/work");
    expect([answer.status, answer.headers.get("retry-after"), answer.headers.get("connection")]).toEqual([503, "3", "close"]);
  });

  it("refuses each request before the start of the transport, with 503 and Retry-After", async () => {
    const res = new FakeResponse(new FakeSocket());
    const handler = handle("api", "GET /work", () => "x");
    const context: MountContext = { intake: new AbortController().signal, signal: new AbortController().signal, life: null, retryAfter: s(3) };
    expect(await handler({ url: "/work", method: "GET" } as IncomingMessage, res as unknown as ServerResponse, context)).toBe(true);
    expect([res.statusCode, res.getHeader("retry-after")]).toEqual([503, "3"]);
    expect(JSON.parse(res.chunks.join(""))).toMatchObject({ end: "refused", cause: "the transport has not started" });
  });

  it("answers 500 for a route that the controller does not declare, through the error of the transport", async () => {
    const server = await served(lifeOf(), handle("api", "GET /missing", () => "x"));
    const answer = await server.request("/missing");
    expect([answer.status, answer.headers.get("retry-after")]).toEqual([500, undefined]);
  });

  it("writes a stream with its format", async () => {
    const server = await served(lifeOf(), handle("api", "GET /work", async function* () {
      yield 1;
      yield 2;
    }, { stream: ndjson }));
    const answer = await server.request("/work");
    expect([answer.status, answer.body]).toEqual([200, '1\n2\n{"end":"done","delivered":2}\n']);
  });
});
