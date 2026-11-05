import { existsSync, readFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";

/**
 * A layer is a rung of the laboratory (`docs/S7.md`). E1 is containers on one kernel, and E2 is a
 * cluster of containers on one kernel. A lab with `Topology.fabric` writes E3: routers in containers.
 * A lab in a guest of QEMU writes E4 (`substrateHere`). The other layers do not have a runner at this
 * time.
 */
export type Layer = "E0" | "E1" | "E2" | "E3" | "E4" | "E5" | "E6";

/** A cloud is where the runner operates. GitHub can schedule a standard Linux job on Azure or on AWS. */
export type Cloud = "azure" | "aws" | "unknown";

/** A host is what a process reads about its own machine. */
export interface Host {
  /** This text is the kernel release. */
  readonly kernel: string | null;
  /** This number is `CONFIG_HZ` from the configuration of the kernel, or null without that file. */
  readonly hz: number | null;
  /** This text is the DMI system vendor, for example `Microsoft Corporation`, or null without that file. */
  readonly vendor: string | null;
  /** This value tells if `/dev/kvm` exists. A later VM layer needs it. */
  readonly kvm: boolean;
  /** This text is `$ImageOS $ImageVersion` of a hosted runner, or null elsewhere. */
  readonly image: string | null;
}

/**
 * A substrate tells where a record comes from. The rules of comparison in `docs/S7.md` read it: no
 * statistic pools two layers, two kernels or two clouds. The digest of each image stays in the
 * manifest. A value is null in a record from before this block.
 */
export interface Substrate {
  readonly layer: Layer;
  readonly cloud: Cloud;
  readonly vendor: string | null;
  readonly kernel: string | null;
  readonly hz: number | null;
  readonly kvm: boolean | null;
  readonly image: string | null;
}

/** GitHub announced Linux jobs on AWS on this date. Each earlier hosted job ran on Azure. */
export const AWS_FROM = "2026-10-28";

/** This function gives the cloud of a DMI vendor. A kernel name does not tell: one image can start on each cloud. */
export const cloudOf = (vendor: string | null): Cloud => {
  if (vendor === null) return "unknown";
  if (/microsoft/i.test(vendor)) return "azure";
  if (/amazon/i.test(vendor)) return "aws";
  return "unknown";
};

const textOf = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
};

/** This function reads the host. `root` and `env` are for tests. */
export const readHost = (root = "/", env: Readonly<Record<string, string | undefined>> = process.env, kernel: string = release()): Host => {
  const config = textOf(join(root, "boot", `config-${kernel}`));
  const hz = config === null ? undefined : /^CONFIG_HZ=(\d+)$/m.exec(config)?.[1];
  const os = env["ImageOS"];
  const version = env["ImageVersion"];
  return {
    kernel,
    hz: hz === undefined ? null : Number(hz),
    vendor: textOf(join(root, "sys", "class", "dmi", "id", "sys_vendor")),
    kvm: existsSync(join(root, "dev", "kvm")),
    image: os === undefined || version === undefined ? null : `${os} ${version}`,
  };
};

/** This function gives the substrate of a layer on a host. */
export const substrateOn = (layer: Layer, host: Host = readHost()): Substrate => ({ layer, cloud: cloudOf(host.vendor), ...host });

/**
 * This function gives the substrate of a lab at this place. A guest cannot read its own runner: its
 * DMI vendor is QEMU, and `ImageOS` is not set. Thus the runner writes its host to `LAB_RUNNER`, and
 * the guest keeps only its own kernel and HZ. A value of that variable makes the layer E4.
 */
export const substrateHere = (layer: Layer, host: Host = readHost(), env: Readonly<Record<string, string | undefined>> = process.env): Substrate => {
  const runner = env["LAB_RUNNER"];
  if (runner === undefined || runner === "") return substrateOn(layer, host);
  return substrateOn("E4", { ...(JSON.parse(runner) as Host), kernel: host.kernel, hz: host.hz });
};

/** A CPU reading is two counters of `/proc/stat`, in ticks of the clock. */
export interface CpuTime {
  /** This count is the time that the host gave to another guest while this one had work. */
  readonly steal: number;
  /** This count is the sum of all states of each CPU. */
  readonly total: number;
}

/** This function reads the CPU time of this machine, or gives null without `/proc/stat`. `root` is for tests. */
export const readCpu = (root = "/"): CpuTime | null => {
  const line = textOf(join(root, "proc", "stat"))?.split("\n")[0];
  if (line === undefined || !line.startsWith("cpu ")) return null;
  // user, nice, system, idle, iowait, irq, softirq, steal: the guest counters that follow are in user
  const ticks = line.trim().split(/\s+/).slice(1, 9).map(Number);
  const steal = ticks[7];
  if (steal === undefined || ticks.some(Number.isNaN)) return null;
  return { steal, total: ticks.reduce((sum, tick) => sum + tick, 0) };
};

/**
 * This function gives the share of the CPU time between two readings that the host took. The share
 * goes from zero to one. It is null if no tick passed. A guest sees only the host above it. On a hosted
 * runner that host is itself a guest, and this number does not show the contention of the layer below it.
 */
export const stealShare = (before: CpuTime, after: CpuTime): number | null => {
  const total = after.total - before.total;
  return total <= 0 ? null : (after.steal - before.steal) / total;
};

/** A part of a record that can hold a substrate: a manifest of the harness, or the fields of a kind manifest. */
export interface SubstrateSource {
  readonly substrate?: Substrate;
  readonly kernel?: string;
  readonly hz?: string | null;
}

/**
 * This function reads the substrate of a record, the upgrade of a record from before this block.
 * Nothing rewrites such a record. It reads as the given layer. Its cloud is Azure if the record is
 * from before `AWS_FROM`, and unknown after that date, because its runner did not record the cloud.
 */
export const substrateOf = (source: SubstrateSource, at: string, layer: Layer = "E1"): Substrate =>
  source.substrate ?? {
    layer,
    cloud: at.slice(0, AWS_FROM.length) < AWS_FROM ? "azure" : "unknown",
    vendor: null,
    kernel: source.kernel ?? null,
    hz: source.hz === undefined || source.hz === null ? null : Number(source.hz),
    kvm: null,
    image: null,
  };

const differ = <T>(a: T | null, b: T | null, unknown?: T): boolean => a !== null && b !== null && a !== unknown && b !== unknown && a !== b;

/**
 * This function tells if a statistic can pool two substrates. They must have one layer, one kernel
 * and one cloud. An unknown value does not refuse a pair, because an old record cannot tell. The
 * reader of such a pair says so with `substrateKey`.
 */
export const comparable = (a: Substrate, b: Substrate): boolean =>
  a.layer === b.layer && !differ(a.kernel, b.kernel) && !differ<Cloud>(a.cloud, b.cloud, "unknown");

/** This function gives the one-line name of a substrate, for a summary. */
export const substrateKey = (substrate: Substrate): string => `${substrate.layer} ${substrate.cloud} ${substrate.kernel ?? "unknown"}`;

/**
 * This function gives the first two substrates that a statistic cannot pool, or undefined. It
 * examines each pair. An unknown value matches Azure and AWS, thus one comparison with the first
 * substrate can miss a pair.
 */
export const unpoolable = (substrates: readonly Substrate[]): readonly [Substrate, Substrate] | undefined => {
  for (const [index, a] of substrates.entries()) {
    const b = substrates.slice(index + 1).find((other) => !comparable(a, other));
    if (b !== undefined) return [a, b];
  }
  return undefined;
};
