import { describe, expect, it } from "vitest";
import { service } from "../builder.ts";
import { fakeClock, seeded } from "../fakes.ts";
import type { Health } from "../health.ts";
import { probeHandler, probeResponse, probeServer } from "../http.ts";
import { scriptedCheck } from "../testing.ts";
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
    const probes = probeServer({ port: 9090, host: "0.0.0.0", server: server.asServer });
    await probes.listen(health);
    expect(server.listens).toEqual([{ port: 9090, host: "0.0.0.0" }]);
    expect((await server.request("/readiness")).status).toBe(200);
    expect((await server.request("/other")).status).toBe(404);
    expect(probes.server).toBe(server.asServer);
  });

  it("closes each connection at its close, and a second close gives the same promise", async () => {
    const { health } = await runtime();
    const server = new FakeServer();
    const probes = probeServer({ port: 0, prefix: "/probe", server: server.asServer });
    await probes.listen(health);
    expect((await server.request("/probe/liveness")).status).toBe(200);
    const open = server.connect();
    const first = probes.close();
    expect(probes.close()).toBe(first);
    await first;
    expect(open.socket.destroyed).toBe(true);
    expect(() => server.connect()).toThrow(/ECONNREFUSED/);
  });

  it("gives the error of its listen, and refuses a server with a request listener of its own", async () => {
    const { health } = await runtime();
    const server = new FakeServer();
    server.failListen = new Error("EADDRINUSE");
    await expect(probeServer({ port: 1, server: server.asServer }).listen(health)).rejects.toThrow("EADDRINUSE");
    const taken = new FakeServer();
    taken.on("request", () => {});
    expect(() => probeServer({ port: 1, server: taken.asServer })).toThrow(/a request listener of its own/);
    expect(() => probeServer({ port: 1, prefix: "x" })).toThrow(/does not start with/);
  });
});
