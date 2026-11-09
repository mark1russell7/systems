import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/** The floors of the coverage of this package (SYS-109), from coverage-floors.json at the root of the repository. */
const floors = JSON.parse(readFileSync(new URL("../../coverage-floors.json", import.meta.url), "utf8")).floors["reference"];
if (floors === undefined) throw new Error("coverage-floors.json has no floors for reference.");

/** This configuration starts the tests of the reference service. Each test listens on a free port of 127.0.0.1. */
export default defineConfig({
  test: {
    coverage: { thresholds: floors },
    include: ["src/**/*.test.ts"],
  },
});
