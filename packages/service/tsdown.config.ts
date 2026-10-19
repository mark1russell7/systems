import { defineConfig } from "tsdown";

/**
 * This configuration builds the package for npm: ES modules and their declarations in `build/`.
 * The workspace uses the source. A declaration map points at `src/`, and the package does not
 * contain `src/`, thus the build makes no declaration maps.
 */
export default defineConfig({
  // the runtime, the seams for tests (a fake clock and a quiet server, which uses node:net), the
  // Redis client, which loads ioredis only when it connects, the timers without node: or zod, and
  // the edge of a service in Node (node:http and node:net only), and the keyed limiter, which loads only quantity
  entry: ["src/index.ts", "src/testing.ts", "src/redis.ts", "src/clock.ts", "src/heartbeat.ts", "src/backoff.ts", "src/http.ts", "src/limiter.ts"],
  outDir: "build",
  format: "esm",
  platform: "neutral",
  target: "es2022",
  dts: { sourcemap: false },
  sourcemap: true,
});
