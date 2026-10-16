import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as backoffEntry from "./backoff.ts";
import * as clockEntry from "./clock.ts";
import * as heartbeatEntry from "./heartbeat.ts";
import * as root from "./index.ts";
import * as redisEntry from "./redis.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * This function follows the imports of a module that load code at run time, and gives each
 * module that it reaches: a file of the package, or the specifier of another package. An import
 * of types only loads nothing.
 */
const reach = (entry: string): { files: string[]; packages: string[] } => {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^(import|export)\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gms)) {
      if (match[2] !== undefined) continue;
      const specifier = match[3]!;
      if (specifier.startsWith(".")) visit(resolve(dirname(file), specifier));
      else packages.add(specifier);
    }
  };
  visit(join(here, entry));
  return { files: [...files].map((file) => file.slice(here.length + 1).replaceAll("\\", "/")).sort(), packages: [...packages].sort() };
};

describe("the timer entries: a client in a browser can import them", () => {
  it("load no other package: no node: module, no zod, no quantity", () => {
    expect(reach("clock.ts")).toEqual({ files: ["clock.ts"], packages: [] });
    expect(reach("heartbeat.ts")).toEqual({ files: ["clock.ts", "heartbeat.ts"], packages: [] });
    expect(reach("backoff.ts")).toEqual({ files: ["backoff.ts"], packages: [] });
  });

  it("give their functions, and the root gives them too", () => {
    expect(Object.keys(clockEntry).sort()).toEqual(["platformClock", "realClock"]);
    expect(Object.keys(heartbeatEntry).sort()).toEqual(["detectionTime", "heartbeat"]);
    expect(Object.keys(backoffEntry).sort()).toEqual(["backoffBand", "backoffDelay", "backoffProblems"]);
    for (const name of [...Object.keys(clockEntry), ...Object.keys(heartbeatEntry), ...Object.keys(backoffEntry)])
      expect(root, name).toHaveProperty(name);
  });

  it("keep the exports of 0.3 that moved: heartbeatDetection in the Redis entry, and replay in the root", () => {
    expect(redisEntry.heartbeatDetection).toBe(root.heartbeatDetection);
    expect(typeof root.replay).toBe("function");
  });
});
