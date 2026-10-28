import type { DiscoveryRead } from "./discovery.ts";
import { readDiscovery } from "./discovery.ts";
import type { HostPorts } from "./ports.ts";
import { joinPath } from "./ports.ts";
import { stopTree } from "./processes.ts";
import type { ServiceSpec } from "./render.ts";
import { renderSystemdTimer, renderSystemdUnit, renderTaskXml, serviceProblems, utf16le } from "./render.ts";

/** A command record is one command that a service operation started, and its result. */
export interface CommandRecord {
  readonly file: string;
  readonly args: readonly string[];
  readonly code: number;
  readonly out: string;
}

/**
 * A service outcome tells what a service operation did. An operation does not throw.
 * - `done`: each command gave 0. `commands` and `files` tell what the operation did.
 * - `failed`: a command gave a code that is not 0, or the file system failed. The problem tells which.
 * - `refused`: the spec has problems, and the operation did nothing.
 * - `unsupported`: the platform is not Windows or Linux, and the operation did nothing.
 */
export type ServiceOutcome =
  | { readonly kind: "done"; readonly commands: readonly CommandRecord[]; readonly files: readonly string[] }
  | { readonly kind: "failed"; readonly commands: readonly CommandRecord[]; readonly problem: string }
  | { readonly kind: "refused"; readonly problems: readonly string[] }
  | { readonly kind: "unsupported"; readonly platform: string };

/** A service status tells if the system has the service, its state, and the instance of the discovery file. */
export interface ServiceStatus {
  /** This flag tells if the system has the task or the unit. */
  readonly installed: boolean;
  /**
   * This text is the state that the system gives, for example `Running` or `Ready` from `schtasks`, or
   * `active` or `inactive` from `systemctl`. It is `unknown` when the system gives no state.
   */
  readonly state: string;
  /** This is the read of the discovery file, or null without a discovery path. */
  readonly instance: DiscoveryRead | null;
  /** These are the commands that the status started. */
  readonly commands: readonly CommandRecord[];
}

/** These options go with an install. */
export interface InstallOptions {
  /** True starts the service after the install. The default is true. */
  readonly start?: boolean | undefined;
}

/** These options go with an operation that stops the instance: the discovery file that names it. */
export interface InstanceOptions {
  /** This path is the discovery file of the instance. With it, the operation stops the process tree of a live instance. */
  readonly discovery?: string | undefined;
}

/** These are the files of a service on this platform. */
export interface ServicePaths {
  /** This path is the task file on Windows, or the unit on Linux. */
  readonly unit: string;
  /** This path is the timer of a daily job on Linux, or null. */
  readonly timer: string | null;
}

/** This function gives the folder of the systemd user units: `$XDG_CONFIG_HOME/systemd/user`, or `~/.config/systemd/user`. */
const unitDir = (ports: HostPorts): string => {
  const config = ports.env["XDG_CONFIG_HOME"];
  return joinPath("linux", config === undefined || config === "" ? joinPath("linux", ports.homeDir, ".config") : config, "systemd", "user");
};

/** This function gives the files of a service on the platform of the ports. */
export const servicePaths = (spec: ServiceSpec, ports: HostPorts): ServicePaths => {
  if (ports.platform === "win32") return { unit: joinPath("win32", spec.stateDir, `${spec.name}.task.xml`), timer: null };
  const dir = unitDir(ports);
  return { unit: joinPath("linux", dir, `${spec.name}.service`), timer: spec.start === "logon" ? null : joinPath("linux", dir, `${spec.name}.timer`) };
};

/** This function gives the unit that `systemctl` enables: the timer of a daily job, or the service. */
const enabledUnit = (spec: ServiceSpec): string => (spec.start === "logon" ? `${spec.name}.service` : `${spec.name}.timer`);

/** This function gives the path of `conhost.exe` from `SystemRoot`. Without it, Task Scheduler expands `%SystemRoot%` at the start. */
const conhostPath = (ports: HostPorts): string => joinPath("win32", ports.env["SystemRoot"] ?? "%SystemRoot%", "System32", "conhost.exe");

/** A runner starts commands, and keeps a record of each. */
interface Runner {
  readonly commands: CommandRecord[];
  run(file: string, args: readonly string[]): Promise<CommandRecord>;
}

