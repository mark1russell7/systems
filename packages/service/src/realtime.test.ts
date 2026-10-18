import { connect } from "node:net";
import type { Socket } from "node:net";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import type { Poll, Timing } from "./index.ts";
import { failSpan, service } from "./index.ts";
import { quietServer, scriptedCheck } from "./testing.ts";

const ms = (value: number) => ({ value, unit: "ms" });
const sleep = (time: number) => new Promise((resolve) => setTimeout(resolve, time));
/** the slack of a real event loop on a shared CI machine, in milliseconds */
const SLACK = 150;

/** a check against the quiet server: it sends a byte, and it passes when the byte comes back */
const echo = (port: number) => {
  let socket: Socket | null = null;
  let waiting: (() => void) | null = null;
  const open = (): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const made = connect(port, "127.0.0.1", () => resolve(made));
      made.on("error", reject);
      made.on("data", () => waiting?.());
    });
  return async (signal: AbortSignal): Promise<"ok"> => {
    socket ??= await open();
    await new Promise<void>((resolve, reject) => {
      waiting = resolve;
      signal.addEventListener("abort", () => reject(new Error("no echo before the timeout")));
      socket!.write("x");
    });
    return "ok";
  };
};

describe("in real time", () => {
  it("trips and recovers on the real clock, inside the bounds of the algebra", async () => {
    const poll: Poll = { interval: ms(40), jitter: 0.2, timeout: ms(20) };
    const timing: Timing = { type: "debounce", interval: ms(40), failAfter: 2, recoverAfter: 1 };
    const check = scriptedCheck("ok");
    const svc = service("realtime")
      .check({ name: "x", dependency: null, step: "round-trip", ownConnection: true, gates: "readiness", poll }, check.run)
      .readiness(timing)
      .liveness({ type: "window", failAfter: ms(10_000) })
      .startup(ms(1000))
      .phase("drain", ms(10))
      .onRepeatSignal("ignore")
      .cooperativeWindow(ms(10));
    const health = await svc.start();
    expect(health.verdict().ready).toBe(true);
    const span = failSpan(timing, poll, "error");
    const bad = performance.now();
    check.behavior = "error";
    while (health.verdict().ready && performance.now() - bad < valueIn(span.max, "ms") + SLACK) await sleep(2);
    const trip = performance.now() - bad;
    expect(health.verdict().ready).toBe(false);
    expect(trip).toBeGreaterThanOrEqual(valueIn(span.min, "ms") - 5);
    check.behavior = "ok";
    const good = performance.now();
    while (!health.verdict().ready && performance.now() - good < 48 + SLACK) await sleep(2);
    expect(health.verdict().ready).toBe(true);
    health.stop();
  });

  it("sees a quiet server: open, silent, and then answering again (F2)", async () => {
    const server = await quietServer();
    const poll: Poll = { interval: ms(50), jitter: 0, timeout: ms(25) };
    const svc = service("quiet")
      .dependency("echo", { system: null, knobs: {}, operations: {} })
      .check(
        { name: "echo.round-trip", dependency: "echo", step: "round-trip", ownConnection: true, gates: "readiness", poll },
        echo(server.port),
      )
      .readiness({ type: "debounce", interval: ms(50), failAfter: 2, recoverAfter: 1 })
      .liveness({ type: "window", failAfter: ms(10_000) })
      .startup(ms(1000))
      .phase("drain", ms(10))
      .onRepeatSignal("ignore")
      .cooperativeWindow(ms(10));
    const health = await svc.start();
    expect(health.verdict().ready).toBe(true);
    server.quiet();
    const quiet = performance.now();
    while (health.verdict().ready && performance.now() - quiet < 2 * 50 + 25 + SLACK) await sleep(2);
    expect(health.verdict().ready).toBe(false);
    // the connection stays open while the server is quiet
    expect(server.connections).toBe(1);
    expect(health.verdict().checks["echo.round-trip"]!.last?.timedOut).toBe(true);
    server.speak();
    const back = performance.now();
    while (!health.verdict().ready && performance.now() - back < 50 + SLACK) await sleep(2);
    expect(health.verdict().ready).toBe(true);
    health.stop();
    await server.close();
  });
});
