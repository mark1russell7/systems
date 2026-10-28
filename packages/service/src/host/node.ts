import type { Serializable } from "node:child_process";
import { execFile, spawn as spawnChild } from "node:child_process";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir, userInfo } from "node:os";
import { dirname } from "node:path";
import type { Clock } from "../clock.ts";
import { realClock } from "../clock.ts";
import type { Logger } from "../logger.ts";
import type { ChildHandle, CommandPort, FilePort, HostPorts, NetPort, ProcessesPort, SpawnRequest, StopSignal } from "./ports.ts";

/** These options go with the ports of Node. */
export interface NodeHostOptions {
  readonly logger?: Logger | undefined;
  /** This clock gives the time and the timers. The default is `realClock`. */
  readonly clock?: Clock | undefined;
}

const codeOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;

const missing = (error: unknown): boolean => codeOf(error) === "ENOENT";

const nodeCommands: CommandPort = {
  run: (file, args, options = {}) =>
    new Promise((resolve) => {
      execFile(
        file,
        [...args],
        { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), timeout: options.timeout ?? 0, windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const out = `${stdout}${stderr}`;
          if (error === null) {
            resolve({ code: 0, out });
            return;
          }
          if (missing(error)) resolve({ code: 127, out: error.message });
          else if (error.killed === true && options.timeout !== undefined) resolve({ code: 124, out });
          else resolve({ code: typeof error.code === "number" ? error.code : 1, out: out === "" ? error.message : out });
        },
      );
    }),
};

let serial = 0;

const nodeFiles: FilePort = {
  async read(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  },
  async write(path, data) {
    await mkdir(dirname(path), { recursive: true });
    serial += 1;
    const temporary = `${path}.${process.pid}.${serial}.tmp`;
    await writeFile(temporary, data);
    try {
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  },
  async create(path, data) {
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, data, { flag: "wx" });
      return true;
    } catch (error) {
      if (codeOf(error) === "EEXIST") return false;
      throw error;
    }
  },
  async append(path, data) {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, data);
  },
  async size(path) {
    try {
      return (await stat(path)).size;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  },
  rename: (from, to) => rename(from, to),
  remove: (path) => rm(path, { force: true }),
};

/** This difference is the time from the start of the Windows file time (1601) to the start of the epoch (1970), in milliseconds. */
const FILETIME_EPOCH_MS = 11_644_473_600_000n;

/** This function gives the start time of a Windows process from PowerShell, in milliseconds after the epoch, or null. */
const windowsStart = async (pid: number): Promise<number | null> => {
  const result = await nodeCommands.run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`],
    { timeout: 10_000 },
  );
  const text = result.out.trim();
  if (result.code !== 0 || !/^\d+$/.test(text)) return null;
  return Number(BigInt(text) / 10_000n - FILETIME_EPOCH_MS);
};

/** This count is the number of clock ticks in one second on Linux. It is 100 on each common kernel. */
const LINUX_TICKS = 100;

/** This function gives the start time of a Linux process from `/proc`, in milliseconds after the epoch, or null. */
const linuxStart = async (pid: number): Promise<number | null> => {
  const record = await readFile(`/proc/${pid}/stat`, "utf8");
  // the name of the program is in parentheses and can have spaces: the fields start after the last ")"
  const fields = record.slice(record.lastIndexOf(")") + 2).split(" ");
  const ticks = Number(fields[19]);
  const boot = /^btime (\d+)$/m.exec(await readFile("/proc/stat", "utf8"));
  if (!Number.isFinite(ticks) || boot === null) return null;
  return Number(boot[1]) * 1000 + (ticks * 1000) / LINUX_TICKS;
};

const sendSignal = (pid: number, signal: StopSignal | 0): boolean => {
  try {
    return process.kill(pid, signal);
  } catch {
    return false;
  }
};

const nodeSpawn = (request: SpawnRequest): ChildHandle => {
  const outputs: Array<(stream: "stdout" | "stderr", chunk: string | Uint8Array) => void> = [];
  const exits: Array<(code: number | null, signal: string | null) => void> = [];
  let end: { code: number | null; signal: string | null } | null = null;
  const finish = (code: number | null, signal: string | null): void => {
    if (end !== null) return;
    end = { code, signal };
    for (const handler of exits) handler(code, signal);
  };
  const child = spawnChild(request.program, [...request.args], {
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    env: { ...request.env },
    stdio: request.ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    // on Linux the child leads its own process group, thus the tree stop reaches each process under it
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk: Uint8Array) => {
    for (const handler of outputs) handler("stdout", chunk);
  });
  child.stderr?.on("data", (chunk: Uint8Array) => {
    for (const handler of outputs) handler("stderr", chunk);
  });
  child.on("error", () => {
    if (child.pid === undefined) finish(null, null);
  });
  child.on("exit", (code, signal) => finish(code, signal));
  return {
    pid: child.pid ?? null,
    ipc: request.ipc,
    onOutput(handler) {
      outputs.push(handler);
    },
    onExit(handler) {
      exits.push(handler);
      if (end !== null) handler(end.code, end.signal);
    },
    send(message) {
      if (!child.connected) return false;
      try {
        return child.send(message as Serializable);
      } catch {
        return false;
      }
    },
  };
};

const nodeProcesses: ProcessesPort = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // a process of a different user is alive, and the signal does not go to it
      return codeOf(error) === "EPERM";
    }
  },
  async startOf(pid) {
    try {
      if (process.platform === "win32") return await windowsStart(pid);
      if (process.platform === "linux") return await linuxStart(pid);
      return null;
    } catch {
      return null;
    }
  },
  signal: (pid, signal) => sendSignal(pid, signal),
  signalGroup: (pid, signal) => process.platform !== "win32" && sendSignal(-pid, signal),
  spawn: nodeSpawn,
};

const nodeNet: NetPort = {
  async httpStatus(url, timeout) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: "manual" });
      await response.body?.cancel();
      return response.status;
    } catch {
      return null;
    }
  },
  tcpConnect: (host, port, timeout) =>
    new Promise((resolve) => {
      const socket = connect({ host, port });
      const done = (open: boolean): void => {
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(timeout, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    }),
};

/**
 * This function gives the host ports of Node: `child_process`, `fs/promises`, `net`, `fetch` and `process`.
 * Only a program uses it. A test gives `fakeHost()` of `./testing`, thus it starts no process and installs no task.
 */
export const nodeHostPorts = (options: NodeHostOptions = {}): HostPorts => {
  const user = (): string => {
    const name = userInfo().username;
    const domain = process.env["USERDOMAIN"];
    return process.platform === "win32" && domain !== undefined && domain !== "" ? `${domain}\\${name}` : name;
  };
  return {
    platform: process.platform,
    commands: nodeCommands,
    files: nodeFiles,
    processes: nodeProcesses,
    net: nodeNet,
    clock: options.clock ?? realClock,
    wall: () => Date.now(),
    self: { pid: process.pid, startedAt: Math.round(Date.now() - process.uptime() * 1000) },
    env: process.env,
    homeDir: homedir(),
    user,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  };
};
