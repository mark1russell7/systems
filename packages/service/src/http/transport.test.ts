import { describe, expect, it, vi } from "vitest";
import { fakeClock } from "../fakes.ts";
import type { HttpKnobs, MountContext, RequestHandler } from "../http.ts";
import { httpTransport, pathOf, probeHandler } from "../http.ts";
import type { Health } from "../health.ts";
import { detachedLifecycle } from "../testing.ts";
import { FakeServer } from "./fake-server.ts";
import type { FakeAnswer } from "./fake-server.ts";

/**
 * SYS-1: the HTTP transport on a fake server, with no socket and no port. The same transport on
 * real sockets, with its timing, runs in CI only (HTTP_IT=1, http-it.test.ts).
 */

const s = (value: number) => ({ value, unit: "s" });
const KNOBS: HttpKnobs = { server_idle_close: s(65), server_idle_sweep_interval: s(1), server_retry_after: s(2) };

const started = async (knobs: HttpKnobs = KNOBS, options: Parameters<typeof httpTransport>[2] = {}) => {
  const server = new FakeServer();
  const clock = fakeClock();
  const transport = httpTransport(server.asServer, knobs, { listen: { port: 8080 }, clock, ...options });
  await transport.start(new AbortController().signal, detachedLifecycle());
  return { server, clock, transport };
};

const turns = async (count = 4): Promise<void> => {
  for (let at = 0; at < count; at += 1) await new Promise((resolve) => setImmediate(resolve));
};

describe("the knobs of the transport", () => {
  it("makes server_idle_close the real close: keepAliveTimeout is the knob less the buffer, which stays", () => {
    const server = new FakeServer();
    httpTransport(server.asServer, KNOBS);
    expect(server.keepAliveTimeout).toBe(64_000);
    expect(server.keepAliveTimeoutBuffer).toBe(1000);
    expect(server.keepAliveTimeout + server.keepAliveTimeoutBuffer).toBe(65_000);
  });

  it("reads the buffer of the server at its construction, and takes a Node without a buffer as 0", () => {
    const wide = new FakeServer();
    wide.keepAliveTimeoutBuffer = 2500;
    httpTransport(wide.asServer, KNOBS);
    expect(wide.keepAliveTimeout).toBe(62_500);
    // a Node before 24.6 has no keepAliveTimeoutBuffer
    const old = new FakeServer();
    Reflect.deleteProperty(old, "keepAliveTimeoutBuffer");
    httpTransport(old.asServer, KNOBS);
    expect(old.keepAliveTimeout).toBe(65_000);
  });

  it("refuses a bounded server_idle_close at or below the buffer, and names both times", () => {
    for (const close of [s(1), s(0.5)])
      expect(() => httpTransport(new FakeServer().asServer, { ...KNOBS, server_idle_close: close })).toThrow(
        `the knob server_idle_close is ${close.value * 1000} ms, at or below the keepAliveTimeoutBuffer of the server, 1000 ms`,
      );
    expect(() => httpTransport(new FakeServer().asServer, { ...KNOBS, server_idle_close: s(1.001) })).not.toThrow();
  });

  it("stops the timer and the hint for a time without a bound, whatever the buffer", () => {
    const open = new FakeServer();
    const transport = httpTransport(open.asServer, { ...KNOBS, server_idle_close: { value: "infinite", unit: "s" } });
    expect(open.keepAliveTimeout).toBe(0);
    expect(transport.knobs.server_idle_close_hint).toEqual({ value: "infinite", unit: "s" });
  });

  it("gives the declaration the three times: the real close, the hint that each response sends, and the buffer", () => {
    const transport = httpTransport(new FakeServer().asServer, { ...KNOBS, server_idle_close: s(5.5) });
    expect(transport.knobs).toEqual({
      ...KNOBS,
      server_idle_close: s(5.5),
      // keepAliveTimeout is 4500 ms, and Node sends its whole seconds: Keep-Alive: timeout=4
      server_idle_close_hint: s(4),
      server_idle_close_buffer: { value: 1000, unit: "ms" },
    });
    expect(() =>
      httpTransport(new FakeServer().asServer, { ...KNOBS, server_idle_close_hint: s(1) } as HttpKnobs),
    ).toThrow("the knob server_idle_close_hint comes from the transport: give only server_idle_close");
  });

  it("has no defaults: each knob is necessary, and each is a time", () => {
    const { server_idle_sweep_interval: _, ...missing } = KNOBS;
    expect(() => httpTransport(new FakeServer().asServer, missing as unknown as HttpKnobs)).toThrow(
      "httpTransport needs the knob server_idle_sweep_interval: it has no defaults",
    );
    expect(() => httpTransport(new FakeServer().asServer, { ...KNOBS, server_idle_sweep_interval: { value: 3, unit: "count" } })).toThrow(
      "the knob server_idle_sweep_interval is not a time",
    );
    expect(() => httpTransport(new FakeServer().asServer, { ...KNOBS, server_idle_sweep_interval: s(0) })).toThrow(/an interval above zero/);
    expect(() => httpTransport(new FakeServer().asServer, { ...KNOBS, server_retry_after: { value: "infinite", unit: "s" } as never })).toThrow(
      /a Retry-After needs a time/,
    );
    expect(() => httpTransport(new FakeServer().asServer, { ...KNOBS, server_idle_close: s(-1) })).toThrow(/less than zero/);
  });

  it("gives each knob of the caller to the declaration, the knobs that it does not read too", () => {
    const knobs = { ...KNOBS, "request_timeout@server": s(30) };
    expect(httpTransport(new FakeServer().asServer, knobs).knobs).toMatchObject(knobs);
  });

  it("refuses a server that has a request listener of its own, at the start too", async () => {
    const server = new FakeServer();
    server.on("request", () => {});
    expect(() => httpTransport(server.asServer, KNOBS)).toThrow(/mount it as a handler/);
    const later = new FakeServer();
    const transport = httpTransport(later.asServer, KNOBS, { listen: { port: 1 } });
    later.on("upgrade", () => {});
    await expect(transport.start(new AbortController().signal, detachedLifecycle())).rejects.toThrow(/mount it as a handler/);
  });
});

