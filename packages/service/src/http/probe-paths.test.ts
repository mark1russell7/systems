import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { service } from "../builder.ts";
import { fakeClock, seeded } from "../fakes.ts";
import type { Health, ProbeKind } from "../health.ts";
import type { ProbePaths } from "../http.ts";
import { probeHandler, probeResponse, probeServer } from "../http.ts";
import { scriptedCheck } from "../testing.ts";
import { FakeResponse, FakeServer, FakeSocket } from "./fake-server.ts";

/** SYS-46: more paths for a probe kind, for example `/livez` and `/healthz` for the liveness. */

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

/** This function asks a handler for a path, and gives the status, or null when the path goes to the next handler. */
const asker =
  (handler: ReturnType<typeof probeHandler>) =>
  (url: string, method = "GET"): { status: number; body: string } | null => {
    const res = new FakeResponse(new FakeSocket());
    if (!handler(fakeReq(url, method), res as unknown as ServerResponse, undefined as never)) return null;
    return { status: res.statusCode, body: res.chunks.join("") };
  };

const K8S: ProbePaths = { liveness: ["/livez", "/healthz"], readiness: ["/readyz"] };

describe("probeHandler({ paths }): more paths for each probe kind (SYS-46)", () => {
  it("answers each more path as its probe kind, and the paths of the kinds still answer", async () => {
    const { health, check, clock } = await runtime();
    const ask = asker(probeHandler(health, { prefix: "/health", paths: K8S }));
    for (const path of ["/livez", "/healthz", "/readyz", "/health/liveness", "/health/readiness"]) expect(ask(path)?.status, path).toBe(200);
    expect(JSON.parse(ask("/livez")!.body)).toMatchObject({ probe: "liveness" });
    expect(JSON.parse(ask("/readyz")!.body)).toMatchObject({ probe: "readiness" });
    expect(ask("/healthz?verbose=1")?.status).toBe(200);
    expect(ask("/readyz", "POST")?.status).toBe(405);
    // a more path follows its probe: the readiness fails, and the liveness passes
    check.behavior = "error";
    await clock.advance(1000);
    expect(ask("/readyz")?.status).toBe(503);
    expect(ask("/livez")?.status).toBe(200);
    // a more path is exact: no controller after it, and no prefix before it
    expect(ask("/readyz/orders")).toBeNull();
    expect(ask("/health/readyz")).toBeNull();
    expect(ask("/startupz")).toBeNull();
  });

  it("answers the same paths as before without the option", async () => {
    const { health } = await runtime();
    const ask = asker(probeHandler(health, { prefix: "" }));
    for (const path of ["/startup", "/readiness", "/liveness", "/report", "/readiness/orders"]) expect(ask(path)?.status, path).toBe(200);
    for (const path of ["/livez", "/healthz", "/readyz"]) expect(ask(path), path).toBeNull();
    expect(probeResponse(health, "GET", "/livez")).toBeNull();
  });

  it("refuses a bad option: an unknown kind, a kind that kinds leaves out, a bad path, a path two times or a path of a kind", () => {
    const make = (paths: unknown, kinds?: readonly ProbeKind[]) => () =>
      probeHandler(() => null, { prefix: "", paths: paths as ProbePaths, ...(kinds === undefined ? {} : { kinds }) });
    expect(make({ live: ["/livez"] })).toThrow(/the probe paths name "live", which is not one of "startup", "readiness", "liveness", "report"/);
    expect(make({ liveness: ["/livez"] }, ["readiness"])).toThrow(/the probe paths name "liveness", but the probe kinds do not/);
    expect(make({ liveness: "/livez" })).toThrow(/the probe paths of "liveness" are not a list/);
    for (const path of ["livez", "/", "/livez/", "/livez?x", 7])
      expect(make({ liveness: [path] }), String(path)).toThrow(/does not start with "\/", ends with "\/", or has a query/);
    expect(make({ liveness: ["/z"], readiness: ["/z"] })).toThrow(/the probe path "\/z" is two times in the probe paths/);
    expect(make({ liveness: ["/readiness"] })).toThrow(/the probe path "\/readiness" is a path of a probe kind after the prefix ""/);
    expect(make([])).toThrow(/are not an object of probe kinds/);
    expect(make({})).not.toThrow();
  });

  it("works on the probe server too", async () => {
    const { health } = await runtime();
    const server = new FakeServer();
    const probes = probeServer({ server_retry_after: s(1), port: 0, server: server.asServer, paths: { liveness: ["/livez"] } });
    await probes.listen(health);
    expect((await server.request("/livez")).status).toBe(200);
    expect((await server.request("/liveness")).status).toBe(200);
    expect((await server.request("/readyz")).status).toBe(404);
  });
});
