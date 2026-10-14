import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessImage } from "@mark1russell7/harness";
import type { StartedNetwork, StartedTestContainer } from "testcontainers";
import { GenericContainer, Network, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Poll, Timing } from "../index.ts";
import type { RedisKnobs } from "../redis.ts";
import type { Band, F6Manifestation, F6Posture } from "./f6.ts";
import { F6_MANIFESTATIONS, F6_POSTURES, recoverBand, reportBand, tripBand } from "./f6.ts";

/**
 * The F6 matrix against a real Redis 7.4, opt-in: `REDIS_F6=1`. The service runs in a probe container
 * on the network of Redis, in the VM of Docker. The injector of @mark1russell7/harness makes the network
 * faults from the namespace of Redis, and an agent in the namespaces of Redis makes the process faults.
 * Each one stamps its act on the CLOCK_MONOTONIC of the VM, the clock of the probe. Each manifestation
 * gets a fresh environment, and the three postures share it: each posture is a service of its own,
 * with its own connection, and the fault meets the three connections.
 */

const RUN = process.env["REDIS_F6"] === "1";
const REDIS = "redis:7.4@sha256:c6eabf748fc7a61dbb5a705c78bcf3d6377b1127a97d0ce965c11c44ba46896f";
const NODE = "node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1";
const PROBE = "f6-redis-probe:dev";
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const FILES = fileURLToPath(new URL("../../test/f6/", import.meta.url));
/** The noise of the pipeline: the event loop of the probe and the scheduler of the VM, in milliseconds. */
const NOISE = 50;
const STALL = 8;

const s = (value: number) => ({ value, unit: "s" });
const ms = (value: number) => ({ value, unit: "ms" });
const KNOBS: RedisKnobs = {
  connect_bound: ms(500),
  request_timeout: ms(800),
  driver_writeoff_time: ms(2000),
  keepalive_idle: s(5),
  heartbeat_interval: ms(1000),
  heartbeat_timeout: ms(400),
  client_retry_window: s(4),
  retry_base: ms(50),
  retry_cap: ms(400),
  close_bound: ms(300),
  max_connection_age: { value: "infinite", unit: "s" },
  retrans_giveup_time: s(924.6),
};
const POLL: Poll = { interval: s(1), jitter: 0.2, timeout: ms(400) };
const TIMING: Record<Exclude<F6Posture, "reports">, Timing> = {
  readiness: { type: "debounce", interval: s(1), failAfter: 3, recoverAfter: 1 },
  liveness: { type: "window", failAfter: s(3) },
};
/** The config of the probe: each service takes the timing of its posture for the policy that its check gates. */
const probeConfig = {
  host: "redis",
  port: 6379,
  postures: F6_POSTURES,
  knobs: KNOBS,
  misses: 2,
  poll: POLL,
  timings: TIMING,
  other: { type: "window", failAfter: s(60) },
  startup: s(20),
  phaseCap: s(1),
  cooperative: s(0.5),
};

/** A line that the probe printed. */
interface Line {
  readonly ev: string;
  readonly t: number;
  readonly posture?: F6Posture;
  readonly ready?: boolean;
  readonly alive?: boolean;
  readonly check?: string | null;
  readonly on?: string;
  readonly code?: number;
  readonly errors?: string[];
  readonly status?: string;
}

/** A container whose process namespace is the namespace of another container. */
class SharedPidContainer extends GenericContainer {
  withPidMode(mode: string): this {
    (this as unknown as { hostConfig: { PidMode?: string } }).hostConfig.PidMode = mode;
    return this;
  }
}

const shell = process.platform === "win32";

