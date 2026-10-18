import { mkdirSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders, Server } from "node:http";
import { createServer, request } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { connect } from "node:net";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { service } from "../builder.ts";
import type { Clock } from "../clock.ts";
import type { LifecycleEvent } from "../events.ts";
import { fakeProcess } from "../fakes.ts";
import type { Health } from "../health.ts";
import type { HttpKnobs } from "../http.ts";
import { httpTransport, pathOf, probeHandler, probeServer, writeOutcome } from "../http.ts";
import type { Lifecycle } from "../lifecycle.ts";
import type { ConformanceRecord, TransportSubject } from "../testing.ts";
import { transportConformance } from "../testing.ts";

/**
 * CI-1: the ./http entry on real sockets of the loopback, opt-in with HTTP_IT=1. These tests measure
 * time, thus they run only in CI (.github/workflows/http.yml), on a runner with no other load. With
 * HTTP_RECORDS=<folder>, each measurement goes to an NDJSON file there, for the artifact of the run.
 * The same parts on fake servers and the fake clock run in the unit tests.
 */

const RUN = process.env["HTTP_IT"] === "1";
const RECORDS = process.env["HTTP_RECORDS"];
const HOST = "127.0.0.1";
const s = (value: number) => ({ value, unit: "s" });
const ms = (value: number) => ({ value, unit: "ms" });
const KNOBS: HttpKnobs = { server_idle_close: s(5), server_idle_sweep_interval: ms(200), server_retry_after: s(1) };
// the most that an event of the loopback can take to arrive on a runner, in milliseconds
const SLACK = 150;

interface Measurement {
  readonly test: string;
  readonly what: string;
  readonly expected: number;
  readonly measured: number;
}
const measurements: Measurement[] = [];
const measure = (test: string, what: string, expected: number, measured: number): void => {
  measurements.push({ test, what, expected, measured: Math.round(measured * 1000) / 1000 });
};

afterAll(() => {
  if (!RUN || RECORDS === undefined) return;
  mkdirSync(RECORDS, { recursive: true });
  const lines = measurements.map((each) => JSON.stringify({ node: process.version, platform: process.platform, ...each }));
  writeFileSync(join(RECORDS, `http-${process.version}.ndjson`), `${lines.join("\n")}\n`);
});

const now = (): number => performance.now();
const sleep = (time: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, time));
const until = async (test: () => boolean, bound = 2000, what = "the condition"): Promise<void> => {
  const end = now() + bound;
  while (!test()) {
    if (now() > end) throw new Error(`${what} did not come in ${bound} ms`);
    await sleep(2);
  }
};
const portOf = (server: Server): number => (server.address() as AddressInfo).port;

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** This function sends one request on a new connection, with no agent. */
const call = (port: number, path: string): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const req = request({ host: HOST, port, path, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });

/** This function tells if a new connection to the port gets a refusal. */
const refused = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ port, host: HOST });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "ECONNREFUSED"));
  });

interface Raw {
  readonly socket: Socket;
  readonly closedAt: Promise<number>;
  text(): string;
  send(data: string): void;
  until(test: (text: string) => boolean, bound?: number): Promise<number>;
}

/** This function opens a raw connection, and keeps each byte that it receives. */
const raw = async (port: number): Promise<Raw> => {
  const socket = connect({ port, host: HOST });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  let text = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => (text += chunk));
  socket.on("error", () => {});
  const closedAt = new Promise<number>((resolve) => socket.once("close", () => resolve(now())));
  return {
    socket,
    closedAt,
    text: () => text,
    send: (data) => void socket.write(data),
    async until(test, bound = 2000) {
      await until(() => test(text), bound, `an answer (${JSON.stringify(text)})`);
      return now();
    },
  };
};

const GET = (path: string, extra = ""): string => `GET ${path} HTTP/1.1\r\nHost: test\r\n${extra}\r\n`;
const UPGRADE = (path: string): string => GET(path, "Connection: Upgrade\r\nUpgrade: test\r\n");
const SWITCHED = "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n";
/** This function counts the complete responses in a text whose bodies end with a period. */
const answers = (text: string): number => text.split("HTTP/1.1 ").length - 1;

interface Holder {
  readonly end: () => void;
  readonly aborted: () => boolean;
}

