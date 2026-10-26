// The service of a kind cell: a Node HTTP server on @mark1russell7/service, with the probes of its
// health server, its Redis client when the cell has Redis, and each stage of the shutdown. The
// declaration comes from the CONFIG variable of the pod, and compose.ts is the same composition that
// lint() reads. Each line on stdout is JSON, stamped on CLOCK_MONOTONIC (process.hrtime), the clock
// of every container of the VM. The listener, the probes and the answers are the ./http entry of the
// service: the lab has no transport of its own.
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import { handle, httpTransport, pathOf, probeServer } from "@mark1russell7/service/http";
import { redisClient } from "@mark1russell7/service/redis";
import { CONTROLLER, ROUTE, compose } from "./compose.ts";

const config = JSON.parse(process.env.CONFIG ?? "{}");
const declaration = config.declaration;
const pod = process.env.POD_NAME ?? "app";
const now = () => Number(process.hrtime.bigint()) / 1e6;
const clock = {
  now,
  after(ms, run) {
    const timer = setTimeout(run, Math.max(0, ms));
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};
const say = (line) => process.stdout.write(`${JSON.stringify({ ...line, t: now(), p: pod })}\n`);
const record = (event) =>
  say({ ev: "rec", at: event.at, m: event.machine, i: event.instance, from: event.from, to: event.to, on: event.on, d: event.detail ?? null });
const s = (value) => ({ value, unit: "s" });

// the seam of the stall: SIGUSR2 blocks the event loop for the milliseconds in /tmp/lab-stall
process.on("SIGUSR2", () => {
  const ms = Number(readFileSync("/tmp/lab-stall", "utf8"));
  const start = now();
  say({ ev: "stall", phase: "start", ms });
  while (now() - start < ms) {
    // the loop does nothing else: no timer, no probe and no request runs
  }
  say({ ev: "stall", phase: "end", ms, held: now() - start });
});

const redis =
  declaration.redis === null
    ? undefined
    : redisClient(
        "redis",
        {
          host: process.env.REDIS_SERVICE_HOST ?? "redis",
          port: Number(process.env.REDIS_SERVICE_PORT ?? 6379),
          system: "systems.component.redis",
          knobs: declaration.redis.knobs,
          heartbeatMisses: declaration.redis.misses,
        },
        { clock, record },
      );

// the flag file fails the check of the liveness restart: the agent writes it in the root of the container.
// With failsRoute of the config (cannot-serve), the flag also fails the route
const FLAG = process.env.LAB_FLAG ?? "/tmp/lab-fail";
const flag = () => (existsSync(FLAG) ? "error" : "ok");

// the knobs of the listener. The real idle close is the one of Node 24.21 before the ./http entry:
// keepAliveTimeout 5 s and its buffer of 1 s. The clients send each request on a new connection, with
// Connection: close. The sweep comes each second after the stop of the intake (S6 A8), and each 503
// tells a client to try again after 1 s
const KNOBS = { server_idle_close: s(6), server_idle_sweep_interval: s(1), server_retry_after: s(1) };

// the server transport: the transport gets the lifecycle at its start, thus a request before the end
// of the startup gets the refusal of the service (503, retryable), and Connection: close while the
// service is not ready. With the protocol h2c of the declaration, the edge is a server of HTTP/2
// without TLS, and the close of a connection is a GOAWAY on its session (the candidate C of S2)
const server = declaration.protocol === "h2c" ? http2.createServer() : http.createServer();
server.on("listening", () => say({ ev: "app", what: "listening", port: config.port }));
// lameDuck false of the declaration keeps each connection open while the service is not ready: then a
// caller learns only from the endpoints (the candidate A of S2). The default is the lame duck
const edge = declaration.lameDuck === false ? { keepAlive: () => true } : {};
const transport = httpTransport(server, KNOBS, { listen: { port: config.port }, clock, ...edge });
// each request of the port is the one route. A failure of the route answers 503, as the lab always
// did: the T07 and T18 cells count the 503s, and T18 predicts them while Redis is down. Each 503 gets
// Retry-After from the rule of the transport
transport.mount(
  handle(
    CONTROLLER,
    () => ROUTE,
    async (_req, signal) => {
      if (config.failsRoute === true && existsSync(FLAG)) throw new Error("the replica cannot serve");
      if (redis !== undefined) {
        const sent = await redis.send("GET", ["lab"], { signal });
        if (sent.outcome !== "ok") throw new Error(`redis ${sent.outcome}: ${sent.error}`);
      }
      return pod;
    },
    {
      failed: (error) => ({
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: `failed: ${error?.message ?? error}`,
      }),
    },
  ),
);
// the lifecycle stops the intake of the transport, and the line tells when
const lab = {
  start: (signal, life) => transport.start(signal, life),
  stopIntake: () => {
    transport.stopIntake();
    say({ ev: "app", what: "intake-stopped" });
  },
  drain: (deadline, signal) => transport.drain(deadline, signal),
  inFlight: () => transport.inFlight(),
  close: () => transport.close(),
};

// the health server: each probe answers from the cache on its own port, and each answer is a line
const KINDS = new Set(["startup", "readiness", "liveness", "report"]);
const probesServer = http.createServer();
const probes = probeServer({ port: config.healthPort, server: probesServer, server_retry_after: KNOBS.server_retry_after });
// the line of each probe comes when its answer goes, and it writes nothing itself
probesServer.on("request", (req, res) => {
  const kind = pathOf(req.url).slice(1);
  if (KINDS.has(kind)) res.once("finish", () => say({ ev: "probe", k: kind, s: res.statusCode }));
});

const svc = compose(config.name, declaration, { redis, flag, http: lab, health: probes });
const exits = { on: (signal, handler) => (process.on(signal, handler), () => process.off(signal, handler)), exit: (code) => {
  say({ ev: "app", what: "exit", code, errors: svc.lifecycle?.errors ?? [] });
  process.exit(code);
} };
say({ ev: "app", what: "start", declaration });
const life = await svc.run({ clock, record, process: exits });
say({ ev: "app", what: "started", ready: life.health.verdict().ready });