describe("the start", () => {
  it("listens with the listen options, and ends when the server listens", async () => {
    const { server } = await started();
    expect(server.listening).toBe(true);
    expect(server.listens).toEqual([{ port: 8080 }]);
  });

  it("gives the error of the listen", async () => {
    const server = new FakeServer();
    server.failListen = new Error("EADDRINUSE");
    const transport = httpTransport(server.asServer, KNOBS, { listen: { port: 8080 } });
    await expect(transport.start(new AbortController().signal, detachedLifecycle())).rejects.toThrow("EADDRINUSE");
  });

  it("takes a function that makes the server listen, or a server that listens already", async () => {
    const server = new FakeServer();
    const listen = vi.fn(async () => {
      server.listening = true;
    });
    await httpTransport(server.asServer, KNOBS, { listen }).start(new AbortController().signal, detachedLifecycle());
    expect(listen).toHaveBeenCalledWith(server);
    const listening = new FakeServer();
    listening.listening = true;
    await httpTransport(listening.asServer, KNOBS).start(new AbortController().signal, detachedLifecycle());
    expect(listening.listens).toEqual([]);
  });

  it("refuses a server that does not listen, without listen options, and a closed transport", async () => {
    const transport = httpTransport(new FakeServer().asServer, KNOBS);
    await expect(transport.start(new AbortController().signal, detachedLifecycle())).rejects.toThrow(/has no listen options/);
    await transport.close();
    await expect(transport.start(new AbortController().signal, detachedLifecycle())).rejects.toThrow(/does not start again/);
  });
});