/** This function builds the image of the probe from the tarballs of the workspace, as an application installs them. */
const buildProbe = async (): Promise<void> => {
  const context = mkdtempSync(join(tmpdir(), "f6-"));
  try {
    execFileSync("pnpm", ["--filter", "@mark1russell7/quantity", "--filter", "@mark1russell7/algebra", "--filter", "@mark1russell7/service", "build"], { cwd: REPO, shell, stdio: "ignore" });
    for (const name of ["quantity", "algebra", "service"])
      execFileSync("pnpm", ["pack", "--pack-destination", context], { cwd: join(REPO, "packages", name), shell, stdio: "ignore" });
    const tarball = (name: string): string => `file:./${readdirSync(context).find((file) => file.startsWith(`mark1russell7-${name}-`))!}`;
    writeFileSync(
      join(context, "package.json"),
      JSON.stringify({
        name: "f6-probe",
        private: true,
        type: "module",
        dependencies: {
          "@mark1russell7/quantity": tarball("quantity"),
          "@mark1russell7/algebra": tarball("algebra"),
          "@mark1russell7/service": tarball("service"),
          ioredis: "6.0.0",
          zod: "^4.1.0",
        },
        overrides: { "@mark1russell7/quantity": "$@mark1russell7/quantity", "@mark1russell7/algebra": "$@mark1russell7/algebra" },
      }),
    );
    for (const file of ["probe.mjs", "agent.mjs"]) copyFileSync(join(FILES, file), join(context, file));
    writeFileSync(
      join(context, "Dockerfile"),
      [
        `FROM ${NODE}`,
        "WORKDIR /opt/f6",
        "COPY package.json *.tgz ./",
        "RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts",
        "COPY probe.mjs agent.mjs ./",
        "",
      ].join("\n"),
    );
    await GenericContainer.fromDockerfile(context).build(PROBE, { deleteOnExit: false });
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
};

const wait = async (done: () => boolean, within: number, what: string): Promise<void> => {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > within) throw new Error(`no ${what} in ${within} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

interface Environment {
  readonly network: StartedNetwork;
  readonly containers: StartedTestContainer[];
  readonly redis: StartedTestContainer;
  readonly injector: StartedTestContainer;
  readonly agent: StartedTestContainer;
  readonly probe: StartedTestContainer;
  readonly lines: Line[];
  readonly probeIp: string;
}

const open = async (): Promise<Environment> => {
  const network = await new Network().start();
  const containers: StartedTestContainer[] = [];
  const redis = await new GenericContainer(REDIS)
    .withNetwork(network)
    .withNetworkAliases("redis")
    .withCommand(["sh", "-c", "while :; do redis-server --save '' --appendonly no --enable-debug-command yes; done"])
    .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
    .start();
  containers.push(redis);
  const injector = await new GenericContainer(await harnessImage())
    .withNetworkMode(`container:${redis.getId()}`)
    .withAddedCapabilities("NET_ADMIN", "NET_RAW")
    .start();
  containers.push(injector);
  const agent = await new SharedPidContainer(PROBE)
    .withNetworkMode(`container:${redis.getId()}`)
    .withPidMode(`container:${redis.getId()}`)
    .withCommand(["sleep", "infinity"])
    .start();
  containers.push(agent);
  const lines: Line[] = [];
  let partial = "";
  const probe = await new GenericContainer(PROBE)
    .withNetwork(network)
    .withCommand(["node", "probe.mjs", JSON.stringify(probeConfig)])
    .withLogConsumer((stream) =>
      stream.on("data", (chunk: Buffer | string) => {
        partial += chunk.toString();
        const split = partial.split("\n");
        partial = split.pop() ?? "";
        for (const text of split) if (text.trim().startsWith("{")) lines.push(JSON.parse(text.trim()) as Line);
      }),
    )
    .start();
  containers.push(probe);
  await wait(() => lines.some((line) => line.ev === "ready"), 60_000, "ready line from the probe");
  return { network, containers, redis, injector, agent, probe, lines, probeIp: probe.getIpAddress(network.getName()) };
};

const close = async (env: Environment): Promise<void> => {
  for (const container of [...env.containers].reverse()) await container.stop({ timeout: 0 }).catch(() => undefined);
  await env.network.stop().catch(() => undefined);
};

/** This function runs one act of an injector or an agent, and gives its stamp in milliseconds on the monotonic clock. */
const act = async (container: StartedTestContainer, argv: string[]): Promise<number> => {
  const result = await container.exec(argv);
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${result.exitCode}: ${result.output}`);
  const stamp = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { t1: string | number };
  return Number(BigInt(stamp.t1)) / 1e6;
};

const inject = async (env: Environment, manifestation: F6Manifestation): Promise<number> => {
  if (manifestation === "rst") return act(env.injector, ["/opt/harness/inject", "rst", env.probeIp]);
  if (manifestation === "blackhole") return act(env.injector, ["/opt/harness/inject", "blackhole", env.probeIp]);
  if (manifestation === "freeze-process") return act(env.agent, ["node", "agent.mjs", "stop"]);
  if (manifestation === "app-stall") return act(env.agent, ["node", "agent.mjs", "stall", String(STALL)]);
  // death without a close: the network drops the FIN, and then the process dies (its holder starts a new one)
  const onset = await act(env.injector, ["/opt/harness/inject", "blackhole", env.probeIp]);
  await act(env.agent, ["node", "agent.mjs", "kill"]);
  return onset;
};

const heal = async (env: Environment, manifestation: F6Manifestation, onset: number): Promise<number> => {
  if (manifestation === "rst") return act(env.injector, ["/opt/harness/inject", "clear-rst", env.probeIp]);
  if (manifestation === "blackhole" || manifestation === "freeze-host") return act(env.injector, ["/opt/harness/inject", "clear", env.probeIp]);
  if (manifestation === "freeze-process") return act(env.agent, ["node", "agent.mjs", "cont"]);
  // the stall ends by itself
  const end = onset + STALL * 1000;
  await wait(() => env.lines.some((line) => line.t >= end), (STALL + 5) * 1000, "a line after the end of the stall");
  return end;
};

