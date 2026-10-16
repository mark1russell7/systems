import { describe, expect, it } from "vitest";
import type { Cell, Group, Target } from "./cell.ts";
import { groupOnce, openGroupLab } from "./group.ts";
import { nodeClientImage, openLab } from "./lab.ts";
import { measure } from "./observe.ts";

/**
 * A lab on Docker, opt-in: `HARNESS_LAB=1`. It needs Docker and privileged containers. It starts a
 * client from an image that the caller gives, and an agent in the namespaces of the target. It
 * also puts a reset and netem at a router of a topology, and it fails a group of Valkey over. Each
 * HTTP client sends two requests to a Node server on one connection.
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

describe.skipIf(!RUN)("a lab on Docker (HARNESS_LAB=1)", () => {
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
      expect((await lab.manifest({})).client).toEqual({ kind: "image", image: node });
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
