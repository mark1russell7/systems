import type { Quantity } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import type { FakeHost } from "./fakes.ts";
import { fakeHost } from "./fakes.ts";
import type { TargetChange, WatchSpec, WatchTarget } from "./watch.ts";
import { watchProblems, watchTargets } from "./watch.ts";

const WALL = 1_000_000_000_000;
const ms = (value: number): Quantity => ({ value, unit: "ms" });
const s = (value: number): Quantity => ({ value, unit: "s" });
const API = "http://127.0.0.1:8080/liveness";
const FRESH = "http://127.0.0.1:8080/freshness";

const target = (fields: Partial<WatchTarget> = {}): WatchTarget => ({
  name: "api",
  probe: { kind: "http", url: API },
  interval: s(10),
  timeout: s(2),
  ...fields,
});
const step = async (host: FakeHost, time: number): Promise<void> => {
  await host.clock.advance(time);
  await host.settle();
};
/** This function starts a watcher with no jitter: random 0.5 moves no interval. */
const watch = (host: FakeHost, spec: WatchSpec, changes: TargetChange[] = []) => watchTargets(spec, host.ports, { onChange: (change) => void changes.push(change), random: () => 0.5 });

describe("watchProblems", () => {
  it("names each bad value of the spec", () => {
    expect(watchProblems({ targets: [] })).toEqual(["the spec has no target"]);
    expect(
      watchProblems({
        targets: [
          target(),
          target({ timeout: s(20), jitter: 1 }),
          target({ name: "", interval: s(0), probe: { kind: "tcp", port: 0 } }),
          target({ name: "w", verdict: { type: "window", failAfter: s(-1), recoverAfter: ms(-5) } }),
          target({ name: "d", verdict: { type: "debounce", failAfter: 0, recoverAfter: 1.5 } }),
        ],
      }),
    ).toEqual([
      'the target "api" is in the spec two times',
      'the target "api": the timeout is above the interval',
      'the target "api": the jitter 1 is not a fraction from 0 to below 1',
      "a target name is empty",
      'the target "": the port 0 is not a port from 1 to 65535',
      'the target "": the interval is not a time above zero',
      'the target "w": the failAfter of the window is not a time of zero or more',
      'the target "w": the recoverAfter of the window is not a time of zero or more',
      'the target "d": the verdict fails after 0 polls, not a whole number above zero',
      'the target "d": the verdict recovers after 1.5 polls, not a whole number above zero',
    ]);
  });

  it("makes watchTargets throw at the start", () => {
    expect(() => watch(fakeHost(), { targets: [] })).toThrow("the watch spec has problems: the spec has no target");
  });
});