/** One row of the results: a manifestation and a posture, with what it measured against its band. */
interface Row {
  readonly manifestation: F6Manifestation;
  readonly posture: F6Posture;
  readonly measured: string;
  readonly band: string;
  readonly holds: boolean;
}
const rows: Row[] = [];
const inside = (value: number, band: Band): boolean => value >= band.low - NOISE && value <= band.high + NOISE;
const show = (band: Band): string => `[${band.low}, ${band.high}] ms`;

describe.skipIf(!RUN)("F6 for Redis against a real Redis 7.4 (REDIS_F6=1)", () => {
  beforeAll(async () => {
    await buildProbe();
    await harnessImage();
  }, 900_000);

  afterAll(() => {
    // the table of the run, for the record: in the file that F6_TABLE names, and on the console
    const table = ["| manifestation | posture | measured | band | holds |", "| --- | --- | --- | --- | --- |", ...rows.map((row) => `| ${row.manifestation} | ${row.posture} | ${row.measured} | ${row.band} | ${row.holds} |`)].join("\n");
    const file = process.env["F6_TABLE"];
    if (file !== undefined) writeFileSync(file, `${table}\n`);
    console.log(table);
  });

  for (const manifestation of F6_MANIFESTATIONS) {
    it(`${manifestation}: each posture trips and releases in the declaration's bounds`, async () => {
      const env = await open();
      try {
        const onset = await inject(env, manifestation);
        const flip = (posture: F6Posture, after: number, field: "ready" | "alive", value: boolean): Line | undefined =>
          env.lines.find((line) => line.ev === "verdict" && line.posture === posture && line.t >= after && line[field] === value);
        await wait(() => flip("readiness", onset, "ready", false) !== undefined && flip("liveness", onset, "alive", false) !== undefined, 20_000, "trips");
        const back = await heal(env, manifestation, onset);
        await wait(() => flip("readiness", back, "ready", true) !== undefined && flip("liveness", back, "alive", true) !== undefined, 30_000, "releases");
        const failures: string[] = [];
        for (const posture of ["readiness", "liveness"] as const) {
          const field = posture === "readiness" ? "ready" : "alive";
          const trip = tripBand(TIMING[posture], POLL);
          const tripped = flip(posture, onset, field, false)!.t - onset;
          const recover = recoverBand(TIMING[posture], POLL, KNOBS);
          const released = flip(posture, back, field, true)!.t - back;
          const holds = inside(tripped, trip) && released <= recover.high + NOISE;
          rows.push({ manifestation, posture, measured: `trip ${tripped.toFixed(1)} ms, release ${released.toFixed(1)} ms`, band: `trip ${show(trip)}, release ≤ ${recover.high} ms`, holds });
          if (!holds) failures.push(`${posture}: tripped after ${tripped.toFixed(1)} ms (${show(trip)}), released after ${released.toFixed(1)} ms (≤ ${recover.high})`);
        }
        // the check that only reports: it fails, and its service stays ready and alive
        const reports = env.lines.filter((line) => line.ev === "verdict" && line.posture === "reports" && line.t >= onset && line.t <= back);
        const failed = reports.find((line) => line.check === "error");
        const band = reportBand(POLL);
        const first = failed === undefined ? Number.POSITIVE_INFINITY : failed.t - onset;
        const steady = reports.every((line) => line.ready === true && line.alive === true);
        rows.push({ manifestation, posture: "reports", measured: `first failure ${first.toFixed(1)} ms, steady ${steady}`, band: `≤ ${band.high} ms`, holds: first <= band.high + NOISE && steady });
        if (!(first <= band.high + NOISE && steady)) failures.push(`reports: first failure after ${first} ms (≤ ${band.high}), steady ${steady}`);
        expect(failures, manifestation).toEqual([]);
      } finally {
        await close(env);
      }
    }, 180_000);
  }

  it("a shutdown in the middle of a black hole: each service exits 0, its close at its bound", async () => {
    const env = await open();
    try {
      await inject(env, "blackhole");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await env.probe.exec(["touch", "/tmp/shutdown"]);
      await wait(() => env.lines.filter((line) => line.ev === "exit").length === F6_POSTURES.length, 20_000, "exits");
      const asked = env.lines.find((line) => line.ev === "shutdown")!.t;
      const exits = env.lines.filter((line) => line.ev === "exit");
      for (const exit of exits) {
        expect(exit.code, exit.posture).toBe(0);
        expect(exit.errors, exit.posture).toEqual([]);
        expect(exit.status, exit.posture).toBe("end");
        // two phases of 1 s at the most
        expect(exit.t - asked, exit.posture).toBeLessThanOrEqual(2000 + NOISE);
      }
      rows.push({ manifestation: "blackhole", posture: "readiness", measured: `shutdown: exits ${exits.map((exit) => `${exit.code} in ${(exit.t - asked).toFixed(0)} ms`).join(", ")}`, band: "exit 0 in ≤ 2000 ms", holds: true });
    } finally {
      await close(env);
    }
  }, 180_000);
});
