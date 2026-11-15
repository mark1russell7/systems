import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/** The floors of the coverage of this package (SYS-109), from coverage-floors.json at the root of the repository. */
const floors = JSON.parse(readFileSync(new URL("../../coverage-floors.json", import.meta.url), "utf8")).floors["kind"];
if (floors === undefined) throw new Error("coverage-floors.json has no floors for kind.");

/**
 * This configuration starts the tests of the kind package. The lab test starts only with
 * `KIND_LAB=1`, because it makes a cluster in Docker. A cluster takes minutes, thus the timeout
 * of a test is one hour.
 */
export default defineConfig({
  test: {
    coverage: { thresholds: floors },
    include: ["src/**/*.{test,spec}.ts"],
    testTimeout: 60 * 60 * 1000,
    hookTimeout: 60 * 60 * 1000,
  },
});
