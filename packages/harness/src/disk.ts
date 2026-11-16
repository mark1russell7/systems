import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { checkDiskFault, stopTriggerOf, type DiskFault } from "@mark1russell7/rigor-chaos";
import { STOP_ENV, parseProgress, stopOrderOf } from "@mark1russell7/rigor-testkit/stop";
import { buildRecordOf, imageOf, shippedSource, sources, type BuildRecord } from "./image.ts";
import { STOP, containers } from "./lab.ts";
import { DIRTY, commitProblems, imagePinProblems, type RecordCode } from "./pins.ts";
import { substrateHere, type Substrate } from "./substrate.ts";

/**
 * The disk tier applies a disk plan of `@mark1russell7/rigor-chaos` to the files of a program. Each fault starts one new
 * container of the shipped image `lazyfs`. LazyFS is a FUSE file system that keeps each write in its cache until an
 * fsync. The writer of the subject writes its files on the mount of LazyFS, and the fault stops it at its point. Then
 * `lazyfs::clear-cache` loses each write after the last fsync: the state of the disk after a power cut. The check of
 * the subject reads the files that the disk kept, and writes one JSON value. The record keeps that value.
 *
 * A point at a step uses the stop points of `@mark1russell7/rigor-testkit/stop` in the writer: the writer stops itself
 * at the step with `SIGKILL`. A point at a time stops the writer with `SIGKILL` after that time from its start.
 *
 * The container is privileged: it needs `/dev/fuse` and a mount, and the AppArmor profile of Docker refuses a FUSE mount
 * in a container that is not privileged. Thus the tier operates only in CI, in the workflow `disk.yml`.
 */

/** The folder of the subject in the container. */
export const DISK_SUBJECT = "/opt/subject";
/** The mount of LazyFS in the container. The writer operates in this folder. */
export const DISK_MOUNT = "/mnt/disk";
/** The folder that holds the files under the mount. The check operates in this folder after the fault. */
export const DISK_ROOT = "/var/disk";
/** The format of a record of the disk tier. */
export const DISK_RECORD_FORMAT = "harness-disk/1";

const FAULTS = "/run/lazyfs/faults.fifo";
const DONE = "/run/lazyfs/done.fifo";
const PROGRESS = "/tmp/rigor-progress.jsonl";
/** The default time in ms for the writer of a fault at a step. */
const WRITER_MS = 60_000;
/** The time in s for the clear of the cache. */
const CLEAR_S = 30;
/** The output of the writer in a record holds this number of the last characters. */
const OUTPUT_LIMIT = 4_000;

/** The subject of the disk tier: a folder with a writer and a check. */
export interface DiskSubject {
  /** The name of the subject, for the record. */
  readonly name: string;
  /** The folder of the subject on this machine. The tier copies it to `DISK_SUBJECT` in each container. */
  readonly folder: string;
  /** The argv of the writer, with no shell. It operates in `DISK_MOUNT`. An example is `["node", "/opt/subject/writer.mjs"]`. */
  readonly writer: readonly [string, ...string[]];
  /** The argv of the check, with no shell. It operates in `DISK_ROOT` after the fault, and writes one JSON value. */
  readonly check: readonly [string, ...string[]];
  /** The variables of the environment of the writer and of the check. */
  readonly env?: Readonly<Record<string, string>>;
  /** The time in ms for the writer of a fault at a step. The default is 60 000. After it, the writer gets `SIGKILL`. */
  readonly timeoutMs?: number;
}

/** The options of `openDiskLab`. */
export interface DiskLabOptions {
  readonly subject: DiskSubject;
  /** The commit of the code that operates, and if its tracked files have changes. The record keeps it. */
  readonly code: RecordCode;
}

/** The image of the disk tier: its tag, and the record of its build. */
export interface DiskImage {
  readonly tag: string;
  readonly build?: BuildRecord;
}

/** A disk lab holds the parts of each run that do not change from one fault to the next. */
export interface DiskLab {
  readonly subject: DiskSubject;
  /** The sha256 of the path and the content of each file of the subject folder. */
  readonly digest: string;
  readonly image: DiskImage;
  readonly code: RecordCode;
  readonly substrate: Substrate;
}

