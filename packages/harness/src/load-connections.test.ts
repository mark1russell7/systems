import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { constant, scheduleHeld } from "@mark1russell7/rigor-chaos";
import { quantile } from "@mark1russell7/rigor-statistics";
import { describe, expect, it } from "vitest";
import type { LoadConnections, LoadStream, ProbeEvent, Target } from "./cell.ts";
import { openLab } from "./lab.ts";
import { LOAD_PATH, loadPlanOf, streamsLoadOf } from "./load.ts";

/**
 * The proof of the connection modes of the client `load` on real containers (CAP-47). It is opt-in,
 * because it needs Docker and the image of the harness: `load.yml` starts it with HARNESS_LOAD=1.
 * `HARNESS_LOAD_OUT` names a folder for the record of the run.
 */
const RUN = process.env["HARNESS_LOAD"] === "1";
const OUT = process.env["HARNESS_LOAD_OUT"] || undefined;

/** The stock image of the server, pinned by its digest. */
const NODE = "node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1";

/**
 * A server that answers `/wait/<ms>/<key>/<i>` after `ms`. It numbers each connection. For each
 * reply, it writes the stream, the arrival, the connection, the start of the request and the time
 * before the write of the reply (`end`). It also writes the count of requests of that connection in
 * its handlers at the start (`inflight`).
 */
const SERVER = [
  'import http from "node:http";',
  "const emit = (ev, f = {}) => process.stdout.write(JSON.stringify({ ev, t: Number(process.hrtime.bigint()), ...f }) + '\\n');",
  "let count = 0;",
  "const server = http.createServer((req, res) => {",
  "  req.resume();",
  "  const socket = req.socket;",
  "  const start = Number(process.hrtime.bigint());",
  "  socket.inflight += 1;",
  "  const inflight = socket.inflight;",
  '  const [, , ms, k, i] = req.url.split("/");',
  "  setTimeout(() => {",
  "    socket.inflight -= 1;",
  "    const end = Number(process.hrtime.bigint());",
  '    res.on("finish", () => emit("served", { k, i: Number(i), conn: socket.conn, inflight, start, end }));',
  '    res.end("ok");',
  "  }, Number(ms));",
  "});",
  'server.on("connection", (socket) => { count += 1; socket.conn = count; socket.inflight = 0; emit("connection", { conn: count }); });',
  "server.keepAliveTimeout = 60_000;",
  'server.listen(8080, "0.0.0.0", () => emit("listening"));',
].join("\n");

/** Each stream sends 20 arrivals each second for 2 s: 40 arrivals, 50 ms apart. */
const ARRIVALS = 40;

/** The streams of the proof: the key, the connections, and the wait of the server for arrival i, in ms. */
const STREAMS: ReadonlyArray<{ readonly key: string; readonly connections?: LoadConnections; readonly wait: (i: number) => number }> = [
  { key: "pipeline", wait: () => 100 },
  { key: "pool", connections: { mode: "pool", size: 8 }, wait: () => 100 },
  { key: "fresh", connections: { mode: "fresh" }, wait: () => 100 },
  // one connection for a request each 50 ms that takes 100 ms: the queue grows
  { key: "queue", connections: { mode: "pool", size: 1 }, wait: () => 100 },
  // a slow and a fast request in turn
  { key: "hol", connections: { mode: "pipeline" }, wait: (i) => (i % 2 === 0 ? 300 : 10) },
  { key: "hol-pool", connections: { mode: "pool", size: 8 }, wait: (i) => (i % 2 === 0 ? 300 : 10) },
];

const p = (values: readonly number[], at: number): number => (values.length === 0 ? Number.NaN : quantile(values, at, "nearest-rank"));

