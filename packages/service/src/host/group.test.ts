import type { Quantity } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { testLogger } from "../testing.ts";
import type { FakeHost } from "./fakes.ts";
import { fakeHost } from "./fakes.ts";
import type { GroupSpec, GroupSupervisor, ProgramRestart, ProgramSpec } from "./group.ts";
import { groupProblems, nextReadyWindow, readyTimesPath, startOrder, superviseGroup } from "./group.ts";
import { lockText, parseLockOwner } from "./lock.ts";
import type { HostPorts } from "./ports.ts";

const WALL = 1_000_000_000_000;
const ms = (value: number): Quantity => ({ value, unit: "ms" });
const quick: ProgramRestart = { backoff: { base: 1000, factor: 2, cap: 8000, jitter: { kind: "none" } }, resetAfter: { value: 5, unit: "s" } };
const API_HEALTH = "http://127.0.0.1:8080/health";

/** This stack lists the programs out of their sequence: the sequence comes from `after`. */
const stack = (): GroupSpec => ({
  name: "demo",
  stateDir: "/state",
  programs: [
    { name: "web", program: "/bin/web", after: ["api"], restart: quick },
    {
      name: "api",
      program: "/bin/api",
      args: ["--port", "8080"],
      cwd: "/srv/api",
      after: ["db"],
      envFile: "/state/api.env",
      env: { SHARED: "spec" },
      ready: { probe: { kind: "http", url: API_HEALTH }, interval: ms(100), timeout: ms(50), within: { value: 5, unit: "s" } },
      restart: quick,
      listen: { port: 8080, url: "http://127.0.0.1:8080/" },
    },
    { name: "db", program: "/bin/db", ready: { probe: { kind: "tcp", port: 5432 }, interval: ms(100), timeout: ms(50), within: { value: 5, unit: "s" } }, restart: quick },
  ],
});

const one = (program: ProgramSpec, stateDir = "/state"): GroupSpec => ({ name: "demo", stateDir, programs: [program] });
const step = async (host: FakeHost, time: number): Promise<void> => {
  await host.clock.advance(time);
  await host.settle();
};
const phases = (group: GroupSupervisor): Record<string, string> => Object.fromEntries(group.states().map((state) => [state.name, state.phase]));
const programs = (host: FakeHost): string[] => host.children.map((child) => child.request.program);
const calls = (host: FakeHost): string[] => host.commands.map((command) => [command.file, ...command.args].join(" "));

describe("groupProblems and startOrder", () => {
  it("gives the layers of the start sequence from after", () => {
    expect(startOrder(stack())).toEqual([["db"], ["api"], ["web"]]);
    expect(groupProblems(stack())).toEqual([]);
  });

  it("names each bad value, an unknown program, a program after itself and a cycle", () => {
    const spec: GroupSpec = {
      name: "demo",
      stateDir: "/s",
      programs: [
        { name: "a", program: "/bin/a", after: ["b"] },
        { name: "b", program: "/bin/b", after: ["a"] },
        { name: "c", program: "/bin/c", after: ["missing", "c"] },
        { name: "c", program: "" },
        {
          name: "d",
          program: "/bin/d",
          ready: { probe: { kind: "tcp", port: 0 }, interval: { value: 1, unit: "MB" }, timeout: ms(0), within: ms(10) },
          restart: { backoff: { base: -1 }, resetAfter: ms(-1) },
          log: { path: "", maxSize: { value: 0, unit: "B" }, keep: 1.5 },
          stop: { grace: ms(-5) },
          listen: { port: 70_000 },
        },
      ],
    };
    expect(groupProblems(spec)).toEqual([
      'the program "c" is after "missing", which is not in the group',
      'the program "c" is after itself',
      'the program "c" comes two times',
      'the program "c": the program is empty',
      'the program "d": the port 0 is not a port from 1 to 65535',
      'the program "d": the interval of the probe is not a time above zero',
      'the program "d": the timeout of the probe is not a time above zero',
      'the program "d": the base -1 is not a time of zero or more',
      'the program "d": the resetAfter is not a time of zero or more',
      'the program "d": the maxSize of the log is not a size above zero',
      'the program "d": the keep of the log is not a whole number of zero or more',
      'the program "d": the path of the log is empty',
      'the program "d": the grace of the stop is not a time of zero or more',
      'the program "d": the port 70000 is not a port from 1 to 65535',
      'the programs "a", "b" are in a cycle of "after", or after a program in one',
    ]);
  });

  it("makes superviseGroup refuse a spec with problems", () => {
    expect(() => superviseGroup({ name: "demo", stateDir: "/s", programs: [] }, fakeHost().ports)).toThrow("the group demo has problems: the group has no programs");
  });
});

