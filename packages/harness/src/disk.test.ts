import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiskFault } from "@mark1russell7/rigor-chaos";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DISK_RECORD_FORMAT,
  diskRecordProblems,
  diskSubjectProblems,
  folderDigest,
  openDiskLab,
  runDiskFault,
  type DiskLab,
  type DiskRecord,
  type DiskSubject,
} from "./disk.ts";
import type { BuildRecord } from "./image.ts";
import { DIRTY } from "./pins.ts";

/**
 * The disk tier on Docker, opt-in: `HARNESS_DISK=1`. It needs Docker and privileged containers, thus only the workflow
 * `disk.yml` starts it. `HARNESS_DISK_OUT` names a folder for the record of each case.
 */
const RUN = process.env["HARNESS_DISK"] === "1";
const OUT = process.env["HARNESS_DISK_OUT"] || undefined;

/** The self-test subject: a writer that writes each line to one file with an fsync, and to a second file with none. */
const FOLDER = fileURLToPath(new URL("./disk-subject", import.meta.url));
const SUBJECT: DiskSubject = {
  name: "self-test",
  folder: FOLDER,
  writer: ["node", "/opt/subject/writer.mts"],
  check: ["node", "/opt/subject/check.mts"],
};

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TAG = "loom-harness-lazyfs:0123456789ab";
const BUILD: BuildRecord = { tag: TAG, bases: [`node:24.21.0-bookworm-slim@sha256:${"a".repeat(64)}`], locks: {}, versions: {} };

const folders: string[] = [];
const folderWith = (files: Readonly<Record<string, string>>): string => {
  const folder = mkdtempSync(join(tmpdir(), "harness-disk-"));
  folders.push(folder);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(folder, path, ".."), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  return folder;
};
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

describe("the subject of the disk tier", () => {
  it("takes a folder with a writer and a check", () => {
    expect(diskSubjectProblems(SUBJECT)).toEqual([]);
    expect(diskSubjectProblems({ ...SUBJECT, env: { DISK_STEPS: "3" }, timeoutMs: 5_000 })).toEqual([]);
  });

  it("names each problem of a subject: no name, no folder, an empty argv and a time that is not positive", () => {
    expect(diskSubjectProblems({ ...SUBJECT, name: "", folder: join(FOLDER, "nope") })).toEqual([
      "the subject has no name",
      `the folder ${join(FOLDER, "nope")} of the subject is not a folder`,
    ]);
    expect(diskSubjectProblems({ ...SUBJECT, writer: [] as never, check: [""] as never, timeoutMs: 0 })).toEqual([
      "the writer is not an argv: a list of one or more texts",
      "the check is not an argv: a list of one or more texts",
      "the timeoutMs of the subject is a positive number of ms, not 0",
    ]);
  });

  it("refuses a subject with problems before it builds an image", async () => {
    await expect(openDiskLab({ subject: { ...SUBJECT, name: "" }, code: { commit: COMMIT, dirty: false } })).rejects.toThrow(
      new RangeError("openDiskLab: the subject has no name"),
    );
  });
});

describe("the digest of a subject folder", () => {
  it("gives the same digest for the same paths and contents, and a new one for a change of a content or a path", () => {
    const one = folderDigest(folderWith({ "writer.mts": "a", "lib/check.mts": "b" }));
    expect(one).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(folderDigest(folderWith({ "lib/check.mts": "b", "writer.mts": "a" }))).toBe(one);
    expect(folderDigest(folderWith({ "writer.mts": "a", "lib/check.mts": "c" }))).not.toBe(one);
    expect(folderDigest(folderWith({ "writer.mts": "a", "lib/other.mts": "b" }))).not.toBe(one);
  });

  it("does not read the output of a local build or the packages of the folder", () => {
    const plain = folderDigest(folderWith({ "writer.mts": "a" }));
    expect(folderDigest(folderWith({ "writer.mts": "a", "node_modules/x/index.js": "x", "target/out": "y" }))).toBe(plain);
  });
});

describe("the pins of a disk record", () => {
  const record = { code: { commit: COMMIT, dirty: false }, image: { tag: TAG, build: BUILD } };

  it("takes a record with a commit, a clean checkout and an image with its build record", () => {
    expect(diskRecordProblems(record)).toEqual([]);
  });

  it("refuses a record with no commit, a checkout with changes, or an image with no build record", () => {
    expect(diskRecordProblems({ ...record, code: undefined })).toEqual(["the record has no commit of the code that operated"]);
    expect(diskRecordProblems({ ...record, code: { commit: COMMIT, dirty: true } })).toEqual([DIRTY]);
    expect(diskRecordProblems({ ...record, image: { tag: TAG } })).toEqual([`the image lazyfs: the image ${TAG} is a build with no build record`]);
    expect(diskRecordProblems({ ...record, image: { tag: TAG, build: { ...BUILD, tag: "loom-harness-lazyfs:ba9876543210" } } })).toEqual([
      `the image lazyfs: the build record has the tag loom-harness-lazyfs:ba9876543210, not the tag of the image ${TAG}`,
    ]);
  });
});