/** The record of the writer of one fault. */
export interface DiskWriterRecord {
  /** The exit code of the writer. A stop with `SIGKILL` gives 137. */
  readonly exit: number;
  /** This value is `true` when the fault stopped the writer at its point. A writer that ends first gives `false`. */
  readonly stopped: boolean;
  /** The number of the stop points that the writer got to. */
  readonly steps: number;
  /** The last stop point that the writer got to, or `null` when it got to no point. */
  readonly lastStep: number | null;
  readonly lastLabel: string | null;
  /** The time in ms from the start of the writer to its end. */
  readonly ms: number;
  /** The last characters of the output of the writer. */
  readonly output: string;
}

/** The record of one fault of a disk plan. */
export interface DiskRecord {
  readonly format: typeof DISK_RECORD_FORMAT;
  readonly fault: DiskFault;
  readonly subject: { readonly name: string; readonly digest: string };
  /** The image: its tag, the id of the image of the container, and the record of its build. */
  readonly image: DiskImage & { readonly id: string };
  readonly code: RecordCode;
  readonly substrate: Substrate;
  readonly writer: DiskWriterRecord;
  /** The JSON value that the check wrote: what the disk kept. */
  readonly persisted: unknown;
  /** The time of the start of the run, in ISO 8601. */
  readonly at: string;
}

const isArgv = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string" && part.length > 0);

/** This function gives each problem of a subject of the disk tier. An empty list means that the subject is correct. */
export const diskSubjectProblems = (subject: DiskSubject): string[] => {
  const problems: string[] = [];
  if (typeof subject.name !== "string" || subject.name.length === 0) problems.push("the subject has no name");
  if (typeof subject.folder !== "string" || subject.folder.length === 0) problems.push("the subject has no folder");
  else if (!statSync(subject.folder, { throwIfNoEntry: false })?.isDirectory()) problems.push(`the folder ${subject.folder} of the subject is not a folder`);
  if (!isArgv(subject.writer)) problems.push("the writer is not an argv: a list of one or more texts");
  if (!isArgv(subject.check)) problems.push("the check is not an argv: a list of one or more texts");
  const timeoutMs = subject.timeoutMs;
  if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0)) problems.push(`the timeoutMs of the subject is a positive number of ms, not ${String(timeoutMs)}`);
  return problems;
};

