import type { Quantity } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { testLogger } from "../testing.ts";
import type { FakeHost } from "./fakes.ts";
import { fakeHost } from "./fakes.ts";
import type { GroupSpec, GroupSupervisor, ProgramRestart, ProgramSpec } from "./group.ts";
import { groupProblems, startOrder, superviseGroup } from "./group.ts";
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
