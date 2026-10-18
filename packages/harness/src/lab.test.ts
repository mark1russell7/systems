import { freemem, totalmem } from "node:os";
import { describe, expect, it } from "vitest";
import type { Cell, Group, ReplicaSet, Target } from "./cell.ts";
import { groupOnce, openGroupLab } from "./group.ts";
import { nodeClientImage, openLab } from "./lab.ts";
import { measure } from "./observe.ts";
import { openReplicaSetLab, replicaSetOnce } from "./replset.ts";
import { runCell } from "./run.ts";

/**
 * A lab on Docker, opt-in: `HARNESS_LAB=1`. It needs Docker and privileged containers. It starts a
 * client from an image that the caller gives, and an agent in the namespaces of the target. It
 * also puts a reset and netem at a router of a topology, and it fails a group of Valkey over. Each
 * HTTP client sends two requests to a Node server on one connection. The procedures WebSocket client
 * drops a silent connection on its heartbeat, and it connects again.
 */
const RUN = process.env["HARNESS_LAB"] === "1";
const REDIS: Target = {
  image: "redis:7.4@sha256:c6eabf748fc7a61dbb5a705c78bcf3d6377b1127a97d0ce965c11c44ba46896f",
  port: 6379,
  ready: "Ready to accept connections",
};
const VALKEY = "valkey/valkey:9.1@sha256:418652cfb58ef879d4978c33553735d7147016032d5aefaa14c828e611eb9dfd";
const GROUP: Group = {
  name: "mymaster",
  image: VALKEY,
  programs: { server: "valkey-server", sentinel: "valkey-sentinel", cli: "valkey-cli" },
  port: 6379,
  sentinelPort: 26379,
  members: ["m1", "m2", "m3"],
  sentinels: ["s1", "s2", "s3"],
  quorum: 2,
  memberSettings: { "protected-mode": "no", save: '""', appendonly: "no" },
  sentinelSettings: { "down-after-milliseconds": "30000", "failover-timeout": "180000", "parallel-syncs": "1" },
  ready: { member: "Ready to accept connections", sentinel: "+monitor master" },
};

const MONGO = "mongo:9.0.4@sha256:f90507905ce6e52e4a63d0ff8964fc254fa4d37ccbe56c56f4bc0186eb02edea";
/**
 * PostgreSQL 17.11 as the child of a shell, with trust authentication. The entrypoint first starts
 * a server on a Unix socket only, to initialize the cluster. Thus the line of the TCP listener
 * tells that the real server serves. A `fin` fault kills each postgres process with SIGKILL.
 */
const POSTGRES: Target = {
  image: "postgres:17.11@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3",
  port: 5432,
  ready: 'listening on IPv4 address "0.0.0.0", port 5432',
  program: "postgres",
  command: ["sh", "-c", "POSTGRES_HOST_AUTH_METHOD=trust docker-entrypoint.sh postgres & echo $! > /tmp/server.pid; while :; do sleep 3600; done"],
  kill: ["sh", "-c", 'for p in /proc/[0-9]*; do [ "$(cat "$p/comm" 2>/dev/null)" = postgres ] && kill -KILL "${p#/proc/}"; done; true'],
};
const SET: ReplicaSet = {
  name: "rs0",
  image: MONGO,
  programs: { server: "mongod", shell: "mongosh" },
  args: ["--wiredTigerCacheSizeGB", "0.25"],
  port: 27017,
  members: ["m1", "m2", "m3"],
  settings: {},
  ready: "Waiting for connections",
};
const SHELL = 'mongosh --quiet --norc "mongodb://127.0.0.1:27017/?directConnection=true"';
/** This target is a replica set of one member. Its setup starts the set with the address of the member, and waits for its primary. */
const ONE: Target = {
  image: MONGO,
  port: 27017,
  ready: "Waiting for connections",
  command: ["sh", "-c", "mongod --replSet rs0 --bind_ip_all --wiredTigerCacheSizeGB 0.25 & echo $! > /tmp/server.pid; while :; do sleep 3600; done"],
  kill: ["sh", "-c", 'kill -KILL "$(cat /tmp/server.pid)"'],
  program: "mongod",
};
const INITIATE = [
  "sh",
  "-c",
  `${SHELL} --eval 'rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "'"$(hostname -i)"':27017" }] })' && ` +
    `for i in $(seq 1 300); do ${SHELL} --eval 'db.hello().isWritablePrimary' | grep -q true && exit 0; sleep 0.2; done; exit 1`,
];

