import { defineConfig } from "vitest/config";

/**
 * This configuration starts the tests of the kind package. The lab test starts only with
 * `KIND_LAB=1`, because it makes a cluster in Docker. A cluster takes minutes, thus the timeout
 * of a test is one hour.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    testTimeout: 60 * 60 * 1000,
    hookTimeout: 60 * 60 * 1000,
  },
});