describe("the mounts", () => {
  it("gives a request to the first handler that takes it, and the others fall through", async () => {
    const { server, transport } = await started();
    const calls: string[] = [];
    transport.mount((req) => {
      calls.push(`a ${req.url}`);
      return false;
    });
    transport.mount(async (req, res) => {
      calls.push(`b ${req.url}`);
      if (pathOf(req.url) !== "/b") return false;
      res.writeHead(200).end("b");
      return true;
    });
    transport.mount((req, res) => {
      calls.push(`c ${req.url}`);
      res.writeHead(200).end("c");
      return true;
    });
    expect((await server.request("/b?x=1")).body).toBe("b");
    expect((await server.request("/c")).body).toBe("c");
    expect(calls).toEqual(["a /b?x=1", "b /b?x=1", "a /c", "b /c", "c /c"]);
  });

  it("answers 404 when no handler takes a request, and a removed handler takes nothing", async () => {
    const { server, transport } = await started();
    const remove = transport.mount((_req, res) => {
      res.writeHead(200).end("here");
      return true;
    });
    expect((await server.request("/")).status).toBe(200);
    remove();
    remove();
    expect((await server.request("/")).status).toBe(404);
  });

  it("takes a request whose handler wrote the response, whatever the handler gave", async () => {
    const { server, transport } = await started();
    const after = vi.fn(() => false);
    transport.mount((_req, res) => {
      res.writeHead(201).end();
      return false;
    });
    transport.mount(after);
    expect((await server.request("/")).status).toBe(201);
    expect(after).not.toHaveBeenCalled();
  });

  it("answers 500 for a handler that throws or rejects, and gives the error to onError", async () => {
    const errors: unknown[] = [];
    const { server, transport } = await started(KNOBS, { onError: (error) => errors.push(error) });
    transport.mount((req) => {
      if (req.url === "/throw") throw new Error("sync");
      return false;
    });
    transport.mount(async (req) => {
      if (req.url === "/reject") throw new Error("async");
      return false;
    });
    expect((await server.request("/throw")).status).toBe(500);
    expect((await server.request("/reject")).status).toBe(500);
    expect(errors.map((error) => (error as Error).message)).toEqual(["sync", "async"]);
  });

  it("destroys a response whose handler threw after its headers went", async () => {
    const { server, transport } = await started();
    transport.mount((_req, res) => {
      res.writeHead(200);
      throw new Error("late");
    });
    await expect(server.request("/")).rejects.toThrow(/ECONNRESET/);
    await turns();
    expect(transport.inFlight()).toBe(0);
  });

  it("gives each handler the signals of the shutdown", async () => {
    const { server, transport } = await started();
    let context: MountContext | undefined;
    transport.mount((_req, res, given) => {
      context = given;
      res.end();
      return true;
    });
    await server.request("/");
    expect([context!.intake.aborted, context!.signal.aborted]).toEqual([false, false]);
    transport.stopIntake();
    expect([context!.intake.aborted, context!.signal.aborted]).toEqual([true, false]);
    const abort = new AbortController();
    void transport.drain(Number.POSITIVE_INFINITY, abort.signal);
    abort.abort(new Error("cooperative"));
    expect(context!.signal.aborted).toBe(true);
    expect((context!.signal.reason as Error).message).toBe("cooperative");
  });

  it("aborts the signal of the handlers at the close, without a drain", async () => {
    const { server, transport } = await started();
    let context: MountContext | undefined;
    transport.mount((_req, res, given) => {
      context = given;
      res.end();
      return true;
    });
    await server.request("/");
    await transport.close();
    expect([context!.intake.aborted, context!.signal.aborted]).toEqual([true, true]);
  });
});

describe("keep-alive (S6 A13)", () => {
  it("reads life.keepAlive() of the lifecycle of its start, without the option", async () => {
    let ready = false;
    const server = new FakeServer();
    const transport = httpTransport(server.asServer, KNOBS, { listen: { port: 8080 } });
    transport.mount((_req, res) => {
      res.end("x");
      return true;
    });
    await transport.start(new AbortController().signal, { ...detachedLifecycle(), keepAlive: () => ready });
    expect((await server.request("/")).headers.get("connection")).toBe("close");
    ready = true;
    expect((await server.request("/")).headers.get("connection")).toBeUndefined();
  });

  it("gives each handler the lifecycle of its start and the knob server_retry_after", async () => {
    const server = new FakeServer();
    const transport = httpTransport(server.asServer, KNOBS, { listen: { port: 8080 } });
    let seen: MountContext | undefined;
    transport.mount((_req, res, context) => {
      seen = context;
      res.end();
      return true;
    });
    const life = detachedLifecycle();
    await transport.start(new AbortController().signal, life);
    await server.request("/");
    expect(seen?.life).toBe(life);
    expect(seen?.retryAfter).toEqual(s(2));
  });

  it("closes each connection while keepAlive() is false, from when the headers go", async () => {
    let keep = false;
    const { server, transport } = await started(KNOBS, { keepAlive: () => keep });
    transport.mount((_req, res) => {
      res.end("x");
      return true;
    });
    const connection = server.connect();
    expect((await connection.request("/")).headers.get("connection")).toBe("close");
    await turns();
    expect(connection.socket.destroyed).toBe(true);
    keep = true;
    const kept = server.connect();
    expect((await kept.request("/")).headers.get("connection")).toBeUndefined();
    expect(kept.socket.destroyed).toBe(false);
  });

  it("reads keepAlive() when the headers go, not when the request comes", async () => {
    let keep = true;
    const { server, transport } = await started(KNOBS, { keepAlive: () => keep });
    let finish: () => void = () => {};
    transport.mount((_req, res) => {
      finish = () => res.end("late");
      return true;
    });
    const answer = server.request("/");
    await turns();
    keep = false;
    finish();
    expect((await answer).headers.get("connection")).toBe("close");
  });
});