/** The HTTP transport on a real server of the loopback: `/ok` answers at once, and `/hold` and `/ws` hold until their release. */
const realSubject =
  (kind: "request" | "upgrade") =>
  (clock: Clock): TransportSubject => {
    const server = createServer();
    const transport = httpTransport(server, KNOBS, { listen: { port: 0, host: HOST }, clock });
    const waiting = new Map<string, (holder: Holder) => void>();
    const clients = new Set<Socket>();
    const idOf = (url: string | undefined): string => new URLSearchParams((url ?? "").split("?")[1] ?? "").get("id") ?? "";
    let next = 0;
    transport.mount((req, res) => {
      if (pathOf(req.url) !== "/ok") return false;
      res.end("ok");
      return true;
    });
    transport.mount((req, res, context) => {
      if (pathOf(req.url) !== "/hold") return false;
      res.writeHead(200, { "content-type": "text/plain" });
      waiting.get(idOf(req.url))?.({ end: () => res.end("held"), aborted: () => context.signal.aborted });
      return true;
    });
    transport.upgrade("/ws", (req, socket, _head, context) => {
      socket.write(SWITCHED);
      waiting.get(idOf(req.url))?.({ end: () => socket.end(), aborted: () => context.signal.aborted });
    });
    return {
      impl: transport,
      async offer() {
        try {
          return (await call(portOf(server), "/ok")).status === 200;
        } catch {
          return false;
        }
      },
      async hold() {
        const id = String((next += 1));
        const entered = new Promise<Holder>((resolve) => waiting.set(id, resolve));
        let ended: Promise<unknown>;
        if (kind === "request") ended = call(portOf(server), `/hold?id=${id}`).catch(() => undefined);
        else {
          const client = await raw(portOf(server));
          clients.add(client.socket);
          client.send(UPGRADE(`/ws?id=${id}`));
          ended = client.closedAt;
        }
        const holder = await Promise.race([
          entered,
          ended.then(() => {
            throw new Error("the work ended before the transport had it");
          }),
        ]);
        return {
          release: async () => {
            holder.end();
            await ended;
          },
          get aborted() {
            return holder.aborted();
          },
        };
      },
      dispose() {
        for (const socket of clients) socket.destroy();
      },
    };
  };

describe.skipIf(!RUN)("httpTransport passes the conformance kit on real sockets (HTTP_IT=1)", () => {
  for (const clock of ["fake", "real"] as const)
    for (const kind of ["request", "upgrade"] as const) {
      const record = (each: ConformanceRecord): void => measure(each.case, `${clock} ${kind}: ${each.what}`, each.expected, each.measured);
      const cases = transportConformance(realSubject(kind), {
        name: `http ${kind} on the ${clock} clock`,
        clock,
        cap: clock === "real" ? 600 : 1000,
        slack: SLACK,
        closeBound: 1000,
        record,
      });
      it.each(cases.map((each) => [each.name, each] as const))("%s", async (_name, each) => {
        await each.run();
      });
    }
});

describe.skipIf(!RUN)("keep-alive on real sockets (S6 A13)", () => {
  it("closes an idle connection at server_idle_close, the real close: keepAliveTimeout and the buffer of this Node", async () => {
    const server = createServer();
    const transport = httpTransport(server, { ...KNOBS, server_idle_close: ms(2000) }, { listen: { port: 0, host: HOST } });
    const buffer = (server as { keepAliveTimeoutBuffer?: number }).keepAliveTimeoutBuffer ?? 0;
    expect(server.keepAliveTimeout + buffer).toBe(2000);
    expect(transport.knobs.server_idle_close_buffer).toEqual({ value: buffer, unit: "ms" });
    const hint = transport.knobs.server_idle_close_hint;
    expect(hint).toEqual({ value: Math.floor((2000 - buffer) / 1000), unit: "s" });
    measure("keep-alive", "the buffer of this Node", 0, buffer);
    transport.mount((_req, res) => {
      res.end("ok.");
      return true;
    });
    await transport.start(new AbortController().signal);
    try {
      const client = await raw(portOf(server));
      client.send(GET("/"));
      const answered = await client.until((text) => text.endsWith("ok."));
      // the hint that the declaration shows is the hint that the response sends
      expect(client.text().toLowerCase()).toContain(`\r\nkeep-alive: timeout=${String(hint.value)}\r\n`);
      const closed = await client.closedAt;
      // the knob is the real close, on each Node of the matrix
      const expected = 2000;
      measure("keep-alive", "idle close after the last response, against server_idle_close", expected, closed - answered);
      expect(closed - answered).toBeGreaterThanOrEqual(expected - SLACK);
      expect(closed - answered).toBeLessThanOrEqual(expected + 2 * SLACK);
    } finally {
      await transport.close();
    }
  });

  it("closes the connection of each response while keepAlive() is false", async () => {
    const server = createServer();
    let keep = false;
    const transport = httpTransport(server, KNOBS, { listen: { port: 0, host: HOST }, keepAlive: () => keep });
    transport.mount((_req, res) => {
      res.end("ok.");
      return true;
    });
    await transport.start(new AbortController().signal);
    try {
      const closing = await raw(portOf(server));
      closing.send(GET("/"));
      const answered = await closing.until((text) => text.endsWith("ok."));
      expect(closing.text()).toMatch(/\r\nConnection: close\r\n/i);
      measure("keep-alive", "close after a response while not ready", 0, (await closing.closedAt) - answered);
      keep = true;
      const kept = await raw(portOf(server));
      kept.send(GET("/"));
      await kept.until((text) => text.endsWith("ok."));
      expect(kept.text()).toMatch(/\r\nConnection: keep-alive\r\n/i);
      expect(kept.socket.destroyed).toBe(false);
      kept.socket.destroy();
    } finally {
      await transport.close();
    }
  });
});

