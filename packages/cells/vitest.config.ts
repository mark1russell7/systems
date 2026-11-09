import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/** The floors of the coverage of this package (SYS-109), from coverage-floors.json at the root of the repository. */
const floors = JSON.parse(readFileSync(new URL("../../coverage-floors.json", import.meta.url), "utf8")).floors["cells"];
if (floors === undefined) throw new Error("coverage-floors.json has no floors for cells.");

/**
 * This configuration starts the tests of the catalog. The runner of the cells is a test too, and
 * it starts only with CELLS=1: it needs Docker and privileged containers. A run of the catalog
 * takes hours, thus its timeout is a day.
 */
export default defineConfig({
  test: {
    coverage: { thresholds: floors },
    include: ["src/**/*.{test,spec}.ts"],
    testTimeout: 24 * 60 * 60 * 1000,
  },
});