const runner = (ports: HostPorts): Runner => {
  const commands: CommandRecord[] = [];
  return {
    commands,
    async run(file, args) {
      let record: CommandRecord;
      try {
        const result = await ports.commands.run(file, args);
        record = { file, args, code: result.code, out: result.out.trim() };
      } catch (error) {
        record = { file, args, code: 127, out: error instanceof Error ? error.message : String(error) };
      }
      commands.push(record);
      ports.logger?.log(record.code === 0 ? "debug" : "warn", `${file} ${args.join(" ")} gave the code ${record.code}`, { ...record });
      return record;
    },
  };
};

const failed = (commands: readonly CommandRecord[], record: CommandRecord): ServiceOutcome => ({
  kind: "failed",
  commands,
  problem: `${record.file} ${record.args.join(" ")} gave the code ${record.code}${record.out === "" ? "" : `: ${record.out}`}`,
});

const problemOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * This function runs the steps of an operation. It refuses a spec with problems and a platform that
 * is not Windows or Linux, and it catches each failure of the file system.
 */
const operate = async (
  spec: ServiceSpec,
  ports: HostPorts,
  steps: (run: Runner, files: string[]) => Promise<CommandRecord | null>,
): Promise<ServiceOutcome> => {
  const problems = serviceProblems(spec);
  if (problems.length > 0) return { kind: "refused", problems };
  if (ports.platform !== "win32" && ports.platform !== "linux") return { kind: "unsupported", platform: ports.platform };
  const run = runner(ports);
  const files: string[] = [];
  try {
    const failure = await steps(run, files);
    if (failure !== null) return failed(run.commands, failure);
  } catch (error) {
    return { kind: "failed", commands: run.commands, problem: `the file system failed: ${problemOf(error)}` };
  }
  return { kind: "done", commands: run.commands, files };
};

/** This function gives the first record whose code is not 0, or null. */
const firstFailure = (...records: readonly CommandRecord[]): CommandRecord | null => records.find((record) => record.code !== 0) ?? null;

/**
 * This function installs a service of the user, and by default starts it. It does not throw.
 * - On Windows, it writes the task file in UTF-16 to `stateDir`, and starts `schtasks /Create /XML <file> /F`, then `schtasks /Run`.
 * - On Linux, it writes the unit (and the timer of a daily job), then starts `systemctl --user daemon-reload` and `enable`.
 * A second install replaces the first. Give it the ports of a test, thus no test installs a real task.
 */
export const installService = (spec: ServiceSpec, ports: HostPorts, options: InstallOptions = {}): Promise<ServiceOutcome> =>
  operate(spec, ports, async (run, files) => {
    const start = options.start ?? true;
    const paths = servicePaths(spec, ports);
    if (ports.platform === "win32") {
      await ports.files.write(paths.unit, utf16le(renderTaskXml(spec, { user: ports.user(), conhost: conhostPath(ports) })));
      files.push(paths.unit);
      const created = await run.run("schtasks", ["/Create", "/TN", spec.name, "/XML", paths.unit, "/F"]);
      if (created.code !== 0 || !start) return firstFailure(created);
      return firstFailure(await run.run("schtasks", ["/Run", "/TN", spec.name]));
    }
    await ports.files.write(paths.unit, renderSystemdUnit(spec));
    files.push(paths.unit);
    const timer = renderSystemdTimer(spec);
    if (paths.timer !== null && timer !== null) {
      await ports.files.write(paths.timer, timer);
      files.push(paths.timer);
    }
    const reloaded = await run.run("systemctl", ["--user", "daemon-reload"]);
    if (reloaded.code !== 0) return reloaded;
    return firstFailure(await run.run("systemctl", ["--user", "enable", ...(start ? ["--now"] : []), enabledUnit(spec)]));
  });

/** This function stops the instance of a discovery file, when it is alive and is the same process. */
const stopInstance = async (ports: HostPorts, options: InstanceOptions): Promise<void> => {
  if (options.discovery === undefined) return;
  const found = await readDiscovery(options.discovery, ports, { clean: true });
  if (found.kind !== "running") return;
  const stopped = await stopTree(found.record.pid, ports);
  ports.logger?.log(stopped.kind === "failed" ? "warn" : "info", `the host stopped the instance ${found.record.pid}: ${stopped.kind}`, {
    pid: found.record.pid,
    outcome: stopped.kind,
  });
};

/**
 * This function removes a service. It does not throw. On Windows, it ends the task and deletes it. On
 * Linux, it disables and stops the unit, removes its files and reloads systemd. With a discovery file,
 * it then stops the process tree of an instance that stays.
 */
