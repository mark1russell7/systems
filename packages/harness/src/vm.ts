import { spawn, spawnSync, type ChildProcess, type StdioOptions } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, release, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/**
 * This file operates the VM tier of layer E4 (SYS-81, docs/S7.md). QEMU boots a pinned kernel with no
 * boot loader, thus the kernel of a guest is independent of the runner.
 *
 * The workflow `vm.yml` starts this file with Node, and Node removes the types. Two commands operate
 * before the install, thus this file imports only the modules of Node.
 *
 * The command `kernel` builds bzImage and its configuration. The command `root` builds the disk from
 * the Dockerfile of the folder `vm`. The command `arm` operates the cells on the runner or in the
 * guest, and keeps their records. The command `guest-cells` is the side of `arm` in the guest.
 *
 * This tier has one guest, and it holds the whole lab. A fault that needs a second kernel adds a
 * second node, on its own overlay of the disk.
 */

const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
const VM_FOLDER = join(REPOSITORY, "packages/harness/vm");
const GUEST_PORT = 2222;
const GUEST_MEMORY = "12G";
/** This limit is the time that a guest gets to give Docker. */
const BOOT_LIMIT_MS = 180_000;
const BOOT_POLL_MS = 2_000;
const POWEROFF_LIMIT_MS = 60_000;
/** The cells workflow gives the runner this size of the conntrack table, thus each layer has one size. */
const KERNEL_LINE = "console=ttyS0 root=/dev/vda rw net.ifnames=0 panic=1 nf_conntrack.hashsize=16384";

/** This function gives the address of the source of a kernel. */
export const kernelUrl = (version: string): string => `https://cdn.kernel.org/pub/linux/kernel/v${version.split(".")[0]}.x/linux-${version}.tar.xz`;

/** This function gives the lines that go over the default configuration: each option, and the HZ of the input. */
export const fragmentOf = (options: string, hz: string): readonly string[] => [...options.split(/\r?\n/).filter((line) => line.startsWith("CONFIG_")), `CONFIG_HZ_${hz}=y`];

/**
 * This function gives the lines of the fragment that are not in the final configuration. An option
 * leaves the configuration if an option that it depends on is off, and the build does not say so.
 */
export const missingOptions = (fragment: readonly string[], config: string): readonly string[] => {
  const lines = new Set(config.split(/\r?\n/));
  return fragment.filter((line) => !lines.has(line));
};

/** This function gives `CONFIG_HZ` from the configuration of a kernel, or null if the file has no value. */
export const hzOf = (config: string): string | null => /^CONFIG_HZ=(\d+)$/m.exec(config)?.[1] ?? null;

/** This function gives the argv of QEMU for the one guest. */
export const qemuArgs = (out: string, cpus: number): readonly string[] => [
  "-name",
  "node0",
  "-enable-kvm",
  "-cpu",
  "host",
  "-smp",
  String(cpus),
  "-m",
  GUEST_MEMORY,
  "-display",
  "none",
  "-kernel",
  join(out, "bzImage"),
  "-append",
  KERNEL_LINE,
  "-drive",
  `file=${join(out, "node0.qcow2")},if=virtio,format=qcow2,cache=none`,
  "-netdev",
  `user,id=net0,hostfwd=tcp:127.0.0.1:${GUEST_PORT}-:22`,
  "-device",
  "virtio-net-pci,netdev=net0",
  "-serial",
  `file:${join(out, "console.log")}`,
  "-pidfile",
  join(out, "qemu.pid"),
  "-daemonize",
];

/** This function gives the argv of ssh for one command in the guest. */
export const sshArgs = (out: string, remote: readonly string[]): readonly string[] => [
  "-q",
  "-i",
  join(out, "key"),
  "-p",
  String(GUEST_PORT),
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "ConnectTimeout=5",
  "-o",
  "ServerAliveInterval=30",
  "root@127.0.0.1",
  ...remote,
];

/** The inputs of the cells in a guest. They go on the standard input of ssh, thus no shell reads them. */
export interface GuestCells {
  readonly only: string;
  readonly out: string;
  /** This text is the host of the runner, for `LAB_RUNNER`. */
  readonly runner: string;
}

/**
 * This function gives the environment of the cells. Rule 3 of docs/S7.md pairs the runner and a guest,
 * thus they have this one form.
 */
export const cellsEnv = (only: string, out: string, hz: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...base,
  CELLS: "1",
  CELLS_ONLY: only,
  CELLS_SHARD: "0/1",
  CELLS_OUT: out,
  CELLS_HZ: hz,
});

/** A command with its arguments, for one side of a pipe. */
export type Command = readonly [string, ...string[]];

