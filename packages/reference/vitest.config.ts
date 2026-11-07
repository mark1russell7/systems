import { defineConfig } from "vitest/config";

/** This configuration starts the tests of the reference service. Each test listens on a free port of 127.0.0.1. */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
