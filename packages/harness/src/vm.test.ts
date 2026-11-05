import { readFileSync } from "node:fs";
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
  it("ends when both sides end with no error", async () => {
    await expect(pipeTo(["node", "-e", "process.stdout.write('a')"], ["node", "-e", "process.stdin.resume()"])).resolves.toBeUndefined();
  });

  it("rejects if the source fails, which a shell pipe does not say", async () => {
    await expect(pipeTo(["node", "-e", "process.exit(3)"], ["node", "-e", "process.stdin.resume()"])).rejects.toThrow("node gave status 3");
  });

  it("rejects if the sink fails", async () => {
    await expect(pipeTo(["node", "-e", "process.stdout.write('a')"], ["node", "-e", "process.exit(4)"])).rejects.toThrow("node gave status 4");
  });
});
