import type { HostPorts } from "./ports.ts";
import { sameProcess } from "./processes.ts";

/**
 * A discovery record tells where a running instance listens. The instance writes it after its start,
 * and a client reads it to find the instance. The file is JSON, one record.
 */
export interface Discovery {
  /** This number is the process ID of the instance. */
  readonly pid: number;
  /** This text is the start time of the process, as an ISO 8601 time. */
  readonly startedAt: string;
  /** This number is the port that the instance listens on, or null. */
  readonly port: number | null;
  /** This text is the address of the instance, for example `http://127.0.0.1:8080/`, or null. */
  readonly url: string | null;
  /** These fields are more data of the instance, for example its version. */
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * A discovery read is what a read of the discovery file found. A read does not throw.
 * - `running`: the file names a live process, and its start time does not prove that it is a different process.
 * - `absent`: no file.
 * - `stale`: the file names a process that stopped, or a new process with the same ID.
 * - `malformed`: the file is not a discovery record, or the read failed. The problem tells why.
 */
export type DiscoveryRead =
  | { readonly kind: "running"; readonly record: Discovery }
  | { readonly kind: "absent" }
  | { readonly kind: "stale"; readonly record: Discovery; readonly why: string }
  | { readonly kind: "malformed"; readonly problem: string };

/** These options go with a read of the discovery file. */
export interface ReadDiscoveryOptions {
  /** True removes a stale or malformed file. The default is false. */
  readonly clean?: boolean | undefined;
}

const isPort = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;

/** This function reads a discovery record from a text. It gives the record, or the problem as a text. */
export const parseDiscovery = (text: string): Discovery | string => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return `the file is not JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "the file is not a JSON object";
  const record = value as Readonly<Record<string, unknown>>;
  const { pid, startedAt, port, url, extra } = record;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return "the field pid is not a process ID";
  if (typeof startedAt !== "string" || !Number.isFinite(Date.parse(startedAt))) return "the field startedAt is not an ISO time";
  if (port !== null && port !== undefined && !isPort(port)) return "the field port is not a port from 1 to 65535";
  if (url !== null && url !== undefined && typeof url !== "string") return "the field url is not a text";
  if (extra !== undefined && (typeof extra !== "object" || extra === null || Array.isArray(extra))) return "the field extra is not an object";
  return {
    pid,
    startedAt,
    port: isPort(port) ? port : null,
    url: typeof url === "string" ? url : null,
    ...(extra === undefined ? {} : { extra: extra as Readonly<Record<string, unknown>> }),
  };
};

/** These fields describe where this process listens. */
export interface DiscoveryFields {
  readonly port?: number | null | undefined;
  readonly url?: string | null | undefined;
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

/** This function gives the discovery record of the process of the host, with its start time. */
export const discoveryOf = (fields: DiscoveryFields, ports: HostPorts): Discovery => ({
  pid: ports.self.pid,
  startedAt: new Date(ports.self.startedAt).toISOString(),
  port: fields.port ?? null,
  url: fields.url ?? null,
  ...(fields.extra === undefined ? {} : { extra: fields.extra }),
});

/** This function writes a discovery file. The write replaces the file in one step, thus a reader sees the old record or the new one. */
export const writeDiscovery = async (path: string, record: Discovery, ports: HostPorts): Promise<void> => {
  await ports.files.write(path, `${JSON.stringify(record, null, 2)}\n`);
};

/**
 * This function reads a discovery file and examines its process. It does not throw: a file that is not
 * a record, or a failed read, gives `malformed`. With `clean`, it removes a stale or malformed file.
 */
export const readDiscovery = async (path: string, ports: HostPorts, options: ReadDiscoveryOptions = {}): Promise<DiscoveryRead> => {
  const found = await examine(path, ports);
  if (options.clean === true && (found.kind === "stale" || found.kind === "malformed")) {
    try {
      await ports.files.remove(path);
      ports.logger?.log("info", `the host removed the ${found.kind} discovery file ${path}`, { path, kind: found.kind });
    } catch {
      // the next read examines the file again
    }
  }
  return found;
};

const examine = async (path: string, ports: HostPorts): Promise<DiscoveryRead> => {
  let text: string | null;
  try {
    text = await ports.files.read(path);
  } catch (error) {
    return { kind: "malformed", problem: `the read failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (text === null) return { kind: "absent" };
  const record = parseDiscovery(text);
  if (typeof record === "string") return { kind: "malformed", problem: record };
  const mark = { pid: record.pid, startedAt: Date.parse(record.startedAt) };
  if (await sameProcess(mark, ports)) return { kind: "running", record };
  const why = ports.processes.alive(record.pid)
    ? `the process ${record.pid} started after the record, thus it is a different process`
    : `the process ${record.pid} stopped`;
  return { kind: "stale", record, why };
};

/** This function removes a discovery file when it names the process `pid`, by default the process of the host. It tells if it removed the file. */
export const removeDiscovery = async (path: string, ports: HostPorts, pid: number = ports.self.pid): Promise<boolean> => {
  try {
    const text = await ports.files.read(path);
    if (text === null) return false;
    const record = parseDiscovery(text);
    if (typeof record === "string" || record.pid !== pid) return false;
    await ports.files.remove(path);
    return true;
  } catch {
    return false;
  }
};