describe.skipIf(!RUN)("the stop of the intake on real sockets (S6 A8)", () => {
  it("refuses new connections, closes idle connections at once, and sweeps a connection that goes idle later", async () => {
    const server = createServer();
    const transport = httpTransport(server, KNOBS, { listen: { port: 0, host: HOST } });
    let finish: () => void = () => {};
    transport.mount((req, res) => {
      if (req.url === "/stream") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("part,");
        finish = () => res.end("end.");
        return true;
      }
      res.end("ok.");
      return true;
    });
    await transport.start(new AbortController().signal);
    const port = portOf(server);
    try {
      const idle = await raw(port);
      idle.send(GET("/"));
      await idle.until((text) => text.endsWith("ok."));
      const stream = await raw(port);
      stream.send(GET("/stream"));
      await stream.until((text) => text.includes("part,"));
      const stopped = now();
      transport.stopIntake();
      measure("stop intake", "close of an idle connection", 0, (await idle.closedAt) - stopped);
      expect((await idle.closedAt) - stopped).toBeLessThan(SLACK);
      expect(await refused(port)).toBe(true);
      // the headers of the stream went before the stop: the stream ends with its connection open, then the sweep closes it
      finish();
      const ended = await stream.until((text) => text.endsWith("end.\r\n0\r\n\r\n") || text.endsWith("end."));
      const closed = await stream.closedAt;
      measure("stop intake", "sweep of a connection that went idle after the stop", 200, closed - ended);
      expect(closed - ended).toBeLessThanOrEqual(200 + SLACK);
    } finally {
      await transport.close();
    }
  });

  it("answers a request on an open connection after the stop with a retryable 503, and closes the connection", async () => {
    const server = createServer();
    const transport = httpTransport(server, KNOBS, { listen: { port: 0, host: HOST } });
    let finish: () => void = () => {};
    let handled = 0;
    transport.mount((_req, res) => {
      handled += 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("part,");
      finish = () => res.end("end.");
      return true;
    });
    await transport.start(new AbortController().signal);
    try {
      const client = await raw(portOf(server));
      client.send(GET("/first"));
      await client.until((text) => text.includes("part,"));
      transport.stopIntake();
      client.send(GET("/second"));
      await sleep(50);
      finish();
      await client.until((text) => answers(text) === 2 && text.includes("Service Unavailable"));
      const second = client.text().slice(client.text().lastIndexOf("HTTP/1.1 "));
      expect(second).toMatch(/^HTTP\/1\.1 503 /);
      expect(second).toMatch(/\r\nRetry-After: 1\r\n/i);
      expect(second).toMatch(/\r\nConnection: close\r\n/i);
      await client.closedAt;
      expect(handled).toBe(1);
    } finally {
      await transport.close();
    }
  });

  it("keeps the listener open through the drain for a mounted probe handler, and refuses each other request", async () => {
    const server = createServer();
    const transport = httpTransport(server, KNOBS, { listen: { port: 0, host: HOST } });
    const health = {
      probe: (kind: string) => ({ status: 200, contentType: "application/health+json", body: { status: "pass", service: "it", probe: kind } }),
    } as unknown as Health;
    transport.mount(probeHandler(health, { prefix: "/health" }));
    transport.mount((_req, res) => {
      res.end("app.");
      return true;
    });
    await transport.start(new AbortController().signal);
    const port = portOf(server);
    try {
      transport.stopIntake();
      const probe = await call(port, "/health/liveness");
      expect([probe.status, probe.headers["content-type"], probe.headers["connection"]]).toEqual([200, "application/health+json", "close"]);
      const app = await call(port, "/work");
      expect([app.status, app.headers["retry-after"]]).toEqual([503, "1"]);
      await transport.close();
      expect(await refused(port)).toBe(true);
    } finally {
      await transport.close();
    }
  });
});

