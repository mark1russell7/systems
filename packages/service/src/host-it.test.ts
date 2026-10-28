import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo, Server } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChildHandle, HostPorts, ServiceSpec } from "./host.ts";
import {
  acquireInstanceLock,
  installService,
  inspectInstanceLock,
  nodeHostPorts,
  readDiscovery,
  sameProcess,
  servicePaths,
  serviceStatus,
  stopTree,
  superviseGroup,
  uninstallService,
  writeDiscovery,
} from "./host.ts";
import type { LogEntry } from "./logger.ts";

/**
 * SYS-47: the host entry on the real ports of Node (`nodeHostPorts`), opt-in with HOST_IT=1.
 * Each unit test of the host entry uses the fake host, thus only this file uses the real ports.
 * These tests start real processes and install a real task or unit, thus only CI starts them
 * (.github/workflows/process.yml), on Linux and on Windows. Each path is in a temporary folder.
 */

const RUN = process.env["HOST_IT"] === "1";
const WINDOWS = process.platform === "win32";
const LINUX = process.platform === "linux";
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => join(here, "..", "test", "host", name);
const SLEEP = fixture("sleep.mjs");
const TREE = fixture("tree.mjs");
const INSTANCE = fixture("instance.mjs");
const SERVE = fixture("serve.mjs");
const CLIENT = fixture("client.mjs");

const ports: HostPorts = nodeHostPorts();
let dir = "";
/** These are the process IDs that this file started. The cleanup stops only them. */
const mine = new Set<number>();
const others: ChildProcess[] = [];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** This function waits until the check is true, or throws after `within` milliseconds. */
const waitFor = async (
  check: () => boolean | Promise<boolean>,
  what: string | (() => string | Promise<string>),
  within = 30_000,
): Promise<void> => {
  const end = Date.now() + within;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error(`${typeof what === "string" ? what : await what()} did not occur in ${within} ms`);
    await sleep(100);
  }
};

const hostEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return env;
};

interface Watch {
  readonly lines: string[];
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  until(pattern: string | RegExp): Promise<string>;
}