describe("superviseGroup starts each program after its programs are ready", () => {
  it("starts in the sequence of after, with the probes, the env file, the locks and the discovery files", async () => {
    const host = fakeHost({ env: { PATH: "/bin", SHARED: "host" }, files: { "/state/api.env": "SHARED=file\nFROM_FILE=1\n" } });
    const group = superviseGroup(stack(), host.ports);
    group.start();
    await host.settle();
    expect(programs(host)).toEqual(["/bin/db"]);
    expect(phases(group)).toEqual({ web: "waiting", api: "waiting", db: "starting" });
    expect(group.states()[2]?.detail).toBe("no TCP connection to 127.0.0.1:5432 in 50 ms");

    host.tcp.add("127.0.0.1:5432");
    await step(host, 100);
    expect(programs(host)).toEqual(["/bin/db", "/bin/api"]);
    expect(phases(group)).toEqual({ web: "waiting", api: "starting", db: "ready" });

    host.http.set(API_HEALTH, 200);
    await step(host, 100);
    expect(programs(host)).toEqual(["/bin/db", "/bin/api", "/bin/web"]);
    expect(phases(group)).toEqual({ web: "ready", api: "ready", db: "ready" });

    // the environment is the host, then the env file, then the env of the spec
    expect(host.children[1]?.request).toEqual({ program: "/bin/api", args: ["--port", "8080"], cwd: "/srv/api", env: { PATH: "/bin", SHARED: "spec", FROM_FILE: "1" }, ipc: false });
    expect(JSON.parse(host.text("/state/api.json") ?? "null")).toEqual({
      pid: 1001,
      startedAt: new Date(WALL + 100).toISOString(),
      port: 8080,
      url: "http://127.0.0.1:8080/",
      extra: { group: "demo", program: "api" },
    });
    // one lock for each program: the supervisor holds it for its child
    expect(parseLockOwner(host.text("/state/api.lock") ?? "")).toEqual({ pid: 100, startedAt: WALL, child: { pid: 1001, startedAt: WALL + 100 } });
    expect(parseLockOwner(host.text("/state/db.lock") ?? "")?.child?.pid).toBe(1000);
    expect(parseLockOwner(host.text("/state/web.lock") ?? "")?.child?.pid).toBe(1002);
  });

  it("writes the output of each program to its log, and stops in the reverse sequence", async () => {
    const host = fakeHost({ files: { "/state/api.env": "" } });
    host.tcp.add("127.0.0.1:5432");
    host.http.set(API_HEALTH, 200);
    const group = superviseGroup(stack(), host.ports);
    group.start();
    await host.settle();
    expect(phases(group)).toEqual({ web: "ready", api: "ready", db: "ready" });
    host.children[0]?.output("stdout", "db up\n");
    host.children[0]?.output("stderr", new TextEncoder().encode("db warns\n"));
    await host.settle();
    expect(host.text("/state/logs/db.log")).toBe("db up\ndb warns\n");

    host.polite = true;
    const stopping = group.stop();
    expect(group.stop()).toBe(stopping);
    await stopping;
    expect(host.signals).toEqual([
      { pid: 1002, signal: "SIGTERM", group: false },
      { pid: 1001, signal: "SIGTERM", group: false },
      { pid: 1000, signal: "SIGTERM", group: false },
    ]);
    expect(phases(group)).toEqual({ web: "stopped", api: "stopped", db: "stopped" });
    // the stop removes each lock and each discovery file
    expect([...host.files.keys()].sort()).toEqual(["/state/api.env", "/state/logs/db.log"]);
  });
});