/** This function gives the sha256 of the path and the content of each file under a folder, in a stable sequence. */
export const folderDigest = (folder: string): string => {
  const root = resolve(folder);
  const hash = createHash("sha256");
  for (const file of sources(root)) {
    hash.update(`${relative(root, file).replaceAll("\\", "/")}\n`);
    hash.update(createHash("sha256").update(readFileSync(file)).digest("hex"));
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
};

/**
 * This function builds the image `lazyfs` once, and gives the lab of a subject. It throws a `RangeError` for a subject
 * with problems. The lab reads the substrate of this machine: a container lab is the layer E1.
 */
export const openDiskLab = async (options: DiskLabOptions): Promise<DiskLab> => {
  const problems = diskSubjectProblems(options.subject);
  if (problems.length > 0) throw new RangeError(`openDiskLab: ${problems.join("; ")}`);
  const source = shippedSource("lazyfs");
  const tag = await imageOf(source);
  const build = buildRecordOf(source);
  return {
    subject: options.subject,
    digest: folderDigest(options.subject.folder),
    image: { tag, ...(build === undefined ? {} : { build }) },
    code: options.code,
    substrate: substrateHere("E1"),
  };
};

const tail = (text: string): string => text.slice(-OUTPUT_LIMIT);

/**
 * This function applies one fault of a disk plan in one new container, and gives its record. It throws a `RangeError`
 * for a fault with problems. The promise rejects when LazyFS does not clear its cache, or when the check does not end
 * with the code 0 and one JSON value. A run that cannot read the disk gives no record.
 */
export const runDiskFault = async (lab: DiskLab, fault: DiskFault): Promise<DiskRecord> => {
  const problems = checkDiskFault(fault);
  if (problems.length > 0) throw new RangeError(`runDiskFault: ${problems.join(" ")}`);
  const trigger = stopTriggerOf(fault.at);
  if (trigger === undefined) throw new RangeError(`runDiskFault: the point of the fault is not a step or a time.`);
  const at = new Date().toISOString();

  const { GenericContainer, Wait, getContainerRuntimeClient } = await containers();
  const container = await new GenericContainer(lab.image.tag)
    .withPrivilegedMode()
    .withCopyDirectoriesToContainer([{ source: resolve(lab.subject.folder), target: DISK_SUBJECT }])
    .withWaitStrategy(Wait.forSuccessfulCommand(`mountpoint -q ${DISK_MOUNT}`).withStartupTimeout(60_000))
    .start();
  try {
    const runtime = await getContainerRuntimeClient();
    const id = (await runtime.container.inspect(runtime.container.getById(container.getId()))).Image;
    const env = lab.subject.env ?? {};

    // A step goes into the order, and the writer stops itself. A time is the limit of `timeout`, which sends SIGKILL.
    const order = stopOrderOf({ at: fault.at, signal: "SIGKILL" }, PROGRESS);
    const seconds = trigger.measure === "ms" ? trigger.value / 1_000 : (lab.subject.timeoutMs ?? WRITER_MS) / 1_000;
    const started = performance.now();
    const write = await container.exec(["timeout", "-s", "KILL", String(seconds), ...lab.subject.writer], {
      workingDir: DISK_MOUNT,
      env: { ...env, [STOP_ENV]: JSON.stringify(order) },
    });
    const ms = performance.now() - started;

    // The power cut: LazyFS loses each write after the last fsync, then writes its answer to the second FIFO
    const cut = await container.exec(["sh", "-c", `printf 'lazyfs::clear-cache\\n' > ${FAULTS} && timeout ${CLEAR_S} head -n 1 ${DONE}`]);
    if (cut.exitCode !== 0 || cut.stdout.trim() !== "finished::clear-cache") {
      throw new Error(`runDiskFault: LazyFS did not clear its cache (exit ${cut.exitCode}): ${tail(cut.output.trim())}`);
    }

    const progress = await container.exec(["cat", PROGRESS]);
    const lines = parseProgress(progress.exitCode === 0 ? progress.stdout : "");
    const last = lines.at(-1);

    const check = await container.exec([...lab.subject.check], { workingDir: DISK_ROOT, env: { ...env } });
    if (check.exitCode !== 0) throw new Error(`runDiskFault: the check ended with the code ${check.exitCode}: ${tail(check.output.trim())}`);
    let persisted: unknown;
    try {
      persisted = JSON.parse(check.stdout);
    } catch (error) {
      throw new Error(`runDiskFault: the output of the check is not one JSON value: ${tail(check.stdout.trim())}`, { cause: error });
    }

    // `timeout` gives 137 when it sends SIGKILL, and the code of the writer when the writer ends first
    const stopped = trigger.measure === "step" ? lines.some((line) => line.stop === true) : write.exitCode === 137;
    return {
      format: DISK_RECORD_FORMAT,
      fault,
      subject: { name: lab.subject.name, digest: lab.digest },
      image: { ...lab.image, id },
      code: lab.code,
      substrate: lab.substrate,
      writer: {
        exit: write.exitCode,
        stopped,
        steps: lines.length,
        lastStep: last?.step ?? null,
        lastLabel: last?.label ?? null,
        ms,
        output: tail(write.output),
      },
      persisted,
      at,
    };
  } finally {
    await container.stop(STOP);
  }
};

/** These are the parts of a disk record that tell if it pins the code and the image of its run. */
export interface DiskPinnable {
  readonly code?: RecordCode | undefined;
  readonly image: DiskImage;
}

/**
 * This function gives each problem that stops a disk record from pinning its run: the commit of the code, a checkout
 * with changes, and the image with its build record. A record with a problem is not a record.
 */
export const diskRecordProblems = (record: DiskPinnable): string[] => [
  ...new Set([
    ...commitProblems(record.code?.commit),
    ...(record.code?.dirty === true ? [DIRTY] : []),
    ...imagePinProblems("the image lazyfs", record.image.tag, record.image.build),
  ]),
];
