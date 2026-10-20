import { describe, expect, it } from "vitest";
import { service } from "../builder.ts";
import { fakeClock, seeded } from "../fakes.ts";
import type { Health, ProbeKind } from "../health.ts";
import type { HttpKnobs } from "../http.ts";
import { httpTransport, PROBE_KINDS, probeHandler, probeResponse, probeServer } from "../http.ts";
import { detachedLifecycle, scriptedCheck } from "../testing.ts";
import { FakeResponse, FakeServer, FakeSocket } from "./fake-server.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

/** SYS-2: the probes, on a port of their own and on the port of the application (D5: both). */

const s = (value: number) => ({ value, unit: "s" });
const poll = { interval: s(1), jitter: 0, timeout: s(0.4) };

/** A started service: one dependency with a readiness check, and a controller that needs it. */
const runtime = async (): Promise<{ health: Health; check: ReturnType<typeof scriptedCheck>; clock: ReturnType<typeof fakeClock> }> => {
  const check = scriptedCheck("ok");
  const clock = fakeClock();
  const svc = service("shop")
    .dependency("db", { system: null, knobs: {}, operations: {} })
    .check({ name: "db.round-trip", dependency: "db", step: "round-trip", ownConnection: true, gates: "readiness", poll }, check.run)
    .readiness({ type: "debounce", interval: s(1), failAfter: 1, recoverAfter: 1 })
    .liveness({ type: "window", failAfter: s(5) })
    .startup(s(10))
    .phase("fail readiness", s(1))
    .cooperativeWindow(s(1))
    .onRepeatSignal("ignore");
  svc.controller("orders").requires("db").route("GET /orders", { idempotent: true });
  const health = await svc.start({ clock, random: seeded(1) });
  return { health, check, clock };
};

const fakeReq = (url: string, method = "GET") => ({ url, method }) as IncomingMessage;

describe("probeResponse: the answer of a probe path, from the cache", () => {
  it("answers each probe with its status and application/health+json, and the report with the verdict", async () => {
    const { health } = await runtime();
    for (const kind of ["startup", "readiness", "liveness"]) {
      const response = probeResponse(health, "GET", `/${kind}`)!;
      expect(response.status).toBe(200);
      expect(response.headers).toEqual({ "content-type": "application/health+json", "cache-control": "no-store" });
      expect(JSON.parse(response.body)).toEqual({ status: "pass", service: "shop", probe: kind });
    }
    const report = JSON.parse(probeResponse(health, "GET", "/report")!.body);
    expect(report.verdict.ready).toBe(true);
  });

  it("asks about one controller at /readiness/<controller>, and answers 404 for a controller that the service does not have", async () => {
    const { health, check, clock } = await runtime();
    expect(probeResponse(health, "GET", "/readiness/orders")!.status).toBe(200);
    check.behavior = "error";
    await clock.advance(1000);
    expect(probeResponse(health, "GET", "/readiness/orders")!.status).toBe(503);
    expect(JSON.parse(probeResponse(health, "GET", "/readiness/orders")!.body)).toMatchObject({ status: "fail", controller: "orders" });
    expect(probeResponse(health, "GET", "/readiness/nobody")!.status).toBe(404);
    // the liveness passes while the dependency fails, as the declaration has no coupling
    expect(probeResponse(health, "GET", "/liveness")!.status).toBe(200);
  });

  it("gives null for a path that is not a probe, and keeps to its prefix", async () => {
    const { health } = await runtime();
    for (const path of ["/", "/health", "/healthz", "/readiness/orders/x", "/liveness/orders", "/readiness/", "/health/startup"])
      expect(probeResponse(health, "GET", path), path).toBeNull();
    expect(probeResponse(health, "GET", "/health/startup", "/health")!.status).toBe(200);
    expect(probeResponse(health, "GET", "/startup", "/health")).toBeNull();
  });

  it("answers 405 to a method other than GET and HEAD, and 503 before the runtime exists", () => {
    expect(probeResponse(null, "POST", "/readiness")).toEqual({ status: 405, headers: { allow: "GET, HEAD", "content-length": "0" }, body: "" });
    const early = probeResponse(null, "GET", "/startup")!;
    expect(early.status).toBe(503);
    expect(JSON.parse(early.body)).toEqual({ status: "fail", probe: "startup" });
  });
});