describe.skipIf(!RUN)("the connection modes of the client load on real containers (HARNESS_LOAD=1)", () => {
  it("gives a pipeline one connection, a pool its connections with one request each, and a fresh stream a connection for each arrival", async () => {
    const target: Target = {
      image: NODE,
      subject: { kind: "pinned", image: NODE },
      port: 8080,
      ready: "listening",
      files: { "/srv/server.mjs": SERVER },
      command: ["node", "/srv/server.mjs"],
      lines: true,
    };
    const plan = { profile: constant(20, 2_000), options: { arrivals: "uniform" as const } };
    const streams: LoadStream[] = STREAMS.map(({ key, connections, wait }) => ({
      key,
      plan,
      requests: Array.from({ length: ARRIVALS }, (_, i) => `GET /wait/${wait(i)}/${key}/${i} HTTP/1.1\r\nHost: target\r\n\r\n`),
      ...(connections === undefined ? {} : { connections }),
    }));
    const load = loadPlanOf(streams);
    expect(load.streams.map((stream) => stream.schedule.times.length)).toEqual(STREAMS.map(() => ARRIVALS));

    const lab = await openLab(target, "load");
    try {
      const serverFrom = lab.server.length;
      const probe = await lab.probe([lab.targetIp, String(lab.targetPort), "--plan", LOAD_PATH, "--max-s", "120"], [{ content: load.content, target: LOAD_PATH }]);
      await probe.until(["ready"], 15_000);
      await probe.go();
      const end = await probe.until(["done", "deadline", "fail"], 120_000);
      const events: readonly ProbeEvent[] = probe.events;
      const server = lab.server.slice(serverFrom);
      const scheduled = events.find((event) => event.ev === "scheduled")?.t ?? Number.NaN;
      const measures = streamsLoadOf(events, load.streams);
      if (measures === null) throw new Error("the client never started its schedule");

      const of = (ev: string, key: string) => events.filter((event) => event.ev === ev && event["k"] === key);
      const served = (key: string) => server.filter((line) => line.ev === "served" && line["k"] === key);
      const each = load.streams.map(({ key, schedule }) => {
        const measure = measures.streams[key];
        if (measure === undefined) throw new Error(`no measure of the stream ${key}`);
        const sent = of("sent", key);
        const replied = of("replied", key);
        const waits = sent.map((event) => Number(event["wait"] ?? 0) / 1e6);
        const order = replied.map((event) => Number(event["i"]));
        // the send behind the plan, with the wait for a connection in it
        const raw = sent.map((event) => (event.t - scheduled) / 1e6 - (schedule.times[Number(event["i"])] ?? Number.NaN));
        const fast = measure.latency.filter((_, at) => at % 2 === 1);
        return {
          key,
          sent: sent.length,
          replied: replied.length,
          unsent: measure.unsent,
          unfinished: measure.unfinished,
          failed: measure.failed ?? 0,
          connections: new Set(served(key).map((line) => line["conn"])).size,
          inflight: Math.max(0, ...served(key).map((line) => Number(line["inflight"]))),
          latency: {
            p50: p(measure.latency, 0.5),
            p90: p(measure.latency, 0.9),
            max: Math.max(...measure.latency),
            first: measure.latency[0] ?? Number.NaN,
            last: measure.latency.at(-1) ?? Number.NaN,
          },
          fastP50: p(fast, 0.5),
          service: { p50: p(measure.service, 0.5), max: Math.max(...measure.service) },
          lag: { max: Math.max(...measure.lag.map(Math.abs)), held: scheduleHeld(measure, 50).held },
          rawLag: { max: Math.max(...raw) },
          wait: { p50: p(waits, 0.5), max: Math.max(...waits), zero: waits.filter((wait) => wait === 0).length },
          outOfOrder: order.filter((i, at) => at > 0 && i < (order[at - 1] ?? Number.NaN)).length,
        };
      });
      const stream = (key: string) => {
        const found = each.find((one) => one.key === key);
        if (found === undefined) throw new Error(`no stream ${key}`);
        return found;
      };
      const connected = events.filter((event) => event.ev === "connected");
      const summary = {
        end: end.ev,
        requests: end["requests"],
        connected: connected.length,
        serverConnections: server.filter((line) => line.ev === "connection").length,
        streams: Object.fromEntries(each.map((one) => [one.key, one])),
      };
      // the record comes before the checks, thus a run that fails has its numbers
      if (OUT !== undefined) {
        mkdirSync(OUT, { recursive: true });
        writeFileSync(join(OUT, "load.json"), `${JSON.stringify({ summary, client: events, server }, null, 2)}\n`);
      }
      console.log(JSON.stringify(summary));

      // the run did its work: each arrival of each stream was sent and got its reply
      expect(end.ev).toBe("done");
      expect(end["requests"]).toBe(STREAMS.length * ARRIVALS);
      for (const one of each) {
        expect([one.key, one.sent, one.replied, one.unsent, one.unfinished, one.failed]).toEqual([one.key, ARRIVALS, ARRIVALS, 0, 0, 0]);
        // the wait for a connection is not a lag of the driver: each stream kept its schedule within 50 ms
        expect([one.key, one.lag.held]).toEqual([one.key, true]);
      }
      // a connected line for each kept connection: 1 of each pipeline and each of each pool, and none for a fresh stream
      expect(connected).toHaveLength(1 + 8 + 1 + 1 + 8);

      // one clock: the server started each request after its send, and ended it before its reply
      for (const event of events.filter((line) => line.ev === "replied")) {
        const line = server.find((one) => one.ev === "served" && one["k"] === event["k"] && one["i"] === event["i"]);
        const send = events.find((one) => one.ev === "sent" && one["k"] === event["k"] && one["i"] === event["i"]);
        if (line === undefined || send === undefined) throw new Error(`no send or no served line for ${String(event["k"])} ${String(event["i"])}`);
        expect(Number(line["start"])).toBeGreaterThanOrEqual(send.t);
        // the stamp comes before the write of the reply: the finish event can come after the read of the client
        expect(Number(line["end"])).toBeLessThanOrEqual(event.t);
      }

      // a pipeline: one connection. Node runs the handlers of pipelined requests at once and keeps only the
      // order of the replies, thus a fixed wait of 100 ms does not queue
      const pipeline = stream("pipeline");
      expect(pipeline.connections).toBe(1);
      expect(pipeline.inflight).toBeGreaterThanOrEqual(2);
      expect(pipeline.latency.p90).toBeLessThan(200);
      expect(pipeline.wait.zero).toBe(ARRIVALS);

      // a pool of 8: each connection has one request at most, and each reply comes near the 100 ms of the server
      const pool = stream("pool");
      expect(pool.connections).toBeGreaterThanOrEqual(2);
      expect(pool.connections).toBeLessThanOrEqual(8);
      expect(pool.inflight).toBe(1);
      expect(pool.latency.p50).toBeGreaterThanOrEqual(100);
      expect(pool.latency.p90).toBeLessThan(200);

      // a fresh stream: a new connection for each arrival, one request on each, and a short wait for each connect
      const fresh = stream("fresh");
      expect(fresh.connections).toBe(ARRIVALS);
      expect(fresh.inflight).toBe(1);
      expect(fresh.latency.p50).toBeGreaterThanOrEqual(100);
      expect(fresh.latency.p90).toBeLessThan(200);
      expect(fresh.wait.zero).toBe(0);
      expect(fresh.wait.max).toBeLessThan(50);

      // a pool of 1: the arrivals queue for the one connection. The latency grows from the planned time, the service
      // stays near 100 ms, and the send behind the plan is the wait for the connection, not a lag of the driver
      const queue = stream("queue");
      expect(queue.connections).toBe(1);
      expect(queue.inflight).toBe(1);
      expect(queue.latency.last).toBeGreaterThanOrEqual(1_500);
      expect(queue.latency.last - queue.latency.first).toBeGreaterThanOrEqual(1_000);
      expect(queue.service.p50).toBeGreaterThanOrEqual(100);
      expect(queue.service.p50).toBeLessThan(150);
      expect(queue.rawLag.max).toBeGreaterThanOrEqual(1_000);
      expect(queue.lag.max).toBeLessThan(50);

      // a slow and a fast request in turn: on a pipeline, each fast reply waits for the slow reply before it.
      // On a pool, a fast reply passes the slow one
      const hol = stream("hol");
      const holPool = stream("hol-pool");
      expect(hol.fastP50).toBeGreaterThanOrEqual(200);
      expect(hol.outOfOrder).toBe(0);
      expect(holPool.fastP50).toBeLessThan(100);
      expect(holPool.outOfOrder).toBeGreaterThan(0);
      expect(holPool.inflight).toBe(1);

      await probe.stop();
    } finally {
      await lab.close();
    }
  }, 900_000);
});
