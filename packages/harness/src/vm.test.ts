import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cellsEnv, fragmentOf, hzOf, kernelUrl, missingOptions, pipeTo, qemuArgs, sshArgs } from "./vm.ts";

describe("the kernel of a guest", () => {
  it("takes the source from the folder of its major version", () => {
    expect(kernelUrl("6.18.60")).toBe("https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.18.60.tar.xz");
  });

  it("keeps each option and adds the HZ of the input", () => {
    expect(fragmentOf("# a comment\nCONFIG_A=y\n\n# CONFIG_B is not set\nCONFIG_C=m\n", "250")).toEqual(["CONFIG_A=y", "CONFIG_C=m", "CONFIG_HZ_250=y"]);
  });

  it("reads the options of the file of this tier, with no option twice", () => {
    const fragment = fragmentOf(readFileSync(new URL("../vm/kernel.config", import.meta.url), "utf8"), "1000");
    expect(fragment.length).toBeGreaterThan(100);
    expect(new Set(fragment).size).toBe(fragment.length);
  });

  it("names an option that left the final configuration", () => {
    expect(missingOptions(["CONFIG_A=y", "CONFIG_B=y"], "CONFIG_A=y\n# CONFIG_B is not set\n")).toEqual(["CONFIG_B=y"]);
  });

  it("does not take an option with another value as the same option", () => {
    expect(missingOptions(["CONFIG_A=y"], "CONFIG_A=m\n")).toEqual(["CONFIG_A=y"]);
  });

  it("reads the HZ from a configuration", () => {
    expect(hzOf("CONFIG_HZ_1000=y\nCONFIG_HZ=1000\n")).toBe("1000");
    expect(hzOf("CONFIG_HZ_1000=y\n")).toBeNull();
  });
});

describe("the guest", () => {
  it("boots with no boot loader, on an overlay, with the port of ssh on the loopback", () => {
    const args = qemuArgs("/vm", 4);
    expect(args[args.indexOf("-smp") + 1]).toBe("4");
    expect(args[args.indexOf("-kernel") + 1]).toContain("bzImage");
    expect(args[args.indexOf("-append") + 1]).toContain("nf_conntrack.hashsize=16384");
    expect(args[args.indexOf("-drive") + 1]).toContain("node0.qcow2");
    expect(args[args.indexOf("-netdev") + 1]).toContain("hostfwd=tcp:127.0.0.1:2222-:22");
  });

  it("gets its command after the host, as separate words", () => {
    const args = sshArgs("/vm", ["docker", "info"]);
    expect(args.slice(-3)).toEqual(["root@127.0.0.1", "docker", "info"]);
    expect(args[args.indexOf("-p") + 1]).toBe("2222");
  });
});

describe("the command of the cells", () => {
  it("is one form for the runner and for a guest", () => {
    expect(cellsEnv("^T01", "/out/a", "1000", { PATH: "/bin" })).toEqual({
      PATH: "/bin",
      CELLS: "1",
      CELLS_ONLY: "^T01",
      CELLS_SHARD: "0/1",
      CELLS_OUT: "/out/a",
      CELLS_HZ: "1000",
    });
  });
});

describe("a pipe of two commands", () => {
  // a node source gets EPIPE where another program gets SIGPIPE: this source ends quietly on it
  const quiet = "process.stdout.on('error', () => process.exit(0));";
  // this source writes its pid to the file of its first argument, then 8 MB, more than a pipe holds, or less
  // when its pipe breaks. A source that writes with no end grows with no limit on Windows: its writes end
  // before the bytes leave the process.
  const bounded = `${quiet} require('node:fs').writeFileSync(process.argv[1], String(process.pid)); let left = 128; const more = () => { if (left-- > 0) process.stdout.write('x'.repeat(65536), more); }; more();`;
  const gone = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  const pidFile = (): string => join(mkdtempSync(join(tmpdir(), "pipe-")), "pid");

  it("ends when both sides end with no error", async () => {
    await expect(pipeTo(["node", "-e", "process.stdout.write('a')"], ["node", "-e", "process.stdin.resume()"])).resolves.toBeUndefined();
  });

  it("gives the sink the bytes of the source", async () => {
    const file = pidFile();
    await pipeTo(["node", "-e", "process.stdout.write('ab'.repeat(100000))"], ["node", "-e", `let n = 0; process.stdin.on('data', (b) => (n += b.length)).on('end', () => require('node:fs').writeFileSync(${JSON.stringify(file)}, String(n)))`]);
    expect(readFileSync(file, "utf8")).toBe("200000");
  });

  it("rejects if the source fails, which a shell pipe does not say", async () => {
    await expect(pipeTo(["node", "-e", "process.exit(3)"], ["node", "-e", "process.stdin.resume()"])).rejects.toThrow("node gave status 3");
  });

  it("rejects if the sink fails", async () => {
    await expect(pipeTo(["node", "-e", `${quiet} process.stdout.write('a')`], ["node", "-e", "process.exit(4)"])).rejects.toThrow("node gave status 4");
  });

  it("names each side that fails", async () => {
    await expect(pipeTo(["node", "-e", "process.exit(3)"], ["node", "-e", "process.exit(4)"])).rejects.toThrow("node gave status 3, and node gave status 4");
  });

  it("stops the source when the sink fails early, and settles only after the source ends", async () => {
    const file = pidFile();
    await expect(pipeTo(["node", "-e", bounded, file], ["node", "-e", "process.stdin.once('data', () => process.exit(4))"])).rejects.toThrow("node gave status 4");
    expect(gone(Number(readFileSync(file, "utf8")))).toBe(true);
  });

  it("stops the source when the sink does not start", async () => {
    const file = pidFile();
    await expect(pipeTo(["node", "-e", bounded, file], ["no-such-command-of-the-harness"])).rejects.toThrow("no-such-command-of-the-harness did not start");
    expect(gone(Number(readFileSync(file, "utf8")))).toBe(true);
  });

  it("rejects if the source does not start, and the sink reads the end of its input", async () => {
    await expect(pipeTo(["no-such-command-of-the-harness"], ["node", "-e", "process.stdin.resume()"])).rejects.toThrow("no-such-command-of-the-harness did not start");
  });

  // a program that is not node ends by SIGPIPE when its sink ends, as `yes` does under `head` in a shell
  it.skipIf(process.platform === "win32")("takes a source that ends by SIGPIPE after the sink ends with no error", async () => {
    await expect(pipeTo(["yes"], ["node", "-e", "process.stdin.once('data', () => process.exit(0))"])).resolves.toBeUndefined();
  });
});
