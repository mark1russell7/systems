import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { valueIn } from "@mark1russell7/quantity";
import { constant } from "@mark1russell7/rigor-chaos";
import { describe, expect, it } from "vitest";
import type { ContainerLimits, ProbeEvent, Target } from "./cell.ts";
import { openLab, withLimits } from "./lab.ts";
import { LOAD_PATH, loadPlanOf } from "./load.ts";
import type { ResourceReading } from "./resources.ts";
import {
  RESOURCES_PROGRAM,
  cgroupKeyed,
  cgroupLimit,
  cgroupNumber,
  cpuMaxOf,
  cpuStatOf,
  hostLimitsOf,
  limitsProblems,
  memoryStatOf,
  networkOf,
  resourceArgs,
  resourceChange,
  resourceReadingIn,
  resourceReadingOf,
} from "./resources.ts";

const MIB = 1024 * 1024;

// The texts below are files of a cgroup v2 and of /proc/net/dev, as Linux 6.8 prints them.

/** `cpu.stat` of a cgroup with the `cpu` controller: it has the counters of the CPU limit. */
const CPU_STAT = [
  "usage_usec 2104530",
  "user_usec 2051020",
  "system_usec 53510",
  "core_sched.force_idle_usec 0",
  "nr_periods 61",
  "nr_throttled 40",
  "throttled_usec 2012345",
  "nr_bursts 0",
  "burst_usec 0",
  "",
].join("\n");

/** `cpu.stat` of a cgroup with no `cpu` controller: only the three times. */
const CPU_STAT_BARE = "usage_usec 5012\nuser_usec 3011\nsystem_usec 2001\n";

const MEMORY_STAT = [
  "anon 71303168",
  "file 4096000",
  "kernel 2265088",
  "kernel_stack 163840",
  "pagetables 471040",
  "sec_pagetables 0",
  "percpu 1440",
  "sock 20480",
  "vmalloc 0",
  "shmem 0",
  "file_mapped 2162688",
  "slab_reclaimable 409600",
  "slab_unreclaimable 602112",
  "slab 1011712",
  "pgfault 21394",
  "",
].join("\n");

/** `memory.stat` of a kernel before Linux 5.18: it has no key `kernel`. */
const MEMORY_STAT_OLD = ["anon 71303168", "file 4096000", "kernel_stack 163840", "sock 0", "slab 1011712", ""].join("\n");

const MEMORY_EVENTS = "low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\noom_group_kill 0\n";

const NET_HEAD = [
  "Inter-|   Receive                                                |  Transmit",
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
].join("\n");
const NET_LO = "    lo:    1200      12    0    0    0     0          0         0     1200      12    0    0    0     0       0          0";
const NET_DEV = [
  NET_HEAD,
  NET_LO,
  "  eth1:     900       9    0    0    0     0          0         0      700       7    0    0    0     0       0          0",
  "  eth0: 1503884    1024    0    0    0     0          0         0 25416332    2048    0    0    0     0       0          0",
  "",
].join("\n");

const CGROUP = "/sys/fs/cgroup/system.slice/docker-0a1b.scope";

/** The files of a line of the reader, each with its text. */
const FILES: Readonly<Record<string, string | null>> = {
  "cpu.stat": CPU_STAT,
  "memory.current": "73400320\n",
  "memory.peak": "140509184\n",
  "memory.stat": MEMORY_STAT,
  "memory.events": MEMORY_EVENTS,
  "pids.current": "11\n",
  "cpu.max": "50000 100000\n",
  "memory.max": "268435456\n",
  "cpuset.cpus.effective": "0\n",
};

/** One line of the reader, as the program prints it. */
const lineOf = (files: Readonly<Record<string, string | null>> = FILES, more: Readonly<Record<string, unknown>> = {}): ProbeEvent => ({
  ev: "resources",
  t: 10_000_000_000,
  t1: 10_000_150_000,
  cgroup: CGROUP,
  files,
  net: NET_DEV,
  ...more,
});

/** A reading with the counters that a test names, on the full reading of `lineOf()`. */
const readingOf = (more: Partial<ResourceReading> = {}): ResourceReading => ({ ...resourceReadingOf(lineOf())!, ...more });

const device = (name: string, rx: readonly [number, number], tx: readonly [number, number]) => ({
  name,
  rx: { bytes: rx[0], packets: rx[1] },
  tx: { bytes: tx[0], packets: tx[1] },
});