/** This function keeps each line of the stdout of a child of the process port. */
const watch = (child: ChildHandle): Watch => {
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let rest = "";
  child.onOutput((stream, chunk) => {
    if (stream !== "stdout") return;
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    const parts = (rest + text).split(/\r?\n/);
    rest = parts.pop() ?? "";
    lines.push(...parts.filter((part) => part.length > 0));
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.onExit((code, signal) => resolve({ code, signal })));
  const until = async (pattern: string | RegExp): Promise<string> => {
    const match = (line: string): boolean => (typeof pattern === "string" ? line === pattern : pattern.test(line));
    await waitFor(() => lines.some(match), () => `the line ${String(pattern)} (the lines: ${JSON.stringify(lines)})`);
    return lines.find(match)!;
  };
  return { lines, exited, until };
};

/** This function starts a Node script through the process port of Node. */
const start = (script: string, ...args: string[]): { readonly child: ChildHandle; readonly run: Watch } => {
  const child = ports.processes.spawn({ program: process.execPath, args: [script, ...args], env: hostEnv(), ipc: false });
  const pid = child.pid;
  if (pid !== null) {
    mine.add(pid);
    // an ID that ended can go to a different process, thus the cleanup forgets it
    child.onExit(() => mine.delete(pid));
  }
  return { child, run: watch(child) };
};

/** This function starts a sleeper with `child_process` and not with the port: a process that a stop must not touch. */
const other = (): ChildProcess => {
  const child = spawn(process.execPath, [SLEEP], { stdio: "ignore" });
  others.push(child);
  return child;
};

/** This function gives a port that no server listens on. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

describe.skipIf(!RUN)("the host entry on the real ports of Node (SYS-47)", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "host-it-"));
  });

  afterEach(async () => {
    for (const pid of [...mine]) await stopTree(pid, ports);
    mine.clear();
    for (const child of others.splice(0))
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) await stopTree(child.pid, ports);
  });

  afterAll(async () => {
    if (dir !== "") await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  describe("the process port", () => {
    it("starts a child, tells that it is alive, gives its start time and sends it a signal", async () => {
      const before = Date.now();
      const { child, run } = start(SLEEP);
      await run.until("ready");
      const pid = child.pid!;
      expect(pid).toBeGreaterThan(0);
      expect(ports.processes.alive(pid)).toBe(true);
      const started = await ports.processes.startOf(pid);
      expect(started).not.toBeNull();
      // a start time of Linux comes from the boot time in whole seconds, thus the band is wide
      expect(started!).toBeGreaterThan(before - 60_000);
      expect(started!).toBeLessThanOrEqual(Date.now() + 1000);
      // the start time tells a new process with an old ID from the process of a record
      expect(await sameProcess({ pid, startedAt: Date.now() }, ports)).toBe(true);
      expect(await sameProcess({ pid, startedAt: before - 3_600_000 }, ports)).toBe(false);

      // Windows has no process groups, and on Linux the tree stop uses the group of the child
      if (!LINUX) expect(ports.processes.signalGroup(pid, "SIGTERM")).toBe(false);
      expect(ports.processes.signal(pid, "SIGTERM")).toBe(true);
      const end = await run.exited;
      if (LINUX) expect(end).toEqual({ code: null, signal: "SIGTERM" });
      await waitFor(() => !ports.processes.alive(pid), `the end of the process ${pid}`);
      expect(ports.processes.signal(pid, "SIGTERM")).toBe(false);
      expect(await ports.processes.startOf(pid)).toBeNull();
    }, 60_000);

    it("gives no process ID and an exit for a program that does not exist", async () => {
      const child = ports.processes.spawn({ program: join(dir, "no-such-program"), args: [], env: hostEnv(), ipc: false });
      expect(child.pid).toBeNull();
      expect(await watch(child).exited).toEqual({ code: null, signal: null });
    }, 30_000);

    it("stops a process tree by its ID: the child and the grandchild end, and a different process stays", async () => {
      const outside = other();
      const { child, run } = start(TREE);
      const line = await run.until(/^grandchild \d+$/);
      const grandchild = Number(line.split(" ")[1]);
      const pid = child.pid!;
      expect(ports.processes.alive(pid)).toBe(true);
      expect(ports.processes.alive(grandchild)).toBe(true);
      await waitFor(() => outside.pid !== undefined && ports.processes.alive(outside.pid), "the start of the outside process");

      expect(await stopTree(pid, ports)).toEqual({ kind: "stopped" });
      await run.exited;
      await waitFor(() => !ports.processes.alive(pid), `the end of the child ${pid}`);
      await waitFor(() => !ports.processes.alive(grandchild), `the end of the grandchild ${grandchild}`);
      expect(ports.processes.alive(outside.pid!)).toBe(true);
      expect(await stopTree(pid, ports)).toEqual({ kind: "absent" });
      expect((await stopTree(process.pid, ports)).kind).toBe("failed");
      expect(ports.processes.alive(process.pid)).toBe(true);
    }, 60_000);
  });

  describe("the command port", () => {
    it("gives the code 0 and the output, the exit code, 127 for a missing program and 124 at the timeout", async () => {
      const node = process.execPath;
      expect(await ports.commands.run(node, ["-e", "process.stdout.write('out'); process.stderr.write('err')"])).toEqual({ code: 0, out: "outerr" });
      expect((await ports.commands.run(node, ["-e", "process.exit(3)"])).code).toBe(3);
      expect((await ports.commands.run(WINDOWS ? "whoami" : "true", [])).code).toBe(0);
      const cwd = await ports.commands.run(node, ["-e", "process.stdout.write(process.cwd())"], { cwd: dir });
      expect(realpathSync.native(cwd.out)).toBe(realpathSync.native(dir));
      expect((await ports.commands.run("host-it-no-such-program", [])).code).toBe(127);
      const began = Date.now();
      expect((await ports.commands.run(node, ["-e", "setTimeout(() => {}, 60000)"], { timeout: 1000 })).code).toBe(124);
      expect(Date.now() - began).toBeLessThan(30_000);
    }, 60_000);
  });

  describe("the net port", () => {
    it("gives the status of a local server, null at a closed port and at a timeout, and tells an open and a closed port", async () => {
      const server = createHttpServer((request, response) => {
        if (request.url === "/missing") response.writeHead(404).end();
        else if (request.url === "/moved") response.writeHead(302, { location: "/" }).end();
        else response.writeHead(204).end();
      });
      const silent = createHttpServer(() => {});
      const port = await listen(server);
      const silentPort = await listen(silent);
      const closed = await freePort();
      try {
        expect(await ports.net.httpStatus(`http://127.0.0.1:${port}/`, 5000)).toBe(204);
        expect(await ports.net.httpStatus(`http://127.0.0.1:${port}/missing`, 5000)).toBe(404);
        expect(await ports.net.httpStatus(`http://127.0.0.1:${port}/moved`, 5000)).toBe(302);
        expect(await ports.net.httpStatus(`http://127.0.0.1:${closed}/`, 5000)).toBeNull();
        const began = Date.now();
        expect(await ports.net.httpStatus(`http://127.0.0.1:${silentPort}/`, 1000)).toBeNull();
        expect(Date.now() - began).toBeLessThan(15_000);
        expect(await ports.net.tcpConnect("127.0.0.1", port, 5000)).toBe(true);
        expect(await ports.net.tcpConnect("127.0.0.1", closed, 5000)).toBe(false);
      } finally {
        server.closeAllConnections();
        silent.closeAllConnections();
        await Promise.all([close(server), close(silent)]);
      }
    }, 60_000);
  });

  describe("the instance lock and the discovery file", () => {
    it("gives held to a second take in one process", async () => {
      const path = join(dir, "self.lock");
      const first = await acquireInstanceLock(path, ports);
      expect(first.kind).toBe("acquired");
      if (first.kind !== "acquired") return;
      expect(first.recovered).toBeNull();
      const second = await acquireInstanceLock(path, ports);
      expect(second.kind).toBe("held");
      if (second.kind === "held") expect(second.owner.pid).toBe(process.pid);
      await first.lock.release();
      expect(existsSync(path)).toBe(false);
    }, 30_000);

    it("gives held for the lock of a live child, and a new take recovers the lock after its end", async () => {
      const path = join(dir, "child.lock");
      const { child, run } = start(INSTANCE, "lock", path);
      await run.until("acquired");
      const pid = child.pid!;
      const held = await acquireInstanceLock(path, ports);
      expect(held.kind).toBe("held");
      if (held.kind === "held") expect(held.owner.pid).toBe(pid);
      expect((await inspectInstanceLock(path, ports)).kind).toBe("held");

      expect(await stopTree(pid, ports)).toEqual({ kind: "stopped" });
      await run.exited;
      await waitFor(() => !ports.processes.alive(pid), `the end of the child ${pid}`);
      expect((await inspectInstanceLock(path, ports)).kind).toBe("stale");
      const next = await acquireInstanceLock(path, ports);
      expect(next.kind).toBe("acquired");
      if (next.kind !== "acquired") return;
      expect(next.recovered).toBe(`the owner process ${pid} stopped`);
      await next.lock.release();
      expect(existsSync(path)).toBe(false);
    }, 60_000);

    it("reads running for the discovery file of a live child, and stale after its end", async () => {
      const path = join(dir, "child.json");
      const { child, run } = start(INSTANCE, "discovery", path);
      await run.until("written");
      const pid = child.pid!;
      const found = await readDiscovery(path, ports);
      expect(found.kind, JSON.stringify(found)).toBe("running");
      if (found.kind === "running") expect(found.record).toMatchObject({ pid, port: 4321, url: "http://127.0.0.1:4321/" });

      expect(await stopTree(pid, ports)).toEqual({ kind: "stopped" });
      await run.exited;
      await waitFor(() => !ports.processes.alive(pid), `the end of the child ${pid}`);
      const after = await readDiscovery(path, ports, { clean: true });
      expect(after.kind).toBe("stale");
      if (after.kind === "stale") expect(after.why).toBe(`the process ${pid} stopped`);
      expect(existsSync(path)).toBe(false);
    }, 60_000);

    it("reads stale for a record whose live process started after the record", async () => {
      const outside = other();
      await waitFor(() => outside.pid !== undefined && ports.processes.alive(outside.pid), "the start of the outside process");
      const path = join(dir, "old.json");
      await writeDiscovery(path, { pid: outside.pid!, startedAt: "2000-01-01T00:00:00.000Z", port: null, url: null }, ports);
      const found = await readDiscovery(path, ports);
      expect(found.kind).toBe("stale");
      if (found.kind === "stale") expect(found.why).toContain("different process");
    }, 30_000);
  });

  describe("the group supervisor", () => {
    it("starts b after a is ready, starts a again after a crash, keeps the logs and stops each process in stages", async () => {
      const stateDir = join(dir, "group");
      const port = await freePort();
      const url = `http://127.0.0.1:${port}/`;
      const entries: LogEntry[] = [];
      const host = nodeHostPorts({ logger: { log: (level, message, fields) => void entries.push({ level, message, fields }) } });
      const envFile = join(dir, "b.env");
      await writeFile(envFile, "GREETING=hello\n");
      const restart = { backoff: { base: 300, factor: 2, cap: 3000 }, resetAfter: { value: 60, unit: "s" } };
      const stop = { grace: { value: 5, unit: "s" } };
      const group = superviseGroup(
        {
          name: "host-it",
          stateDir,
          programs: [
            {
              name: "a",
              program: process.execPath,
              args: [SERVE],
              env: { PORT: String(port) },
              ready: { probe: { kind: "http", url }, interval: { value: 200, unit: "ms" }, timeout: { value: 2, unit: "s" }, within: { value: 30, unit: "s" } },
              restart,
              stop,
              listen: { port, url },
            },
            { name: "b", program: process.execPath, args: [CLIENT], env: { A_URL: url }, envFile, after: ["a"], ipc: true, restart, stop },
          ],
        },
        host,
      );
      const state = (name: string) => group.states().find((each) => each.name === name)!;
      const messages = (): string[] => entries.map((entry) => entry.message);
      try {
        group.start();
        await waitFor(() => state("a").phase === "ready" && state("b").phase === "ready", () => `a and b ready (${JSON.stringify(group.states())})`, 60_000);
        const firstA = state("a").pid!;
        const firstB = state("b").pid!;
        // the probe of a failed first, because a listens after approximately 1 s
        const readyAt = messages().indexOf("a is ready");
        expect(readyAt).toBeGreaterThanOrEqual(0);
        expect(messages().indexOf("b started")).toBeGreaterThan(readyAt);
        const found = await readDiscovery(join(stateDir, "a.json"), host);
        expect(found.kind, JSON.stringify(found)).toBe("running");
        if (found.kind === "running") expect(found.record).toMatchObject({ pid: firstA, port, url });
        expect((await inspectInstanceLock(join(stateDir, "a.lock"), host)).kind).toBe("held");

        expect(host.processes.signal(firstA, "SIGKILL")).toBe(true);
        await waitFor(
          () => state("a").phase === "ready" && state("a").restarts >= 1 && state("a").pid !== firstA,
          () => `the start of a again (${JSON.stringify(group.states())})`,
          60_000,
        );
        const secondA = state("a").pid!;
        expect(messages().some((message) => message.startsWith("a starts again in "))).toBe(true);
        expect(state("b").pid).toBe(firstB);

        await group.stop();
        expect(group.states().map((each) => each.phase)).toEqual(["stopped", "stopped"]);
        expect(messages()).toContain("b stops through the IPC message");
        if (LINUX) expect(messages()).toContain("a stops through SIGTERM");
        for (const pid of [firstA, secondA, firstB]) await waitFor(() => !host.processes.alive(pid), `the end of the process ${pid}`);
        for (const file of ["a.lock", "b.lock", "a.json", "b.json"]) expect(existsSync(join(stateDir, file)), file).toBe(false);

        const aLog = await readFile(join(stateDir, "logs", "a.log"), "utf8");
        expect(aLog).toContain(`a start ${firstA}`);
        expect(aLog).toContain(`a note ${firstA}`);
        expect(aLog).toContain(`a start ${secondA}`);
        if (LINUX) expect(aLog).toContain("a sigterm");
        const bLog = await readFile(join(stateDir, "logs", "b.log"), "utf8");
        expect(bLog).toContain(`b start ${firstB} a=200 greeting=hello`);
        expect(bLog).toContain("b shutdown");
      } finally {
        await group.stop();
      }
    }, 180_000);
  });

  describe("the install of a user service", () => {
    const specOf = (name: string, discovery: string): ServiceSpec => ({
      name,
      description: "A test service of the host entry",
      program: process.execPath,
      args: [INSTANCE, "discovery", discovery],
      start: "logon",
      restart: null,
      stateDir: join(dir, "service"),
    });

    /** This function installs a service, checks its status and its instance, and removes it. */
    const roundTrip = async (spec: ServiceSpec, discovery: string, skip: (why: string) => void): Promise<void> => {
      let installed = false;
      try {
        const outcome = await installService(spec, ports);
        if (outcome.kind === "failed" && /access is denied|permission denied|not permitted/i.test(outcome.problem)) {
          const why = `the runner refused the install: ${outcome.problem}`;
          console.warn(`SYS-47 skip: ${why}`);
          skip(why);
          return;
        }
        expect(outcome.kind, JSON.stringify(outcome)).toBe("done");
        installed = true;
        const status = await serviceStatus(spec, ports, { discovery });
        expect(status.installed, JSON.stringify(status)).toBe(true);
        await waitFor(
          async () => (await readDiscovery(discovery, ports)).kind === "running",
          async () => `the start of the service instance (${JSON.stringify(await serviceStatus(spec, ports))})`,
          60_000,
        );
        const running = await serviceStatus(spec, ports, { discovery });
        expect(running.installed).toBe(true);
        expect(running.state, JSON.stringify(running)).toBe(WINDOWS ? "Running" : "active");
        expect(running.instance?.kind).toBe("running");
        const pid = running.instance?.kind === "running" ? running.instance.record.pid : 0;

        const removed = await uninstallService(spec, ports, { discovery });
        expect(removed.kind, JSON.stringify(removed)).toBe("done");
        installed = false;
        await waitFor(() => !ports.processes.alive(pid), `the end of the service instance ${pid}`);
        const after = await serviceStatus(spec, ports);
        expect(after.installed, JSON.stringify(after)).toBe(false);
        expect(existsSync(servicePaths(spec, ports).unit)).toBe(false);
      } finally {
        if (installed) await uninstallService(spec, ports, { discovery });
      }
    };

    it.skipIf(!LINUX)("installs a systemd user unit, gives its status and removes it", async (context) => {
      const bus = await ports.commands.run("systemctl", ["--user", "show-environment"], { timeout: 15_000 });
      if (bus.code !== 0) {
        const why = `systemctl --user does not work on this runner (code ${bus.code}): ${bus.out.trim()}`;
        console.warn(`SYS-47 skip: ${why}`);
        context.skip(why);
        return;
      }
      const name = `host-it-${process.pid}-${Date.now()}`;
      const discovery = join(dir, `${name}.json`);
      await roundTrip(specOf(name, discovery), discovery, (why) => context.skip(why));
    }, 180_000);

    it.skipIf(!WINDOWS)("installs a Windows task, gives its status and removes it", async (context) => {
      const name = `host-it-${process.pid}-${Date.now()}`;
      const discovery = join(dir, `${name}.json`);
      await roundTrip(specOf(name, discovery), discovery, (why) => context.skip(why));
    }, 180_000);
  });
});
