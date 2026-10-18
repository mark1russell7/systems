import type { Extent } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import type { LifecycleEvent } from "./events.ts";
import type { Check, CheckFn, Dependency, DependencyHandle, HealthServer, Lifecycle, ServiceBuilder, TransportImpl } from "./index.ts";
import { service } from "./index.ts";
import { fakeClock, fakeProcess, scriptedCheck, seeded } from "./testing.ts";

/**
 * SYS-8: the composition of components (D2). Each component gives its parts as data, and it does
 * not run. The entry of the process declares the parts of each component under one service, and
 * only the entry uses `run()`. This test composes two components, each with a transport, a
 * dependency handle and a check, as the README shows.
 */

const s = (value: number) => ({ value, unit: "s" });

/** These are the parts of a component, as data, in the form of the README. */
interface Parts {
  readonly servers: ReadonlyArray<{ name: string; knobs: Record<string, Extent>; impl: TransportImpl }>;
  readonly dependencies: ReadonlyArray<{ name: string; spec: Omit<Dependency, "name">; handle: DependencyHandle }>;
  readonly checks: ReadonlyArray<{ check: Check; run: CheckFn }>;
}

const declare = (svc: ServiceBuilder, parts: Parts): void => {
  for (const { name, spec, handle } of parts.dependencies) svc.dependency(name, spec, handle);
  for (const { name, knobs, impl } of parts.servers) svc.server(name, knobs, impl);
  for (const { check, run } of parts.checks) svc.check(check, run);
};

/** This function makes the parts of one host, under its prefix. Each part writes each use to the log. */
const host = (prefix: string, log: string[], lives: Lifecycle[]): Parts => {
  const write = (what: string): void => void log.push(`${prefix}: ${what}`);
  return {
    dependencies: [
      {
        name: `${prefix}.db`,
        spec: { system: null, knobs: {}, operations: { SELECT: { idempotent: true } } },
        handle: { connect: () => write("connect db"), close: () => write("close db") },
      },
    ],
    servers: [
      {
        name: `${prefix}.http`,
        knobs: {},
        impl: {
          start: (_signal, life) => {
            lives.push(life);
            write("start http");
          },
          stopIntake: () => write("stop intake http"),
          drain: () => write("drain http"),
          inFlight: () => 0,
          close: () => write("close http"),
        },
      },
    ],
    checks: [
      {
        check: {
          name: `${prefix}.db.round-trip`,
          dependency: `${prefix}.db`,
          step: "round-trip",
          ownConnection: true,
          gates: "readiness",
          poll: { interval: s(1), jitter: 0.2, timeout: s(0.4) },
        },
        run: scriptedCheck("ok").run,
      },
    ],
  };
};

describe("two components under one service and one run() (SYS-8)", () => {
  it("starts the parts in the declared sequence, stops each stage across both, and exits one time", async () => {
    const log: string[] = [];
    const lives: Lifecycle[] = [];
    const svc = service("app");
    for (const prefix of ["app", "ingest"]) declare(svc, host(prefix, log, lives));
    const probes: HealthServer = { listen: () => void log.push("entry: listen health"), close: () => void log.push("entry: close health") };
    svc
      .healthServer(probes)
      .readiness({ type: "debounce", interval: s(1), failAfter: 3, recoverAfter: 1 })
      .liveness({ type: "window", failAfter: s(5) })
      .startup(s(10))
      .phase("fail readiness", s(1))
      .phase("stop intake", s(1))
      .phase("drain", s(4))
      .phase("close transports", s(1))
      .phase("stop the poller", s(1))
      .phase("tear down dependencies", s(1))
      .phase("close the health server", s(1))
      .cooperativeWindow(s(1));
    svc.controller("app.api").requires("app.db").route("GET /things", { idempotent: true });
    svc.controller("ingest.api").requires("ingest.db").route("POST /ingest", { idempotent: true });

    const clock = fakeClock();
    const process = fakeProcess({ clock });
    const events: LifecycleEvent[] = [];
    let ended = false;
    const running = svc.run({ clock, random: seeded(1), process, record: (event) => events.push(event) }).finally(() => {
      ended = true;
    });
    for (let step = 0; step < 100 && !ended; step += 1) await clock.advance(100);
    const life = await running;

    // the startup: the one health server, the dependencies of both components, then each transport
    expect(log).toEqual([
      "entry: listen health",
      "app: connect db",
      "ingest: connect db",
      "app: start http",
      "ingest: start http",
    ]);
    expect(life.health.verdict()).toMatchObject({ ready: true, controllers: { "app.api": true, "ingest.api": true } });
    // each transport has the one lifecycle of the process
    expect(lives).toEqual([life, life]);
    expect(await life.request("ingest.api", "POST /ingest", () => "stored").collect()).toEqual({ items: ["stored"], end: { kind: "done", delivered: 1 } });

    log.length = 0;
    process.signal("SIGTERM");
    let code: number | null = null;
    void life.done.then((value) => {
      code = value;
    });
    for (let step = 0; step < 400 && code === null; step += 1) await clock.advance(50);

    // each stage acts on the parts of both components, and the dependencies close in reverse
    expect(log).toEqual([
      "app: stop intake http",
      "ingest: stop intake http",
      "app: drain http",
      "ingest: drain http",
      "app: close http",
      "ingest: close http",
      "ingest: close db",
      "app: close db",
      "entry: close health",
    ]);
    // one shutdown and one exit for the process, with no handler and no timer left
    expect(code).toBe(0);
    expect(process.exits).toEqual([0]);
    expect(events.filter((event) => event.machine === "exit" && event.to === "exited")).toHaveLength(1);
    expect(process.handlers).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it("refuses two components that give a part the same name: the entry gives each a prefix", () => {
    const svc = service("app");
    declare(svc, host("app", [], []));
    expect(() => declare(svc, host("app", [], []))).toThrow(/already has a dependency named app.db/);
  });
});