describe("a fault of the disk tier", () => {
  it("refuses a fault with problems before it starts a container", async () => {
    const lab: DiskLab = {
      subject: SUBJECT,
      digest: folderDigest(FOLDER),
      image: { tag: TAG, build: BUILD },
      code: { commit: COMMIT, dirty: false },
      substrate: {} as DiskLab["substrate"],
    };
    await expect(runDiskFault(lab, { kind: "lose-unsynced", at: { step: -1 } })).rejects.toThrow(RangeError);
    await expect(runDiskFault(lab, { kind: "torn" as never, at: { step: 1 } })).rejects.toThrow(RangeError);
  });
});

/** One case of the self-test: a fault, the environment of the writer, and the result that the gate expects. */
interface SelfTest {
  readonly name: string;
  readonly fault: DiskFault;
  readonly env?: Readonly<Record<string, string>>;
  readonly writer: { readonly exit: number; readonly stopped: boolean; readonly steps?: number; readonly lastStep?: number };
  /** The count of the lines that the disk kept of `synced.log`. A fault at a time gives the count of the stop points, or one more. */
  readonly synced: number | "steps";
  /** The count of the lines that the disk kept of `unsynced.log`. The writer made none of them durable. */
  readonly unsynced: number;
}

/** The self-test as data. The writer writes 8 steps by default, and the check counts the lines that the disk kept. */
const SELF_TEST: readonly SelfTest[] = [
  {
    name: "a power cut at the step 3 keeps the 4 synced lines, and none of the lines with no fsync",
    fault: { kind: "lose-unsynced", at: { step: 3 } },
    writer: { exit: 137, stopped: true, steps: 4, lastStep: 3 },
    synced: 4,
    unsynced: 0,
  },
  {
    name: "a power cut after the end of the writer: its close made no line durable",
    fault: { kind: "lose-unsynced", at: { step: 50 } },
    writer: { exit: 0, stopped: false, steps: 8, lastStep: 7 },
    synced: 8,
    unsynced: 0,
  },
  {
    name: "a power cut at 1500 ms keeps each synced line up to the stop",
    fault: { kind: "lose-unsynced", at: { ms: 1500 } },
    env: { DISK_STEPS: "1000", DISK_PAUSE_MS: "20" },
    writer: { exit: 137, stopped: true },
    synced: "steps",
    unsynced: 0,
  },
];

/** This function gives each difference between the record of a case and the result that the case expects. */
const selfTestProblems = (record: DiskRecord, expected: SelfTest): string[] => {
  const persisted = record.persisted as { readonly synced: number | null; readonly unsynced: number | null };
  const { writer } = record;
  const problems: string[] = [];
  if (writer.exit !== expected.writer.exit) problems.push(`the writer ended with ${writer.exit}, not ${expected.writer.exit}`);
  if (writer.stopped !== expected.writer.stopped) problems.push(`the writer stopped: ${writer.stopped}, not ${expected.writer.stopped}`);
  if (expected.writer.steps !== undefined && writer.steps !== expected.writer.steps) problems.push(`the writer got to ${writer.steps} stop points, not ${expected.writer.steps}`);
  if (expected.writer.lastStep !== undefined && writer.lastStep !== expected.writer.lastStep) problems.push(`the last step is ${writer.lastStep}, not ${expected.writer.lastStep}`);
  const synced = persisted.synced;
  const syncedOk = expected.synced === "steps" ? synced !== null && synced >= writer.steps && synced <= writer.steps + 1 && writer.steps > 0 : synced === expected.synced;
  if (!syncedOk) problems.push(`the disk kept ${synced} synced lines, not ${expected.synced === "steps" ? `${writer.steps} or ${writer.steps + 1}` : expected.synced}`);
  if (persisted.unsynced !== expected.unsynced) problems.push(`the disk kept ${persisted.unsynced} lines with no fsync, not ${expected.unsynced}`);
  return problems;
};

const git = (args: readonly string[]): string => execFileSync("git", [...args], { cwd: FOLDER, encoding: "utf8" }).trim();

describe.skipIf(!RUN)("the disk tier on Docker (HARNESS_DISK=1)", () => {
  const labs = new Map<string, DiskLab>();
  beforeAll(async () => {
    const code = { commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain", "--untracked-files=no"]) !== "" };
    for (const each of SELF_TEST) {
      const key = JSON.stringify(each.env ?? {});
      if (!labs.has(key)) labs.set(key, await openDiskLab({ subject: { ...SUBJECT, ...(each.env === undefined ? {} : { env: each.env }) }, code }));
    }
    if (OUT !== undefined) mkdirSync(OUT, { recursive: true });
  }, 900_000);

  for (const [index, each] of SELF_TEST.entries()) {
    it(each.name, async () => {
      const record = await runDiskFault(labs.get(JSON.stringify(each.env ?? {}))!, each.fault);
      if (OUT !== undefined) writeFileSync(join(OUT, `case-${index}.json`), `${JSON.stringify(record, null, 2)}\n`);
      expect(record.format).toBe(DISK_RECORD_FORMAT);
      expect(record.image.id).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(diskRecordProblems(record)).toEqual([]);
      expect(selfTestProblems(record, each)).toEqual([]);
    }, 180_000);
  }
});