const network = (...devices: ReadonlyArray<ReturnType<typeof device>>) => {
  const sum = (side: "rx" | "tx") => ({
    bytes: devices.reduce((all, each) => all + each[side].bytes, 0),
    packets: devices.reduce((all, each) => all + each[side].packets, 0),
  });
  return { devices: [...devices], rx: sum("rx"), tx: sum("tx") };
};

describe("the files of a cgroup", () => {
  it("reads a file of one count, and gives no read for another text", () => {
    expect(cgroupNumber("73400320\n")).toBe(73_400_320);
    expect(cgroupNumber("0\n")).toBe(0);
    expect(cgroupNumber("max\n")).toBeNull();
    expect(cgroupNumber("")).toBeNull();
    expect(cgroupNumber("-1\n")).toBeNull();
    expect(cgroupNumber("12 13\n")).toBeNull();
    expect(cgroupNumber("1.5\n")).toBeNull();
    // a count that a number cannot hold is no read, not a rounded count
    expect(cgroupNumber("18446744073709551615\n")).toBeNull();
  });

  it("reads a limit as its count, or as max for no limit", () => {
    expect(cgroupLimit("268435456\n")).toBe(268_435_456);
    expect(cgroupLimit("max\n")).toBe("max");
    expect(cgroupLimit("none\n")).toBeNull();
    expect(cgroupLimit("")).toBeNull();
  });

  it("reads a flat keyed file, and skips each line that is not a key and a count", () => {
    expect(cgroupKeyed(MEMORY_EVENTS)).toEqual({ low: 0, high: 0, max: 3, oom: 1, oom_kill: 1, oom_group_kill: 0 });
    expect(cgroupKeyed("a 1\nb x\nc\nd 2 3\n\n  e   4  \n")).toEqual({ a: 1, e: 4 });
    expect(cgroupKeyed("")).toEqual({});
  });

  it("reads cpu.stat with the counters of the CPU limit, and without them", () => {
    expect(cpuStatOf(CPU_STAT)).toEqual({ usage: 2_104_530, user: 2_051_020, system: 53_510, periods: 61, throttled: 40, throttledTime: 2_012_345 });
    // a cgroup with no cpu controller has no limit to count: no read, not 0 periods
    expect(cpuStatOf(CPU_STAT_BARE)).toEqual({ usage: 5012, user: 3011, system: 2001, periods: null, throttled: null, throttledTime: null });
    expect(cpuStatOf("user_usec 1\nsystem_usec 2\n")).toBeNull();
    expect(cpuStatOf("")).toBeNull();
  });

  it("reads memory.stat, and takes the stacks and the slabs where the kernel has no key kernel", () => {
    expect(memoryStatOf(MEMORY_STAT)).toEqual({ anon: 71_303_168, file: 4_096_000, kernel: 2_265_088, sock: 20_480 });
    expect(memoryStatOf(MEMORY_STAT_OLD)).toEqual({ anon: 71_303_168, file: 4_096_000, kernel: 163_840 + 1_011_712, sock: 0 });
    expect(memoryStatOf("anon 5\nkernel_stack 7\n")).toEqual({ anon: 5, file: null, kernel: null, sock: null });
    expect(memoryStatOf("")).toEqual({ anon: null, file: null, kernel: null, sock: null });
  });

  it("reads cpu.max as a quota and a period", () => {
    expect(cpuMaxOf("50000 100000\n")).toEqual({ quota: 50_000, period: 100_000 });
    expect(cpuMaxOf("max 100000\n")).toEqual({ quota: "max", period: 100_000 });
    expect(cpuMaxOf("max\n")).toBeNull();
    expect(cpuMaxOf("a b\n")).toBeNull();
    expect(cpuMaxOf("1 2 3\n")).toBeNull();
    expect(cpuMaxOf("")).toBeNull();
  });
});

