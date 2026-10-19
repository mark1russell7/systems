// The smoke test of a release: the tarballs that pack.mjs wrote, as an application gets them.
//
//   node scripts/smoke.mjs <folder>
//
// 1. Each tarball holds the files that its package reads at run time, other than build/.
// 2. An empty project installs all the tarballs from disk, with their other dependencies from npm.
//    Each @mark1russell7 package resolves to its tarball, because npm does not have a new version yet.
// 3. Each package imports from the built JavaScript, and a few functions give their known results.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
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
    "build/schema.js",
    "build/schema.d.ts",
    "image/Dockerfile",
    "image/native/Cargo.toml",
    "image/native/Cargo.lock",
    "image/native/src/bin/client.rs",
    "image/native/src/bin/inject.rs",
    "image/node/Dockerfile",
    "image/node/client-ioredis.mjs",
    "image/node/client-sentinel.mjs",
    "image/node/observer.mjs",
    "image/node/package.json",
    "image/node/npm-lock.json",
    "image/go-http/Dockerfile",
    "image/go-http/go.mod",
    "image/go-http/main.go",
    "image/node-http/Dockerfile",
    "image/node-http/package.json",
    "image/node-http/npm-lock.json",
    "image/node-http/lines.mjs",
    "image/node-http/client-agent.mjs",
    "image/node-http/client-undici.mjs",
    "image/mongo/Dockerfile",
    "image/mongo/client-mongo.mjs",
    "image/mongo/stepdown-mongo.mjs",
    "image/mongo/package.json",
    "image/pg/Dockerfile",
    "image/pg/client-pg.mjs",
    "image/pg/package.json",
    "image/pg/npm-lock.json",
    "image/amqp/Dockerfile",
    "image/amqp/client-amqp.mjs",
    "image/amqp/client-cluster.mjs",
    "image/amqp/admin-cluster.mjs",
    "image/amqp/package.json",
    "image/amqp/npm-lock.json",
    "image/mongo/npm-lock.json",
    "image/procedures/Dockerfile",
    "image/procedures/package.json",
    "image/procedures/npm-lock.json",
    "image/procedures/lines.mjs",
    "image/procedures/client-ws.mjs",
    "image/procedures/server-ws.mjs",
    "image/router/Dockerfile",
    "image/router/mbx.sh",
    "image/router/ctwatch.py",
    "image/router/resetter.py",
  ],
  // the lab builds its image from these, and the judge is an entry of its own
  "@mark1russell7/kind": [
    "build/judge.js",
    "build/judge.d.ts",
    "image/Dockerfile",
    "image/package.json",
    "image/npm-lock.json",
    "image/app.mjs",
    "image/client.mjs",
    "image/agent.mjs",
    "image/watch.mjs",
    "src/compose.ts",
    "src/backends.ts",
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
        .onRepeatSignal("ignore")
        .cooperativeWindow(s(5));
      check(svc.describe().format === module.FORMAT, "service describes a declaration");
      const bound = module.serviceBindings(svc.describe(), { platform: {}, probes: { readiness: s(30), liveness: s(30) } }).bind;
      check(bound["readiness_hold@process"] === 0 && module.SERVICE_RULES.includes("O04"), "service binds the hold of fail readiness for O04");
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
        .onRepeatSignal("ignore")
        .cooperativeWindow(s(5));
      const health = await live.start({ clock, random: testing.seeded(1) });
      check(health.probe("readiness").status === 200, "service starts its health runtime, and it is ready");
      step.behavior = "error";
      await clock.advance(18_000);
      check(health.probe("readiness").status === 503, "service fails readiness inside 18 s of a failing check");
      health.stop();
      // the lifecycle: a signal, the phases, one exit, on the fake process of the testing subpath
      const process = testing.fakeProcess();
      const runClock = testing.fakeClock();
      const exits = module
        .service("exits")
        .readiness(latch)
        .liveness({ type: "window", failAfter: s(45) })
        .startup(s(60))
        .phase("fail readiness", s(1))
        .phase("drain", s(2))
        .onRepeatSignal("ignore")
        .cooperativeWindow(s(1));
      const life = await exits.run({ clock: runClock, random: testing.seeded(1), process });
      check(life.state === "running", "service runs its lifecycle");
      process.signal("SIGTERM");
      await runClock.advance(5000);
      check(process.exits.length === 1 && process.exits[0] === 0, "service shuts down in its phases on SIGTERM, and exits 0 one time");
      check(module.MACHINES.gate.format === "mark1russell7.machine/1", "service gives its machines as documents");
      // the Redis client: ioredis is an optional peer, absent here, thus the subpath must import without it
      const redis = await load("@mark1russell7/service/redis");
      const cache = redis.redisClient("cache", {
        host: "localhost",
        port: 6379,
        system: null,
        heartbeatMisses: 2,
        knobs: {
          connect_bound: s(1),
          request_timeout: s(1),
          driver_writeoff_time: s(2),
          keepalive_idle: s(5),
          heartbeat_interval: s(1),
          heartbeat_timeout: s(0.4),
          client_retry_window: s(10),
          retry_base: s(0.05),
          retry_cap: s(0.4),
          close_bound: s(0.3),
          max_connection_age: { value: "infinite", unit: "s" },
          retrans_giveup_time: s(924.6),
        },
      });
      check(cache.declaration.knobs.heartbeat_detection_time.value === 2.4, "service/redis declares its client without ioredis installed");
      check(redis.unwatched(cache.meets).length === 0, "service/redis finds each manifestation with a detector");
      // the timer entries, which a client in a browser imports without the rest of the package
      const backoffEntry = await load("@mark1russell7/service/backoff");
      const band = backoffEntry.backoffBand({ base: 50, factor: 2, cap: 400, jitter: { kind: "add", amount: 50 } });
      check(band.low === 50 && band.high === 450, "service/backoff gives the band of the Redis retry strategy: 50 to 450 ms");
      const heartbeatEntry = await load("@mark1russell7/service/heartbeat");
      const beatClock = testing.fakeClock();
      let dead = false;
      const beat = heartbeatEntry.heartbeat({ interval: 1000, timeout: 400, misses: 2, clock: beatClock, ping: () => {}, onDead: () => (dead = true) });
      await beatClock.advance(2400);
      beat.stop();
      check(dead && heartbeatEntry.detectionTime(1000, 400, 2) === 2400, "service/heartbeat finds a silent peer in 2.4 s");
      const clockEntry = await load("@mark1russell7/service/clock");
      check(typeof clockEntry.platformClock({ unref: true }).now() === "number", "service/clock gives the clock of the platform");
      // the edge of a service in Node, with no socket: the server does not listen
      const httpEntry = await load("@mark1russell7/service/http");
      const refusal = httpEntry.outcomeResponse(
        [],
        { kind: "refused", status: 503, retryable: true, cause: "the service stopped its intake", delivered: 0 },
        { keepAlive: false, retryAfter: s(1) },
      );
      check(
        refusal.status === 503 && refusal.headers["retry-after"] === "1" && refusal.headers.connection === "close",
        "service/http gives a refusal 503 with Retry-After and Connection: close",
      );
      check(
        typeof httpEntry.handle("api", "GET /work", () => "x") === "function" && httpEntry.ndjson.end({ kind: "done", delivered: 2 }) === '{"end":"done","delivered":2}\n',
        "service/http gives handle() and the NDJSON format of a stream",
      );
      const { createServer } = await import("node:http");
      const edge = httpEntry.httpTransport(createServer(), { server_idle_close: s(65), server_idle_sweep_interval: s(1), server_retry_after: s(1) });
      const buffer = edge.server.keepAliveTimeoutBuffer ?? 0;
      check(
        edge.server.keepAliveTimeout + buffer === 65000 && edge.knobs.server_idle_close_buffer.value === buffer && edge.inFlight() === 0,
        "service/http makes a server of node:http a transport, whose real idle close is server_idle_close",
      );
      const conformance = testing.transportConformance(() => ({ impl: edge, offer: async () => true, hold: async () => ({ release: async () => {}, aborted: false }) }));
      check(conformance.length === 12, "service/testing generates the 12 cases of the conformance of a transport");
      await edge.close();
    }
    if (name === "@mark1russell7/prober")
      check(module.RECORD_KINDS.length === 15 && module.RECORD_KINDS.at(-1) === "tx", "prober has 15 record kinds, the write last");
    if (name === "@mark1russell7/algebra") {
      const node = module.parseExpr("idle + interval * probes");
      check(typeof node === "object" && node !== null, "algebra parses an expression of a timer");
      const old = module.machineSchema.safeParse({ format: "jarvis.machine/1" });
      check(old.success === false, "algebra refuses a machine document of another format");
      // a window that nothing bounds: the cap less it is no bound below, which a max discards
      const doc = { title: "t", knobs: { cap: { unit: "s" }, open: { unit: "s" } } };
      const cap = module.evaluate(doc, { expr: "max(cap - open, cap / 2)", unit: "s" }, (knob) => (knob === "cap" ? s(120) : { value: "infinite", unit: "s" }));
      check(cap.value === 60, "algebra gives max(cap - infinity, cap / 2) as cap / 2");
      // the replay without zod, for a machine with its own names
      const replayEntry = await load("@mark1russell7/algebra/replay");
      const door = { id: "door", states: { shut: {}, open: {} }, transitions: [{ id: "open", from: "shut", on: "open", to: "open" }] };
      const permitted = replayEntry.replay(door, [{ instance: "d", from: "shut", on: "open", to: "open" }]);
      const refused = replayEntry.replay(door, [{ instance: "d", from: "open", on: "open", to: "open" }]);
      check(permitted.length === 0 && refused.length === 1, "algebra/replay replays a trace of a machine with its own names");
      const wait = module.evaluate(doc, { expr: "min(500 * pow(1.5, fired), 4000)", unit: "ms" }, () => undefined, 3);
      check(wait.value === 1687.5, "algebra raises to a whole power: the fourth wait of a backoff of 1.5");
    }
    if (name === "@mark1russell7/machines") {
      // the documents, read by the algebra as an application installs both
      const algebra = await load("@mark1russell7/algebra");
      const documents = Object.values(module.MACHINES);
      check(documents.length === 27 && module.MACHINES["amqplib"] === module.AMQPLIB && module.MACHINES["rabbitmq-connection"] === module.RABBITMQ_CONNECTION && module.MACHINES["aten"] === module.ATEN_DETECTOR && module.MACHINES["ra-member"] === module.RA_MEMBER && module.MACHINES["linux-tcp"] === module.LINUX_TCP && module.MACHINES["postgres-session"] === module.POSTGRES_SESSION && module.MACHINES["pgbouncer-client"] === module.PGBOUNCER_CLIENT && module.MACHINES["pgbouncer-server"] === module.PGBOUNCER_SERVER && module.MACHINES["pgpool-session"] === module.PGPOOL_SESSION && module.MACHINES["supavisor-client"] === module.SUPAVISOR_CLIENT && module.MACHINES["supavisor-server"] === module.SUPAVISOR_SERVER, "machines gives each document by its identifier");
      check(
        documents.every((doc) => algebra.machineSchema.safeParse(doc).success && algebra.machineProblems(doc).length === 0),
        "machines holds only documents that the algebra accepts",
      );
      const linux = (knob) => ({ keepidle: s(7200), keepintvl: s(75), keepcnt: { value: 9, unit: "count" } })[knob];
      check(algebra.timerOf(module.LINUX_TCP, "keepalive", linux).duration.value === 7875, "machines gives Linux TCP, whose keepalive the algebra reads as 7875 s");
      const blackhole = { name: "blackhole", passes: module.MANIFESTATIONS.blackhole };
      const idle = algebra.detection(module.LINUX_TCP, { state: "ESTABLISHED", inFlight: false }, blackhole, linux);
      check(idle.first?.timer === "keepalive", "machines lets the algebra find an idle black hole by keepalive");
      check(module.nodeLateSeconds(6, 250) === 0.007, "machines gives the lateness of a Node timer: 7 ms for 6 s at HZ 250");
    }
    if (name === "@mark1russell7/harness") {
      const verdict = module.verdictOf({ detects: false, window: s(1) }, []);
      check(verdict.decision === "inconclusive", "harness judges no runs as inconclusive");
      check(module.routesOf([{ kind: "router" }])[0].networks[0] === 1, "harness routes the network after a router through it");
      check(module.toxicBody({ type: "latency", stream: "downstream", attributes: { latency: 100 } }).includes("toxicity"), "harness writes a toxic for Toxiproxy");
      check(module.deviceOf("172.22.0.2 dev eth1 src 172.22.0.3 uid 0") === "eth1", "harness finds the device of a router toward a side");
      check(module.quantileOf([1, 2, 3, 4], 0.99) === 4 && module.spreadOf([s(0.001), s(0.003)]).median.value === 0.002, "harness gives the quantiles of a calibration");
      // a group: the peers that a partition from the group cuts, never the client
      const parts = { members: { m1: { ip: "10.0.0.2", netns: 1 }, m2: { ip: "10.0.0.3", netns: 2 } }, sentinels: { s1: { ip: "10.0.0.4", netns: 3 } } };
      check(module.peersOf(parts, "10.0.0.9", "m1", "group").join(",") === "10.0.0.3,10.0.0.4", "harness cuts a part of a group from the group only");
      check(module.STAGES.length === 8 && module.stagesOf([{ ev: "sentinel", t: 2e9, event: "+switch-master", detail: "mymaster" }], 1e9)["+switch-master"].value === 1, "harness reads the timeline of a group");
      // an HTTP client: which connection its second request went on, a retry, and its end
      const lines = [
        { ev: "ready", t: 1e9 },
        { ev: "sent", t: 7e9, i: 2 },
        { ev: "request", t: 7e9, i: 2, reused: true },
        { ev: "retry", t: 7e9, i: 2, reused: false },
        { ev: "replied", t: 7e9, i: 2 },
      ];
      const second = module.requestOf(lines);
      check(module.requestWords(second) === "reused, a retry, a reply" && second.gap.value === 6, "harness reads the second request of an HTTP client");
      // a replica set: a cut from one member in one direction, and a log line of mongod
      const set = { name: "rs0", members: ["m1", "m2"], port: 27017 };
      check(module.cutOf(set, parts.members, "10.0.0.9", "m1", "one-way").direction === "out", "harness cuts a member of a replica set from one member in one direction");
      const line = module.memberLineOf("m1", '{"t":{"$date":"2026-10-16T12:00:00.000+00:00"},"c":"REPL","id":21331,"msg":"Transition to primary complete"}');
      check(line?.id === 21331 && module.REPLICA_SET_STAGES.length === 9, "harness reads a log line of a member of a replica set");
      // a program with its own detector: its first ping without an answer, and its drop, at the kernel's stamps of the writes
      const writes = [1e9, 2e9].map((t) => ({ ev: "tx", mono: t + 1e4, cookie: 1, netns: 1, src: "a" }));
      const pings = module.pingsOf([{ ev: "ping", t: 1e9, local: "a" }], writes, "a");
      const drop = module.dropOf([{ ev: "drop", t: 2e9, local: "a" }], writes, "a");
      check(module.firstUnanswered(pings, writes)?.at === 1e9 + 1e4 && drop?.at === 2e9 + 1e4, "harness reads the heartbeat and the drop of a program");
      // a subject is data: the shipped procedures image builds from the files of the install, by the rules of a caller's build
      const plan = module.planOf(module.SUBJECTS.procedures.image);
      check(
        plan.kind === "build" && /^loom-harness-procedures:[0-9a-f]{12}$/.test(plan.tag) && plan.files.some((file) => file.at === "harness/image/procedures/server-ws.mjs"),
        "harness plans the build of its procedures subject from an install",
      );
      check(module.subjectClient(module.SUBJECTS.procedures) === "procedures-ws", "harness names the client of its procedures subject");
      const schemaEntry = await load("@mark1russell7/harness/schema");
      const pinned = { kind: "pinned", image: "ghcr.io/owner/subject:1.0.0" };
      check(
        schemaEntry.subjectSchema.safeParse(module.SUBJECTS.procedures).success && !schemaEntry.imageSourceSchema.safeParse(pinned).success,
        "harness/schema accepts a subject, and refuses an image that no digest pins",
      );
    }
    if (name === "@mark1russell7/kind") {
      const judgeEntry = await load("@mark1russell7/kind/judge");
      // a record of the format /1: the Service is empty 35 s after the fault, in a band of 28 to 49 s
      const probe = { period: s(10), threshold: 3, timeout: s(1) };
      const cell = {
        id: "T18.defaults.1",
        name: "a smoke cell",
        template: "T18",
        substitutes: null,
        mode: "iptables",
        workers: 1,
        trigger: { kind: "rst", hold: s(53) },
        pod: { replicas: 1, grace: s(30), preStop: s(0), readiness: probe, liveness: probe, startup: null },
        declaration: {
          poll: { interval: s(5), jitter: 0.2, timeout: s(4) },
          readiness: { type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 },
          liveness: { type: "window", failAfter: s(45) },
          startup: s(60),
          phases: [["fail readiness", s(2)], ["drain", s(15)]],
          cooperativeWindow: s(5),
          couplings: [],
          redis: null,
          flag: null,
          watchdog: null,
        },
        workload: { every: { value: 20, unit: "ms" }, timeout: s(1) },
        prediction: { kind: "removal", band: { lo: 28, hi: 49 }, why: "a smoke" },
        calibrates: false,
        runs: 1,
      };
      const run = {
        env: 0,
        index: 0,
        warmup: false,
        start: 0,
        end: 60_000,
        acts: { fault: 0, heal: 53_000, resume: null },
        target: null,
        paused: null,
        replicas: [],
        void: null,
        dropped: {},
        lines: [
          { ev: "slice", t: 35_000, type: "MODIFIED", name: "lab-x", svc: "lab", eps: [{ ip: "10.244.1.3", r: false }] },
          { ev: "rules", t: 35_100, prev: 35_050, node: "w1", b: [] },
        ],
      };
      const facts = { failures: 0, outcomes: {}, byNode: {}, first: null, last: null, deletion: null, intakeAfterDeletion: null, sliceAfter: null, propagation: {} };
      const record = {
        format: "systems.kind-cell-record/1",
        cell,
        runs: [run],
        manifests: [],
        loads: [],
        verdict: {
          decision: "holds",
          counted: 1,
          voided: 0,
          failed: 0,
          median: 35,
          why: "1 of 1 runs agree",
          checks: [{ ok: true, why: "the Service was empty at 35 s", value: 35, facts: { ...facts, sliceEmpty: 35, rules: { w1: 35.1 } } }],
        },
        at: "2026-10-16T00:00:00.000Z",
      };
      const upgraded = judgeEntry.readRecord(record);
      check(upgraded.format === "systems.kind-cell-record/2" && upgraded.cell.prediction.band.lo.unit === "s", "kind/judge reads a record of /1 with its band in seconds");
      check(isDeepStrictEqual(judgeEntry.judge(record), upgraded.verdict) && upgraded.verdict.median.value === 35, "kind/judge judges a record as its own verdict says");
      check(judgeEntry.kindCellRecordSchema.safeParse(upgraded).success, "kind/judge accepts its upgrade as a record of /2");
      // a new process imports the judge, and a hook of the resolver writes each module that it loads
      const hook = [
        'import { registerHooks } from "node:module";',
        "const seen = [];",
        "registerHooks({ resolve(specifier, context, next) { const out = next(specifier, context); seen.push(out.url); return out; } });",
        `await import(${JSON.stringify(pathToFileURL(resolveIn("@mark1russell7/kind/judge")).href)});`,
        "process.stdout.write(JSON.stringify(seen));",
      ].join("\n");
      const seen = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", hook], { cwd: project, encoding: "utf8" }));
      const heavy = seen.filter((url) => url.startsWith("node:") || /child_process|testcontainers|dockerode|docker-modem|ssh2|@mark1russell7[\\/+]harness/.test(url));
      check(seen.length > 0 && heavy.length === 0, `kind/judge loads no Docker, no Testcontainers, no child process and no node: module${heavy.length === 0 ? "" : `: ${heavy.join(" ")}`}`);
      check(typeof module.judge === "function" && typeof module.openKindLab === "function", "kind gives the judge and the lab in its root");
      // the lab stages the context of its image from the installed packages, as npm installed them
      const context = module.stageLabImage();
      try {
        const packed = readdirSync(join(context, "workspace")).filter((file) => file.endsWith(".tgz"));
        const files = ["Dockerfile", "app.mjs", "client.mjs", "agent.mjs", "watch.mjs", "compose.ts", "backends.ts"];
        check(packed.length === 3 && files.every((file) => existsSync(join(context, file))), "kind stages its lab image from an install");
      } finally {
        rmSync(context, { recursive: true, force: true });
      }
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
