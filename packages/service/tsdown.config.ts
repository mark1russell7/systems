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
  // only when it connects, the gRPC client, which loads @grpc/grpc-js only when it connects, the timers without node: or zod,
  // the edge of a service in Node (node:http and node:net only), the keyed limiter, which loads only quantity,
  // the drain rules as data, which load no module, and the host of a program in Node, which uses only node: built-ins
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
    "src/heartbeat.ts",
    "src/backoff.ts",
    "src/http.ts",
    "src/limiter.ts",
    "src/rules.ts",
    "src/host.ts",
  ],
  outDir: "build",
  format: "esm",
  platform: "neutral",
  target: "es2022",
  dts: { sourcemap: false },
  sourcemap: true,
});
