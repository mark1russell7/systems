import { describe, expect, it } from "vitest";
import type { FakeHostOptions } from "./fakes.ts";
import { fakeHost } from "./fakes.ts";
import { installService, servicePaths, serviceStatus, startService, stopService, uninstallService } from "./install.ts";
import type { ServiceSpec } from "./render.ts";

const WALL = 1_000_000_000_000;

const winSpec: ServiceSpec = {
  name: "demo-host",
  description: "Demo host",
  program: "Z:\\Node Runtime\\node.exe",
  args: ["Z:\\demo dir\\group.js"],
  start: "logon",
  restart: { after: { value: 1, unit: "min" } },
  stateDir: "Z:\\state dir",
};
const linuxSpec: ServiceSpec = { ...winSpec, program: "/usr/bin/node", args: ["/srv/demo/group.js"], stateDir: "/home/test/.demo" };
const dailySpec: ServiceSpec = { ...linuxSpec, name: "demo-job", start: { daily: "06:30" }, restart: null };

const windows = (options: FakeHostOptions = {}) => fakeHost({ platform: "win32", env: { SystemRoot: "Z:\\Windows" }, user: "HOST\\test", homeDir: "Z:\\home", ...options });
const calls = (host: { commands: ReadonlyArray<{ file: string; args: readonly string[] }> }): string[] =>
  host.commands.map((command) => [command.file, ...command.args].join(" "));
const TASK_FILE = "Z:\\state dir\\demo-host.task.xml";

describe("installService on Windows", () => {
  it("writes the task file in UTF-16, creates the task and runs it", async () => {
    const host = windows();
    const outcome = await installService(winSpec, host.ports);
    expect(outcome.kind).toBe("done");
    expect(outcome.kind === "done" && outcome.files).toEqual([TASK_FILE]);
    expect(calls(host)).toEqual([`schtasks /Create /TN demo-host /XML ${TASK_FILE} /F`, "schtasks /Run /TN demo-host"]);
    const bytes = host.files.get(TASK_FILE);
    if (!(bytes instanceof Uint8Array)) throw new Error("the task file is not bytes");
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    const xml = new TextDecoder("utf-16le").decode(bytes.slice(2));
    expect(xml).toContain("<Command>Z:\\Windows\\System32\\conhost.exe</Command>");
    expect(xml).toContain("<UserId>HOST\\test</UserId>");
    expect(xml).toContain("<Interval>PT1M</Interval>");
  });

  it("does not run the task without start, and gives failed with the output of schtasks", async () => {
    const quiet = windows();
    expect((await installService(winSpec, quiet.ports, { start: false })).kind).toBe("done");
    expect(calls(quiet)).toEqual([`schtasks /Create /TN demo-host /XML ${TASK_FILE} /F`]);
    const denied = windows({ answer: (command) => (command.args[0] === "/Create" ? { code: 1, out: "ERROR: Access is denied.\r\n" } : undefined) });
    const outcome = await installService(winSpec, denied.ports);
    expect(outcome).toEqual({
      kind: "failed",
      commands: [{ file: "schtasks", args: ["/Create", "/TN", "demo-host", "/XML", TASK_FILE, "/F"], code: 1, out: "ERROR: Access is denied." }],
      problem: `schtasks /Create /TN demo-host /XML ${TASK_FILE} /F gave the code 1: ERROR: Access is denied.`,
    });
  });

  it("refuses a spec with problems and an unknown platform, and does nothing", async () => {
    const host = windows();
    expect(await installService({ ...winSpec, name: "bad name" }, host.ports)).toEqual({
      kind: "refused",
      problems: ['the name "bad name" is not letters, digits, ".", "_" and "-"'],
    });
    const mac = fakeHost({ platform: "darwin" });
    expect(await installService(linuxSpec, mac.ports)).toEqual({ kind: "unsupported", platform: "darwin" });
    expect(host.commands).toEqual([]);
    expect(mac.commands).toEqual([]);
    expect(host.files.size + mac.files.size).toBe(0);
  });

  it("gives failed and not a throw when the file system fails", async () => {
    const host = windows();
    host.failFiles = () => true;
    expect(await installService(winSpec, host.ports)).toEqual({ kind: "failed", commands: [], problem: `the file system failed: the fake write of ${TASK_FILE} failed` });
  });
});