describe("the devices of a network namespace", () => {
  it("reads the bytes and the packets of each device without lo, in the order of the names, and their sums", () => {
    expect(networkOf(NET_DEV)).toEqual(network(device("eth0", [1_503_884, 1024], [25_416_332, 2048]), device("eth1", [900, 9], [700, 7])));
    expect(networkOf(NET_DEV)?.tx).toEqual({ bytes: 25_417_032, packets: 2055 });
    // a namespace with only lo has no traffic: a real zero, because the file gave a read
    expect(networkOf(`${NET_HEAD}\n${NET_LO}\n`)).toEqual(network());
    // a name can touch its first count
    expect(networkOf(`${NET_HEAD}\n  eth0:1503884 1024 0 0 0 0 0 0 25416332 2048 0 0 0 0 0 0\n`)?.devices[0]?.rx.bytes).toBe(1_503_884);
  });

  it("gives no read for a text that is not the file, and for a line that it cannot read", () => {
    expect(networkOf("")).toBeNull();
    expect(networkOf("eth0: 1 2 0 0 0 0 0 0 3 4 0 0 0 0 0 0\n")).toBeNull();
    expect(networkOf(`${NET_HEAD}\n  eth0: 1 2 3\n`)).toBeNull();
    expect(networkOf(`${NET_HEAD}\n  eth0: 1 x 0 0 0 0 0 0 3 4 0 0 0 0 0 0\n`)).toBeNull();
  });
});

describe("a line of the reader", () => {
  it("gives the reading of each file, with the two stamps and the folder of the cgroup", () => {
    expect(resourceReadingOf(lineOf())).toEqual({
      t0: 10_000_000_000,
      t1: 10_000_150_000,
      cgroup: CGROUP,
      cpu: { usage: 2_104_530, user: 2_051_020, system: 53_510, periods: 61, throttled: 40, throttledTime: 2_012_345 },
      memory: {
        current: 73_400_320,
        peak: 140_509_184,
        anon: 71_303_168,
        file: 4_096_000,
        kernel: 2_265_088,
        sock: 20_480,
        events: { low: 0, high: 0, max: 3, oom: 1, oom_kill: 1, oom_group_kill: 0 },
      },
      pids: 11,
      network: network(device("eth0", [1_503_884, 1024], [25_416_332, 2048]), device("eth1", [900, 9], [700, 7])),
      limits: { cpu: { quota: 50_000, period: 100_000 }, memory: 268_435_456, cpuset: "0" },
    });
    expect(resourceReadingOf(lineOf({ ...FILES, "cpu.max": "max 100000\n", "memory.max": "max\n", "cpuset.cpus.effective": "0-3\n" }))?.limits).toEqual({
      cpu: { quota: "max", period: 100_000 },
      memory: "max",
      cpuset: "0-3",
    });
  });

  it("gives no read for a file that the reader did not read, and never a zero", () => {
    const none = Object.fromEntries(Object.keys(FILES).map((name) => [name, null]));
    expect(resourceReadingOf(lineOf(none, { net: null }))).toEqual({
      t0: 10_000_000_000,
      t1: 10_000_150_000,
      cgroup: CGROUP,
      cpu: null,
      memory: { current: null, peak: null, anon: null, file: null, kernel: null, sock: null, events: null },
      pids: null,
      network: null,
      limits: { cpu: null, memory: null, cpuset: null },
    });
    // a kernel before Linux 5.19 has no memory.peak: the other files keep their values
    const old = resourceReadingOf(lineOf({ ...FILES, "memory.peak": null }));
    expect(old?.memory.peak).toBeNull();
    expect(old?.memory.current).toBe(73_400_320);
    // a line with no files, and a file with a text that is not its format
    expect(resourceReadingOf(lineOf(FILES, { files: undefined }))?.cpu).toBeNull();
    expect(resourceReadingOf(lineOf({ ...FILES, "pids.current": "max\n", "cpuset.cpus.effective": "\n" }))).toMatchObject({ pids: null, limits: { cpuset: null } });
  });

  it("gives null for another line, and for a line with no stamps", () => {
    expect(resourceReadingOf({ ev: "error", t: 1, what: "no cgroup folder of the container" })).toBeNull();
    expect(resourceReadingOf(lineOf(FILES, { t1: undefined }))).toBeNull();
    expect(resourceReadingOf(lineOf(FILES, { cgroup: 5 }))).toBeNull();
  });

  it("reads the output of one read, and throws for an output that is not a reading", () => {
    expect(resourceReadingIn(`${JSON.stringify(lineOf())}\n`)).toEqual(resourceReadingOf(lineOf()));
    expect(() => resourceReadingIn("")).toThrow(/gave no reading/);
    expect(() => resourceReadingIn("not JSON")).toThrow(/gave no reading: not JSON/);
    expect(() => resourceReadingIn('{"ev":"error","t":1,"what":"no cgroup folder of the container"}')).toThrow(/no cgroup folder/);
    expect(() => resourceReadingIn("[1]")).toThrow(/gave no reading/);
  });
});