export const uninstallService = (spec: ServiceSpec, ports: HostPorts, options: InstanceOptions = {}): Promise<ServiceOutcome> =>
  operate(spec, ports, async (run, files) => {
    const paths = servicePaths(spec, ports);
    let failure: CommandRecord | null;
    if (ports.platform === "win32") {
      // the end of a task that does not run gives a code that is not 0: it is not a failure of the removal
      await run.run("schtasks", ["/End", "/TN", spec.name]);
      failure = firstFailure(await run.run("schtasks", ["/Delete", "/TN", spec.name, "/F"]));
      await ports.files.remove(paths.unit);
    } else {
      failure = firstFailure(await run.run("systemctl", ["--user", "disable", "--now", enabledUnit(spec)]));
      if (paths.timer !== null) await run.run("systemctl", ["--user", "stop", `${spec.name}.service`]);
      await ports.files.remove(paths.unit);
      if (paths.timer !== null) await ports.files.remove(paths.timer);
      await run.run("systemctl", ["--user", "daemon-reload"]);
    }
    files.push(paths.unit, ...(paths.timer === null ? [] : [paths.timer]));
    await stopInstance(ports, options);
    return failure;
  });

/** This function enables a service and starts it. It does not throw. On Windows, it enables the task and runs it. */
export const startService = (spec: ServiceSpec, ports: HostPorts): Promise<ServiceOutcome> =>
  operate(spec, ports, async (run) => {
    if (ports.platform === "win32") {
      const enabled = await run.run("schtasks", ["/Change", "/TN", spec.name, "/ENABLE"]);
      if (enabled.code !== 0) return enabled;
      return firstFailure(await run.run("schtasks", ["/Run", "/TN", spec.name]));
    }
    return firstFailure(await run.run("systemctl", ["--user", "start", spec.start === "logon" ? `${spec.name}.service` : `${spec.name}.timer`]));
  });

/**
 * This function stops a service, and keeps it stopped until `startService`. It does not throw.
 * - On Windows, it disables the task, thus its time trigger does not start it again, and ends the task.
 *   With a discovery file, it then stops the process tree of the instance. Windows has no signal that a child can catch.
 * - On Linux, `systemctl --user stop` sends SIGTERM, thus `run()` stops in its stages.
 */
export const stopService = (spec: ServiceSpec, ports: HostPorts, options: InstanceOptions = {}): Promise<ServiceOutcome> =>
  operate(spec, ports, async (run) => {
    if (ports.platform === "win32") {
      const disabled = await run.run("schtasks", ["/Change", "/TN", spec.name, "/DISABLE"]);
      if (disabled.code !== 0) return disabled;
      await run.run("schtasks", ["/End", "/TN", spec.name]);
      await stopInstance(ports, options);
      return null;
    }
    return firstFailure(await run.run("systemctl", ["--user", "stop", `${spec.name}.service`]));
  });

/** This function gives the value of a line `Key: value` of the list of `schtasks /Query /FO LIST`. */
const listValue = (out: string, key: string): string | null => {
  for (const line of out.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0 && line.slice(0, at).trim() === key) return line.slice(at + 1).trim();
  }
  return null;
};

/**
 * This function gives the status of a service. It does not throw. A service that the system does not
 * have gives `installed: false`. A malformed or stale discovery file gives its read, and not a throw.
 */
export const serviceStatus = async (spec: ServiceSpec, ports: HostPorts, options: InstanceOptions = {}): Promise<ServiceStatus> => {
  const run = runner(ports);
  const instance = options.discovery === undefined ? null : await readDiscovery(options.discovery, ports);
  if (serviceProblems(spec).length > 0 || (ports.platform !== "win32" && ports.platform !== "linux"))
    return { installed: false, state: "unknown", instance, commands: run.commands };
  if (ports.platform === "win32") {
    const query = await run.run("schtasks", ["/Query", "/TN", spec.name, "/V", "/FO", "LIST"]);
    if (query.code !== 0) return { installed: false, state: "unknown", instance, commands: run.commands };
    return { installed: true, state: listValue(query.out, "Status") ?? "unknown", instance, commands: run.commands };
  }
  let installed: boolean;
  try {
    installed = (await ports.files.read(servicePaths(spec, ports).unit)) !== null;
  } catch {
    installed = false;
  }
  const active = await run.run("systemctl", ["--user", "is-active", `${spec.name}.service`]);
  const state = active.out.split(/\r?\n/)[0]?.trim() ?? "";
  return { installed, state: state === "" ? "unknown" : state, instance, commands: run.commands };
};