describe("the other operations on Windows", () => {
  const live = (host: ReturnType<typeof windows>): void => {
    host.processes.set(4242, WALL - 60_000);
    host.files.set("Z:\\state dir\\demo.json", JSON.stringify({ pid: 4242, startedAt: new Date(WALL - 60_000).toISOString() }));
  };

  it("uninstall ends and deletes the task, removes its file and stops the tree of the instance", async () => {
    const host = windows();
    await installService(winSpec, host.ports);
    live(host);
    host.commands.length = 0;
    const outcome = await uninstallService(winSpec, host.ports, { discovery: "Z:\\state dir\\demo.json" });
    expect(outcome.kind).toBe("done");
    expect(calls(host)).toEqual(["schtasks /End /TN demo-host", "schtasks /Delete /TN demo-host /F", "taskkill /T /F /PID 4242"]);
    expect(host.files.has(TASK_FILE)).toBe(false);
    expect(host.processes.has(4242)).toBe(false);
  });

  it("stop disables the task first, thus its time trigger does not start it again", async () => {
    const host = windows();
    live(host);
    expect((await stopService(winSpec, host.ports, { discovery: "Z:\\state dir\\demo.json" })).kind).toBe("done");
    expect(calls(host)).toEqual(["schtasks /Change /TN demo-host /DISABLE", "schtasks /End /TN demo-host", "taskkill /T /F /PID 4242"]);
  });

  it("start enables the task and runs it", async () => {
    const host = windows();
    expect((await startService(winSpec, host.ports)).kind).toBe("done");
    expect(calls(host)).toEqual(["schtasks /Change /TN demo-host /ENABLE", "schtasks /Run /TN demo-host"]);
  });

  it("status reads the Status line of schtasks, and the discovery file without a throw", async () => {
    const host = windows({
      answer: (command) =>
        command.args[0] === "/Query" ? { code: 0, out: "\r\nFolder: \\\r\nTaskName:      \\demo-host\r\nStatus:        Running\r\nLogon Mode: Interactive only\r\n" } : undefined,
    });
    host.files.set("Z:\\state dir\\demo.json", "{");
    const status = await serviceStatus(winSpec, host.ports, { discovery: "Z:\\state dir\\demo.json" });
    expect(status.installed).toBe(true);
    expect(status.state).toBe("Running");
    expect(status.instance?.kind).toBe("malformed");
    expect(calls(host)).toEqual(["schtasks /Query /TN demo-host /V /FO LIST"]);
    const missing = windows({ answer: () => ({ code: 1, out: "ERROR: The system cannot find the file specified." }) });
    expect(await serviceStatus(winSpec, missing.ports)).toEqual({
      installed: false,
      state: "unknown",
      instance: null,
      commands: [{ file: "schtasks", args: ["/Query", "/TN", "demo-host", "/V", "/FO", "LIST"], code: 1, out: "ERROR: The system cannot find the file specified." }],
    });
  });
});

describe("the operations on Linux", () => {
  it("install writes the user unit and enables it with --now", async () => {
    const host = fakeHost();
    const outcome = await installService(linuxSpec, host.ports);
    expect(outcome.kind === "done" && outcome.files).toEqual(["/home/test/.config/systemd/user/demo-host.service"]);
    expect(calls(host)).toEqual(["systemctl --user daemon-reload", "systemctl --user enable --now demo-host.service"]);
    expect(host.text("/home/test/.config/systemd/user/demo-host.service")).toContain("ExecStart=/usr/bin/node /srv/demo/group.js\n");
  });

  it("puts the units in XDG_CONFIG_HOME, and enables the timer of a daily job", async () => {
    const host = fakeHost({ env: { XDG_CONFIG_HOME: "/xdg" } });
    expect(servicePaths(dailySpec, host.ports)).toEqual({ unit: "/xdg/systemd/user/demo-job.service", timer: "/xdg/systemd/user/demo-job.timer" });
    await installService(dailySpec, host.ports, { start: false });
    expect(calls(host)).toEqual(["systemctl --user daemon-reload", "systemctl --user enable demo-job.timer"]);
    expect(host.text("/xdg/systemd/user/demo-job.timer")).toContain("OnCalendar=*-*-* 06:30:00\n");
  });

  it("uninstall disables and stops the unit, removes its files and reloads", async () => {
    const host = fakeHost();
    await installService(dailySpec, host.ports);
    host.commands.length = 0;
    expect((await uninstallService(dailySpec, host.ports)).kind).toBe("done");
    expect(calls(host)).toEqual(["systemctl --user disable --now demo-job.timer", "systemctl --user stop demo-job.service", "systemctl --user daemon-reload"]);
    expect(host.files.size).toBe(0);
  });

  it("start and stop use systemctl, and stop sends SIGTERM through it", async () => {
    const host = fakeHost();
    await startService(linuxSpec, host.ports);
    await stopService(linuxSpec, host.ports);
    expect(calls(host)).toEqual(["systemctl --user start demo-host.service", "systemctl --user stop demo-host.service"]);
  });

  it("status tells the unit file and the state of is-active", async () => {
    const host = fakeHost({ answer: (command) => (command.args[1] === "is-active" ? { code: 3, out: "inactive\n" } : undefined) });
    expect(await serviceStatus(linuxSpec, host.ports)).toEqual({
      installed: false,
      state: "inactive",
      instance: null,
      commands: [{ file: "systemctl", args: ["--user", "is-active", "demo-host.service"], code: 3, out: "inactive" }],
    });
    await installService(linuxSpec, host.ports);
    expect((await serviceStatus(linuxSpec, host.ports)).installed).toBe(true);
  });
});