describe("the stop of the intake (S6 A8)", () => {
  it("closes the listener, so new connections get a refusal, and it closes idle connections at once", async () => {
    const { server, transport } = await started();
    transport.mount((_req, res) => {
      res.end("x");
      return true;
    });
    const idle = server.connect();
    await idle.request("/");
    transport.stopIntake();
    expect(server.listening).toBe(false);
    expect(transport.intakeStopped).toBe(true);
    expect(() => server.connect()).toThrow(/ECONNREFUSED/);
    await turns();
    expect(idle.socket.destroyed).toBe(true);
  });

  it("closes the connection of each response after the stop, and sweeps the idle connections at each server_idle_sweep_interval", async () => {
    const { server, clock, transport } = await started();
    const ends = new Map<string, () => void>();
    transport.mount((req, res) => {
      // the headers of a stream go before the stop of the intake
      if (req.url === "/stream") res.writeHead(200);
      ends.set(req.url ?? "", () => res.end("x"));
      return true;
    });
    const stream = server.connect();
    const plain = server.connect();
    const streamAnswer = stream.request("/stream");
    const plainAnswer = plain.request("/plain");
    await turns();
    transport.stopIntake();
    ends.get("/plain")!();
    expect((await plainAnswer).headers.get("connection")).toBe("close");
    ends.get("/stream")!();
    expect((await streamAnswer).headers.get("connection")).toBeUndefined();
    await turns();
    expect(plain.socket.destroyed).toBe(true);
    // the stream kept its connection, which is idle now: the next sweep closes it
    expect(stream.socket.destroyed).toBe(false);
    await clock.advance(999);
    await turns();
    expect(stream.socket.destroyed).toBe(false);
    await clock.advance(1);
    await turns();
    expect(stream.socket.destroyed).toBe(true);
  });

  it("answers a request on an open connection after the stop with a retryable 503", async () => {
    const { server, transport } = await started();
    const handler = vi.fn(() => true);
    transport.mount(handler);
    const open = server.connect();
    open.idle = false;
    transport.stopIntake();
    const answer = await open.request("/late");
    expect(answer.status).toBe(503);
    expect(answer.headers.get("retry-after")).toBe("2");
    expect(answer.headers.get("connection")).toBe("close");
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps the listener open through the drain for a mount until close transports, and refuses the other requests", async () => {
    const { server, transport } = await started();
    transport.mount((req, res) => {
      if (req.url !== "/app") return false;
      res.end("app");
      return true;
    });
    const remove = transport.mount(
      (req, res) => {
        if (req.url !== "/probe") return false;
        res.end("probe");
        return true;
      },
      { until: "close transports" },
    );
    transport.stopIntake();
    expect(server.listening).toBe(true);
    expect((await server.request("/probe")).body).toBe("probe");
    expect((await server.request("/app")).status).toBe(503);
    // the last mount through the drain goes: the listener closes, as the stop of the intake asks
    remove();
    expect(server.listening).toBe(false);
  });

  it("keeps the listener open for a mounted probe handler, which answers through the drain", async () => {
    const { server, transport } = await started();
    let ready = true;
    const health = {
      probe: (kind: string) => ({
        status: kind === "readiness" && !ready ? 503 : 200,
        contentType: "application/health+json",
        body: { status: "pass", service: "app", probe: kind },
      }),
    } as unknown as Health;
    transport.mount(probeHandler(health, { prefix: "/health" }));
    ready = false;
    transport.stopIntake();
    expect((await server.request("/health/readiness")).status).toBe(503);
    expect((await server.request("/health/liveness")).status).toBe(200);
    await transport.close();
    expect(() => server.connect()).toThrow(/ECONNREFUSED/);
  });
});