describe.skipIf(!RUN)("a lab on Docker (HARNESS_LAB=1)", () => {
  it("steps a replica set of MongoDB down, and the driver writes to the new primary", async () => {
    const cell: Cell = {
      name: "lab replica set, event:stepdown",
      target: { image: MONGO, port: 27017, ready: "Waiting for connections" },
      sysctls: {},
      probe: { mode: "stream", keepalive: false, interval: { value: 50, unit: "ms" } },
      fault: "step-down",
      replicaSet: SET,
      prediction: {
        detects: null,
        window: { value: 30, unit: "s" },
        why: "a lab test",
        from: "fault",
        group: { lands: "new", failover: true, stages: [] },
      },
      runs: 1,
      environments: 1,
    };
    const lab = await openReplicaSetLab(SET);
    try {
      // the smoke of a runner: three members, their sidecars, the client and the prober in its memory
      const free = Math.round(freemem() / 2 ** 20);
      console.log(`memory with a replica set of three: ${free} MiB free of ${Math.round(totalmem() / 2 ** 20)} MiB`);
      expect(free).toBeGreaterThan(2_048);
      const manifest = await lab.manifest({});
      expect(manifest.group?.members.map((member) => member.settings["version"])).toEqual(["9.0.4", "9.0.4", "9.0.4"]);
      const run = await replicaSetOnce(lab, cell, 0, 0);
      expect(run.group?.after).not.toBe(run.group?.primary);
      const read = measure(cell, run);
      expect(read).toMatchObject({ outcome: { kind: "answered" }, void: null });
      expect(read.group?.to).toBe(run.group?.after);
      expect(read.group?.stages["elected"]).toBeDefined();
      expect(read.group?.stages["discovered"]).toBeDefined();
      expect(read.group?.writes.lost).toEqual([]);
    } finally {
      await lab.close();
    }
  }, 600_000);

  it("resets a write of the MongoDB driver in flight to a set of one member, and its retry's selection times out", async () => {
    const s = (value: number) => ({ value, unit: "s" });
    const cell: Cell = {
      name: "lab mongodb, rst, a write in flight",
      target: ONE,
      targetSetup: [INITIATE],
      sysctls: {},
      probe: { mode: "inflight", keepalive: false, driver: { name: "mongodb", set: "rs0" } },
      fault: "rst",
      prediction: {
        detects: true,
        timer: "the reset of the request",
        errno: "ECONNRESET",
        from: "request-sent",
        low: s(0),
        high: s(1),
        driver: {
          socket: "pool",
          then: [{ what: "the retry's selection times out", name: "MongoServerSelectionError", from: "request-sent", ends: { ev: "fail", where: { n: 2 } }, low: s(25), high: s(35) }],
        },
      },
      runs: 1,
      environments: 1,
    };
    const result = await runCell(cell);
    const [read] = result.measured;
    expect(read).toMatchObject({ outcome: { kind: "error", errno: "ECONNRESET" }, void: null, finding: null });
    expect(result.manifests[0]?.client.kind).toBe("mongodb");
  }, 600_000);

  it("resets a query of node-postgres in flight, and the pool gives the error of the socket", async () => {
    const s = (value: number) => ({ value, unit: "s" });
    const cell: Cell = {
      name: "lab pg, rst, a query in flight",
      target: POSTGRES,
      sysctls: {},
      probe: { mode: "inflight", keepalive: false, driver: { name: "pg" } },
      fault: "rst",
      prediction: { detects: true, timer: "the reset of the request", errno: "ECONNRESET", from: "request-sent", low: s(0), high: s(1) },
      runs: 1,
      environments: 1,
    };
    const result = await runCell(cell);
    const [read] = result.measured;
    expect(read).toMatchObject({ outcome: { kind: "error", errno: "ECONNRESET" }, void: null, finding: null });
    expect(result.manifests[0]?.client.kind).toBe("pg");
  }, 600_000);

  it("fails a group of Valkey over with a planned failover, and the client writes to the new primary", async () => {
    const cell: Cell = {
      name: "lab group, event:planned SENTINEL FAILOVER",
      target: { image: VALKEY, port: 6379, ready: "Ready to accept connections" },
      sysctls: {},
      probe: { mode: "stream", keepalive: false, interval: { value: 50, unit: "ms" } },
      fault: "planned-failover",
      group: GROUP,
      prediction: {
        detects: null,
        window: { value: 30, unit: "s" },
        why: "a lab test",
        from: "fault",
        group: { lands: "new", failover: true, stages: [] },
      },
      runs: 1,
      environments: 1,
    };
    const lab = await openGroupLab(GROUP);
    try {
      expect(Object.keys(lab.members)).toEqual(["m1", "m2", "m3"]);
      expect((await lab.manifest({})).group?.sentinels[0]?.settings).toMatchObject({ "down-after-milliseconds": "30000", quorum: "2" });
      const run = await groupOnce(lab, cell, 0, 0);
      expect(run.group?.primary).toBe("m1");
      expect(run.group?.after).not.toBe("m1");
      expect(run.group?.timeline.some((line) => line.event === "+switch-master")).toBe(true);
      const read = measure(cell, run);
      expect(read).toMatchObject({ outcome: { kind: "answered" }, void: null });
      expect(read.group?.to).toBe(run.group?.after);
      // the old primary accepted writes until a Sentinel converted it: the group lost them
      expect(read.group?.stages["+convert-to-slave"]).toBeDefined();
      expect(read.group?.writes.lost).not.toBeNull();
    } finally {
      await lab.close();
    }
  }, 600_000);

  it("runs a client image in the namespace of the client, and an agent in the namespaces of the target", async () => {
    const node = await nodeClientImage();
    const lab = await openLab(REDIS, { image: node, command: ["node", "/opt/harness/node/client-ioredis.mjs"] });
    try {
      const probe = await lab.probe([lab.targetIp, String(lab.targetPort), "--mode", "idle", "--keepalive-ms", "5000", "--max-s", "5"]);
      const ready = await probe.until(["ready"], 15_000);
      expect(ready.ev).toBe("ready");
      // the prober saw the socket of the image in the namespace of the client
      const local = probe.events.find((event) => event.ev === "connected")?.["local"];
      await probe.stop();
      expect(lab.kernel.some((record) => record.netns === lab.netns.client && record.src === local)).toBe(true);
      const manifest = await lab.manifest({});
      expect(manifest.client).toEqual({ kind: "image", image: node });
      // the manifest knows HZ: from /proc/config.gz, or measured on a host without it (a runner)
      expect(["100", "250", "300", "1000"]).toContain(manifest.hz);
      expect(["config", "measured"]).toContain(manifest.hzFrom);
      // an agent with the process namespace of the target finds the server process
      const agent = await lab.agent(node, ["sh", "-c", "while :; do sleep 3600; done"], { pid: true });
      expect(Number(await agent.exec(["sh", "-c", "pidof redis-server"]))).toBeGreaterThan(0);
      await agent.stop();
    } finally {
      await lab.close();
    }
  }, 300_000);

  it("runs each HTTP client against a Node server on a stock image, and reads which connection each request went on", async () => {
    // a server from a script that goes into the stock image, and writes its own lines
    const script = [
      'import http from "node:http";',
      "const emit = (ev, f = {}) => process.stdout.write(JSON.stringify({ ev, t: Number(process.hrtime.bigint()), ...f }) + '\\n');",
      'const server = http.createServer((req, res) => { req.resume(); res.on("finish", () => emit("finished")); res.end("ok\\n"); });',
      'server.listen(8080, "0.0.0.0", () => emit("listening", { keepAliveTimeout: server.keepAliveTimeout }));',
    ].join("\n");
    const node: Target = {
      image: "node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1",
      port: 8080,
      ready: "listening",
      files: { "/srv/server.mjs": script },
      command: ["node", "/srv/server.mjs"],
      lines: true,
    };
    for (const client of ["go-http", "http-agent", "undici"] as const) {
      const lab = await openLab(node, client);
      try {
        const probe = await lab.probe([lab.targetIp, String(lab.targetPort), "--mode", "gap", "--method", "GET", "--gap-ms", "300", "--linger-ms", "100", "--max-s", "20"]);
        await probe.until(["done", "fail", "deadline"], 60_000);
        const local = probe.events.find((event) => event.ev === "connected")?.["local"];
        // the second request went on the connection of the first, 0.3 s later, and got its reply
        const second = probe.events.find((event) => event.ev === "request" && event["i"] === 2);
        expect(second, client).toMatchObject({ reused: true, local });
        expect(probe.events.some((event) => event.ev === "replied" && event["i"] === 2), client).toBe(true);
        await probe.stop();
        expect(lab.kernel.some((record) => record.netns === lab.netns.client && record.src === local), client).toBe(true);
        // the server wrote its own lines, and the manifest has its first one and its script
        expect(lab.server.filter((line) => line.ev === "finished").length, client).toBe(2);
        const manifest = await lab.manifest({});
        expect(manifest.target.first, client).toMatchObject({ ev: "listening", keepAliveTimeout: 5000 });
        expect(Object.keys(manifest.target.files ?? {}), client).toEqual(["/srv/server.mjs"]);
        expect(manifest.client.kind, client).toBe(client);
      } finally {
        await lab.close();
      }
    }
  }, 900_000);

  it("runs the procedures WebSocket client against the procedures server of one image, and reads its pings, its drop and its new try", async () => {
    // the server script is in the image of the harness, as the client is: one release of the package
    const target: Target = {
      image: "node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1",
      harness: "procedures",
      port: 8080,
      ready: '"ev":"listening"',
      command: ["node", "/opt/harness/procedures/server-ws.mjs", "--port", "8080", "--tcp-keepalive", "off", "--heartbeat", "off"],
      lines: true,
    };
    const lab = await openLab(target, "procedures-ws");
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    try {
      const settings = ["--heartbeat", "on", "--heartbeat-interval-ms", "300", "--heartbeat-timeout-ms", "200", "--heartbeat-misses", "1"];
      const reconnect = ["--reconnect", "on", "--reconnect-initial-ms", "200", "--reconnect-multiplier", "2", "--reconnect-max-ms", "1000", "--reconnect-attempts", "5", "--reconnect-jitter", "0"];
      const calls = ["--request-timeout-ms", "5000", "--connection-timeout-ms", "5000", "--max-s", "30"];
      // the global WebSocket of Node drops with a close frame, and the WebSocket of ws with terminate()
      for (const socket of ["global", "ws"] as const) {
        await lab.forget();
        const probe = await lab.probe([lab.targetIp, String(lab.targetPort), "--mode", "idle", "--websocket", socket, ...settings, ...reconnect, ...calls]);
        await probe.until(["ready"], 30_000);
        // a ping with its pong first, then a black hole: the heartbeat drops the connection after its next ping
        await probe.until(["ping"], 5_000);
        await sleep(100);
        await lab.fault("blackhole");
        const drop = await probe.until(["drop"], 5_000);
        await lab.lift("blackhole");
        for (let look = 0; look < 100 && probe.events.filter((event) => event.ev === "connected").length < 2; look += 1) await sleep(50);
        await probe.stop();
        const local = probe.events.find((event) => event.ev === "connected")?.["local"];
        expect(drop, socket).toMatchObject({ conn: 1, local, how: socket === "ws" ? "terminate" : "close" });
        expect(probe.events.filter((event) => event.ev === "connected").length, socket).toBeGreaterThanOrEqual(2);
        expect(probe.events.some((event) => event.ev === "reconnecting" && event["attempt"] === 1), socket).toBe(true);
        // the kernel stamped the close frame on the first socket, or its change out of ESTABLISHED
        const first = lab.kernel.filter((record) => record.netns === lab.netns.client && record.src === local);
        const soon = (record: (typeof first)[number]) => record.mono >= drop.t && record.mono - drop.t < 4e6;
        const left = first.some((record) => soon(record) && record.ev === "state" && (record as { readonly old?: number }).old === 1);
        const wrote = first.some((record) => soon(record) && record.ev === "tx");
        expect({ left, wrote }, socket).toEqual(socket === "ws" ? { left: true, wrote: false } : { left: false, wrote: true });
      }
      // the server wrote its own lines, and the manifest names the image of the harness
      expect(lab.server.filter((line) => line.ev === "accepted").length).toBeGreaterThanOrEqual(4);
      const manifest = await lab.manifest({});
      expect(manifest.target).toMatchObject({ harness: "procedures", first: { ev: "listening", heartbeat: null } });
      expect(manifest.client.kind).toBe("procedures-ws");
    } finally {
      await lab.close();
    }
  }, 600_000);

  it("puts a fault at a router in its FORWARD chain, and netem on its device toward one side", async () => {
    const lab = await openLab(REDIS, "tcp", {
      name: "T03",
      hops: [
        {
          name: "nat",
          kind: "router",
          form: "none",
          idle: { value: 60, unit: "s" },
          sysctls: { "net.ipv4.icmp_ratelimit": "0" },
        },
      ],
    });
    try {
      // the router sets its own sysctls, and the manifest reads them back
      expect((await lab.manifest({})).hops?.[0]?.sysctls).toMatchObject({ "net.ipv4.icmp_ratelimit": "0" });
      await lab.warm();
      const probe = await lab.probe([lab.targetIp, String(lab.targetPort), "--mode", "inflight", "--max-s", "10"]);
      await probe.until(["ready"], 15_000);
      // a reset from the router, for the segments that it forwards from the client
      const at = { hop: "nat", toward: "client" } as const;
      await lab.fault("rst", at);
      await probe.go();
      expect(await probe.until(["error", "eof"], 5_000)).toMatchObject({ ev: "error", errno: "ECONNRESET" });
      await lab.lift("rst", at);
      await probe.stop();
      // the prober recorded the write of the request on the socket of the client
      const local = probe.events.find((event) => event.ev === "connected")?.["local"];
      expect(lab.kernel.some((record) => record.ev === "tx" && record.netns === lab.netns.client && record.src === local)).toBe(true);
      // netem on the device of the router toward the target, and off again
      const toward = { hop: "nat", toward: "target" } as const;
      const delay = await lab.netem("delay 50ms", toward);
      expect(delay.t1).toBeGreaterThanOrEqual(delay.t0);
      await lab.netem(null, toward);
    } finally {
      await lab.close();
    }
  }, 300_000);
});