describe("superviseGroup starts a program again after it stops", () => {
  it("waits the backoff of the retrier, and resets it after the program is ready for resetAfter", async () => {
    const logger = testLogger();
    const host = fakeHost({ logger });
    const group = superviseGroup(one({ name: "worker", program: "/bin/worker", restart: quick }), host.ports);
    group.start();
    await host.settle();
    host.children[0]?.exit(1);
    await host.settle();
    expect(group.states()[0]).toEqual({ name: "worker", phase: "backoff", pid: null, restarts: 0, detail: "it exited with the code 1" });
    await step(host, 999);
    expect(host.children).toHaveLength(1);
    await step(host, 1);
    expect(host.children).toHaveLength(2);
    expect(group.states()[0]?.restarts).toBe(1);

    host.children[1]?.exit(null, "SIGSEGV");
    await host.settle();
    expect(group.states()[0]?.detail).toBe("it exited with the signal SIGSEGV");
    await step(host, 2000);
    expect(host.children).toHaveLength(3);

    // ready for 5 s: the count of tries goes back to 0
    await step(host, 5000);
    host.children[2]?.exit(1);
    await host.settle();
    await step(host, 1000);
    expect(host.children).toHaveLength(4);
    expect(logger.messages("info").filter((message) => message.includes("starts again"))).toEqual([
      "worker starts again in 1000 ms",
      "worker starts again in 2000 ms",
      "worker starts again in 1000 ms",
    ]);
    // the lock stays with the supervisor between the starts
    expect(parseLockOwner(host.text("/state/worker.lock") ?? "")?.child?.pid).toBe(1003);
  });

  it("starts a program again only after its programs are ready again", async () => {
    const host = fakeHost();
    const none = { kind: "none" } as const;
    const group = superviseGroup(
      {
        name: "demo",
        stateDir: "/state",
        programs: [
          { name: "db", program: "/bin/db", restart: { backoff: { base: 3000, jitter: none }, resetAfter: ms(0) } },
          { name: "api", program: "/bin/api", after: ["db"], restart: { backoff: { base: 1000, jitter: none }, resetAfter: ms(0) } },
        ],
      },
      host.ports,
    );
    group.start();
    await host.settle();
    expect(programs(host)).toEqual(["/bin/db", "/bin/api"]);
    host.children[0]?.exit(1);
    host.children[1]?.exit(1);
    await host.settle();
    await step(host, 1000);
    expect(phases(group)).toEqual({ db: "backoff", api: "waiting" });
    expect(host.children).toHaveLength(2);
    await step(host, 2000);
    expect(programs(host)).toEqual(["/bin/db", "/bin/api", "/bin/db", "/bin/api"]);
    expect(phases(group)).toEqual({ db: "ready", api: "ready" });
  });

  it("stops a program that is not ready in its time, and gives the reason", async () => {
    const host = fakeHost();
    host.polite = true;
    const group = superviseGroup(
      one({ name: "slow", program: "/bin/slow", ready: { probe: { kind: "tcp", port: 9000 }, interval: ms(100), timeout: ms(50), within: ms(300) }, restart: quick }),
      host.ports,
    );
    group.start();
    await host.settle();
    await step(host, 100);
    await step(host, 100);
    expect(host.signals).toEqual([]);
    await step(host, 100);
    expect(host.signals).toEqual([{ pid: 1000, signal: "SIGTERM", group: false }]);
    expect(group.states()[0]).toMatchObject({
      phase: "backoff",
      detail: "it was not ready in 300 ms (no TCP connection to 127.0.0.1:9000 in 50 ms), then it exited with the code 0",
    });
  });

  /** This function moves the clock in steps of 100 ms until the host has `count` signals, or 100 s go by. */
  const untilSignals = async (host: FakeHost, count: number): Promise<void> => {
    for (let steps = 0; steps < 1000 && host.signals.length < count; steps += 1) await step(host, 100);
  };
  const slowReady = { probe: { kind: "tcp", port: 9000 }, interval: ms(100), timeout: ms(50), within: ms(300) } as const;
  const missedIn = (window: number): string => `it was not ready in ${window} ms (no TCP connection to 127.0.0.1:9000 in 50 ms), then it exited with the code 0`;

  it("makes the ready window longer after each start that is not ready in it, to its cap, and a ready start sets it back", async () => {
    const host = fakeHost();
    host.polite = true;
    const group = superviseGroup(
      one({ name: "slow", program: "/bin/slow", ready: { ...slowReady, grow: { factor: 2, cap: ms(1000) } }, restart: quick }),
      host.ports,
    );
    group.start();
    await host.settle();
    const details: Array<string | null> = [];
    for (let stops = 1; stops <= 4; stops += 1) {
      await untilSignals(host, stops);
      details.push(group.states()[0]!.detail);
    }
    expect(details).toEqual([missedIn(300), missedIn(600), missedIn(1000), missedIn(1000)]);
    host.tcp.add("127.0.0.1:9000");
    for (let steps = 0; steps < 1000 && phases(group)["slow"] !== "ready"; steps += 1) await step(host, 100);
    expect(phases(group)).toEqual({ slow: "ready" });
    host.tcp.delete("127.0.0.1:9000");
    host.children.at(-1)?.exit(1);
    await host.settle();
    await untilSignals(host, 5);
    expect(group.states()[0]!.detail).toBe(missedIn(300));
  });

  it("keeps the ready window of each start without a growth", async () => {
    const host = fakeHost();
    host.polite = true;
    const group = superviseGroup(one({ name: "slow", program: "/bin/slow", ready: slowReady, restart: quick }), host.ports);
    group.start();
    await host.settle();
    await untilSignals(host, 1);
    expect(group.states()[0]!.detail).toBe(missedIn(300));
    await untilSignals(host, 2);
    expect(group.states()[0]!.detail).toBe(missedIn(300));
  });

  it("refuses a ready growth with a factor of 1 or less, or a cap that is not a time of `within` or more", () => {
    const of = 'the program "slow"';
    expect(groupProblems(one({ name: "slow", program: "/bin/slow", ready: { ...slowReady, grow: { factor: 1, cap: ms(200) } } }))).toEqual([
      `${of}: the factor of the ready growth is not a finite number above 1`,
      `${of}: the cap of the ready growth is shorter than the within of the probe`,
    ]);
    expect(groupProblems(one({ name: "slow", program: "/bin/slow", ready: { ...slowReady, grow: { factor: Number.NaN, cap: { value: 1, unit: "MB" } } } }))).toEqual([
      `${of}: the factor of the ready growth is not a finite number above 1`,
      `${of}: the cap of the ready growth is not a time above zero`,
    ]);
    expect(groupProblems(one({ name: "slow", program: "/bin/slow", ready: { ...slowReady, grow: { factor: 1.5, cap: ms(300) } } }))).toEqual([]);
  });

  const READY_FILE = "/state/slow.ready.json";
  const ADDRESS = "127.0.0.1:9000";
  const s = (value: number): Quantity => ({ value, unit: "s" });
  const timesOf = (host: FakeHost): Array<{ ms: number; missed?: true }> => (JSON.parse(host.text(READY_FILE) ?? "null") as { times: Array<{ ms: number; missed?: true }> }).times;
  const windowLines = (logger: ReturnType<typeof testLogger>): string[] => logger.messages("info").filter((message) => message.includes("ready window"));

  /**
   * This function runs one start on a slow host: the program is ready `need` ms after its spawn. It moves the clock until
   * the program is ready, and it gives the count of the stops before it.
   */
  const startReadyAfter = async (host: FakeHost, group: GroupSupervisor, need: number): Promise<number> => {
    const signals = host.signals.length;
    let count = host.children.length;
    let spawned = host.clock.now();
    for (let steps = 0; steps < 2000 && phases(group)["slow"] !== "ready"; steps += 1) {
      if (host.children.length !== count) {
        count = host.children.length;
        spawned = host.clock.now();
      }
      if (host.clock.now() - spawned >= need) host.tcp.add(ADDRESS);
      else host.tcp.delete(ADDRESS);
      await step(host, 250);
    }
    return host.signals.length - signals;
  };
  /** This function keeps the program ready past its resetAfter, then ends it, thus the next start comes after the first backoff. */
  const endReadyStart = async (host: FakeHost): Promise<void> => {
    await step(host, 6000);
    host.tcp.delete(ADDRESS);
    host.children.at(-1)?.exit(1);
    await host.settle();
  };

  it("measures the ready time of each start, thus starts of 24 to 50 s get ready with no restart loop, also under a new supervisor", async () => {
    const logger = testLogger();
    const host = fakeHost({ logger });
    host.polite = true;
    const spec = one({
      name: "slow",
      program: "/bin/slow",
      ready: { probe: { kind: "tcp", port: 9000 }, interval: ms(250), timeout: ms(50), within: s(30), measured: { after: 3, keep: 5, floor: s(10), cap: s(300) } },
      restart: quick,
    });
    const group = superviseGroup(spec, host.ports);
    group.start();
    await host.settle();
    const stops: number[] = [];
    for (const need of [24_000, 50_000, 31_000, 45_000, 28_000, 50_000, 40_000, 26_000]) {
      stops.push(await startReadyAfter(host, group, need));
      expect(phases(group)).toEqual({ slow: "ready" });
      await endReadyStart(host);
    }
    // the second start misses the first window, and the next window is two times longer: 50 s fits in it.
    // The third start misses the first window too, because 2 ready times are fewer than `after`. Then the window is measured.
    expect(stops).toEqual([0, 1, 1, 0, 0, 0, 0, 0]);
    expect(windowLines(logger)[0]).toBe("slow has a ready window of 30000 ms, from 0 ready times and 0 missed starts");
    const times = timesOf(host);
    expect(times).toHaveLength(5);
    expect(times.every((time) => time.missed === undefined)).toBe(true);
    await group.stop();

    // a new supervisor of the same state folder starts with the measured window
    logger.clear();
    const again = superviseGroup(spec, host.ports);
    again.start();
    await host.settle();
    expect(windowLines(logger)[0]).toMatch(/^slow has a ready window of \d+ ms, from 5 ready times and 0 missed starts$/);
    expect(await startReadyAfter(host, again, 50_000)).toBe(0);
    await again.stop();
  });

  it("makes the window two times longer after a missed start, to the cap, and a ready start gives the measured window", async () => {
    const host = fakeHost();
    host.polite = true;
    const measured = { after: 1, keep: 5, floor: ms(100), cap: ms(1000) };
    const ready = { ...slowReady, measured };
    const group = superviseGroup(one({ name: "slow", program: "/bin/slow", ready, restart: quick }), host.ports);
    group.start();
    await host.settle();
    const details: Array<string | null> = [];
    for (let stops = 1; stops <= 4; stops += 1) {
      await untilSignals(host, stops);
      details.push(group.states()[0]!.detail);
    }
    expect(details).toEqual([missedIn(300), missedIn(600), missedIn(1000), missedIn(1000)]);
    expect(timesOf(host).map((time) => [time.ms, time.missed])).toEqual([
      [300, true],
      [600, true],
      [1000, true],
      [1000, true],
    ]);
    // an app reads the same window from the file
    expect(nextReadyWindow(ready, host.text(READY_FILE))).toEqual({ ms: 1000, measured: 0, missed: 4, problem: null });
    // the next start is ready at its spawn: its time is 0 ms, thus the next window is the floor
    host.tcp.add(ADDRESS);
    for (let steps = 0; steps < 1000 && phases(group)["slow"] !== "ready"; steps += 1) await step(host, 100);
    expect(timesOf(host)).toEqual([{ at: expect.any(String) as string, ms: 0 }]);
    host.tcp.delete(ADDRESS);
    host.children.at(-1)?.exit(1);
    await host.settle();
    await untilSignals(host, 5);
    expect(group.states()[0]!.detail).toBe(missedIn(100));
  });

  it("uses no times from a bad file, with one warning, and continues when it cannot write the file", async () => {
    const logger = testLogger();
    const host = fakeHost({ logger, files: { [READY_FILE]: "{" } });
    host.polite = true;
    const measured = { after: 1, keep: 5, floor: ms(100), cap: ms(1000) };
    const group = superviseGroup(one({ name: "slow", program: "/bin/slow", ready: { ...slowReady, measured }, restart: quick }), host.ports);
    group.start();
    await host.settle();
    await untilSignals(host, 1);
    expect(group.states()[0]!.detail).toBe(missedIn(300));
    expect(logger.messages("warn").filter((message) => message.includes("ready times"))).toEqual(["the ready times of slow are not used: the file is not JSON"]);
    // the write replaces the bad file with a good file
    expect(timesOf(host)).toEqual([{ at: expect.any(String) as string, ms: 300, missed: true }]);

    host.failFiles = (operation, path) => path === READY_FILE && operation !== "read";
    host.tcp.add(ADDRESS);
    for (let steps = 0; steps < 1000 && phases(group)["slow"] !== "ready"; steps += 1) await step(host, 100);
    expect(phases(group)).toEqual({ slow: "ready" });
    expect(logger.messages("warn")).toContain("the ready time of slow was not written");
    expect(timesOf(host)).toHaveLength(1);
  });

  it("gives the window of the next start to an app, from the text of the file of the ready times", () => {
    const ready = { ...slowReady, measured: { after: 1, keep: 5, floor: ms(100), cap: ms(1000) } };
    expect(readyTimesPath("linux", "/state", "slow")).toBe(READY_FILE);
    expect(nextReadyWindow(slowReady, "{")).toEqual({ ms: 300, measured: 0, missed: 0, problem: null });
    expect(nextReadyWindow(ready, null)).toEqual({ ms: 300, measured: 0, missed: 0, problem: null });
    expect(nextReadyWindow(ready, "{")).toEqual({ ms: 300, measured: 0, missed: 0, problem: "the file is not JSON" });
  });

  it("names each bad value of a ready measure", () => {
    const of = 'the program "slow"';
    const bad = { after: 0.5, keep: 0, floor: { value: 1, unit: "MB" }, cap: ms(0) };
    expect(groupProblems(one({ name: "slow", program: "/bin/slow", ready: { ...slowReady, measured: bad } }))).toEqual([
      `${of}: the after of the ready measure is not a whole number of 1 or more`,
      `${of}: the keep of the ready measure is not a whole number of 1 or more`,
      `${of}: the floor of the ready measure is not a time above zero`,
      `${of}: the cap of the ready measure is not a time above zero`,
      `${of}: the cap of the ready measure is shorter than the within of the probe`,
    ]);
    const short = { after: 3, keep: 2, floor: ms(500), cap: ms(400) };
    expect(groupProblems(one({ name: "slow", program: "/bin/slow", ready: { ...slowReady, grow: { factor: 2, cap: ms(600) }, measured: short } }))).toEqual([
      `${of}: the ready spec has a growth and a measure, but it can have only one of them`,
      `${of}: the keep of the ready measure is less than its after`,
      `${of}: the cap of the ready measure is shorter than its floor`,
    ]);
    expect(groupProblems(one({ name: "slow", program: "/bin/slow", ready: { ...slowReady, measured: { after: 3, keep: 3, floor: ms(100), cap: ms(300) } } }))).toEqual([]);
  });

  it("does not start a program again without a restart, and frees its lock", async () => {
    const host = fakeHost();
    const group = superviseGroup(one({ name: "once", program: "/bin/once", restart: null }), host.ports);
    group.start();
    await host.settle();
    host.children[0]?.exit(0);
    await host.settle();
    await step(host, 60_000);
    expect(host.children).toHaveLength(1);
    expect(phases(group)).toEqual({ once: "exited" });
    expect(host.text("/state/once.lock")).toBeNull();
    expect(host.text("/state/once.json")).toBeNull();
  });

  it("counts a program that did not start as a stop, and starts it again", async () => {
    const host = fakeHost();
    host.failSpawn = () => true;
    const group = superviseGroup(one({ name: "gone", program: "/bin/gone", restart: quick }), host.ports);
    group.start();
    await host.settle();
    expect(group.states()[0]).toMatchObject({ phase: "backoff", detail: "/bin/gone did not start" });
    host.failSpawn = null;
    await step(host, 1000);
    expect(group.states()[0]).toMatchObject({ phase: "ready", pid: 1000 });
  });
});

