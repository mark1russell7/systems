import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as backoffEntry from "./backoff.ts";
import * as clockEntry from "./clock.ts";
import * as heartbeatEntry from "./heartbeat.ts";
import * as httpEntry from "./http.ts";
import * as root from "./index.ts";
import * as limiterEntry from "./limiter.ts";
import * as rabbitEntry from "./rabbitmq.ts";
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

const require = createRequire(import.meta.url);
const SCOPE = "@mark1russell7/";

/** This function gives the source file of a specifier of a package of this repository, from the exports of its manifest. */
const sourceOf = (specifier: string): string => {
  const [scope, name, ...rest] = specifier.split("/");
  const manifest = require.resolve(`${scope}/${name}/package.json`);
  const exports = (JSON.parse(readFileSync(manifest, "utf8")) as { exports: Record<string, string> }).exports;
  const target = exports[rest.length === 0 ? "." : `./${rest.join("/")}`];
  if (target === undefined) throw new Error(`${specifier} is not an export of its package`);
  return resolve(dirname(manifest), target);
};

/**
 * This function follows the imports that load code at run time from an entry, also into the other
 * packages of this repository. It gives each package outside this repository that it reaches, and
 * each `node:` module.
 */
const reachAll = (entry: string, from = here): string[] => {
  const files = new Set<string>();
  const outside = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^(import|export)\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gms)) {
      if (match[2] !== undefined) continue;
      const specifier = match[3]!;
      if (specifier.startsWith(".")) visit(resolve(dirname(file), specifier));
      else if (specifier.startsWith(SCOPE)) visit(sourceOf(specifier));
      else outside.add(specifier);
    }
  };
  visit(join(from, entry));
  return [...outside].sort();
};

describe("zod is an optional peer: no entry of the service loads it (SYS-12)", () => {
  it("reaches no zod from any entry, through quantity and the replay of the algebra too", () => {
    for (const entry of ["index.ts", "testing.ts", "redis.ts", "pg.ts", "mongodb.ts", "rabbitmq.ts", "clock.ts", "heartbeat.ts", "backoff.ts", "limiter.ts"])
      expect(reachAll(entry), entry).not.toContain("zod");
    // the root loads no other package and no node: module at run time
    expect(reachAll("index.ts")).toEqual([]);
    // the negative control: the schema entry of quantity loads zod, and the search finds it
    const schema = sourceOf("@mark1russell7/quantity/schema");
    expect(reachAll(schema.slice(dirname(schema).length + 1), dirname(schema))).toContain("zod");
  });

  it("marks zod optional in the manifest, beside amqplib, ioredis, pg and mongodb", () => {
    const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      peerDependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };
    expect(Object.keys(manifest.peerDependencies).sort()).toEqual(["amqplib", "ioredis", "mongodb", "pg", "zod"]);
    expect(manifest.peerDependenciesMeta).toEqual({
      amqplib: { optional: true },
      ioredis: { optional: true },
      mongodb: { optional: true },
      pg: { optional: true },
      zod: { optional: true },
    });
  });
});

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

describe("the pg entry: pg is an optional peer, loaded only at the connect", () => {
  it("loads no pg at its import, and no node: module other than node:net", () => {
    const { packages } = reach("pg.ts");
    expect(packages).not.toContain("pg");
    expect(packages.filter((name) => name.startsWith("node:"))).toEqual(["node:net"]);
  });
});

describe("the mongodb entry: mongodb is an optional peer, loaded only at the connect", () => {
  it("loads no mongodb at its import, and no node: module other than node:net", () => {
    const { packages } = reach("mongodb.ts");
    expect(packages).not.toContain("mongodb");
    expect(packages.filter((name) => name.startsWith("node:"))).toEqual(["node:net"]);
  });

  it("does not load the fakes of its tests", () => {
    expect(reach("mongodb.ts").files.filter((file) => file.includes("fake"))).toEqual([]);
  });

  it("is in the manifest, for the source and for npm", () => {
    const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      exports: Record<string, string>;
      publishConfig: { exports: Record<string, { types: string; default: string }> };
    };
    expect(manifest.exports["./mongodb"]).toBe("./src/mongodb.ts");
    expect(manifest.publishConfig.exports["./mongodb"]).toEqual({ types: "./build/mongodb.d.ts", default: "./build/mongodb.js" });
  });
});