describe("the change between two readings", () => {
  const before = readingOf({
    cpu: { usage: 100_000, user: 60_000, system: 40_000, periods: 10, throttled: 2, throttledTime: 30_000 },
    network: network(device("eth0", [1000, 10], [2000, 20])),
  });
  const after = readingOf({
    t0: 14_000_000_000,
    t1: 14_000_120_000,
    cpu: { usage: 2_100_000, user: 1_900_000, system: 200_000, periods: 50, throttled: 40, throttledTime: 2_030_000 },
    memory: { ...before.memory, current: 141_000_000, peak: 150_000_000 },
    network: network(device("eth0", [501_000, 310], [25_002_000, 2020]), device("eth1", [300, 3], [700, 7])),
  });

  it("gives the CPU time, the time under the limit, the traffic of each device and the memory at the end", () => {
    expect(resourceChange(before, after)).toEqual({
      elapsed: { value: 4, unit: "s" },
      cpu: {
        total: { value: 2, unit: "s" },
        user: { value: 1.84, unit: "s" },
        system: { value: 0.16, unit: "s" },
        throttled: { value: 2, unit: "s" },
        periods: 40,
        throttledPeriods: 38,
      },
      memory: { last: 141_000_000, peak: 150_000_000, peakBetween: true },
      // eth1 came after the first reading: it counts from 0
      network: network(device("eth0", [500_000, 300], [25_000_000, 2000]), device("eth1", [300, 3], [700, 7])),
      resets: [],
    });
    // two readings of one moment have no use
    expect(resourceChange(before, before)).toMatchObject({
      elapsed: { value: 0, unit: "s" },
      cpu: { total: { value: 0, unit: "s" }, periods: 0 },
      memory: { peakBetween: false },
      network: { rx: { bytes: 0, packets: 0 }, tx: { bytes: 0, packets: 0 } },
      resets: [],
    });
  });

  it("names a counter that went down, and gives no negative use", () => {
    // a restart of the container starts its counters again
    const restarted = readingOf({ t0: 14_000_000_000, cpu: { ...after.cpu!, usage: 50_000, user: 30_000 } });
    expect(resourceChange(before, restarted)).toMatchObject({ cpu: null, resets: ["cpu.usage", "cpu.user"] });
    // only the counters of the limit went down: the times keep their values
    const lower = readingOf({ t0: 14_000_000_000, cpu: { ...after.cpu!, periods: 5, throttled: 1, throttledTime: 10 } });
    expect(resourceChange(before, lower)).toMatchObject({
      cpu: { total: { value: 2, unit: "s" }, periods: null, throttledPeriods: null, throttled: null },
      resets: ["cpu.periods", "cpu.throttled", "cpu.throttledTime"],
    });
    const fewer = readingOf({ t0: 14_000_000_000, network: network(device("eth0", [500, 310], [25_002_000, 2020])) });
    expect(resourceChange(before, fewer)).toMatchObject({ network: null, resets: ["network.eth0.rx.bytes"] });
    // a device that went away took its counters with it
    expect(resourceChange(after, readingOf({ t0: 15_000_000_000, cpu: after.cpu, network: network(device("eth0", [501_000, 310], [25_002_000, 2020])) }))).toMatchObject({
      network: null,
      resets: ["network.eth1"],
    });
    // another folder is another container
    const other = readingOf({ t0: 14_000_000_000, cgroup: "/sys/fs/cgroup/system.slice/docker-ffff.scope", cpu: after.cpu });
    expect(resourceChange(before, other)).toMatchObject({ cpu: null, memory: { peakBetween: null }, resets: ["cgroup"] });
    expect(() => resourceChange(after, before)).toThrow(RangeError);
  });

  it("gives no read for a part that one of the readings did not read", () => {
    const blind = readingOf({ t0: 14_000_000_000, cpu: null, network: null, memory: { ...before.memory, current: null, peak: null } });
    expect(resourceChange(before, blind)).toMatchObject({ cpu: null, network: null, memory: { last: null, peak: null, peakBetween: null }, resets: [] });
    expect(resourceChange(readingOf({ cpu: null, network: null }), after)).toMatchObject({ cpu: null, network: null, resets: [] });
    // a cgroup with no cpu controller has the times, and no counters of a limit
    const bare = (t0: number, usage: number): ResourceReading =>
      readingOf({ t0, cpu: { usage, user: usage, system: 0, periods: null, throttled: null, throttledTime: null } });
    expect(resourceChange(bare(1e9, 1000), bare(2e9, 501_000))).toMatchObject({
      cpu: { total: { value: 0.5, unit: "s" }, throttled: null, periods: null, throttledPeriods: null },
      resets: [],
    });
  });
});