/** This function pipes the output of one command to the input of another. It rejects if either side fails. */
export const pipeTo = async (from: Command, to: Command): Promise<void> => {
  const [fromFile, ...fromArgs] = from;
  const [toFile, ...toArgs] = to;
  const source = spawn(fromFile, fromArgs, { stdio: ["ignore", "pipe", "inherit"] });
  const sink = spawn(toFile, toArgs, { stdio: ["pipe", "inherit", "inherit"] });
  source.stdout.pipe(sink.stdin);
  // a sink that stops early gives this error, and the status of the sink names the failure
  sink.stdin.on("error", () => undefined);
  const ended = (child: ChildProcess, name: string): Promise<void> =>
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${name} gave status ${String(code)}`));
      });
    });
  await Promise.all([ended(source, fromFile), ended(sink, toFile)]);
};

interface StepOptions {
  readonly cwd?: string;
  readonly input?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** This option hides the output. */
  readonly quiet?: boolean;
  /** This option hides the output and the errors. */
  readonly silent?: boolean;
}

const statusOf = (file: string, args: readonly string[], options: StepOptions = {}): number => {
  const hideOutput = options.quiet === true || options.silent === true;
  const stdio: StdioOptions = [options.input === undefined ? "ignore" : "pipe", hideOutput ? "ignore" : "inherit", options.silent === true ? "ignore" : "inherit"];
  return spawnSync(file, args, { cwd: options.cwd, input: options.input, env: options.env, stdio }).status ?? 1;
};

const mustRun = (file: string, args: readonly string[], options: StepOptions = {}): void => {
  const status = statusOf(file, args, options);
  if (status !== 0) throw new Error(`${file} ${args[0] ?? ""} gave status ${status}`);
};

const outputOf = (file: string, args: readonly string[], cwd?: string): string => {
  const result = spawnSync(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (result.status !== 0) throw new Error(`${file} ${args[0] ?? ""} gave status ${String(result.status)}`);
  return result.stdout.trim();
};

const buildKernel = (out: string, version: string, sum: string, hz: string): void => {
  const source = mkdtempSync(join(tmpdir(), "linux-"));
  const archive = join(source, "linux.tar.xz");
  mustRun("curl", ["-fsSL", "-o", archive, kernelUrl(version)]);
  mustRun("sha256sum", ["-c", "-"], { input: `${sum}  ${archive}\n` });
  mustRun("tar", ["-xf", archive, "-C", source, "--strip-components=1"]);
  rmSync(archive);
  const fragment = fragmentOf(readFileSync(join(VM_FOLDER, "kernel.config"), "utf8"), hz);
  writeFileSync(join(source, "fragment"), `${fragment.join("\n")}\n`);
  mustRun("make", ["-s", "defconfig", "kvm_guest.config"], { cwd: source });
  mustRun(join(source, "scripts/kconfig/merge_config.sh"), ["-m", ".config", "fragment"], { cwd: source });
  mustRun("make", ["-s", "olddefconfig"], { cwd: source });
  // stop before the build, which takes minutes
  const missing = missingOptions(fragment, readFileSync(join(source, ".config"), "utf8"));
  if (missing.length > 0) throw new Error(`these options are not in the final configuration: ${missing.join(" ")}`);
  mustRun("make", ["-s", `-j${availableParallelism()}`, "bzImage"], { cwd: source });
  mkdirSync(out, { recursive: true });
  copyFileSync(join(source, "arch/x86/boot/bzImage"), join(out, "bzImage"));
  copyFileSync(join(source, ".config"), join(out, "config"));
  writeFileSync(join(out, "release"), `${outputOf("make", ["-s", "kernelrelease"], source)}\n`);
  rmSync(source, { recursive: true, force: true });
};

const buildDisk = async (out: string): Promise<void> => {
  const tree = join(out, "tree");
  const kernel = readFileSync(join(out, "release"), "utf8").trim();
  const asRoot = (path: string, text: string): void => mustRun("sudo", ["tee", path], { input: text, quiet: true });
  mustRun("docker", ["build", "-q", "-f", join(VM_FOLDER, "Dockerfile"), "-t", "lab-guest", REPOSITORY], { quiet: true });
  mustRun("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(out, "key")]);
  const container = outputOf("docker", ["create", "lab-guest"]);
  mustRun("sudo", ["mkdir", "-p", tree]);
  await pipeTo(["docker", "export", container], ["sudo", "tar", "-xf", "-", "-C", tree]);
  mustRun("docker", ["rm", container], { quiet: true });
  // `readHost` and `runCells` read the HZ from this file, as on the runner
  mustRun("sudo", ["install", "-D", "-m", "644", join(out, "config"), join(tree, `boot/config-${kernel}`)]);
  mustRun("sudo", ["install", "-D", "-m", "600", join(out, "key.pub"), join(tree, "root/.ssh/authorized_keys")]);
  // an export has empty copies of these files, because Docker mounts them in a container
  asRoot(join(tree, "etc/resolv.conf"), "nameserver 10.0.2.3\n");
  asRoot(join(tree, "etc/hostname"), "guest\n");
  asRoot(join(tree, "etc/hosts"), "127.0.0.1 localhost guest\n");
  mustRun("sudo", ["mkdir", "-p", join(tree, "out")]);
  mustRun("sudo", ["mkfs.ext4", "-q", "-F", "-L", "root", "-d", tree, join(out, "root.img"), "40G"]);
  mustRun("sudo", ["chown", `${outputOf("id", ["-u"])}:${outputOf("id", ["-g"])}`, join(out, "root.img")]);
  mustRun("sudo", ["rm", "-rf", tree]);
  // the runner has approximately 14 GB of disk: the image is in root.img, and each arm of the host needs that space
  mustRun("docker", ["image", "rm", "-f", "lab-guest"], { quiet: true });
  mustRun("docker", ["builder", "prune", "-af"], { quiet: true });
  mustRun("qemu-img", ["create", "-q", "-f", "qcow2", "-b", join(out, "root.img"), "-F", "raw", join(out, "node0.qcow2")]);
};

const startGuest = async (out: string): Promise<void> => {
  mustRun("qemu-system-x86_64", qemuArgs(out, availableParallelism()));
  const started = Date.now();
  // the time to the first ssh reply and to Docker is the boot time of this layer
  while (statusOf("ssh", sshArgs(out, ["docker", "info"]), { silent: true }) !== 0) {
    if (Date.now() - started >= BOOT_LIMIT_MS) {
      const log = join(out, "console.log");
      if (existsSync(log)) process.stdout.write(`${readFileSync(log, "utf8").split("\n").slice(-40).join("\n")}\n`);
      throw new Error(`the guest gave no Docker in ${BOOT_LIMIT_MS / 1000} s`);
    }
    await sleep(BOOT_POLL_MS);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  process.stdout.write(`boot: ${seconds} s to Docker, kernel ${outputOf("ssh", sshArgs(out, ["uname", "-r"]))}\n`);
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const stopGuest = async (out: string): Promise<void> => {
  const file = join(out, "qemu.pid");
  if (!existsSync(file)) return;
  const pid = Number(readFileSync(file, "utf8").trim());
  statusOf("ssh", sshArgs(out, ["systemctl", "poweroff"]), { silent: true });
  const end = Date.now() + POWEROFF_LIMIT_MS;
  while (isAlive(pid)) {
    if (Date.now() >= end) {
      process.kill(pid);
      break;
    }
    await sleep(1_000);
  }
  rmSync(file, { force: true });
};

/** The catalogs' bands read the HZ of the kernel that the lab operates on. */
const runCells = (only: string, out: string, base: NodeJS.ProcessEnv): number => {
  const hz = hzOf(readFileSync(`/boot/config-${release()}`, "utf8"));
  if (hz === null) throw new Error(`the configuration of ${release()} gives no CONFIG_HZ`);
  mkdirSync(out, { recursive: true });
  return statusOf("pnpm", ["--filter", "@systems/cells", "exec", "vitest", "run", "src/run.test.ts"], { cwd: REPOSITORY, env: cellsEnv(only, out, hz, base) });
};

const runArm = async (out: string, layer: string, name: string, only: string): Promise<number> => {
  const records = join(out, "records");
  mkdirSync(records, { recursive: true });
  if (layer === "e1") return runCells(only, join(records, name), process.env);
  if (layer !== "e4") throw new Error(`an arm is e1 or e4, not ${layer}`);
  try {
    await startGuest(out);
    const input: GuestCells = { only, out: `/out/${name}`, runner: readFileSync(join(out, "runner.json"), "utf8").trim() };
    const status = statusOf("ssh", sshArgs(out, ["node", "/lab/packages/harness/src/vm.ts", "guest-cells"]), { input: JSON.stringify(input) });
    // the records come back first: a failed arm keeps what it measured
    await pipeTo(["ssh", ...sshArgs(out, ["tar", "-C", "/out", "-cf", "-", name])], ["tar", "-xf", "-", "-C", records]);
    return status;
  } finally {
    await stopGuest(out);
  }
};

const main = async (args: readonly string[]): Promise<number> => {
  const [command, ...rest] = args;
  const inputs = (count: number): readonly string[] => {
    if (rest.length !== count) throw new Error(`the command ${String(command)} takes ${count} inputs`);
    return rest;
  };
  switch (command) {
    case "kernel": {
      const [out, version, sum, hz] = inputs(4) as readonly [string, string, string, string];
      buildKernel(out, version, sum, hz);
      return 0;
    }
    case "root": {
      const [out] = inputs(1) as readonly [string];
      await buildDisk(out);
      return 0;
    }
    case "arm": {
      const [out, layer, name, only] = inputs(4) as readonly [string, string, string, string];
      return runArm(out, layer, name, only);
    }
    case "guest-cells": {
      const input = JSON.parse(readFileSync(0, "utf8")) as GuestCells;
      return runCells(input.only, input.out, { ...process.env, LAB_RUNNER: input.runner });
    }
    default:
      throw new Error(`no command ${String(command)}`);
  }
};

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (status) => process.exit(status),
    (error: unknown) => {
      process.stdout.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