describe("probeHandler: the probes on the port of the application", () => {
  it("answers a probe path and gives true, and gives false for each other path", async () => {
    const { health } = await runtime();
    const handler = probeHandler(health, { prefix: "/health" });
    const res = new FakeResponse(new FakeSocket());
    expect(handler(fakeReq("/health/readiness?x=1"), res as unknown as ServerResponse, undefined as never)).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.chunks.join("")).toContain('"probe":"readiness"');
    const other = new FakeResponse(new FakeSocket());
    expect(handler(fakeReq("/api"), other as unknown as ServerResponse, undefined as never)).toBe(false);
    expect(other.headersSent).toBe(false);
  });

  it("answers HEAD with no body, and reads a lazy runtime at each request", async () => {
    let current: Health | null = null;
    const handler = probeHandler(() => current, { prefix: "" });
    const before = new FakeResponse(new FakeSocket());
    handler(fakeReq("/startup"), before as unknown as ServerResponse, undefined as never);
    expect(before.statusCode).toBe(503);
    current = (await runtime()).health;
    const head = new FakeResponse(new FakeSocket());
    handler(fakeReq("/startup", "HEAD"), head as unknown as ServerResponse, undefined as never);
    expect(head.statusCode).toBe(200);
    expect(head.chunks).toEqual([]);
  });

  it("answers until close transports, and refuses a prefix that does not start with a slash or ends with one", () => {
    expect(probeHandler(() => null, { prefix: "/health" }).until).toBe("close transports");
    expect(() => probeHandler(() => null, { prefix: "health" })).toThrow(/does not start with/);
    expect(() => probeHandler(() => null, { prefix: "/health/" })).toThrow(/ends with/);
  });
});

describe("probeServer: the probes on a port of their own", () => {
  it("listens with its listen options when the lifecycle gives it the runtime, and answers 404 for each other path", async () => {
    const { health } = await runtime();
    const server = new FakeServer();
    const probes = probeServer({ server_retry_after: s(1), port: 9090, host: "0.0.0.0", server: server.asServer });
    await probes.listen(health);
    expect(server.listens).toEqual([{ port: 9090, host: "0.0.0.0" }]);
    expect((await server.request("/readiness")).status).toBe(200);
    expect((await server.request("/other")).status).toBe(404);
    expect(probes.server).toBe(server.asServer);
  });

  it("closes each connection at its close, and a second close gives the same promise", async () => {
    const { health } = await runtime();
    const server = new FakeServer();
    const probes = probeServer({ server_retry_after: s(1), port: 0, prefix: "/probe", server: server.asServer });
    await probes.listen(health);
    expect((await server.request("/probe/liveness")).status).toBe(200);
    const open = server.connect();
    const first = probes.close();
    expect(probes.close()).toBe(first);
    await first;
    expect(open.socket.destroyed).toBe(true);
    expect(() => server.connect()).toThrow(/ECONNREFUSED/);
  });

  it("gives each 503 of a probe the Retry-After of server_retry_after, and no other answer", async () => {
    const { health } = await runtime();
    const server = new FakeServer();
    const probes = probeServer({ server_retry_after: s(2.5), port: 0, server: server.asServer });
    await probes.listen(health);
    const ready = await server.request("/readiness");
    expect([ready.status, ready.headers.get("retry-after")]).toEqual([200, undefined]);
    health.drain();
    const draining = await server.request("/readiness");
    expect([draining.status, draining.headers.get("retry-after")]).toEqual([503, "3"]);
    const missing = await server.request("/nothing");
    expect([missing.status, missing.headers.get("retry-after")]).toEqual([404, undefined]);
  });

  it("has no defaults: server_retry_after is necessary, and it is a time with a bound", () => {
    expect(() => probeServer({ port: 1 } as never)).toThrow("probeServer needs the knob server_retry_after: it has no defaults");
    expect(() => probeServer({ server_retry_after: { value: 1, unit: "count" }, port: 1 })).toThrow("the knob server_retry_after is not a time");
    expect(() => probeServer({ server_retry_after: { value: "infinite", unit: "s" } as never, port: 1 })).toThrow(/has no bound/);
  });

  it("gives the error of its listen, and refuses a server with a request listener of its own", async () => {
    const { health } = await runtime();
    const server = new FakeServer();
    server.failListen = new Error("EADDRINUSE");
    await expect(probeServer({ server_retry_after: s(1), port: 1, server: server.asServer }).listen(health)).rejects.toThrow("EADDRINUSE");
    const taken = new FakeServer();
    taken.on("request", () => {});
    expect(() => probeServer({ server_retry_after: s(1), port: 1, server: taken.asServer })).toThrow(/a request listener of its own/);
    expect(() => probeServer({ server_retry_after: s(1), port: 1, prefix: "x" })).toThrow(/does not start with/);
  });
});