describe("the limits of a container", () => {
  it("gives the limits as Docker takes them, with no swap", () => {
    expect(hostLimitsOf({ cpus: 1, cpuset: "2-3", memory: { value: 512, unit: "MiB" } })).toEqual({
      NanoCpus: 1_000_000_000,
      CpusetCpus: "2-3",
      Memory: 536_870_912,
      MemorySwap: 536_870_912,
    });
    expect(hostLimitsOf({ cpus: 0.5 })).toEqual({ NanoCpus: 500_000_000 });
    expect(hostLimitsOf({ cpuset: "0,2" })).toEqual({ CpusetCpus: "0,2" });
    expect(hostLimitsOf({})).toEqual({});
  });

  it("names each problem of the limits, and refuses limits with a problem", () => {
    expect(limitsProblems({ cpus: 1, cpuset: "0,2-3", memory: { value: 6, unit: "MiB" } })).toEqual([]);
    expect(limitsProblems({ cpus: 0 })).toHaveLength(1);
    expect(limitsProblems({ cpus: Number.NaN, cpuset: "3-2", memory: { value: 1, unit: "s" } })).toHaveLength(3);
    for (const cpuset of ["", "a", "0,", "1-", "0-1-2", " 0"]) expect(limitsProblems({ cpuset }), cpuset).toHaveLength(1);
    expect(limitsProblems({ memory: { value: 1, unit: "MiB" } })).toEqual(["memory is 1048576 B: Docker takes 6 MiB or more"]);
    expect(() => hostLimitsOf({ cpus: -1 })).toThrow(RangeError);
    expect(() => hostLimitsOf({ cpuset: "x" })).toThrow(/write a list of CPUs/);
  });

  it("writes the limits into the host config of a container, and changes nothing without limits", () => {
    type Stock = Parameters<typeof withLimits>[0];
    const hostConfig: Record<string, unknown> = { Privileged: true };
    const stock = { hostConfig } as unknown as Stock;
    expect(withLimits(stock, undefined)).toBe(stock);
    expect(hostConfig).toEqual({ Privileged: true });
    expect(withLimits(stock, { cpus: 1, cpuset: "1", memory: { value: 512, unit: "MiB" } })).toBe(stock);
    expect(hostConfig).toEqual({ Privileged: true, NanoCpus: 1_000_000_000, CpusetCpus: "1", Memory: 536_870_912, MemorySwap: 536_870_912 });
    expect(() => withLimits(stock, { cpus: 0 })).toThrow(RangeError);
  });

  it("gives the argv of one reading, and of a series with its period", () => {
    expect(resourceArgs(["/a", "/b"])).toEqual([RESOURCES_PROGRAM, "read", "/a", "/b"]);
    expect(resourceArgs(["/a"], { value: 1, unit: "s" })).toEqual([RESOURCES_PROGRAM, "watch", "--period-ms", "1000", "/a"]);
    expect(resourceArgs(["/a"], { value: 250, unit: "ms" })).toEqual([RESOURCES_PROGRAM, "watch", "--period-ms", "250", "/a"]);
    expect(() => resourceArgs(["/a"], { value: 0.1, unit: "ms" })).toThrow(RangeError);
  });
});

/**
 * The proof on real containers. It is opt-in, because it needs Docker and the image of the harness:
 * `resources.yml` starts it with HARNESS_RESOURCES=1. `HARNESS_RESOURCES_OUT` names a folder for the
 * record of the run.
 */
const RUN = process.env["HARNESS_RESOURCES"] === "1";
const OUT = process.env["HARNESS_RESOURCES_OUT"] || undefined;

/** The stock image of the server, pinned by its digest. */
const NODE = "node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1";

/** The CPU time that the server burns for one request of /burn, by its own count, in microseconds. */
const BURN_US = 2_000_000;
/** The anonymous memory that the server holds after its first burn. */
const HELD = 64 * MIB;
/** The body of each reply of /bytes. */
const BODY = MIB;

