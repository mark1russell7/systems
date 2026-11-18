import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/** The floors of the coverage of this package (SYS-109), from coverage-floors.json at the root of the repository. */
const floors = JSON.parse(readFileSync(new URL("../../coverage-floors.json", import.meta.url), "utf8")).floors["harness"];
if (floors === undefined) throw new Error("coverage-floors.json has no floors for harness.");

export default defineConfig({
  test: {
    coverage: { thresholds: floors },
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
