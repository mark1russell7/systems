import { defineConfig } from "tsdown";

/**
 * This configuration builds the package for npm: ES modules and their declarations in `build/`.
 * The build holds each JSON document in the JavaScript. The workspace uses the source. A
 * declaration map points at `src/`, and the package does not contain `src/`, thus the build makes
 * no declaration maps.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "build",
  format: "esm",
  platform: "neutral",
  target: "es2022",
  dts: { sourcemap: false },
  sourcemap: true,
});
