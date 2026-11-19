import type { Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { ContainerLimits, ProbeEvent } from "./cell.ts";

/**
 * The resources that one container of a lab used. A reader in a sidecar reads the files of the
 * cgroup of the container and the devices of its network namespace (`RESOURCES_PROGRAM`). It
 * writes the text of each file in one JSON line, with a stamp on CLOCK_MONOTONIC. This module reads
 * each file from that line, and it gives the change between two readings.
 *
 * A file that the reader cannot read gives null: no read. It does not give a zero.
 */

/** This name is the event of a line of the reader. */
export const RESOURCES_EVENT = "resources";

/** This path is the reader of the resources, in the image of the harness. */
export const RESOURCES_PROGRAM = "/opt/harness/resources";

/** These are the counters of `cpu.stat` of a cgroup. Each time is in microseconds, as the kernel gives it. */
export interface ResourceCpu {
  /** This time is `usage_usec`: the CPU time of the tasks of the cgroup. */
  readonly usage: number;
  /** This time is `user_usec`: the part of the usage in user mode. */
  readonly user: number;
  /** This time is `system_usec`: the part of the usage in the kernel. */
  readonly system: number;
  /** This count is `nr_periods`: the periods of the CPU limit. It is null in a cgroup with no `cpu` controller. */
  readonly periods: number | null;
  /** This count is `nr_throttled`: the periods in which the limit stopped the cgroup. */
  readonly throttled: number | null;
  /** This time is `throttled_usec`: how long the limit stopped the cgroup. */
  readonly throttledTime: number | null;
}

/** These are the amounts of memory of a cgroup, in bytes. Each one is null when its file or its key gave no read. */
export interface ResourceMemory {
  /** This amount is `memory.current`: the memory that the cgroup holds at this time. */
  readonly current: number | null;
  /** This amount is `memory.peak`: the highest `memory.current` of the cgroup. A kernel before Linux 5.19 has no such file. */
  readonly peak: number | null;
  /** This amount is `anon` of `memory.stat`: the anonymous memory, for example the heap of a program. */
  readonly anon: number | null;
  /** This amount is `file` of `memory.stat`: the page cache. */
  readonly file: number | null;
  /** This amount is `kernel` of `memory.stat`. Where the kernel has no such key, it is `kernel_stack` and `slab`. */
  readonly kernel: number | null;
  /** This amount is `sock` of `memory.stat`: the buffers of the sockets. */
  readonly sock: number | null;
  /** These are the counts of `memory.events`, for example `max` and `oom_kill`. */
  readonly events: Readonly<Record<string, number>> | null;
}

/** These are the bytes and the packets of one direction of a device. */
export interface ResourceTraffic {
  readonly bytes: number;
  readonly packets: number;
}

/** These are the counters of one device of a network namespace: what it received (`rx`) and what it sent (`tx`). */
export interface ResourceDevice {
  readonly name: string;
  readonly rx: ResourceTraffic;
  readonly tx: ResourceTraffic;
}

/** These are the counters of the devices of a network namespace, without `lo`, and their sums. */
export interface ResourceNetwork {
  /** These are the devices, in the order of their names. */
  readonly devices: readonly ResourceDevice[];
  readonly rx: ResourceTraffic;
  readonly tx: ResourceTraffic;
}

/** These are the limits of a cgroup, as the kernel prints them. Each one is null when its file gave no read. */
export interface ResourceLimits {
  /** This limit is `cpu.max`: the CPU time of each period in microseconds, or `max` for no limit. */
  readonly cpu: { readonly quota: number | "max"; readonly period: number } | null;
  /** This limit is `memory.max` in bytes, or `max` for no limit. */
  readonly memory: number | "max" | null;
  /** This list is `cpuset.cpus.effective`: the CPUs of the cgroup, for example `0-3`. */
  readonly cpuset: string | null;
}

/** A resource reading is the resources of one container at one moment. */
export interface ResourceReading {
  /** This stamp is the time on CLOCK_MONOTONIC before the first file, in nanoseconds. The reader reads `cpu.stat` first. */
  readonly t0: number;
  /** This stamp is the time on CLOCK_MONOTONIC after the last file, in nanoseconds. */
  readonly t1: number;
  /** This folder is the cgroup of the container, as the reader found it. */
  readonly cgroup: string;
  readonly cpu: ResourceCpu | null;
  readonly memory: ResourceMemory;
  /** This count is `pids.current`: the tasks of the cgroup. */
  readonly pids: number | null;
  readonly network: ResourceNetwork | null;
  readonly limits: ResourceLimits;
}

/**
 * A resource change is what a container used between two readings. A part is null when a file of
 * it gave no read in one of the readings, or when a counter of it went down. `resets` names each
 * counter that went down, because a negative use has no meaning.
 */
export interface ResourceChange {
  /** This time is the time between the first stamps of the two readings. */
  readonly elapsed: Quantity;
  readonly cpu: {
    readonly total: Quantity;
    readonly user: Quantity;
    readonly system: Quantity;
    /** This time is how long the CPU limit stopped the cgroup. It is null in a cgroup with no `cpu` controller. */
    readonly throttled: Quantity | null;
    /** This count is the periods of the CPU limit. */
    readonly periods: number | null;
    /** This count is the periods in which the limit stopped the cgroup. */
    readonly throttledPeriods: number | null;
  } | null;
  readonly memory: {
    /** This amount is `memory.current` at the second reading, in bytes. */
    readonly last: number | null;
    /** This amount is `memory.peak` at the second reading, in bytes: the highest usage of the cgroup from its start. */
    readonly peak: number | null;
    /** This choice says that the peak rose between the two readings. The peak is then the peak of that time. */
    readonly peakBetween: boolean | null;
  };
  /** This part is the traffic of each device and the sums. A device that came after the first reading counts from 0. */
  readonly network: ResourceNetwork | null;
  /** These are the counters that went down, for example `cpu.usage` after a restart of the container. */
  readonly resets: readonly string[];
}

/** These are the options of a reader of the resources of a container. */
export interface ResourceOptions {
  /** This time is the period of a series, for example 1 s. Without it, the reader has no series. */
  readonly period?: Quantity;
  /** This list is the CPUs that the kernel puts the reader on, for example the CPUs of the client. Without it, the reader has no such limit. */
  readonly cpuset?: string;
}

/**
 * A resource reader reads the resources of one container from a sidecar. The sidecar is in the
 * network namespace of the container and in the cgroup namespace of the host. It is not in the
 * cgroup of the container, thus its own CPU time and memory are not in the readings.
 */
export interface ResourceReader {
  /** These are the readings of the series, as they arrive. A reader with no period has none. */
  readonly series: readonly ResourceReading[];
  /**
   * This method gives one reading at this moment. The stamps of the reading are the times of the
   * read in the VM, thus the latency of the call is not in them.
   */
  read(): Promise<ResourceReading>;
  /** This method stops the sidecar. The series keeps its readings. */
  stop(): Promise<void>;
}

/** These are the fields of the `HostConfig` of the Docker API that hold the limits of a container. */
export interface HostLimits {
  /** This count is the CPU quota, in units of 1e-9 CPUs. */
  NanoCpus?: number;
  /** This list is the CPUs that the kernel puts the container on. */
  CpusetCpus?: string;
  /** This amount is the memory limit, in bytes. */
  Memory?: number;
  /** This amount is the limit of the memory and the swap together, in bytes. It is equal to `Memory`, thus the container has no swap. */
  MemorySwap?: number;
}

/** This count is the smallest CPU limit that Docker takes, in CPUs. */
const LEAST_CPUS = 0.01;

/** This amount is the smallest memory limit that Docker takes, in bytes: 6 MiB. */
const LEAST_MEMORY = 6 * 1024 * 1024;

/** This function gives the bytes of a memory limit, or null for an amount that is not a count of bytes. */
const bytesOf = (memory: Quantity): number | null => {
  try {
    const bytes = Math.round(valueIn(memory, "B"));
    return Number.isSafeInteger(bytes) ? bytes : null;
  } catch {
    // the unit is not a unit of data
    return null;
  }
};

/** This function tells that a text is a list of CPUs, as `cpuset.cpus` takes it: `0`, `2-3` or `0,2`. */
const isCpuList = (text: string): boolean =>
  /^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(text) &&
  text.split(",").every((range) => {
    const [first, last] = range.split("-").map(Number);
    return last === undefined || first! <= last;
  });

/** This function gives the problems of the limits of a container, each as a sentence. Limits with no problem give an empty list. */
export const limitsProblems = (limits: ContainerLimits): string[] => {
  const problems: string[] = [];
  const { cpus, cpuset, memory } = limits;
  if (cpus !== undefined && !(Number.isFinite(cpus) && cpus >= LEAST_CPUS)) problems.push(`cpus is ${cpus}: Docker takes ${LEAST_CPUS} CPUs or more`);
  if (cpuset !== undefined && !isCpuList(cpuset)) problems.push(`cpuset is "${cpuset}": write a list of CPUs, for example 0, 2-3 or 0,2`);
  if (memory !== undefined) {
    const bytes = bytesOf(memory);
    if (bytes === null) problems.push(`memory is ${memory.value} ${memory.unit}: write an amount of data, for example 512 MiB`);
    else if (bytes < LEAST_MEMORY) problems.push(`memory is ${bytes} B: Docker takes 6 MiB or more`);
  }
  return problems;
};

/**
 * This function gives the limits of a container as Docker takes them: the CPU quota, the CPUs and
 * the memory, with no swap. It throws for limits that have a problem (`limitsProblems`).
 */
export const hostLimitsOf = (limits: ContainerLimits): HostLimits => {
  const problems = limitsProblems(limits);
  if (problems.length > 0) throw new RangeError(`the limits of a container: ${problems.join("; ")}`);
  const bytes = limits.memory === undefined ? null : bytesOf(limits.memory);
  return {
    ...(limits.cpus === undefined ? {} : { NanoCpus: Math.round(limits.cpus * 1e9) }),
    ...(limits.cpuset === undefined ? {} : { CpusetCpus: limits.cpuset }),
    ...(bytes === null ? {} : { Memory: bytes, MemorySwap: bytes }),
  };
};

/**
 * This function gives the argv of the reader: one reading, or a series with a period. Each folder
 * is a place where the cgroup of the container can be. The reader takes the first one that is there.
 */
export const resourceArgs = (dirs: readonly string[], period?: Quantity): string[] => {
  if (period === undefined) return [RESOURCES_PROGRAM, "read", ...dirs];
  const ms = Math.round(valueIn(period, "ms"));
  if (!(ms >= 1)) throw new RangeError(`resourceArgs: the period of a series is ${ms} ms, and the reader takes 1 ms or more`);
  return [RESOURCES_PROGRAM, "watch", "--period-ms", String(ms), ...dirs];
};

/** This function gives a count from its digits, or null for another text and for a count that a number cannot hold. */
const countOf = (text: string | undefined): number | null => {
  if (text === undefined || !/^\d+$/.test(text)) return null;
  const count = Number(text);
  return Number.isSafeInteger(count) ? count : null;
};

/** This function gives the count of a file of a cgroup that holds one count, as `memory.current` does. Another text gives null. */
export const cgroupNumber = (text: string): number | null => countOf(text.trim());

/** This function gives a limit of a cgroup, as `memory.max` prints it: its count, or `max` for no limit. Another text gives null. */
export const cgroupLimit = (text: string): number | "max" | null => (text.trim() === "max" ? "max" : cgroupNumber(text));

/**
 * This function gives the counts of a flat keyed file of a cgroup: one key and one count on each
 * line. `cpu.stat` and `memory.stat` are such files. It skips each other line.
 */
export const cgroupKeyed = (text: string): Readonly<Record<string, number>> =>
  Object.fromEntries(
    text.split("\n").flatMap((line): Array<[string, number]> => {
      const parts = line.trim().split(/\s+/);
      const count = parts.length === 2 ? countOf(parts[1]) : null;
      return count === null ? [] : [[parts[0]!, count]];
    }),
  );

/** This function gives one count of a flat keyed file, or null for a key that the file does not have. */
const keyOf = (counts: Readonly<Record<string, number>>, key: string): number | null => (Object.hasOwn(counts, key) ? counts[key]! : null);

/** This function reads `cpu.stat`. It gives null for a text with no usage. */
export const cpuStatOf = (text: string): ResourceCpu | null => {
  const counts = cgroupKeyed(text);
  const [usage, user, system] = [keyOf(counts, "usage_usec"), keyOf(counts, "user_usec"), keyOf(counts, "system_usec")];
  if (usage === null || user === null || system === null) return null;
  return {
    usage,
    user,
    system,
    periods: keyOf(counts, "nr_periods"),
    throttled: keyOf(counts, "nr_throttled"),
    throttledTime: keyOf(counts, "throttled_usec"),
  };
};

/** This function reads `memory.stat`: the amounts of `anon`, `file`, `kernel` and `sock`, each null without its key. */
export const memoryStatOf = (text: string): Pick<ResourceMemory, "anon" | "file" | "kernel" | "sock"> => {
  const counts = cgroupKeyed(text);
  const [stack, slab] = [keyOf(counts, "kernel_stack"), keyOf(counts, "slab")];
  return {
    anon: keyOf(counts, "anon"),
    file: keyOf(counts, "file"),
    // a kernel before Linux 5.18 has no key `kernel`: its stacks and its slabs are the larger parts of it
    kernel: keyOf(counts, "kernel") ?? (stack === null || slab === null ? null : stack + slab),
    sock: keyOf(counts, "sock"),
  };
};

/** This function reads `cpu.max`: the quota and the period, as `50000 100000` or `max 100000`. Another text gives null. */
export const cpuMaxOf = (text: string): ResourceLimits["cpu"] => {
  const parts = text.trim().split(/\s+/);
  const quota = parts[0] === "max" ? "max" : countOf(parts[0]);
  const period = countOf(parts[1]);
  return parts.length !== 2 || quota === null || period === null ? null : { quota, period };
};

const NO_TRAFFIC: ResourceTraffic = { bytes: 0, packets: 0 };

const sumOf = (devices: readonly ResourceDevice[], side: "rx" | "tx"): ResourceTraffic =>
  devices.reduce((sum, device) => ({ bytes: sum.bytes + device[side].bytes, packets: sum.packets + device[side].packets }), NO_TRAFFIC);

/** This function gives the network of some devices: the devices in the order of their names, and their sums. */
const networkWith = (devices: readonly ResourceDevice[]): ResourceNetwork => {
  const sorted = [...devices].sort((one, other) => (one.name < other.name ? -1 : one.name > other.name ? 1 : 0));
  return { devices: sorted, rx: sumOf(sorted, "rx"), tx: sumOf(sorted, "tx") };
};

/**
 * This function reads `/proc/net/dev`: the bytes and the packets of each device, without `lo`. It
 * gives null for a text that is not that file, and for a line of a device that it cannot read.
 */
export const networkOf = (text: string): ResourceNetwork | null => {
  // the second line of headings names the columns of each direction
  if (!text.includes("|bytes")) return null;
  const devices: ResourceDevice[] = [];
  for (const line of text.split("\n")) {
    const colon = line.lastIndexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    // 16 columns: 8 of the receive side, then 8 of the transmit side, each with its bytes and its packets first
    const counts = line.slice(colon + 1).trim().split(/\s+/).map(countOf);
    if (name === "" || counts.length < 16 || counts.includes(null)) return null;
    if (name === "lo") continue;
    devices.push({ name, rx: { bytes: counts[0]!, packets: counts[1]! }, tx: { bytes: counts[8]!, packets: counts[9]! } });
  }
  return networkWith(devices);
};

/** This function gives the text of one file of a line of the reader, or null for no read. */
const textOf = (files: unknown, name: string): string | null => {
  if (typeof files !== "object" || files === null || !Object.hasOwn(files, name)) return null;
  const text = (files as Readonly<Record<string, unknown>>)[name];
  return typeof text === "string" ? text : null;
};

/** This function reads a text with `read`, and gives null for no text. */
const readWith = <T>(text: string | null, read: (text: string) => T | null): T | null => (text === null ? null : read(text));

/**
 * This function gives the reading of one line of the reader (`RESOURCES_EVENT`). It gives null for
 * another line, and for a line with no stamps.
 */
export const resourceReadingOf = (line: ProbeEvent): ResourceReading | null => {
  const { t, t1, cgroup, files, net } = line;
  if (line.ev !== RESOURCES_EVENT || typeof t !== "number" || typeof t1 !== "number" || typeof cgroup !== "string") return null;
  const file = (name: string): string | null => textOf(files, name);
  const stat = readWith(file("memory.stat"), memoryStatOf) ?? { anon: null, file: null, kernel: null, sock: null };
  const cpuset = file("cpuset.cpus.effective")?.trim();
  return {
    t0: t,
    t1,
    cgroup,
    cpu: readWith(file("cpu.stat"), cpuStatOf),
    memory: {
      current: readWith(file("memory.current"), cgroupNumber),
      peak: readWith(file("memory.peak"), cgroupNumber),
      ...stat,
      events: readWith(file("memory.events"), cgroupKeyed),
    },
    pids: readWith(file("pids.current"), cgroupNumber),
    network: typeof net === "string" ? networkOf(net) : null,
    limits: {
      cpu: readWith(file("cpu.max"), cpuMaxOf),
      memory: readWith(file("memory.max"), cgroupLimit),
      cpuset: cpuset === undefined || cpuset === "" ? null : cpuset,
    },
  };
};

/**
 * This function gives the reading of the output of one read of the reader. It throws for a text
 * that is not a line of a reading.
 */
export const resourceReadingIn = (output: string): ResourceReading => {
  let line: unknown = null;
  try {
    line = JSON.parse(output);
  } catch {
    // not JSON: the error below shows the text
  }
  const isLine = typeof line === "object" && line !== null && typeof (line as { ev?: unknown }).ev === "string";
  const reading = isLine ? resourceReadingOf(line as ProbeEvent) : null;
  if (reading === null) throw new Error(`the reader of the resources gave no reading: ${output.slice(0, 200)}`);
  return reading;
};

/** This function gives a time from its microseconds. */
const fromMicroseconds = (time: number): Quantity => quantity(time / 1e6, "s");

/**
 * This function gives what a container used between two readings. It gives its CPU time, the time
 * that its CPU limit stopped it, the traffic of each device, and its last memory. A counter that
 * went down is in `resets`, and its part is null. It throws when the second reading is the earlier one.
 */
export const resourceChange = (before: ResourceReading, after: ResourceReading): ResourceChange => {
  if (after.t0 < before.t0) throw new RangeError(`resourceChange: the second reading is ${before.t0 - after.t0} ns before the first`);
  const resets: string[] = [];
  /** This function gives the rise of a counter. It gives null for a counter that went down, and names it. */
  const rise = (name: string, from: number, to: number): number | null => {
    if (to >= from) return to - from;
    resets.push(name);
    return null;
  };
  /** This function gives the rise of a counter that can have no read. */
  const riseOf = (name: string, from: number | null, to: number | null): number | null => (from === null || to === null ? null : rise(name, from, to));
  // a new cgroup is a new container: its counters started again
  const same = before.cgroup === after.cgroup;
  if (!same) resets.push("cgroup");

  const cpu = ((): ResourceChange["cpu"] => {
    if (!same || before.cpu === null || after.cpu === null) return null;
    const [total, user, system] = [
      rise("cpu.usage", before.cpu.usage, after.cpu.usage),
      rise("cpu.user", before.cpu.user, after.cpu.user),
      rise("cpu.system", before.cpu.system, after.cpu.system),
    ];
    const periods = riseOf("cpu.periods", before.cpu.periods, after.cpu.periods);
    const throttledPeriods = riseOf("cpu.throttled", before.cpu.throttled, after.cpu.throttled);
    const throttled = riseOf("cpu.throttledTime", before.cpu.throttledTime, after.cpu.throttledTime);
    if (total === null || user === null || system === null) return null;
    return {
      total: fromMicroseconds(total),
      user: fromMicroseconds(user),
      system: fromMicroseconds(system),
      throttled: throttled === null ? null : fromMicroseconds(throttled),
      periods,
      throttledPeriods,
    };
  })();

  const network = ((): ResourceNetwork | null => {
    if (before.network === null || after.network === null) return null;
    const earlier = new Map(before.network.devices.map((device) => [device.name, device]));
    const devices: ResourceDevice[] = [];
    let whole = true;
    for (const device of after.network.devices) {
      // a device that the first reading does not have came after it: its counters started at 0
      const from = earlier.get(device.name) ?? { name: device.name, rx: NO_TRAFFIC, tx: NO_TRAFFIC };
      earlier.delete(device.name);
      const each = (["rx", "tx"] as const).map((side) => ({
        bytes: rise(`network.${device.name}.${side}.bytes`, from[side].bytes, device[side].bytes),
        packets: rise(`network.${device.name}.${side}.packets`, from[side].packets, device[side].packets),
      }));
      const [rx, tx] = [each[0]!, each[1]!];
      if (rx.bytes === null || rx.packets === null || tx.bytes === null || tx.packets === null) whole = false;
      else devices.push({ name: device.name, rx: { bytes: rx.bytes, packets: rx.packets }, tx: { bytes: tx.bytes, packets: tx.packets } });
    }
    // a device that the second reading does not have went away, and its last counters with it
    for (const name of earlier.keys()) {
      resets.push(`network.${name}`);
      whole = false;
    }
    return whole ? networkWith(devices) : null;
  })();

  const [peakBefore, peakAfter] = [before.memory.peak, after.memory.peak];
  return {
    elapsed: quantity((after.t0 - before.t0) / 1e9, "s"),
    cpu,
    memory: {
      last: after.memory.current,
      peak: peakAfter,
      peakBetween: !same || peakBefore === null || peakAfter === null ? null : peakAfter > peakBefore,
    },
    network,
    resets,
  };
};