describe.skipIf(!RUN)("the upgrades on real sockets", () => {
  it("shares the port: an upgrade by path, a 404 for another path, a request beside them, and the close destroys the upgrade", async () => {
    const server = createServer();
    const transport = httpTransport(server, KNOBS, { listen: { port: 0, host: HOST } });
    transport.upgrade("/ws", (_req, socket) => {
      socket.write(SWITCHED);
      socket.on("data", (chunk: Buffer) => socket.write(chunk));
    });
    transport.mount((_req, res) => {
      res.end("plain.");
      return true;
    });
    await transport.start(new AbortController().signal);
    const port = portOf(server);
    try {
      const ws = await raw(port);
      ws.send(UPGRADE("/ws?x=1"));
      await ws.until((text) => text.startsWith(SWITCHED));
      ws.send("echo.");
      await ws.until((text) => text.endsWith("echo."));
      const other = await raw(port);
      other.send(UPGRADE("/other"));
      await other.until((text) => text.startsWith("HTTP/1.1 404 Not Found"));
      await other.closedAt;
      expect((await call(port, "/")).body).toBe("plain.");
      // the close of the plain response comes just after its answer
      await until(() => transport.inFlight() === 1, 1000, "one upgraded connection in flight");
      const began = now();
      await transport.close();
      const closed = await ws.closedAt;
      measure("upgrades", "close of an upgraded connection", 0, closed - began);
      expect(transport.inFlight()).toBe(0);
    } finally {
      await transport.close();
    }
  });
});

describe.skipIf(!RUN)("probeServer on a real port", () => {
  it("answers each probe from the cache with application/health+json, and refuses connections after its close", async () => {
    const svc = service("probes")
      .readiness({ type: "debounce", interval: s(1), failAfter: 3, recoverAfter: 1 })
      .liveness({ type: "window", failAfter: s(5) })
      .startup(s(5))
      .phase("fail readiness", s(1))
      .cooperativeWindow(s(1));
    const health = await svc.start();
    const probes = probeServer({ port: 0, host: HOST });
    await probes.listen(health);
    const port = portOf(probes.server);
    try {
      const ready = await call(port, "/readiness");
      expect([ready.status, ready.headers["content-type"]]).toEqual([200, "application/health+json"]);
      expect(JSON.parse(ready.body)).toEqual({ status: "pass", service: "probes", probe: "readiness" });
      health.drain();
      expect((await call(port, "/readiness")).status).toBe(503);
      expect((await call(port, "/liveness")).status).toBe(200);
      expect((await call(port, "/nothing")).status).toBe(404);
      await probes.close();
      expect(await refused(port)).toBe(true);
    } finally {
      await probes.close();
      health.stop();
    }
  });
});

