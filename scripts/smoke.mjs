// The smoke test of a release: the tarballs that pack.mjs wrote, as an application gets them.
//
//   node scripts/smoke.mjs <folder>
//
// 1. Each tarball holds the files that its package reads at run time, other than build/.
// 2. An empty project installs all the tarballs from disk, with their other dependencies from npm.
//    Each @mark1russell7 package resolves to its tarball, because npm does not have a new version yet.
// 3. Each package imports from the built JavaScript, and a few functions give their known results.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const folder = process.argv[2];
if (folder === undefined) {
  process.stderr.write("usage: node scripts/smoke.mjs <folder>\n");
  process.exit(2);
}
const shell = process.platform === "win32";
const releases = readFileSync(join(folder, "packages.txt"), "utf8")
  .trim()
  .split("\n")
  .map((line) => {
    const [name, version, file] = line.split(" ");
    return { name, version, tarball: resolve(folder, file) };
  });

let failures = 0;
const check = (ok, what) => {
  process.stdout.write(`${ok ? "ok" : "FAIL"}  ${what}\n`);
  if (!ok) failures += 1;
};

// 1. the files that each package reads at run time: the harness builds its images from these
const NEEDS = {
  "@mark1russell7/prober": [
    "bpf/prober.bpf.c",
    "bpf/prober.h",
    "native/Cargo.toml",
    "native/Cargo.lock",
    "native/src/lib.rs",
    "native/src/record.rs",
    "native/src/bin/prober.rs",
    "fixtures/records.bin",
  ],
  "@mark1russell7/harness": [
    "image/Dockerfile",
    "image/native/Cargo.toml",
    "image/native/Cargo.lock",
    "image/native/src/bin/client.rs",
    "image/native/src/bin/inject.rs",
    "image/node/Dockerfile",
    "image/node/client-ioredis.mjs",
    "image/node/package.json",
    "image/node/npm-lock.json",
  ],
};
/** the paths in a gzipped tar file, read with zlib: each entry has a 512-byte ustar header */
const entries = (tarball) => {
  const tar = gunzipSync(readFileSync(tarball));
  const paths = [];
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (from, to) => header.subarray(from, to).toString("utf8").replace(/\0.*$/s, "");
    const prefix = text(345, 500);
    paths.push(prefix === "" ? text(0, 100) : `${prefix}/${text(0, 100)}`);
    const size = parseInt(text(124, 136).trim() || "0", 8);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return paths;
};
for (const { name, tarball } of releases) {
  const listed = new Set(entries(tarball).map((path) => path.replace(/^package\//, "")));
  for (const file of ["package.json", "README.md", "LICENSE", "build/index.js", "build/index.d.ts"])
    check(listed.has(file), `${name} holds ${file}`);
  for (const file of NEEDS[name] ?? []) check(listed.has(file), `${name} holds ${file}`);
}

// 2. an empty project installs the tarballs
const project = mkdtempSync(join(tmpdir(), "smoke-"));
const tarballs = Object.fromEntries(
  releases.map(({ name, tarball }) => [name, `file:${tarball.replaceAll("\\", "/")}`]),
);
writeFileSync(
  join(project, "package.json"),
  JSON.stringify(
    { name: "smoke", private: true, type: "module", dependencies: { ...tarballs, zod: "^4.1.0" } },
    null,
    2,
  ),
);
writeFileSync(
  join(project, "pnpm-workspace.yaml"),
  [
    "overrides:",
    ...Object.entries(tarballs).map(([name, spec]) => `  "${name}": "${spec}"`),
    // Testcontainers reaches Docker through ssh2, which needs none of these install scripts
    "allowBuilds:",
    "  cpu-features: false",
    "  protobufjs: false",
    "  ssh2: false",
    "",
  ].join("\n"),
);
try {
  execFileSync("pnpm", ["install"], { cwd: project, stdio: "inherit", shell });
  check(true, "an empty project installs the tarballs");

  // 3. each package imports, and gives known results
  // through the exports of the packed manifest, as an import in the project resolves it
  const resolveIn = createRequire(join(project, "package.json")).resolve;
  const load = (name) => import(pathToFileURL(resolveIn(name)).href);
  const s = (value) => ({ value, unit: "s" });
  for (const { name } of releases) {
    const module = await load(name);
    check(Object.keys(module).length > 0, `${name} imports`);
    if (name === "@mark1russell7/quantity") {
      check(module.format(module.quantity(7875, "s")) === "7,875 s", "quantity formats 7875 s");
      check(
        module.format(module.convert(module.quantity(7875, "s"), "min")) === "131.25 min",
        "quantity converts 7875 s to 131.25 min exactly",
      );
    }
    if (name === "@mark1russell7/service") {
      const svc = module
        .service("app")
        .dependency("db", { system: null, knobs: { request_timeout: s(10) }, operations: {} })
        .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
        .liveness({ type: "window", failAfter: s(45) })
        .startup(s(60))
        .phase("drain", s(15))
        .cooperativeWindow(s(5));
      check(svc.describe().format === module.FORMAT, "service describes a declaration");
      const latch = { type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 };
      const span = module.failSpan(latch, { interval: s(5), jitter: 0.2, timeout: s(4) });
      check(span.min.value === 8 && span.max.value === 18, "service gives a latch 8–18 s to fail");
      // the health runtime, on the fake clock of the testing subpath
      const testing = await load("@mark1russell7/service/testing");
      const clock = testing.fakeClock();
      const step = testing.scriptedCheck("ok");
      const poll = { interval: s(5), jitter: 0.2, timeout: s(4) };
      const live = module
        .service("live")
        .check({ name: "x", dependency: null, step: "round-trip", ownConnection: true, gates: "readiness", poll }, step.run)
        .readiness(latch)
        .liveness({ type: "window", failAfter: s(45) })
        .startup(s(60))
        .phase("drain", s(15))
        .cooperativeWindow(s(5));
      const health = await live.start({ clock, random: testing.seeded(1) });
      check(health.probe("readiness").status === 200, "service starts its health runtime, and it is ready");
      step.behavior = "error";
      await clock.advance(18_000);
      check(health.probe("readiness").status === 503, "service fails readiness inside 18 s of a failing check");
      health.stop();
    }
    if (name === "@mark1russell7/prober")
      check(module.RECORD_KINDS.length === 14, "prober has 14 record kinds");
    if (name === "@mark1russell7/algebra") {
      const node = module.parseExpr("idle + interval * probes");
      check(typeof node === "object" && node !== null, "algebra parses an expression of a timer");
      const old = module.machineSchema.safeParse({ format: "jarvis.machine/1" });
      check(old.success === false, "algebra refuses a machine document of another format");
    }
    if (name === "@mark1russell7/harness") {
      const verdict = module.verdictOf({ detects: false, window: s(1) }, []);
      check(verdict.decision === "inconclusive", "harness judges no runs as inconclusive");
    }
  }
} catch (error) {
  check(false, `the install or an import: ${error.message}`);
} finally {
  rmSync(project, { recursive: true, force: true });
}

if (failures > 0) {
  process.stderr.write(`${failures} checks failed\n`);
  process.exit(1);
}
process.stdout.write("all checks passed\n");