describe("superviseGroup does not count a liveness failure in a full stall of the host", () => {
  const ALIVE = "http://127.0.0.1:8080/liveness";
  const MEMORY = "/proc/pressure/memory";
  const IO = "/proc/pressure/io";
  const psi = (full: number): string => `some avg10=0.00 avg60=0.00 avg300=0.00 total=${full}\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=${full}\n`;
  const stalled = (failures = 3): GroupSpec =>
    one({
      name: "api",
      program: "/bin/api",
      alive: { probe: { kind: "http", url: ALIVE }, interval: ms(1000), timeout: ms(100), failures, stall: { share: 0.5, most: 2 } },
      stop: { grace: ms(500) },
      restart: quick,
    });

  it("names each bad value of the stall excuse", () => {
    const program = stalled().programs[0]!;
    const spec = one({ ...program, alive: { ...program.alive!, stall: { share: 0, most: 0.5 } } });
    expect(groupProblems(spec)).toEqual([
      'the program "api": the share of the stall excuse is not a number above 0 and not above 1',
      'the program "api": the most of the stall excuse is not a whole number of 1 or more',
    ]);
  });

  it("excuses at most the count most of failures in a stall, then each failure counts", async () => {
    const host = fakeHost({ files: { [MEMORY]: psi(0), [IO]: psi(0) } });
    host.http.set(ALIVE, 200);
    const group = superviseGroup(stalled(), host.ports);
    group.start();
    await host.settle();
    expect(phases(group)).toEqual({ api: "ready" });
    host.http.delete(ALIVE);
    let total = 0;
    const stallStep = async (): Promise<void> => {
      total += 2_000_000;
      host.files.set(IO, psi(total));
      await step(host, 1000);
    };
    await stallStep();
    await stallStep();
    expect(group.states()[0]!.detail).toMatch(/^the liveness probe failed in a full stall of the host for 100% of its span, thus the failure does not count \(2 of 2 excused, /);
    await stallStep();
    await stallStep();
    expect(host.signals).toEqual([]);
    await stallStep();
    expect(host.signals).toEqual([{ pid: 1000, signal: "SIGTERM", group: false }]);
  });

  it("counts each failure when the host is not in a stall, and logs the measured share of each", async () => {
    const logger = testLogger();
    const host = fakeHost({ logger, files: { [MEMORY]: psi(0), [IO]: psi(0) } });
    host.http.set(ALIVE, 200);
    const group = superviseGroup(stalled(), host.ports);
    group.start();
    await host.settle();
    host.http.delete(ALIVE);
    await step(host, 1000);
    await step(host, 1000);
    expect(host.signals).toEqual([]);
    await step(host, 1000);
    expect(host.signals).toEqual([{ pid: 1000, signal: "SIGTERM", group: false }]);
    const failed = logger.entries.filter((entry) => entry.level === "warn" && entry.message.startsWith("api"));
    expect(failed.map((entry) => entry.fields["stalledShare"])).toEqual([0, 0, 0]);
  });

  it("counts each failure on a host with no pressure files", async () => {
    const host = fakeHost();
    host.http.set(ALIVE, 200);
    const group = superviseGroup(stalled(1), host.ports);
    group.start();
    await host.settle();
    host.http.delete(ALIVE);
    await step(host, 1000);
    expect(host.signals).toEqual([{ pid: 1000, signal: "SIGTERM", group: false }]);
  });

  it("sets the count of excused failures to 0 after a pass", async () => {
    const host = fakeHost({ files: { [MEMORY]: psi(0), [IO]: psi(0) } });
    host.http.set(ALIVE, 200);
    const group = superviseGroup(stalled(1), host.ports);
    group.start();
    await host.settle();
    let total = 0;
    for (let round = 0; round < 3; round += 1) {
      host.http.delete(ALIVE);
      for (let excuse = 0; excuse < 2; excuse += 1) {
        total += 2_000_000;
        host.files.set(MEMORY, psi(total));
        await step(host, 1000);
      }
      host.http.set(ALIVE, 200);
      await step(host, 1000);
      expect(group.states()[0]).toMatchObject({ phase: "ready", detail: null });
    }
    expect(host.signals).toEqual([]);
  });
});

describe("superviseGroup stops a ready program that does not pass its liveness probe", () => {
  const ALIVE = "http://127.0.0.1:8080/liveness";
  const watched = (): GroupSpec =>
    one({
      name: "api",
      program: "/bin/api",
      alive: { probe: { kind: "http", url: ALIVE }, interval: ms(1000), timeout: ms(100), failures: 3 },
      stop: { grace: ms(500) },
      restart: quick,
    });

  it("names each bad value of the liveness probe", () => {
    const spec = one({ name: "api", program: "/bin/api", alive: { probe: { kind: "tcp", port: 0 }, interval: ms(0), timeout: { value: 1, unit: "MB" }, failures: 1.5 } });
    expect(groupProblems(spec)).toEqual([
      'the program "api": the liveness probe: the port 0 is not a port from 1 to 65535',
      'the program "api": the interval of the liveness probe is not a time above zero',
      'the program "api": the timeout of the liveness probe is not a time above zero',
      'the program "api": the failures of the liveness probe is not a whole number of 1 or more',
    ]);
    expect(groupProblems(one({ ...watched().programs[0]!, alive: { probe: { kind: "http", url: ALIVE }, interval: ms(1), timeout: ms(1), failures: 0 } }))).toEqual([
      'the program "api": the failures of the liveness probe is not a whole number of 1 or more',
    ]);
  });

  it("counts the failures in sequence, and a pass sets the count to 0", async () => {
    const host = fakeHost();
    host.http.set(ALIVE, 200);
    const group = superviseGroup(watched(), host.ports);
    group.start();
    await host.settle();
    expect(phases(group)).toEqual({ api: "ready" });
    host.http.set(ALIVE, 500);
    await step(host, 1000);
    await step(host, 1000);
    expect(group.states()[0]).toMatchObject({ phase: "ready", detail: `the liveness probe failed 2 of 3 times in sequence (${ALIVE} gave 500, not 200)` });
    host.http.set(ALIVE, 200);
    await step(host, 1000);
    expect(group.states()[0]).toMatchObject({ phase: "ready", detail: null });
    host.http.set(ALIVE, 500);
    await step(host, 1000);
    await step(host, 1000);
    expect(host.signals).toEqual([]);
    expect(host.children).toHaveLength(1);
  });

  it("stops a hung program in stages after its failures, and starts it again after its backoff", async () => {
    const host = fakeHost();
    host.http.set(ALIVE, 200);
    const group = superviseGroup(watched(), host.ports);
    group.start();
    await host.settle();
    host.http.delete(ALIVE);
    await step(host, 1000);
    await step(host, 1000);
    expect(host.signals).toEqual([]);
    await step(host, 1000);
    // the hung program does not stop on SIGTERM, thus the process group stops after the grace
    expect(host.signals).toEqual([{ pid: 1000, signal: "SIGTERM", group: false }]);
    await step(host, 500);
    expect(host.signals).toEqual([
      { pid: 1000, signal: "SIGTERM", group: false },
      { pid: 1000, signal: "SIGKILL", group: true },
    ]);
    expect(group.states()[0]).toMatchObject({
      phase: "backoff",
      detail: `its liveness probe failed 3 times in sequence (${ALIVE} gave no answer in 100 ms), then it exited with the signal SIGKILL`,
    });
    host.http.set(ALIVE, 200);
    await step(host, 1000);
    expect(group.states()[0]).toMatchObject({ phase: "ready", pid: 1001, restarts: 1, detail: null });
    await step(host, 3000);
    expect(host.children).toHaveLength(2);
  });

  it("stops the probe with the group", async () => {
    const host = fakeHost();
    host.polite = true;
    host.http.set(ALIVE, 200);
    const group = superviseGroup(watched(), host.ports);
    group.start();
    await host.settle();
    await group.stop();
    host.http.delete(ALIVE);
    await step(host, 10_000);
    expect(phases(group)).toEqual({ api: "stopped" });
    expect(host.children).toHaveLength(1);
    expect(host.signals).toEqual([{ pid: 1000, signal: "SIGTERM", group: false }]);
  });
});

describe("superviseGroup keeps one instance of each program", () => {
  it("does not start a program whose lock a live process holds, and takes the lock after it stops", async () => {
    const host = fakeHost({ files: { "/state/worker.lock": lockText({ pid: 4242, startedAt: WALL - 5000 }) } });
    host.processes.set(4242, WALL - 5000);
    const group = superviseGroup(one({ name: "worker", program: "/bin/worker", restart: quick }), host.ports);
    group.start();
    await host.settle();
    expect(host.children).toHaveLength(0);
    expect(group.states()[0]).toMatchObject({ phase: "held", detail: "the process 4242 holds the lock /state/worker.lock" });
    host.processes.delete(4242);
    await step(host, 1000);
    expect(host.children).toHaveLength(1);
    expect(parseLockOwner(host.text("/state/worker.lock") ?? "")).toEqual({ pid: 100, startedAt: WALL, child: { pid: 1000, startedAt: WALL + 1000 } });
  });

  it("gives held to a second supervisor of the same group", async () => {
    const host = fakeHost();
    const spec: GroupSpec = { name: "demo", stateDir: "/state", programs: [{ name: "a", program: "/bin/a" }, { name: "b", program: "/bin/b" }] };
    superviseGroup(spec, host.ports).start();
    await host.settle();
    host.processes.set(200, WALL);
    const second: HostPorts = { ...host.ports, self: { pid: 200, startedAt: WALL } };
    const other = superviseGroup(spec, second);
    other.start();
    await host.settle();
    expect(phases(other)).toEqual({ a: "held", b: "held" });
    expect(host.children).toHaveLength(2);
  });
});

describe("the stop of a group: the staged stop, then the tree stop by the process ID", () => {
  it("sends SIGTERM on Linux, and stops the process group with SIGKILL after the grace", async () => {
    const host = fakeHost();
    const group = superviseGroup(one({ name: "worker", program: "/bin/worker", stop: { grace: { value: 2, unit: "s" } } }), host.ports);
    group.start();
    await host.settle();
    const stopping = group.stop();
    await host.settle();
    expect(host.signals).toEqual([{ pid: 1000, signal: "SIGTERM", group: false }]);
    await step(host, 1999);
    expect(host.children[0]?.ended).toBe(false);
    await step(host, 1);
    await stopping;
    expect(host.signals).toEqual([
      { pid: 1000, signal: "SIGTERM", group: false },
      { pid: 1000, signal: "SIGKILL", group: true },
    ]);
    expect(host.children[0]?.ended).toBe(true);
    expect(phases(group)).toEqual({ worker: "stopped" });
  });

  it("sends SIGINT when the spec asks for it", async () => {
    const host = fakeHost();
    host.polite = true;
    const group = superviseGroup(one({ name: "worker", program: "/bin/worker", stop: { grace: ms(500), signal: "SIGINT" } }), host.ports);
    group.start();
    await host.settle();
    await group.stop();
    expect(host.signals).toEqual([{ pid: 1000, signal: "SIGINT", group: false }]);
  });

  it("sends the IPC message to a child with a channel, and no signal", async () => {
    const host = fakeHost();
    host.polite = true;
    const group = superviseGroup(
      { name: "demo", stateDir: "/state", programs: [{ name: "a", program: "/bin/node", ipc: true }, { name: "b", program: "/bin/node", ipc: true, stop: { grace: ms(500), message: { type: "stop" } } }] },
      host.ports,
    );
    group.start();
    await host.settle();
    await group.stop();
    expect(host.children.map((child) => child.sent)).toEqual([["shutdown"], [{ type: "stop" }]]);
    expect(host.signals).toEqual([]);
  });

  it("asks taskkill without /F on Windows, and stops the tree with /F when that fails", async () => {
    const host = fakeHost({ platform: "win32" });
    const group = superviseGroup(one({ name: "worker", program: "Z:\\bin\\worker.exe" }, "Z:\\state"), host.ports);
    group.start();
    await host.settle();
    expect(host.text("Z:\\state\\worker.lock")).not.toBeNull();
    await group.stop();
    expect(calls(host)).toEqual(["taskkill /T /PID 1000", "taskkill /T /F /PID 1000"]);
    expect(host.text("Z:\\state\\worker.lock")).toBeNull();
    expect(host.text("Z:\\state\\worker.json")).toBeNull();
  });

  it("waits for the end after a taskkill that went, and never names a program or an image", async () => {
    const host = fakeHost({ platform: "win32" });
    host.polite = true;
    const group = superviseGroup(one({ name: "worker", program: "Z:\\bin\\worker.exe" }, "Z:\\state"), host.ports);
    group.start();
    await host.settle();
    await group.stop();
    expect(calls(host)).toEqual(["taskkill /T /PID 1000"]);
    for (const command of host.commands) {
      expect(command.args).toContain("/PID");
      expect(command.args).not.toContain("/IM");
    }
  });
});