describe.skipIf(!RUN)("a service under run() on real sockets and the real clock", () => {
  const CAPS = {
    "fail readiness": 300,
    "stop intake": 200,
    drain: 1500,
    "close transports": 500,
    "stop the poller": 500,
    "close the health server": 500,
  } as const;

  const running = async (mounted: boolean) => {
    const process = fakeProcess();
    const events: LifecycleEvent[] = [];
    let life: Lifecycle | null = null;
    const app = createServer();
    const http = httpTransport(app, KNOBS, { listen: { port: 0, host: HOST }, keepAlive: () => life?.keepAlive() ?? false });
    const probes = probeServer({ port: 0, host: HOST });
    const svc = service("it")
      .server("http", http.knobs, http)
      .healthServer(probes)
      .readiness({ type: "debounce", interval: s(1), failAfter: 3, recoverAfter: 1 })
      .liveness({ type: "window", failAfter: s(5) })
      .startup(s(5))
      .cooperativeWindow(ms(500));
    for (const [stage, cap] of Object.entries(CAPS)) svc.phase(stage, ms(cap));
    svc.controller("api").route("GET /work", { idempotent: true });
    // a window between the close of the transports and the close of the health server
    svc.onPhase("stop the poller", ({ clock }) => new Promise((resolve) => clock.after(200, resolve)));
    const releases: Array<() => void> = [];
    if (mounted) http.mount(probeHandler(() => svc.health, { prefix: "/health" }));
    http.mount(async (req, res) => {
      const outcome = await life!.request("api", "GET /work", () =>
        req.url?.includes("hold") === true ? new Promise<string>((resolve) => releases.push(() => resolve("held"))) : "done",
      );
      writeOutcome(res, outcome, { keepAlive: () => life!.keepAlive(), retryAfter: s(1) });
      return true;
    });
    life = await svc.run({ process, record: (event) => events.push(event) });
    const stage = (): string | undefined => events.filter((event) => event.machine === "drain").at(-1)?.to;
    return { life, process, events, stage, releases, appPort: portOf(app), probePort: portOf(probes.server) };
  };

  it("drains a held request after SIGTERM, answers the mounted probes until close transports, and the probe server until the end", async () => {
    const r = await running(true);
    expect((await call(r.appPort, "/work")).body).toBe("done");
    const held = call(r.appPort, "/work?hold");
    await until(() => r.life.inFlight() === 1, 2000, "the held request");
    r.process.signal("SIGTERM");
    await until(() => r.stage() === "fail readiness");
    expect((await call(r.appPort, "/health/readiness")).status).toBe(503);
    expect((await call(r.appPort, "/health/liveness")).status).toBe(200);
    await until(() => r.stage() === "drain");
    expect((await call(r.appPort, "/health/liveness")).status).toBe(200);
    expect((await call(r.appPort, "/work")).status).toBe(503);
    await sleep(300);
    r.releases[0]!();
    const answer = await held;
    expect([answer.status, answer.body, answer.headers["connection"]]).toEqual([200, "held", "close"]);
    await until(() => r.stage() === "stop the poller");
    expect(await refused(r.appPort)).toBe(true);
    expect((await call(r.probePort, "/liveness")).status).toBe(200);
    expect(await r.life.done).toBe(0);
    expect(await refused(r.probePort)).toBe(true);
    const steps = r.events.filter((event) => event.machine === "drain" && event.from !== event.to);
    for (let at = 1; at < steps.length; at += 1)
      measure("run", `phase ${steps[at - 1]!.to}`, CAPS[steps[at - 1]!.to as keyof typeof CAPS] ?? 0, steps[at]!.at - steps[at - 1]!.at);
    const hold = steps.find((event) => event.to === "stop intake")!.at - steps.find((event) => event.to === "fail readiness")!.at;
    expect(hold).toBeGreaterThanOrEqual(CAPS["fail readiness"] - 5);
  });

  it("refuses connections from the stop of the intake when no mount answers through the drain", async () => {
    const r = await running(false);
    const held = call(r.appPort, "/work?hold");
    await until(() => r.life.inFlight() === 1, 2000, "the held request");
    r.process.signal("SIGTERM");
    await until(() => r.stage() === "drain");
    expect(await refused(r.appPort)).toBe(true);
    r.releases[0]!();
    expect((await held).body).toBe("held");
    expect(await r.life.done).toBe(0);
  });

  it("cuts a held request at the deadline of the drain, as a retryable 503, in the cap", async () => {
    const r = await running(false);
    const held = call(r.appPort, "/work?hold");
    await until(() => r.life.inFlight() === 1, 2000, "the held request");
    r.process.signal("SIGTERM");
    await until(() => r.stage() === "drain");
    const began = now();
    const answer = await held;
    measure("run", "cut of a held request after the start of the drain", CAPS.drain, now() - began);
    // each 503 gets Retry-After: the cut of an idempotent route can go again
    expect([answer.status, answer.headers["retry-after"]]).toEqual([503, "1"]);
    expect(now() - began).toBeLessThanOrEqual(CAPS.drain + SLACK);
    expect(await r.life.done).toBe(0);
  });
});
