import { defineConfig } from "tsdown";

/**
 * This configuration builds the package for npm: ES modules and their declarations in `build/`.
 * The workspace uses the source. A declaration map points at `src/`, and the package does not
 * contain `src/`, thus the build makes no declaration maps.
 */
export default defineConfig({
  // The schemas are an entry of their own: the root entry does not import zod. The entry of the
  // times has a table of the times, the frequencies and the counts only.
  entry: ["src/index.ts", "src/schema.ts", "src/time.ts"],
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