describe("Retry-After on each 503 of the port, and on no 500, whatever writes the headers (RFC 9110)", () => {
  /** This function starts a transport with one handler, and gives the answer to one request. */
  const answerOf = async (handler: RequestHandler, url = "/"): Promise<FakeAnswer> => {
    const { server, transport } = await started();
    transport.mount(handler);
    return server.request(url);
  };

  it("gives the 503s of a mounted probe handler Retry-After: before the health runtime exists, and for a failing probe", async () => {
    let health: Health | null = null;
    const { server, transport } = await started();
    transport.mount(probeHandler(() => health, { prefix: "/health" }));
    const early = await server.request("/health/startup");
    expect([early.status, early.headers.get("retry-after")]).toEqual([503, "2"]);
    health = {
      probe: (kind: string) => ({
        status: kind === "readiness" ? 503 : 200,
        contentType: "application/health+json",
        body: { status: kind === "readiness" ? "fail" : "pass", service: "app", probe: kind },
      }),
    } as unknown as Health;
    const failing = await server.request("/health/readiness");
    expect([failing.status, failing.headers.get("retry-after")]).toEqual([503, "2"]);
    const passing = await server.request("/health/liveness");
    expect([passing.status, passing.headers.get("retry-after")]).toEqual([200, undefined]);
  });

  it("adds Retry-After to a raw writeHead(503) of a mounted handler, in each form of writeHead", async () => {
    const plain = await answerOf((_req, res) => {
      res.writeHead(503).end();
      return true;
    });
    expect(plain.headers.get("retry-after")).toBe("2");
    const message = await answerOf((_req, res) => {
      res.writeHead(503, "Busy", { "x-reason": "busy" }).end();
      return true;
    });
    expect([message.headers.get("retry-after"), message.headers.get("x-reason")]).toEqual(["2", "busy"]);
    const implicit = await answerOf((_req, res) => {
      res.statusCode = 503;
      res.end("later");
      return true;
    });
    expect(implicit.headers.get("retry-after")).toBe("2");
  });

  it("keeps the Retry-After that a handler gives to its own 503, and to a status other than 500", async () => {
    const own = await answerOf((_req, res) => {
      res.writeHead(503, { "Retry-After": "7" }).end();
      return true;
    });
    expect(own.headers.get("retry-after")).toBe("7");
    const limited = await answerOf((_req, res) => {
      res.writeHead(429, { "retry-after": "9" }).end();
      return true;
    });
    expect([limited.status, limited.headers.get("retry-after")]).toEqual([429, "9"]);
  });

  it("takes each Retry-After from a 500: from setHeader, from the headers of writeHead, and from a flat list", async () => {
    const set = await answerOf((_req, res) => {
      res.setHeader("Retry-After", "5");
      res.writeHead(500).end();
      return true;
    });
    expect([set.status, set.headers.get("retry-after")]).toEqual([500, undefined]);
    const given = await answerOf((_req, res) => {
      res.writeHead(500, { "Retry-After": "5", "x-kept": "yes" }).end();
      return true;
    });
    expect([given.headers.get("retry-after"), given.headers.get("x-kept")]).toEqual([undefined, "yes"]);
    const flat = await answerOf((_req, res) => {
      res.writeHead(500, ["retry-after", "5", "x-kept", "yes"] as unknown as Record<string, string>).end();
      return true;
    });
    expect([flat.headers.get("retry-after"), flat.headers.get("x-kept")]).toEqual([undefined, "yes"]);
    const implicit = await answerOf((_req, res) => {
      res.setHeader("retry-after", "5");
      res.statusCode = 500;
      res.end();
      return true;
    });
    expect(implicit.headers.get("retry-after")).toBeUndefined();
  });

  it("gives the 500 of a handler that throws no Retry-After", async () => {
    const thrown = await answerOf((_req, res) => {
      res.setHeader("retry-after", "5");
      throw new Error("the handler failed");
    });
    expect([thrown.status, thrown.headers.get("retry-after")]).toEqual([500, undefined]);
  });
});

