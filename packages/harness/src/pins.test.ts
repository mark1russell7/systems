import { describe, expect, it } from "vitest";
import type { BuildRecord } from "./image.ts";
import type { Manifest } from "./lab.ts";
import { commitProblems, DEBUG, DIRTY, imagePinProblems, manifestProblems, recordProblems } from "./pins.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const ID = `sha256:${"b".repeat(64)}`;
const REDIS = `redis:7.4.11@${DIGEST}`;
const BASE = `node:24.21.0-alpine@${DIGEST}`;

const buildOf = (tag: string, bases: readonly string[] = [BASE]): BuildRecord => ({
  tag,
  bases,
  locks: { "harness/image/node/npm-lock.json": "c".repeat(64) },
  versions: { ioredis: "6.0.0" },
});

/** This manifest pins each program of its run: the target by its digest, and the builds of the harness and the client. */
const pinned: Manifest = {
  kernel: "6.17.0-1010-azure",
  architecture: "x86_64",
  hz: "1000",
  boot_id: "boot",
  docker: "29.1.5 on Ubuntu 24.04",
  target: { image: REDIS, id: ID, settings: {}, sysctls: {} },
  harness: { image: "loom-harness:0123456789ab", id: ID, packages: [], version: "0.15.0", build: buildOf("loom-harness:0123456789ab") },
  client: { kind: "ioredis", image: "loom-harness-node:0123456789ab", source: { kind: "shipped", name: "node" }, build: buildOf("loom-harness-node:0123456789ab") },
  netns: { client: 1, target: 2 },
  sysctls: {},
};

describe("the pins of a manifest", () => {
  it("gives no problem for a manifest that pins each program", () => {
    expect(manifestProblems(pinned)).toEqual([]);
  });

  it("refuses a target by its tag, with no digest", () => {
    expect(manifestProblems({ ...pinned, target: { ...pinned.target, image: "redis:7.4" } })).toEqual(["the target: the image redis:7.4 has no digest"]);
  });

  it("refuses a subject with no build record, or with a base that no digest pins", () => {
    const subject = { kind: "build", name: "procedures-subject", context: "client" } as const;
    const target = { ...pinned.target, image: "procedures-subject:0123456789ab", subject, base: BASE };
    expect(manifestProblems({ ...pinned, target })).toEqual(["the target: the image procedures-subject:0123456789ab is a build with no build record"]);
    expect(manifestProblems({ ...pinned, target: { ...target, build: buildOf(target.image) } })).toEqual([]);
    expect(manifestProblems({ ...pinned, target: { ...target, base: "node:24-alpine", build: buildOf(target.image) } })).toEqual([
      "the target: the base node:24-alpine of its subject is not pinned by digest",
    ]);
  });

  it("refuses a harness or a client without its build record or its version: the old form of a manifest", () => {
    const { version: _version, build: _build, ...harness } = pinned.harness;
    const { build: _client, ...client } = pinned.client;
    expect(manifestProblems({ ...pinned, harness, client })).toEqual([
      "the harness: the manifest has no version of the harness",
      "the harness: the image has no build record",
      "the client: the image loom-harness-node:0123456789ab is a build with no build record",
    ]);
  });

  it("refuses a build with a base that no digest pins", () => {
    const client = { ...pinned.client, build: buildOf(pinned.client.image, ["node:24-alpine"]) };
    expect(manifestProblems({ ...pinned, client })).toEqual(["the client: the base node:24-alpine is not pinned by digest"]);
  });

  it("takes a hop by its digest, or by the tag of a build and the id of its image", () => {
    const hop = { name: "r1", kind: "router" as const, image: "loom-harness-router:0123456789ab", id: ID, settings: {}, sysctls: {} };
    expect(manifestProblems({ ...pinned, hops: [hop] })).toEqual([]);
    expect(manifestProblems({ ...pinned, hops: [{ ...hop, image: "toxiproxy:2.12.0" }] })).toEqual(["the hop r1: the image toxiproxy:2.12.0 has no digest"]);
  });
});

describe("the pins of one image outside a manifest", () => {
  it("takes an image by its digest, or a build with its build record", () => {
    expect(imagePinProblems("the image redis", REDIS, undefined)).toEqual([]);
    expect(imagePinProblems("the image lab", "systems-kind-lab:0123456789ab", buildOf("systems-kind-lab:0123456789ab"))).toEqual([]);
  });

  it("refuses a tag with no digest, a build with no build record, and the build record of another tag", () => {
    expect(imagePinProblems("the image redis", "redis:7.4", undefined)).toEqual(["the image redis: the image redis:7.4 has no digest"]);
    expect(imagePinProblems("the image lab", "systems-kind-lab:0123456789ab", undefined)).toEqual([
      "the image lab: the image systems-kind-lab:0123456789ab is a build with no build record",
    ]);
    expect(imagePinProblems("the image lab", "systems-kind-lab:0123456789ab", buildOf("systems-kind-lab:ba9876543210"))).toEqual([
      "the image lab: the build record has the tag systems-kind-lab:ba9876543210, not the tag of the image systems-kind-lab:0123456789ab",
    ]);
  });

  it("refuses a build with a base that no digest pins", () => {
    expect(imagePinProblems("the image lab", "systems-kind-lab:0123456789ab", buildOf("systems-kind-lab:0123456789ab", ["node:24-alpine"]))).toEqual([
      "the image lab: the base node:24-alpine is not pinned by digest",
    ]);
  });
});

describe("the commit of a record", () => {
  it("takes 40 hex digits, and refuses no commit or another text", () => {
    expect(commitProblems("0123456789abcdef0123456789abcdef01234567")).toEqual([]);
    expect(commitProblems(undefined)).toEqual(["the record has no commit of the code that operated"]);
    expect(commitProblems("HEAD")).toEqual(["the record has the commit HEAD, which is not 40 hex digits"]);
  });
});

describe("the problems of a record", () => {
  const code = { commit: "0123456789abcdef0123456789abcdef01234567", dirty: false };

  it("gives no problem for a clean commit and manifests that pin each program", () => {
    expect(recordProblems({ code, manifests: [pinned, pinned] })).toEqual([]);
  });

  it("refuses the tag redis:7.4 with no digest", () => {
    const tagged = { ...pinned, target: { ...pinned.target, image: "redis:7.4" } };
    expect(recordProblems({ code, manifests: [pinned, tagged] })).toEqual(["the target: the image redis:7.4 has no digest"]);
  });

  it("refuses a commit with changes: dirty is not a pin", () => {
    expect(recordProblems({ code: { ...code, dirty: true }, manifests: [pinned] })).toEqual([DIRTY]);
  });

  it("refuses a record with no commit: the old form, with no pin", () => {
    expect(recordProblems({ manifests: [pinned] })).toEqual(["the record has no commit of the code that operated"]);
  });

  it("refuses the record of a local debug run, and gives each problem once", () => {
    const tagged = { ...pinned, target: { ...pinned.target, image: "redis:7.4" } };
    expect(recordProblems({ code: { ...code, dirty: true }, manifests: [tagged, tagged], debug: true })).toEqual([
      DIRTY,
      "the target: the image redis:7.4 has no digest",
      DEBUG,
    ]);
  });
});
