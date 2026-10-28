import { describe, expect, it } from "vitest";
import { parseEnvFile } from "./env.ts";
import { fakeHost } from "./fakes.ts";
import { rotatingLog } from "./logs.ts";
import { joinPath } from "./ports.ts";
import { probeOnce, probeProblems } from "./probes.ts";
import { sameProcess, stopTree } from "./processes.ts";

const WALL = 1_000_000_000_000;

describe("joinPath", () => {
  it("joins with the separator of the platform, and trims the separators between parts", () => {
    expect(joinPath("win32", "Z:\\state dir\\", "logs", "a.log")).toBe("Z:\\state dir\\logs\\a.log");
    expect(joinPath("linux", "/state/", "/logs/", "a.log")).toBe("/state/logs/a.log");
    expect(joinPath("linux", "/", "a")).toBe("/a");
  });
});

describe("sameProcess", () => {
  it("compares the host process by its start time, and another process by the system", async () => {
    const host = fakeHost();
    expect(await sameProcess({ pid: 100, startedAt: WALL + 500 }, host.ports)).toBe(true);
    expect(await sameProcess({ pid: 100, startedAt: WALL + 5000 }, host.ports)).toBe(false);
    expect(await sameProcess({ pid: 0, startedAt: WALL }, host.ports)).toBe(false);
    expect(await sameProcess({ pid: 555, startedAt: WALL }, host.ports)).toBe(false);
    host.processes.set(555, WALL - 100);
    expect(await sameProcess({ pid: 555, startedAt: WALL }, host.ports)).toBe(true);
    host.processes.set(555, WALL + 2000);
    expect(await sameProcess({ pid: 555, startedAt: WALL }, host.ports)).toBe(false);
  });
});

describe("stopTree stops by the process ID only", () => {
  it("starts taskkill /T /F /PID on Windows, and never names a program", async () => {
    const host = fakeHost({ platform: "win32" });
    host.processes.set(555, WALL);
    expect(await stopTree(555, host.ports)).toEqual({ kind: "stopped" });
    expect(host.commands).toEqual([{ file: "taskkill", args: ["/T", "/F", "/PID", "555"], options: undefined }]);
    expect(await stopTree(555, host.ports)).toEqual({ kind: "absent" });
  });

  it("sends SIGKILL to the process group on Linux, or to the process when it leads no group", async () => {
    const host = fakeHost();
    const child = host.ports.processes.spawn({ program: "/bin/demo", args: [], env: {}, ipc: false });
    expect(await stopTree(child.pid!, host.ports)).toEqual({ kind: "stopped" });
    await host.settle();
    expect(host.signals).toEqual([{ pid: child.pid, signal: "SIGKILL", group: true }]);
    host.processes.set(555, WALL);
    expect(await stopTree(555, host.ports)).toEqual({ kind: "stopped" });
    expect(host.signals[1]).toEqual({ pid: 555, signal: "SIGKILL", group: false });
  });

  it("refuses the host process and a bad ID, and gives failed when taskkill fails", async () => {
    const host = fakeHost({ platform: "win32", answer: () => ({ code: 5, out: "ERROR: Access is denied." }) });
    expect(await stopTree(100, host.ports)).toEqual({ kind: "failed", problem: "the host does not stop its own process" });
    expect(await stopTree(-1, host.ports)).toEqual({ kind: "failed", problem: "-1 is not a process ID" });
    host.processes.set(555, WALL);
    expect(await stopTree(555, host.ports)).toEqual({ kind: "failed", problem: "taskkill gave the code 5: ERROR: Access is denied." });
  });
});