/**
 * A server with two known costs. `/bytes` sends a body of 1 MiB. `/burn` touches 64 MiB and spins
 * until the process used 2 s of CPU time by getrusage(), and it writes what it used and how long
 * that took. Its lines have a `t` on CLOCK_MONOTONIC, as each line of a lab has.
 */
const SERVER = [
  'import http from "node:http";',
  "const emit = (ev, f = {}) => process.stdout.write(JSON.stringify({ ev, t: Number(process.hrtime.bigint()), ...f }) + '\\n');",
  `const body = Buffer.alloc(${BODY}, 97);`,
  "let held = null;",
  "const used = (from) => { const { user, system } = process.cpuUsage(from); return user + system; };",
  "const server = http.createServer((req, res) => {",
  "  req.resume();",
  '  if (req.url === "/bytes") { res.writeHead(200, { "content-length": body.length }); res.end(body); return; }',
  "  const [from, start] = [process.cpuUsage(), process.hrtime.bigint()];",
  // the fill writes each page, thus the pages are anonymous memory of the process
  `  held = Buffer.alloc(${HELD}, 1);`,
  "  let spins = 0;",
  `  while (used(from) < ${BURN_US}) for (let i = 0; i < 1e6; i += 1) spins += i;`,
  '  emit("burned", { cpu: used(from), wall: Number(process.hrtime.bigint() - start), held: held.length, spins });',
  '  res.end("ok");',
  "});",
  "server.keepAliveTimeout = 60_000;",
  'server.listen(8080, "0.0.0.0", () => emit("listening"));',
].join("\n");

