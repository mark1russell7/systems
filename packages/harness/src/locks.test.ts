import { describe, expect, it } from "vitest";
import { SHIPPED_NAMES, buildRecordOf, planOf } from "./image.ts";
import { cargoVersions, goVersions, jarVersions, locksOf, npmVersions, versionsOf } from "./locks.ts";

const NPM_LOCK = JSON.stringify({
  name: "client",
  lockfileVersion: 3,
  packages: {
    "": { name: "client", dependencies: { ioredis: "6.0.0" }, optionalDependencies: { "fsevents-like": "1.0.0" } },
    "node_modules/ioredis": { version: "6.0.0" },
    "node_modules/denque": { version: "2.1.0" },
    "node_modules/fsevents-like": { version: "1.0.0" },
  },
});

const CARGO_LOCK = `version = 4

[[package]]
name = "app"
version = "0.1.0"
dependencies = [
 "libc",
 "rand 0.9.1",
]

[[package]]
name = "libc"
version = "0.2.190"

[[package]]
name = "rand"
version = "0.8.5"

[[package]]
name = "rand"
version = "0.9.1"
`;

describe("the lockfiles of a build context", () => {
  it("reads the direct dependencies of an npm lockfile, not the packages under them", () => {
    expect(npmVersions(NPM_LOCK)).toEqual({ ioredis: "6.0.0", "fsevents-like": "1.0.0" });
  });

  it("reads the direct dependencies of the root of a Cargo.lock: a name, or a name and a version when the lock has two", () => {
    expect(cargoVersions(CARGO_LOCK, '[package]\nname = "app"\nversion = "0.1.0"\n')).toEqual({ libc: "0.2.190", rand: "0.9.1" });
    // a lock without the package of its Cargo.toml gives no versions
    expect(cargoVersions(CARGO_LOCK, '[package]\nname = "other"\n')).toEqual({});
  });

  it("reads the direct requirements of a go.mod, in a line or a block, but not an indirect one", () => {
    expect(goVersions("module m\n\ngo 1.25.0\n\nrequire google.golang.org/grpc v1.84.0\n")).toEqual({ "google.golang.org/grpc": "v1.84.0" });
    expect(goVersions("module m\nrequire (\n\ta.dev/x v1.2.3\n\tb.dev/y v0.4.0 // indirect\n)\n")).toEqual({ "a.dev/x": "v1.2.3" });
    expect(goVersions("module m\n\ngo 1.27\n")).toEqual({});
  });

  it("reads the version of each jar from its file name", () => {
    const hex = "0".repeat(64);
    expect(jarVersions(`${hex}  HikariCP-7.1.0.jar\n${hex}  slf4j-api-2.0.17.jar\n`)).toEqual({ HikariCP: "7.1.0", "slf4j-api": "2.0.17" });
  });

  it("hashes each lockfile by its path, and reads the version of a workspace package that is not private", () => {
    const files = [
      { at: "app/npm-lock.json", content: NPM_LOCK },
      { at: "app/package.json", content: JSON.stringify({ name: "client", private: true }) },
      { at: "packages/lib/package.json", content: JSON.stringify({ name: "@scope/lib", version: "0.22.3" }) },
      { at: "app/main.mjs", content: "console.log(1)" },
    ];
    expect(Object.keys(locksOf(files))).toEqual(["app/npm-lock.json"]);
    expect(locksOf(files)["app/npm-lock.json"]).toMatch(/^[0-9a-f]{64}$/);
    expect(versionsOf(files)).toEqual({ ioredis: "6.0.0", "fsevents-like": "1.0.0", "@scope/lib": "0.22.3" });
  });
});

describe("the build record of each image that the harness ships", () => {
  it("records its tag, its bases by digest, and the sha256 of each lockfile", () => {
    for (const name of SHIPPED_NAMES) {
      const plan = planOf({ kind: "shipped", name });
      if (plan.kind !== "build") throw new Error(`${name} is not a build`);
      expect(plan.record.tag, name).toBe(plan.tag);
      expect(plan.record.bases.length, name).toBeGreaterThan(0);
      for (const base of plan.record.bases) expect(base, name).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it("names the version of each client library: the drivers on npm, the crates of the TCP client, the jars and the Go modules", () => {
    const versions = (name: (typeof SHIPPED_NAMES)[number]) => buildRecordOf({ kind: "shipped", name })?.versions;
    expect(versions("node")).toEqual({ ioredis: "6.0.0" });
    expect(versions("grpc")).toEqual({ "@grpc/grpc-js": "1.14.6" });
    expect(versions("hikari")).toMatchObject({ HikariCP: "7.1.0", postgresql: "42.7.13" });
    expect(versions("grpc-go")).toEqual({ "google.golang.org/grpc": "v1.84.0" });
    expect(Object.keys(versions("harness") ?? {})).toEqual(expect.arrayContaining(["libc", "serde_json", "prober"]));
    // each client library has a lockfile with its sha256 beside its version
    for (const name of ["node", "node-http", "mongo", "pg", "amqp", "grpc", "hikari", "harness"] as const)
      expect(Object.keys(buildRecordOf({ kind: "shipped", name })?.locks ?? {}).length, name).toBeGreaterThan(0);
  });

  it("has no build record for an image that the harness pulls", () => {
    expect(buildRecordOf("redis:7.4")).toBeUndefined();
  });
});
