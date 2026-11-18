import { defineConfig } from "tsdown";

/**
 * This configuration builds the package for npm: ES modules and their declarations in `build/`.
 * The workspace uses the source. A declaration map points at `src/`, and the package does not
 * contain `src/`, thus the build makes no declaration maps.
 */
export default defineConfig({
  // the runtime, the seams for tests (a fake clock and a quiet server, which uses node:net), the
  // Redis, PostgreSQL, MongoDB and RabbitMQ clients, which load ioredis, pg, mongodb and amqplib only when they connect,
  // the HTTP client, which loads node:http only when it connects, the WebSocket client, which loads ws
  // only when it connects, the gRPC client, which loads @grpc/grpc-js only when it connects, the timers without node: or zod, the channels on the clock, which load only collections,
  // the edge of a service in Node (node:http and node:net only), the files of a folder for that edge (node:fs, node:path and files), the keyed limiter, which loads only quantity,
  // the drain rules as data, which load no module, the host of a program in Node, which uses only node: built-ins, the trace ids, which load only @opentelemetry/api and the context entry of otel-ts, and the scopes, which load only the clock
  entry: [
    "src/index.ts",
    "src/testing.ts",
    "src/redis.ts",
    "src/pg.ts",
    "src/mongodb.ts",
    "src/rabbitmq.ts",
    "src/http-client.ts",
    "src/websocket.ts",
    "src/grpc.ts",
    "src/clock.ts",
    "src/channel.ts",
    "src/heartbeat.ts",
    "src/backoff.ts",
    "src/http.ts",
    "src/http-folder.ts",
    "src/limiter.ts",
    "src/rules.ts",
    "src/host.ts",
    "src/otel.ts",
    "src/scope.ts",
  ],
  // Each module of src/ is a file of build/. A bundle of a caller then drops each module that it
  // does not import. A shared chunk joins modules into one file, and the bundle keeps all of it.
  unbundle: true,
  outDir: "build",
  format: "esm",
  platform: "neutral",
  target: "es2022",
  dts: { sourcemap: false },
  sourcemap: true,
});