/** This function waits for a value that arrives on a stream, for example a reading of a series. */
const seen = async <T>(look: () => T | undefined, within: number, what: string): Promise<T> => {
  const end = Date.now() + within;
  for (;;) {
    const found = look();
    if (found !== undefined) return found;
    if (Date.now() > end) throw new Error(`no ${what} in ${within} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const median = (values: readonly number[]): number => [...values].sort((one, other) => one - other)[Math.floor(values.length / 2)] ?? Number.NaN;

describe.skipIf(!RUN)("the resources of real containers (HARNESS_RESOURCES=1)", () => {
  it("reads the CPU time, the memory and the traffic of a target under its limits, and other values for the client", async () => {
    // the target has CPU 0. The client and the two readers have the last CPU, thus they take no time from the target.
    const other = String(availableParallelism() - 1);
    const limits: ContainerLimits = { cpus: 0.5, cpuset: "0", memory: { value: 256, unit: "MiB" } };
    const target: Target = {
      image: NODE,
      subject: { kind: "pinned", image: NODE },
      port: 8080,
      ready: "listening",
      files: { "/srv/server.mjs": SERVER },
      command: ["node", "/srv/server.mjs"],
      lines: true,
      limits,
    };
    // 24 bodies of 1 MiB in 3 s, and one burn of 2 s of CPU time at 0.5 s
    const request = (path: string): string => `GET ${path} HTTP/1.1\r\nHost: target\r\n\r\n`;
    const uniform = { arrivals: "uniform" as const };
    const load = loadPlanOf([
      { key: "bytes", plan: { profile: constant(8, 3_000), options: uniform }, requests: [request("/bytes")] },
      { key: "burn", plan: { profile: constant(1, 1_000), options: uniform }, requests: [request("/burn")] },
    ]);
    const planned = (key: string): number => load.streams.find((stream) => stream.key === key)?.schedule.times.length ?? 0;
    expect([planned("bytes"), planned("burn")]).toEqual([24, 1]);

    const lab = await openLab(target, "load");
    try {
      // use (b) of a reader: a series, each second, for the whole run
      const reader = await lab.resources({ period: { value: 1, unit: "s" }, cpuset: other });
      const probe = await lab.probe(
        [lab.targetIp, String(lab.targetPort), "--plan", LOAD_PATH, "--max-s", "120"],
        [{ content: load.content, target: LOAD_PATH }],
        undefined,
        { cpuset: other },
      );
      await probe.until(["ready"], 15_000);
      // the control: the readings of the other container of the lab
      const control = await probe.resources({ period: { value: 250, unit: "ms" }, cpuset: other });
      // use (a) of a reader: one reading before the schedule, and one after it
      const before = await reader.read();
      await probe.go();
      const end = await probe.until(["done", "deadline", "fail"], 120_000);
      const after = await reader.read();
      // each line of a series before these stamps is in the series when a later line is there
      await seen(() => reader.series.find((reading) => reading.t0 > after.t1), 15_000, "reading of the target after the second read");
      // 2 s after the end of the client, Docker has removed its cgroup
      const gone = await seen(() => control.series.find((reading) => reading.t0 > end.t + 2e9), 15_000, "reading of the client after its end");

      const replies = (key: string): number => probe.events.filter((event) => event.ev === "replied" && event["k"] === key && event["status"] === 200).length;
      const burned = lab.server.filter((line) => line.ev === "burned");
      // the known amounts: the CPU time by the count of the process, and the bytes of the bodies
      const burn = burned.reduce((sum, line) => sum + Number(line["cpu"]), 0) / 1e6;
      const wall = burned.reduce((sum, line) => sum + Number(line["wall"]), 0) / 1e9;
      const sent = replies("bytes") * BODY;
      const change = resourceChange(before, after);
      const running = control.series.filter((reading) => reading.cpu !== null);
      const [first, last] = [running[0], running.at(-1)];
      const client = first === undefined || last === undefined ? null : resourceChange(first, last);
      const traffic = resourceChange(control.series[0] ?? gone, gone);
      const took = reader.series.map((reading) => (reading.t1 - reading.t0) / 1e6);
      const summary = {
        cpus: availableParallelism(),
        end: end.ev,
        replies: { bytes: replies("bytes"), burn: replies("burn") },
        burn: { cpu: burn, wall },
        sent,
        target: { limits: after.limits, change },
        client: { limits: first?.limits ?? null, change: client, traffic: traffic.network },
        series: { readings: reader.series.length, medianMs: median(took), maxMs: Math.max(...took) },
      };
      // the record comes before the checks, thus a run that fails has its numbers
      if (OUT !== undefined) {
        mkdirSync(OUT, { recursive: true });
        const record = { summary, burned, before, after, series: reader.series, control: control.series, client: probe.events };
        writeFileSync(join(OUT, "resources.json"), `${JSON.stringify(record, null, 2)}\n`);
      }
      console.log(JSON.stringify(summary));

      // the run did its work: each request got its reply, and the server burned once
      expect(end.ev).toBe("done");
      expect([replies("bytes"), replies("burn")]).toEqual([planned("bytes"), planned("burn")]);
      expect(burned).toHaveLength(planned("burn"));
      expect(burn).toBeGreaterThanOrEqual(BURN_US / 1e6);

      // the limits of the target, as the kernel prints them
      expect(after.limits).toEqual({ cpu: { quota: 50_000, period: 100_000 }, memory: 256 * MIB, cpuset: "0" });
      expect(change.resets).toEqual([]);

      // one clock: the reads are around the schedule of the client and around the burn of the server
      const scheduled = probe.events.find((event) => event.ev === "scheduled")?.t ?? Number.NaN;
      expect(before.t0).toBeLessThanOrEqual(before.t1);
      expect(before.t1).toBeLessThan(scheduled);
      expect(end.t).toBeLessThan(after.t0);
      const burnEnd = burned[0]?.t ?? Number.NaN;
      const burnStart = burnEnd - wall * 1e9;
      expect(burnStart).toBeGreaterThan(scheduled);
      expect(burnEnd).toBeLessThan(after.t0);

      // the CPU time: from 3 % less to 25 % more than the 2 s that the process counted. The rest of the run is small.
      const cpu = change.cpu;
      if (cpu === null) throw new Error("the change has no CPU time");
      const total = valueIn(cpu.total, "s");
      expect(total).toBeGreaterThanOrEqual(0.97 * burn);
      expect(total).toBeLessThanOrEqual(1.25 * burn);
      // the spin is in user mode, and the two parts make the total within 2 %
      expect(valueIn(cpu.user, "s")).toBeGreaterThanOrEqual(0.8 * total);
      expect(Math.abs(valueIn(cpu.user, "s") + valueIn(cpu.system, "s") - total)).toBeLessThanOrEqual(0.02 * total);

      // the limit of 0.5 CPUs: 2 s of CPU time took 4 s, within 5 %, and the kernel stopped the cgroup in most periods
      expect(wall).toBeGreaterThanOrEqual(0.95 * (burn / 0.5));
      // about 39 periods of 100 ms with 50 ms stopped in each: half of that or more
      expect(cpu.throttledPeriods ?? 0).toBeGreaterThanOrEqual(20);
      expect(cpu.periods ?? 0).toBeGreaterThanOrEqual(cpu.throttledPeriods ?? 0);
      expect(cpu.throttled === null ? 0 : valueIn(cpu.throttled, "s")).toBeGreaterThanOrEqual(1);

      // the series: readings each second in the burn, while the event loop of the server did nothing else
      const inBurn = reader.series.filter((reading) => reading.t0 > burnStart && reading.t0 < burnEnd);
      expect(inBurn.length).toBeGreaterThanOrEqual(3);
      for (let at = 1; at < reader.series.length; at += 1) {
        const [one, next] = [reader.series[at - 1]!, reader.series[at]!];
        // the period of 1 s, within 25 %
        expect((next.t0 - one.t0) / 1e9).toBeGreaterThanOrEqual(0.75);
        expect((next.t0 - one.t0) / 1e9).toBeLessThanOrEqual(1.25);
      }
      for (let at = 1; at < inBurn.length; at += 1) {
        // between two readings of the burn, the target used 0.5 CPUs, within 0.1 CPUs
        const rate = valueIn(resourceChange(inBurn[at - 1]!, inBurn[at]!).cpu?.total ?? { value: Number.NaN, unit: "s" }, "s") / ((inBurn[at]!.t0 - inBurn[at - 1]!.t0) / 1e9);
        expect(rate).toBeGreaterThanOrEqual(0.4);
        expect(rate).toBeLessThanOrEqual(0.6);
      }
      // a reading is short: the median of the series is less than 50 ms
      expect(median(took)).toBeLessThan(50);

      // the memory: the 64 MiB that the server holds are anonymous memory, from 10 % less to 100 % more
      const anon = (after.memory.anon ?? Number.NaN) - (before.memory.anon ?? Number.NaN);
      expect(anon).toBeGreaterThanOrEqual(0.9 * HELD);
      expect(anon).toBeLessThanOrEqual(2 * HELD);
      expect(change.memory.last).toBe(after.memory.current);
      expect(change.memory.last ?? 0).toBeGreaterThanOrEqual(after.memory.anon ?? Number.NaN);
      // the peak is not below the last usage, it is not above the limit, and the burn raised it
      expect(change.memory.peak ?? 0).toBeGreaterThanOrEqual(change.memory.last ?? Number.NaN);
      expect(change.memory.peak ?? Number.NaN).toBeLessThanOrEqual(256 * MIB);
      expect(change.memory.peakBetween).toBe(true);
      expect(after.memory.events?.["oom_kill"]).toBe(0);
      expect(after.pids ?? 0).toBeGreaterThanOrEqual(2);

      // the traffic: the device counts each body with its headers, thus the bytes of the bodies or more, and 8 % more at most
      const devices = change.network;
      if (devices === null) throw new Error("the change has no traffic");
      expect(devices.devices.length).toBeGreaterThanOrEqual(1);
      expect(devices.tx.bytes).toBeGreaterThanOrEqual(sent);
      expect(devices.tx.bytes).toBeLessThanOrEqual(1.08 * sent);
      expect(devices.tx.packets).toBeGreaterThan(0);
      // the requests and the acknowledgements are less than 10 % of the bodies
      expect(devices.rx.bytes).toBeGreaterThan(0);
      expect(devices.rx.bytes).toBeLessThan(0.1 * sent);

      // the control: the client is another container, and its readings are far from the bounds of the target
      if (first === undefined || client === null || client.cpu === null) throw new Error("the series of the client has no CPU time");
      expect(first.cgroup).not.toBe(before.cgroup);
      expect(first.limits.cpuset).toBe(other);
      expect(running.length).toBeGreaterThanOrEqual(8);
      // the client sleeps between its arrivals: less than half of the CPU time of the burn
      expect(valueIn(client.cpu.total, "s")).toBeLessThan(0.5 * burn);
      // its namespace received the bodies, and it sent only requests and acknowledgements
      expect(traffic.network?.rx.bytes ?? 0).toBeGreaterThanOrEqual(sent);
      expect(traffic.network?.tx.bytes ?? Number.NaN).toBeLessThan(0.1 * sent);
      // no read, never a zero: the cgroup of the client went away with its program, and its namespace did not
      expect(gone).toMatchObject({ cpu: null, pids: null, memory: { current: null, peak: null, anon: null } });
      expect(gone.network).not.toBeNull();
      await expect(control.read()).rejects.toThrow(/no cgroup folder/);

      await probe.stop();
    } finally {
      await lab.close();
    }
  }, 900_000);
});