describe("the upgrades", () => {
  it("gives an upgrade to the handler of its path, or a predicate, and counts it in flight until it closes", async () => {
    const { server, transport } = await started();
    const taken: string[] = [];
    transport.upgrade("/ws", (req) => taken.push(`path ${req.url}`));
    transport.upgrade(
      (req) => req.url?.startsWith("/events") === true,
      (req) => taken.push(`match ${req.url}`),
    );
    const ws = server.connect().upgrade("/ws?token=1");
    server.connect().upgrade("/events/a");
    expect(taken).toEqual(["path /ws?token=1", "match /events/a"]);
    expect(transport.inFlight()).toBe(2);
    ws.destroy();
    await turns();
    expect(transport.inFlight()).toBe(1);
  });

  it("answers 404 to an upgrade that no handler takes, and 503 after the stop of the intake", async () => {
    const { server, transport } = await started();
    transport.upgrade("/ws", () => {});
    const missing = server.connect().upgrade("/other");
    expect(missing.written.join("")).toMatch(/^HTTP\/1\.1 404 Not Found\r\nConnection: close\r\n/);
    // a connection that sends its upgrade while the intake stops, thus it is not idle
    const open = server.connect();
    open.idle = false;
    transport.stopIntake();
    const late = open.upgrade("/ws");
    expect(late.written.join("")).toMatch(/^HTTP\/1\.1 503 Service Unavailable\r\n[^]*Retry-After: 2\r\n/);
    await turns();
    expect(transport.inFlight()).toBe(0);
  });

  it("keeps an upgrade mount until close transports through the drain", async () => {
    const { server, transport } = await started();
    const taken = vi.fn();
    transport.upgrade("/live", taken, { until: "close transports" });
    transport.stopIntake();
    server.connect().upgrade("/live");
    expect(taken).toHaveBeenCalledTimes(1);
  });

  it("destroys the upgraded connections at the close, which closeAllConnections does not reach", async () => {
    const { server, transport } = await started();
    transport.upgrade("/ws", () => {});
    const socket = server.connect().upgrade("/ws");
    await transport.close();
    expect(socket.destroyed).toBe(true);
    expect(transport.inFlight()).toBe(0);
    expect(transport.connections).toBe(0);
  });

  it("destroys an upgrade whose handler throws, and gives the error to onError", async () => {
    const errors: unknown[] = [];
    const { server, transport } = await started(KNOBS, { onError: (error) => errors.push(error) });
    transport.upgrade("/ws", () => {
      throw new Error("handshake");
    });
    const socket = server.connect().upgrade("/ws");
    expect(socket.destroyed).toBe(true);
    expect((errors[0] as Error).message).toBe("handshake");
  });
});

describe("the drain and the close", () => {
  it("ends the drain when the last response closes, from its event", async () => {
    const { server, clock, transport } = await started();
    let finish: () => void = () => {};
    transport.mount((_req, res) => {
      finish = () => res.end("x");
      return true;
    });
    const answer = server.request("/");
    await turns();
    transport.stopIntake();
    let drained = false;
    void Promise.resolve(transport.drain(clock.now() + 10_000, new AbortController().signal)).then(() => (drained = true));
    await turns();
    expect(drained).toBe(false);
    finish();
    await answer;
    await turns();
    expect(drained).toBe(true);
    // only the sweep is left: the drain stopped its timer
    expect(clock.pending).toBe(1);
  });

  it("closes the listener, each connection and each sweep, and a second close gives the same promise", async () => {
    const { server, clock, transport } = await started();
    transport.mount(() => true);
    const held = server.request("/");
    const idle = server.connect();
    await turns();
    transport.stopIntake();
    const first = transport.close();
    expect(transport.close()).toBe(first);
    await first;
    await expect(held).rejects.toThrow(/ECONNRESET/);
    expect(idle.socket.destroyed).toBe(true);
    expect(transport.inFlight()).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it("ends the close of a transport that never listened at once", async () => {
    await httpTransport(new FakeServer().asServer, KNOBS).close();
  });
});

describe("pathOf", () => {
  it("gives the path of a target, without its query or fragment, also for an absolute target", () => {
    expect(pathOf("/a/b?c=1")).toBe("/a/b");
    expect(pathOf("/a#x")).toBe("/a");
    expect(pathOf(undefined)).toBe("/");
    expect(pathOf("http://example.test/p?q")).toBe("/p");
    expect(pathOf("*")).toBe("*");
  });
});