describe("the ready probes", () => {
  it("pass on the HTTP status, a TCP connection or a command that gives 0", async () => {
    const host = fakeHost();
    host.http.set("http://127.0.0.1:8080/health", 200);
    host.http.set("http://127.0.0.1:8081/health", 503);
    host.tcp.add("127.0.0.1:5432");
    expect(await probeOnce({ kind: "http", url: "http://127.0.0.1:8080/health" }, 500, host.ports)).toEqual({ ok: true });
    expect(await probeOnce({ kind: "http", url: "http://127.0.0.1:8081/health" }, 500, host.ports)).toEqual({ ok: false, why: "http://127.0.0.1:8081/health gave 503, not 200" });
    expect(await probeOnce({ kind: "http", url: "http://127.0.0.1:8081/health", status: 503 }, 500, host.ports)).toEqual({ ok: true });
    expect(await probeOnce({ kind: "http", url: "http://127.0.0.1:9/" }, 500, host.ports)).toEqual({ ok: false, why: "http://127.0.0.1:9/ gave no answer in 500 ms" });
    expect(await probeOnce({ kind: "tcp", port: 5432 }, 500, host.ports)).toEqual({ ok: true });
    expect(await probeOnce({ kind: "tcp", host: "::1", port: 5432 }, 500, host.ports)).toEqual({ ok: false, why: "no TCP connection to ::1:5432 in 500 ms" });
    expect(await probeOnce({ kind: "command", program: "/bin/check", args: ["--ready"], cwd: "/srv" }, 500, host.ports)).toEqual({ ok: true });
    expect(host.commands).toEqual([{ file: "/bin/check", args: ["--ready"], options: { cwd: "/srv", timeout: 500 } }]);
  });

  it("fail on a command that does not give 0, and do not throw", async () => {
    const host = fakeHost({ answer: () => ({ code: 3, out: "" }) });
    expect(await probeOnce({ kind: "command", program: "/bin/check", args: [] }, 500, host.ports)).toEqual({ ok: false, why: "/bin/check gave the code 3" });
    const broken = fakeHost({
      answer: () => {
        throw new Error("no shell");
      },
    });
    expect(await probeOnce({ kind: "command", program: "/bin/check", args: [] }, 500, broken.ports)).toEqual({ ok: false, why: "the probe failed: no shell" });
  });

  it("name each bad value", () => {
    expect(probeProblems({ kind: "http", url: "ftp://x", status: 42 })).toEqual(['the address "ftp://x" is not an http or https address', "the status 42 is not an HTTP status"]);
    expect(probeProblems({ kind: "tcp", port: 0 })).toEqual(["the port 0 is not a port from 1 to 65535"]);
    expect(probeProblems({ kind: "command", program: "", args: [] })).toEqual(["the program of the command probe is empty"]);
  });
});

describe("parseEnvFile", () => {
  it("reads KEY=value lines, quotes, export and comments", () => {
    const text = [
      "\uFEFF# the settings",
      "",
      "PLAIN=one two  # a comment",
      "export EXPORTED=yes",
      "SINGLE='a $literal \\n # not a comment'",
      'DOUBLE="line\\nnext \\"quoted\\" \\\\ end"',
      "EMPTY=",
      "PLAIN=again",
      "  SPACED = value ",
    ].join("\r\n");
    expect(parseEnvFile(text)).toEqual({
      env: {
        PLAIN: "again",
        EXPORTED: "yes",
        SINGLE: "a $literal \\n # not a comment",
        DOUBLE: 'line\nnext "quoted" \\ end',
        EMPTY: "",
        SPACED: "value",
      },
      problems: [],
    });
  });

  it("skips a bad line and gives its problem", () => {
    expect(parseEnvFile("no equals\n1BAD=x\nOPEN=\"never closed\nGOOD=1\n")).toEqual({
      env: { GOOD: "1" },
      problems: ["line 1 has no KEY=value", 'line 2: "1BAD" is not a name of a variable', "line 3: the value of OPEN has no closing quote"],
    });
  });
});

describe("rotatingLog", () => {
  it("appends in sequence, and rotates the file at its size, keeping the newest old files", async () => {
    const host = fakeHost();
    const log = rotatingLog({ path: "/logs/a.log", maxSize: { value: 10, unit: "B" }, keep: 2 }, host.ports.files);
    for (const chunk of ["123456", "7890ab", "cdefgh", "ijklmn"]) log.write(chunk);
    log.write(new TextEncoder().encode("op"));
    await log.flush();
    expect(host.text("/logs/a.log")).toBe("ijklmnop");
    expect(host.text("/logs/a.log.1")).toBe("cdefgh");
    expect(host.text("/logs/a.log.2")).toBe("7890ab");
    expect(host.files.size).toBe(3);
    expect(log.failures).toBe(0);
  });

  it("keeps no old file with keep 0, and counts a failed write without a throw", async () => {
    const host = fakeHost();
    const log = rotatingLog({ path: "/logs/b.log", maxSize: { value: 1, unit: "kB" }, keep: 0 }, host.ports.files);
    log.write("x".repeat(900));
    log.write("y".repeat(200));
    await log.flush();
    expect(host.text("/logs/b.log")).toBe("y".repeat(200));
    expect([...host.files.keys()]).toEqual(["/logs/b.log"]);
    host.failFiles = () => true;
    log.write("z");
    await log.flush();
    expect(log.failures).toBe(1);
    host.failFiles = null;
    log.write("z");
    await log.flush();
    expect(host.text("/logs/b.log")).toBe(`${"y".repeat(200)}z`);
  });
});
