import { describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import { outcomeResponse, writeOutcome } from "../http.ts";
import type { OutcomeOptions } from "../http.ts";
import type { Controller } from "../description.ts";
import { fakeClock } from "../fakes.ts";
import type { RequestOutcome } from "../requests.ts";
import { tracker } from "../requests.ts";
import { FakeResponse, FakeSocket } from "./fake-server.ts";

/** SYS-3 (its first part): a request outcome as a status, a Retry-After and a Connection: close. */

const s = (value: number) => ({ value, unit: "s" });
const OPTIONS: OutcomeOptions<unknown> = { keepAlive: true, retryAfter: s(1.2) };

describe("outcomeResponse: each outcome as a response", () => {
  it("gives 200 and JSON for a value, text for a string, bytes for bytes, and 204 for no value", () => {
    expect(outcomeResponse({ kind: "done", value: { id: 1 } }, OPTIONS)).toEqual({
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: '{"id":1}',
    });
    expect(outcomeResponse({ kind: "done", value: "pod-a" }, OPTIONS).headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(outcomeResponse({ kind: "done", value: new Uint8Array([1]) }, OPTIONS).headers["content-type"]).toBe("application/octet-stream");
    expect(outcomeResponse({ kind: "done", value: undefined }, OPTIONS)).toEqual({ status: 204, headers: {}, body: "" });
  });

  it("gives 500 with no detail for a failure of the route, and the failed hook can change it", () => {
    const failed: RequestOutcome<unknown> = { kind: "failed", error: new Error("the password is hunter2") };
    const plain = outcomeResponse(failed, OPTIONS);
    expect(plain.status).toBe(500);
    expect(plain.body).toBe('{"outcome":"failed","retryable":false}');
    const hooked = outcomeResponse(failed, { ...OPTIONS, failed: () => ({ status: 502, body: "upstream" }) });
    expect([hooked.status, hooked.body, hooked.headers["content-type"]]).toEqual([502, "upstream", "application/json; charset=utf-8"]);
  });

  it("gives a refusal 503 with Retry-After in whole seconds, rounded up", () => {
    const refused = outcomeResponse({ kind: "refused", status: 503, retryable: true, cause: "the service stopped its intake" }, OPTIONS);
    expect(refused.status).toBe(503);
    expect(refused.headers["retry-after"]).toBe("2");
    expect(JSON.parse(refused.body as string)).toEqual({ outcome: "refused", retryable: true, cause: "the service stopped its intake" });
  });

  it("gives a cut its own status: 503 with Retry-After when the route can go again, and 500 with none when it cannot", () => {
    const again = outcomeResponse({ kind: "cut", status: 503, retryable: true, cause: "the drain reached its deadline" }, OPTIONS);
    expect([again.status, again.headers["retry-after"]]).toEqual([503, "2"]);
    const once = outcomeResponse({ kind: "cut", status: 500, retryable: false, cause: "the drain reached its deadline" }, OPTIONS);
    expect([once.status, once.headers["retry-after"]]).toEqual([500, undefined]);
  });

  it("adds Connection: close while the service cannot keep the connection, and reads a function each time", () => {
    let keep = true;
    const options: OutcomeOptions<string> = { keepAlive: () => keep, retryAfter: s(0) };
    expect(outcomeResponse({ kind: "done", value: "x" }, options).headers["connection"]).toBeUndefined();
    keep = false;
    expect(outcomeResponse({ kind: "done", value: "x" }, options).headers["connection"]).toBe("close");
    const refused = outcomeResponse({ kind: "refused", status: 503, retryable: true, cause: "c" }, { keepAlive: false, retryAfter: s(0) });
    expect([refused.headers["retry-after"], refused.headers["connection"]]).toEqual(["0", "close"]);
  });

  it("lets the done hook give the status, the headers and the body of a value", () => {
    const response = outcomeResponse({ kind: "done", value: 7 }, { ...OPTIONS, done: (value) => ({ status: 201, headers: { location: `/v/${String(value)}` } }) });
    expect(response).toEqual({ status: 201, headers: { "content-type": "application/json; charset=utf-8", location: "/v/7" }, body: "7" });
  });
});

describe("writeOutcome: the response of node:http", () => {
  const written = (outcome: RequestOutcome<unknown>, options: OutcomeOptions<unknown> = OPTIONS) => {
    const res = new FakeResponse(new FakeSocket());
    writeOutcome(res as unknown as ServerResponse, outcome, options);
    return res;
  };

  it("writes the status, the headers and the length of the body", () => {
    const res = written({ kind: "done", value: "héllo" });
    expect(res.statusCode).toBe(200);
    expect(res.getHeader("content-length")).toBe("6");
    expect(res.chunks.join("")).toBe("héllo");
    expect(res.writableEnded).toBe(true);
  });

  it("writes a 204 with no body and no length, and closes the connection when it cannot keep it", () => {
    const res = written({ kind: "done", value: undefined }, { keepAlive: false, retryAfter: s(1) });
    expect(res.statusCode).toBe(204);
    expect(res.getHeader("content-length")).toBeUndefined();
    expect(res.shouldKeepAlive).toBe(false);
    expect(res.getHeader("connection")).toBe("close");
  });

  it("destroys a response whose headers went already, because it cannot give a second status", () => {
    const socket = new FakeSocket();
    const res = new FakeResponse(socket);
    res.writeHead(200);
    writeOutcome(res as unknown as ServerResponse, { kind: "failed", error: new Error("late") }, OPTIONS);
    expect(socket.destroyed).toBe(true);
  });
});

describe("Retry-After on each 503 and on no 500, from the outcomes of the request tracker (RFC 9110, S6 A12)", () => {
  const controllers: Controller[] = [
    { name: "api", requires: [], routes: { "GET /work": { idempotent: true }, "POST /once": { idempotent: false } } },
  ];
  const hang = (): Promise<never> => new Promise<never>(() => {});

  /** This function gives the real outcome of each path, from a tracker on the fake clock. */
  const paths = async (): Promise<Array<[string, RequestOutcome<unknown>]>> => {
    const clock = fakeClock();
    const starting = tracker(controllers, clock, () => "the service has not started");
    const startup = await starting.request("api", "GET /work", () => "x");
    const running = tracker(controllers, clock, () => null);
    const again = running.request("api", "GET /work", hang);
    const once = running.request("api", "POST /once", hang);
    running.stopIntake();
    const stopped = await running.request("api", "GET /work", () => "x");
    const drained = running.drain(clock.now() + 1000);
    await clock.advance(1000);
    await drained;
    const failing = tracker(controllers, clock, () => null);
    const failed = await failing.request("api", "POST /once", () => {
      throw new Error("the route failed");
    });
    return [
      ["the refusal at the startup", startup],
      ["the refusal after the intake stopped", stopped],
      ["the retryable cut of an idempotent route", await again],
      ["the cut of a route that is not idempotent", await once],
      ["a failure of the route", failed],
    ];
  };

  it("gives each path the status and the Retry-After of its rule", async () => {
    const answers = (await paths()).map(([path, outcome]) => {
      const response = outcomeResponse(outcome, OPTIONS);
      return [path, response.status, response.headers["retry-after"]];
    });
    expect(answers).toEqual([
      ["the refusal at the startup", 503, "2"],
      ["the refusal after the intake stopped", 503, "2"],
      ["the retryable cut of an idempotent route", 503, "2"],
      ["the cut of a route that is not idempotent", 500, undefined],
      ["a failure of the route", 500, undefined],
    ]);
  });

  it("writes the same header to the response of node:http on each path", async () => {
    for (const [path, outcome] of await paths()) {
      const res = new FakeResponse(new FakeSocket());
      writeOutcome(res as unknown as ServerResponse, outcome, OPTIONS);
      expect(res.getHeader("retry-after"), path).toBe(res.statusCode === 503 ? "2" : undefined);
    }
  });
});
