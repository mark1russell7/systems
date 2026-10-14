import { defineConfig } from "vitest/config";

/**
 * This configuration starts the tests of the catalog. The runner of the cells is a test too, and
 * it starts only with CELLS=1: it needs Docker and privileged containers. A run of the catalog
 * takes hours, thus its timeout is a day.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    testTimeout: 24 * 60 * 60 * 1000,
  },
});