describe("the option kinds: the probes that answer, and a path of a kind left out is not a probe (SYS-30)", () => {
  const noReport: readonly ProbeKind[] = ["startup", "readiness", "liveness"];

  it("gives the four kinds in PROBE_KINDS, as a frozen list", () => {
    expect(PROBE_KINDS).toEqual(["startup", "readiness", "liveness", "report"]);
    expect(Object.isFrozen(PROBE_KINDS)).toBe(true);
  });

  it("probeResponse gives null for the path of a kind that the list does not name, and answers the others", async () => {
    const { health } = await runtime();
    expect(probeResponse(health, "GET", "/health/report", "/health", noReport)).toBeNull();
    // a left-out kind is not a probe for each method: no 405
    expect(probeResponse(health, "POST", "/health/report", "/health", noReport)).toBeNull();
    expect(probeResponse(health, "GET", "/health/readiness/orders", "/health", ["liveness"])).toBeNull();
    expect(probeResponse(health, "GET", "/health/readiness/orders", "/health", noReport)!.status).toBe(200);
    expect(probeResponse(health, "GET", "/health/report", "/health", ["report"])!.status).toBe(200);
    expect(probeResponse(health, "GET", "/health/startup", "/health", ["report"])).toBeNull();
  });

  it("probeServer without report gives 404 at /report, and still answers /readiness/<controller> and the other probes", async () => {
    const { health } = await runtime();
    const server = new FakeServer();
    const probes = probeServer({ server_retry_after: s(1), port: 0, server: server.asServer, kinds: noReport });
    await probes.listen(health);
    const report = await server.request("/report");
    expect([report.status, report.body]).toEqual([404, "Not Found"]);
    expect((await server.request("/report", "POST")).status).toBe(404);
    const controller = await server.request("/readiness/orders");
    expect(controller.status).toBe(200);
    expect(JSON.parse(controller.body)).toMatchObject({ status: "pass", probe: "readiness", controller: "orders" });
    for (const kind of noReport) expect((await server.request(`/${kind}`)).status, kind).toBe(200);
    // the option goes to no listen of the port
    expect(server.listens).toEqual([{ port: 0 }]);
  });

  it("probeHandler without report passes /report on to the next handler of the port", async () => {
    const { health } = await runtime();
    const handler = probeHandler(health, { prefix: "/health", kinds: noReport });
    const res = new FakeResponse(new FakeSocket());
    expect(handler(fakeReq("/health/report"), res as unknown as ServerResponse, undefined as never)).toBe(false);
    expect(res.headersSent).toBe(false);
    // on a transport, the next mount answers the path
    const knobs: HttpKnobs = { server_idle_close: s(65), server_idle_sweep_interval: s(1), server_retry_after: s(2) };
    const server = new FakeServer();
    const transport = httpTransport(server.asServer, knobs, { listen: { port: 8080 }, clock: fakeClock() });
    await transport.start(new AbortController().signal, detachedLifecycle());
    transport.mount(handler);
    transport.mount((req, next) => {
      if (req.url !== "/health/report") return false;
      next.writeHead(200, { "content-type": "text/plain" }).end("the report of the application");
      return true;
    });
    const report = await server.request("/health/report");
    expect([report.status, report.body]).toEqual([200, "the report of the application"]);
    const readiness = await server.request("/health/readiness/orders");
    expect(readiness.status).toBe(200);
    expect(JSON.parse(readiness.body)).toMatchObject({ probe: "readiness", controller: "orders" });
    await transport.close();
  });

  it("serves /report by default, on a probe server and in a probe handler", async () => {
    const { health } = await runtime();
    const server = new FakeServer();
    await probeServer({ server_retry_after: s(1), port: 0, server: server.asServer }).listen(health);
    const report = await server.request("/report");
    expect(report.status).toBe(200);
    expect(JSON.parse(report.body).verdict.ready).toBe(true);
    const res = new FakeResponse(new FakeSocket());
    expect(probeHandler(health, { prefix: "/health" })(fakeReq("/health/report"), res as unknown as ServerResponse, undefined as never)).toBe(true);
    expect(res.statusCode).toBe(200);
    // an undefined kinds is the default too
    expect(probeResponse(health, "GET", "/report", "", undefined)!.status).toBe(200);
  });

  it("refuses an empty list, an unknown kind and a kind two times at the call, and names the bad part", () => {
    const refusals: Array<[unknown, RegExp]> = [
      [[], /the probe kinds are an empty list: name one or more of "startup", "readiness", "liveness", "report"/],
      [["readiness", "health"], /the probe kind "health" is not one of "startup", "readiness", "liveness", "report"/],
      [["report", "liveness", "report"], /the probe kind "report" is two times in the probe kinds/],
      ["report", /the probe kinds "report" are not a list/],
    ];
    for (const [kinds, message] of refusals) {
      expect(() => probeHandler(() => null, { prefix: "", kinds: kinds as never }), String(kinds)).toThrow(message);
      expect(() => probeServer({ server_retry_after: s(1), port: 1, kinds: kinds as never }), String(kinds)).toThrow(message);
    }
  });

  it("keeps its own copy of the list, thus a later change of the caller's list changes nothing", async () => {
    const { health } = await runtime();
    const kinds: ProbeKind[] = ["readiness"];
    const handler = probeHandler(health, { prefix: "", kinds });
    kinds.push("report");
    expect(handler(fakeReq("/report"), new FakeResponse(new FakeSocket()) as unknown as ServerResponse, undefined as never)).toBe(false);
  });
});