describe("the rabbitmq entry: amqplib is an optional peer, loaded only at the connect", () => {
  it("loads no amqplib at its import, and no node: module other than node:net", () => {
    const { packages } = reach("rabbitmq.ts");
    expect(packages).not.toContain("amqplib");
    expect(packages.filter((name) => name.startsWith("node:"))).toEqual(["node:net"]);
  });

  it("does not load the fakes of its tests", () => {
    expect(reach("rabbitmq.ts").files.filter((file) => file.includes("fake"))).toEqual([]);
  });

  it("is in the manifest, for the source and for npm", () => {
    const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      exports: Record<string, string>;
      publishConfig: { exports: Record<string, { types: string; default: string }> };
    };
    expect(manifest.exports["./rabbitmq"]).toBe("./src/rabbitmq.ts");
    expect(manifest.publishConfig.exports["./rabbitmq"]).toEqual({ types: "./build/rabbitmq.d.ts", default: "./build/rabbitmq.js" });
  });

  it("shares the backoff of the core with the redis entry, which keeps its export of 0.5", () => {
    expect(rabbitEntry.retryBackoff).toBe(redisEntry.retryBackoff);
  });
});

describe("the http entry: Node only, on node:http and node:net", () => {
  it("loads no node: module other than node:http and node:net, and no package other than quantity", () => {
    const { packages } = reach("http.ts");
    expect(packages.filter((name) => name.startsWith("node:")).every((name) => name === "node:http" || name === "node:net")).toBe(true);
    expect(packages.filter((name) => !name.startsWith("node:"))).toEqual(["@mark1russell7/quantity"]);
  });

  it("does not load the fakes of its tests", () => {
    expect(reach("http.ts").files.filter((file) => file.includes("fake"))).toEqual([]);
  });

  it("gives its functions, and the root does not give them", () => {
    expect(Object.keys(httpEntry).sort()).toEqual([
      "PROBE_KINDS",
      "endRecord",
      "handle",
      "httpTransport",
      "limitedResponse",
      "ndjson",
      "outcomeResponse",
      "pathOf",
      "probeHandler",
      "probeResponse",
      "probeServer",
      "sse",
      "writeOutcome",
    ]);
    for (const name of Object.keys(httpEntry)) expect(root, name).not.toHaveProperty(name);
  });
});

describe("the limiter entry: a client in a browser can import it (SYS-28)", () => {
  it("loads only quantity: no node: module and no zod", () => {
    expect(reach("limiter.ts").packages).toEqual(["@mark1russell7/quantity"]);
    expect(reachAll("limiter.ts")).toEqual([]);
  });

  it("gives its functions, and the root gives them too", () => {
    expect(Object.keys(limiterEntry).sort()).toEqual([
      "SLIDING_WINDOW_MACHINE",
      "TOKEN_BUCKET_MACHINE",
      "decide",
      "freeAt",
      "idleSpan",
      "keyedLimiter",
      "limitRule",
      "limiterMachine",
      "limiterProblems",
      "limiterStateOf",
      "longestRetryAfter",
      "memoryStore",
      "retryAfterSeconds",
    ]);
    for (const name of Object.keys(limiterEntry)) expect(root, name).toHaveProperty(name);
  });

  it("is in the manifest, for the source and for npm", () => {
    const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      exports: Record<string, string>;
      publishConfig: { exports: Record<string, { types: string; default: string }> };
    };
    expect(manifest.exports["./limiter"]).toBe("./src/limiter.ts");
    expect(manifest.publishConfig.exports["./limiter"]).toEqual({ types: "./build/limiter.d.ts", default: "./build/limiter.js" });
  });
});

describe("the root entry: free of node: modules", () => {
  it("loads no node: module", () => {
    expect(reach("index.ts").packages.filter((name) => name.startsWith("node:"))).toEqual([]);
  });

  it("gives the worker loop and the queue drain, which load only quantity (SYS-14)", () => {
    for (const name of ["workerLoop", "queueDrain", "redeliverOnce"]) expect(root, name).toHaveProperty(name);
    for (const entry of ["worker.ts", "queue.ts"]) expect(reach(entry).packages, entry).toEqual(["@mark1russell7/quantity"]);
  });
});
