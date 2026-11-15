import { DIRTY } from "@mark1russell7/harness";
import { describe, expect, it } from "vitest";
import type { KindCell, KindRun } from "./cell.ts";
import type { Line } from "./lab.ts";
import { cellOf } from "./cells.fixture.ts";
import type { KindPinnable } from "./held.ts";
import { KIND_FAULT_OUTCOME, faultedKind, kindRecordProblems } from "./held.ts";
import { judgeKind } from "./verdict.ts";

const NODE = `kindest/node:v1.37.0@sha256:${"a".repeat(64)}`;
const REDIS = `redis:7.4@sha256:${"c".repeat(64)}`;
const LAB = "systems-kind-lab:d2c858b375a9";
const BUILD = { tag: LAB, bases: [`node:24-bookworm-slim@sha256:${"d".repeat(64)}`], locks: { "pnpm-lock.yaml": "e".repeat(64) }, versions: {} };
const COMMIT = "b".repeat(40);

type Manifest = KindPinnable["manifests"][number];
/** This function gives the manifest of one cluster, with the images and the build records that it gets. */
const manifestOf = (images: Record<string, string>, builds?: Manifest["builds"]): Manifest =>
  ({ env: 0, cluster: { nodeImage: NODE }, images, ...(builds === undefined ? {} : { builds }) }) as unknown as Manifest;
const pinned: KindPinnable = { code: { commit: COMMIT, dirty: false }, manifests: [manifestOf({ lab: LAB, redis: REDIS }, { lab: BUILD })] };

describe("the pins of a kind record", () => {
  it("gives no problem for a record of a clean commit, with each image by digest or by a build with its record", () => {
    expect(kindRecordProblems(pinned)).toEqual([]);
  });

  it("gives each problem of a record from before SYS-99", () => {
    const old: KindPinnable = { manifests: [manifestOf({ lab: LAB, redis: "systems-lab/redis:7.4-c6eabf748fc7" })] };
    expect(kindRecordProblems(old)).toEqual([
      "the record has no commit of the code that operated",
      `the image lab: the image ${LAB} is a build with no build record`,
      "the image redis: the image systems-lab/redis:7.4-c6eabf748fc7 has no digest",
    ]);
  });

  it("refuses a checkout with changes to tracked files", () => {
    expect(kindRecordProblems({ ...pinned, code: { commit: COMMIT, dirty: true } })).toEqual([DIRTY]);
  });

  it("refuses an image by a tag with no digest, and a build record of another tag", () => {
    expect(kindRecordProblems({ ...pinned, manifests: [manifestOf({ lab: LAB, redis: "redis:7.4" }, { lab: BUILD })] })).toEqual([
      "the image redis: the image redis:7.4 has no digest",
    ]);
    expect(kindRecordProblems({ ...pinned, manifests: [manifestOf({ lab: "systems-kind-lab:0123456789ab", redis: REDIS }, { lab: BUILD })] })).toEqual([
      `the image lab: the build record has the tag ${LAB}, not the tag of the image systems-kind-lab:0123456789ab`,
    ]);
  });

  it("gives each problem one time, when each cluster has it", () => {
    const old = manifestOf({ lab: LAB, redis: REDIS });
    expect(kindRecordProblems({ ...pinned, manifests: [old, old] })).toEqual([`the image lab: the image ${LAB} is a build with no build record`]);
  });
});

const request = (t: number, o: string): Line => ({ ev: "req", t, d: 1, o, p: "client-w1", n: "w1" });
const TARGET = { pod: "lab-a", node: "w1", ip: "10.244.1.3", version: "h1" };
/** This function gives a run with a fault at 1000 ms. It has a request before the fault, and a request and a line of the rules after it. */
const runOf = (warmup: boolean, voided: string | null = null): KindRun => ({
  env: 0,
  index: 0,
  warmup,
  start: 0,
  end: 60_000,
  acts: { fault: 1000, heal: null, resume: null },
  target: TARGET,
  paused: "w1",
  replicas: [TARGET],
  void: voided,
  dropped: {},
  lines: [request(500, "ok"), { ev: "rules", t: 1100, prev: 1050, node: "w1", b: ["10.244.1.3:8080"] }, request(2000, "ok")],
});

describe("the injected fault of the flip test", () => {
  const none: KindCell = { ...cellOf("pod-deletion"), prediction: { kind: "none", why: "a test" } };

  it("fails each request from the fault of each counted run, and removes each other line from the fault", () => {
    const [run] = faultedKind(none, [runOf(false)]);
    expect(run!.lines).toEqual([request(500, "ok"), request(2000, KIND_FAULT_OUTCOME)]);
  });

  it("leaves a warm-up and a void run as they are", () => {
    const warm = runOf(true);
    const voided = runOf(false, "not at rest");
    expect(faultedKind(none, [warm, voided])).toEqual([warm, voided]);
  });

  it("turns a cell that holds into a cell that fails", () => {
    const runs = [runOf(true), runOf(false), runOf(false)];
    expect(judgeKind(none, runs).decision).toBe("holds");
    expect(judgeKind(none, faultedKind(none, runs)).decision).toBe("fails");
  });

  it("takes the first outcome that a prediction of no failure excludes by name", () => {
    const named: KindCell = { ...none, prediction: { kind: "none", why: "a test", outcomes: ["reset"] } };
    const [run] = faultedKind(named, [runOf(false)]);
    expect(run!.lines.at(-1)).toEqual(request(2000, "reset"));
  });
});