describe("watchTargets", () => {
  it("makes a target up at its first pass, down after 3 failures, and up again after 2 passes", async () => {
    const host = fakeHost();
    host.http.set(API, 200);
    const changes: TargetChange[] = [];
    const watcher = watch(host, { targets: [target()] }, changes);
    expect(watcher.states()[0]).toMatchObject({ name: "api", health: "unknown", since: WALL, last: null, lastAt: null, failures: 0 });
    await step(host, 0);
    expect(changes).toEqual([{ target: "api", from: "unknown", to: "up", at: WALL, why: null }]);

    host.http.set(API, 503);
    await step(host, 10_000);
    await step(host, 10_000);
    expect(changes).toHaveLength(1);
    expect(watcher.states()[0]).toMatchObject({ health: "up", failures: 2, last: { ok: false, why: `${API} gave 503, not 200` }, lastAt: WALL + 20_000 });
    await step(host, 10_000);
    expect(changes[1]).toEqual({ target: "api", from: "up", to: "down", at: WALL + 30_000, why: `${API} gave 503, not 200` });

    host.http.set(API, 200);
    await step(host, 10_000);
    expect(watcher.states()[0]).toMatchObject({ health: "down", failures: 0, last: { ok: true } });
    await step(host, 10_000);
    expect(changes[2]).toEqual({ target: "api", from: "down", to: "up", at: WALL + 50_000, why: null });
    expect(watcher.states()[0]).toMatchObject({ health: "up", since: WALL + 50_000 });
    watcher.stop();
  });

  it("makes a target that never passes down from unknown, with the reason of the latest poll", async () => {
    const host = fakeHost();
    const changes: TargetChange[] = [];
    const watcher = watch(host, { targets: [target({ probe: { kind: "tcp", port: 5432 } })] }, changes);
    await step(host, 0);
    await step(host, 10_000);
    expect(changes).toEqual([]);
    expect(watcher.states()[0]?.health).toBe("unknown");
    await step(host, 10_000);
    expect(changes).toEqual([{ target: "api", from: "unknown", to: "down", at: WALL + 20_000, why: "no TCP connection to 127.0.0.1:5432 in 2000 ms" }]);
    watcher.stop();
  });

  it("goes down on a stale time of a freshness bound, and names it", async () => {
    const host = fakeHost();
    host.http.set(FRESH, 200);
    const body = (sentAt: number): string => JSON.stringify({ delivery: { lastTestSendAt: sentAt } });
    host.bodies.set(FRESH, body(WALL));
    const changes: TargetChange[] = [];
    const probe = { kind: "http" as const, url: FRESH, fresh: [{ pointer: "/delivery/lastTestSendAt", within: s(25) }] };
    const watcher = watch(host, { targets: [target({ name: "pipeline", probe, verdict: { type: "debounce", failAfter: 1, recoverAfter: 1 } })] }, changes);
    await step(host, 0);
    await step(host, 10_000);
    await step(host, 10_000);
    expect(changes).toEqual([{ target: "pipeline", from: "unknown", to: "up", at: WALL, why: null }]);
    await step(host, 10_000);
    expect(changes[1]).toEqual({ target: "pipeline", from: "up", to: "down", at: WALL + 30_000, why: `${FRESH}: /delivery/lastTestSendAt is 30 s old, above 25 s` });
    host.bodies.set(FRESH, body(WALL + 35_000));
    await step(host, 10_000);
    expect(changes[2]).toMatchObject({ to: "up", at: WALL + 40_000 });
    watcher.stop();
  });

  it("fails a poll at its timeout when the probe gives no answer", async () => {
    const host = fakeHost();
    const ports = { ...host.ports, net: { ...host.ports.net, httpStatus: () => new Promise<number | null>(() => {}) } };
    const changes: TargetChange[] = [];
    const watcher = watchTargets({ targets: [target({ verdict: { type: "debounce", failAfter: 1, recoverAfter: 1 } })] }, ports, {
      onChange: (change) => void changes.push(change),
      random: () => 0.5,
    });
    await step(host, 0);
    await step(host, 2_000);
    expect(changes).toEqual([{ target: "api", from: "unknown", to: "down", at: WALL + 2_000, why: "no answer in 2000 ms" }]);
    // the hung call stays pending, thus the next poll fails at once with its own reason
    await step(host, 8_000);
    expect(watcher.states()[0]?.last).toEqual({ ok: false, why: "its call of 10000 ms ago is still pending" });
    watcher.stop();
  });

  it("goes down after the time of a window, and up at the first pass without recoverAfter", async () => {
    const host = fakeHost();
    const changes: TargetChange[] = [];
    const watcher = watch(host, { targets: [target({ verdict: { type: "window", failAfter: s(25) } })] }, changes);
    await step(host, 0);
    await step(host, 20_000);
    expect(changes).toEqual([]);
    await step(host, 5_000);
    expect(changes).toEqual([{ target: "api", from: "unknown", to: "down", at: WALL + 25_000, why: `${API} gave no answer in 2000 ms` }]);
    host.http.set(API, 200);
    await step(host, 5_000);
    expect(changes[1]).toEqual({ target: "api", from: "down", to: "up", at: WALL + 30_000, why: null });
    watcher.stop();
  });

  it("watches each target on its own loop, and keeps on when the handler throws", async () => {
    const host = fakeHost();
    host.http.set(API, 200);
    host.tcp.add("127.0.0.1:5432");
    const seen: string[] = [];
    const watcher = watchTargets({ targets: [target(), target({ name: "db", probe: { kind: "tcp", port: 5432 }, interval: s(5), timeout: s(1) })] }, host.ports, {
      onChange: (change) => {
        seen.push(`${change.target} ${change.to}`);
        throw new Error("the handler broke");
      },
      random: () => 0.5,
    });
    await step(host, 0);
    expect(seen).toEqual(["api up", "db up"]);
    host.tcp.clear();
    for (let poll = 0; poll < 3; poll += 1) await step(host, 5_000);
    expect(seen).toEqual(["api up", "db up", "db down"]);
    expect(watcher.states().map((state) => state.health)).toEqual(["up", "down"]);
    watcher.stop();
  });

  it("polls at once with pollNow, and gives no change after stop", async () => {
    const host = fakeHost();
    host.http.set(API, 200);
    const changes: TargetChange[] = [];
    const watcher = watch(host, { targets: [target()] }, changes);
    const states = await watcher.pollNow();
    expect(states[0]?.health).toBe("up");
    watcher.stop();
    host.http.set(API, 503);
    for (let poll = 0; poll < 5; poll += 1) await step(host, 10_000);
    expect(changes).toEqual([{ target: "api", from: "unknown", to: "up", at: WALL, why: null }]);
    expect(watcher.states()[0]?.lastAt).toBe(WALL);
  });
});
