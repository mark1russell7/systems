// The service of a kind cell: a Node HTTP server on @mark1russell7/service, with the probes of its
// health server, its Redis client when the cell has Redis, and each stage of the shutdown. The
// declaration comes from the CONFIG variable of the pod, and compose.ts is the same composition that
// lint() reads. Each line on stdout is JSON, stamped on CLOCK_MONOTONIC (process.hrtime), the clock
// of every container of the VM.
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
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

// the flag file fails the check of the liveness restart: the agent writes it in the root of the container
const FLAG = process.env.LAB_FLAG ?? "/tmp/lab-fail";
const flag = () => (existsSync(FLAG) ? "error" : "ok");

// the server transport: a new connection for each request, and Connection: close while the service is not ready.
// The lifecycle comes with the start of the transport, thus a request before the end of the startup
// gets the refusal of the service: 503, retryable
const sockets = new Set();
let inFlight = 0;
const serve = (life) => async (req, res) => {
  inFlight += 1;
  try {
    const outcome = await life.request(CONTROLLER, ROUTE, async (signal) => {
      if (redis !== undefined) {
        const sent = await redis.send("GET", ["lab"], { signal });
        if (sent.outcome !== "ok") throw new Error(`redis ${sent.outcome}: ${sent.error}`);
      }
      return pod;
    });
    const headers = { "content-type": "text/plain" };
    if (!life.keepAlive()) headers.connection = "close";
    if (outcome.kind === "done") res.writeHead(200, headers).end(String(outcome.value));
    else if (outcome.kind === "failed") res.writeHead(503, headers).end(`failed: ${outcome.error?.message ?? outcome.error}`);
    else res.writeHead(outcome.status, headers).end(`${outcome.kind}: ${outcome.cause}`);
  } finally {
    inFlight -= 1;
  }
};
const server = http.createServer();
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
const transport = {
  start: (_signal, life) =>
    new Promise((resolve, reject) => {
      server.on("request", serve(life));
      server.once("error", reject);
      server.listen(config.port, () => {
        say({ ev: "app", what: "listening", port: config.port });
        resolve();
      });
    }),
  stopIntake: () => {
    // the listener closes: a new connection is refused from here on
    server.close();
    server.closeIdleConnections();
    say({ ev: "app", what: "intake-stopped" });
  },
  drain: async (deadline) => {
    while (inFlight > 0 && now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  },
  inFlight: () => inFlight,
  close: () => {
    for (const socket of sockets) socket.destroy();
  },
};

// the health server: each probe answers from the cache, and each answer is a line
const probes = http.createServer((req, res) => {
  const kind = (req.url ?? "/").slice(1).split("?")[0];
  if (!["startup", "readiness", "liveness", "report"].includes(kind) || health === null) {
    res.writeHead(404).end();
    return;
  }
  const answer = health.probe(kind);
  say({ ev: "probe", k: kind, s: answer.status });
  res.writeHead(answer.status, { "content-type": answer.contentType }).end(JSON.stringify(answer.body));
});
let health = null;
const healthServer = {
  listen: (runtime) =>
    new Promise((resolve) => {
      health = runtime;
      probes.listen(config.healthPort, resolve);
    }),
  close: () => new Promise((resolve) => probes.close(() => resolve())),
};

const svc = compose(config.name, declaration, { redis, flag, http: transport, health: healthServer });
const exits = { on: (signal, handler) => (process.on(signal, handler), () => process.off(signal, handler)), exit: (code) => {
  say({ ev: "app", what: "exit", code, errors: svc.lifecycle?.errors ?? [] });
  process.exit(code);
} };
say({ ev: "app", what: "start", declaration });
const life = await svc.run({ clock, record, process: exits });
say({ ev: "app", what: "started", ready: life.health.verdict().ready });
