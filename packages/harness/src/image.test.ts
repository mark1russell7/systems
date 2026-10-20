import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildImage, ImageSource, Subject, Target } from "./cell.ts";
import {
  CLIENT_NAMES,
  SHIPPED_CLIENTS,
  SHIPPED_NAMES,
  buildFailure,
  buildOnce,
  imageProblems,
  inContext,
  planOf,
  programOf,
  subjectClient,
  subjectProblems,
  targetSourceOf,
  unlockedManifests,
  unpinnedBases,
} from "./image.ts";
import { clientOf } from "./lab.ts";
import { clientSchema, imageSourceSchema, subjectSchema } from "./schema.ts";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const NODE = "node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1";
/** the folder that holds this package: `packages` in the workspace, `@mark1russell7` from npm */
const ABOVE = dirname(fileURLToPath(new URL("..", import.meta.url)));

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
/** a new folder with these files, as a caller's build context */
const contextWith = (files: Readonly<Record<string, string>>): string => {
  const root = mkdtempSync(join(tmpdir(), "harness-subject-"));
  folders.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};
const APP = {
  Dockerfile: `FROM ${NODE}\nWORKDIR /opt/subject\nCOPY . ./\n`,
  "package.json": '{ "name": "subject", "private": true }\n',
  "npm-lock.json": '{ "lockfileVersion": 3 }\n',
  "app.mjs": "console.log('{\"ev\":\"listening\"}');\n",
};
const build = (context: string, more: Partial<BuildImage> = {}): BuildImage => ({ kind: "build", name: "caller", context, ...more });
const builtOf = (source: string | ImageSource) => {
  const plan = planOf(source);
  if (plan.kind !== "build") throw new Error("not a build");
  return plan;
};

describe("the image sources", () => {
  it("pulls a stock image by its name as it is, and a pinned image by its digest", () => {
    expect(planOf("redis:7.4")).toEqual({ kind: "pull", image: "redis:7.4" });
    expect(planOf({ kind: "pinned", image: `ghcr.io/owner/subject:1.2.0@${DIGEST}` })).toEqual({ kind: "pull", image: `ghcr.io/owner/subject:1.2.0@${DIGEST}` });
    // a tag alone moves: a pinned image names its digest
    expect(() => planOf({ kind: "pinned", image: "ghcr.io/owner/subject:1.2.0" })).toThrow(/not pinned by digest/);
    expect(() => planOf({ kind: "pinned", image: "subject@sha256:abc" })).toThrow(/not pinned by digest/);
  });

  it("builds the gRPC client from the files of its folder in the package, with a tag from their content", () => {
    const plan = builtOf({ kind: "shipped", name: "grpc" });
    expect(plan.tag).toMatch(/^loom-harness-grpc:[0-9a-f]{12}$/);
    expect(plan.dockerfile).toBe("harness/image/grpc/Dockerfile");
    expect(plan.files.map((each) => each.at)).toEqual(["Dockerfile", "client-grpc.mjs", "npm-lock.json", "package.json"].map((file) => `harness/image/grpc/${file}`));
    // the image starts from the stock Node image, pinned by digest
    const dockerfile = readFileSync(plan.files.find((each) => each.at === plan.dockerfile)!.file, "utf8");
    expect(/^FROM (\S+)$/m.exec(dockerfile)?.[1]).toBe(NODE);
  });

  it("gives a caller's build context of the same files the same content digits as the shipped image", () => {
    const shipped = builtOf({ kind: "shipped", name: "grpc" });
    const caller = builtOf({
      kind: "build",
      name: "caller-grpc",
      context: ABOVE,
      dockerfile: "harness/image/grpc/Dockerfile",
      files: ["harness/image/grpc"],
    });
    expect(caller.tag.split(":")[1]).toBe(shipped.tag.split(":")[1]);
    expect(caller.tag.startsWith("caller-grpc:")).toBe(true);
    expect(caller.files.map((each) => each.at)).toEqual(shipped.files.map((each) => each.at));
  });

  it("holds each image that the harness ships to the rules of a caller's build: a digest on each FROM, a lockfile for each manifest", () => {
    for (const name of SHIPPED_NAMES) expect(() => planOf({ kind: "shipped", name }), name).not.toThrow();
    // each client that the harness ships is an image source and a command, as a caller's client image is
    for (const name of CLIENT_NAMES) {
      expect(imageProblems(SHIPPED_CLIENTS[name].image as ImageSource), name).toEqual([]);
      expect(SHIPPED_CLIENTS[name].command.length, name).toBeGreaterThan(0);
    }
    // the WebSocket client of @procedures/client is a program of its subject: the client repository builds it (CLI-33)
    expect((CLIENT_NAMES as readonly string[]).includes("procedures-ws")).toBe(false);
    expect((SHIPPED_NAMES as readonly string[]).includes("procedures")).toBe(false);
  });

  it("publishes each file of each image that the harness ships: a build from npm reads the same files", () => {
    // the files of the package on npm, by the field `files` of its package.json: a file, or a folder
    const published: readonly string[] = JSON.parse(readFileSync(join(ABOVE, "harness", "package.json"), "utf8")).files;
    const isPublished = (path: string) => published.some((entry) => path === entry || path.startsWith(`${entry}/`));
    const missing = SHIPPED_NAMES.flatMap((name) => {
      const plan = planOf({ kind: "shipped", name });
      if (plan.kind !== "build") return [];
      // the parts of the prober are in the package of the prober, and a .gitignore is not an input of a build
      const own = [plan.dockerfile, ...plan.files.map((each) => each.at)].filter((at) => at.startsWith("harness/") && !at.endsWith("/.gitignore"));
      return own.map((at) => at.slice("harness/".length)).filter((path) => !isPublished(path)).map((path) => `${name}: ${path}`);
    });
    expect(missing).toEqual([]);
  });

  it("gives the error lines of a failed build, then its last lines: the diagnostic of a compiler comes before the tail", () => {
    const head = ["#1 [internal] load build definition", "#9 1.010 prober.bpf.c:212:20: error: no member named 'x' in 'struct y'"];
    const tail = Array.from({ length: 15 }, (_, at) => `#9 1.0${at} note: line ${at}`);
    expect(buildFailure([...head, ...tail].join("\n")).split("\n")).toEqual([head[1], "...", ...tail]);
    // a short output is its own tail, with no line before it
    expect(buildFailure("ERROR: failed to solve\n")).toBe("ERROR: failed to solve");
  });

  it("builds a caller's context: each file with its path in the context, and a new tag when a file changes", () => {
    const context = contextWith(APP);
    const plan = builtOf(build(context));
    expect(plan.dockerfile).toBe("Dockerfile");
    expect(plan.files.map((each) => each.at)).toEqual(["Dockerfile", "app.mjs", "npm-lock.json", "package.json"]);
    expect(plan.tag).toMatch(/^caller:[0-9a-f]{12}$/);
    // the same content gives the same tag, and a changed program gives another
    expect(builtOf(build(context)).tag).toBe(plan.tag);
    writeFileSync(join(context, "app.mjs"), "console.log('changed');\n");
    expect(builtOf(build(context)).tag).not.toBe(plan.tag);
  });

  it("builds only the files that a caller names, with a Dockerfile in a folder of the context", () => {
    const context = contextWith({ ...APP, "notes.txt": "not in the image\n", "image/Dockerfile": `FROM ${NODE}\n` });
    const plan = builtOf(build(context, { dockerfile: "./image/Dockerfile", files: ["image/Dockerfile", "app.mjs"] }));
    expect(plan.dockerfile).toBe("image/Dockerfile");
    expect(plan.files.map((each) => each.at)).toEqual(["image/Dockerfile", "app.mjs"]);
    // another Dockerfile of the same files is another image
    const files = ["Dockerfile", "image/Dockerfile", "app.mjs"];
    expect(builtOf(build(context, { files })).tag).not.toBe(builtOf(build(context, { dockerfile: "image/Dockerfile", files })).tag);
  });

  it("refuses a build with a base that no digest pins, a manifest without a lockfile, or no Dockerfile", () => {
    expect(() => planOf(build(contextWith({ ...APP, Dockerfile: "FROM node:24-alpine\n" })))).toThrow(/the base node:24-alpine is not pinned by digest/);
    const unlocked = contextWith({ Dockerfile: APP.Dockerfile, "package.json": APP["package.json"], "app.mjs": APP["app.mjs"] });
    expect(() => planOf(build(unlocked))).toThrow(/package.json has no lockfile/);
    expect(() => planOf(build(contextWith({ "app.mjs": APP["app.mjs"] })))).toThrow(/the context has no Dockerfile/);
  });

  it("drops a failed build from its cache, thus a later cell builds again after a fault of Docker or of the network", async () => {
    const plan = builtOf(build(contextWith(APP), { name: "flaky" }));
    const staged: string[][] = [];
    const flaky = async (context: string) => {
      staged.push(readdirSync(context).sort());
      if (staged.length === 1) throw new Error("the daemon went away");
    };
    // with no waits, a failed build fails at once
    await expect(buildOnce(plan, flaky, [])).rejects.toThrow(/the daemon went away/);
    await expect(buildOnce(plan, flaky, [])).resolves.toBe(plan.tag);
    // a build that worked stays: the third call builds nothing
    await expect(buildOnce(plan, flaky, [])).resolves.toBe(plan.tag);
    expect(staged).toEqual([
      ["Dockerfile", "app.mjs", "npm-lock.json", "package.json"],
      ["Dockerfile", "app.mjs", "npm-lock.json", "package.json"],
    ]);
  });

  it("tries a failed build again after each wait, in the same context, and fails after the last one", async () => {
    const plan = builtOf(build(contextWith(APP), { name: "retried" }));
    let tries = 0;
    const twice = async () => {
      tries += 1;
      if (tries <= 2) throw new Error("the registry did not answer");
    };
    await expect(buildOnce(plan, twice, [1, 1])).resolves.toBe(plan.tag);
    expect(tries).toBe(3);
    const never = builtOf(build(contextWith(APP), { name: "never" }));
    let failed = 0;
    await expect(
      buildOnce(never, async () => {
        failed += 1;
        throw new Error("the registry did not answer");
      }, [1]),
    ).rejects.toThrow(/the registry did not answer/);
    expect(failed).toBe(2);
  });

  it("finds each FROM that no digest pins", () => {
    const dockerfile = [
      `FROM --platform=linux/amd64 golang:1.27@${DIGEST} AS build`,
      "# FROM a comment is no base",
      "FROM build AS test",
      "FROM scratch",
      "ARG BASE",
      "FROM ${BASE}",
      "from alpine:3.23 \\",
      "  AS run",
      "FROM run",
    ].join("\n");
    expect(unpinnedBases(dockerfile)).toEqual(["${BASE}", "alpine:3.23"]);
  });

  it("finds each manifest of packages without a lockfile in its folder or a folder above it", () => {
    expect(unlockedManifests(["package.json", "npm-lock.json"])).toEqual([]);
    // a workspace has one lockfile at its root
    expect(unlockedManifests(["pnpm-lock.yaml", "packages/a/package.json", "native/Cargo.toml"])).toEqual(["native/Cargo.toml"]);
    expect(unlockedManifests(["native/Cargo.toml", "native/Cargo.lock", "go.mod"])).toEqual([]);
  });

  it("gives the problems of a source as data", () => {
    expect(inContext("image/Dockerfile")).toBe(true);
    for (const path of ["", "/etc/passwd", "../outside", "a/../../b", "C:/x", "a\\b"]) expect(inContext(path), path).toBe(false);
    expect(imageProblems(build("subject", { name: "Caller" }))).toEqual(["Caller is not the name of a repository"]);
    expect(imageProblems(build("subject", { files: ["../outside"] }))).toEqual(["../outside is not a path in the context"]);
    expect(imageProblems(build("subject", { files: [] }))).toEqual(["the build names no files"]);
    expect(imageProblems(build(""))).toEqual(["the build names no context"]);
    expect(imageProblems({ kind: "shipped", name: "nope" } as never)).toEqual([`the harness ships no image nope: ${SHIPPED_NAMES.join(", ")}`]);
    expect(imageProblems({ kind: "registry" } as never)).toEqual(['"registry" is not a kind of image source: pinned, build or shipped']);
  });
});

describe("the subjects", () => {
  const caller: Subject = {
    name: "procedures",
    image: { kind: "pinned", image: `ghcr.io/owner/procedures-subject:0.8.0@${DIGEST}` },
    base: NODE,
    programs: { client: ["node", "/opt/subject/client-ws.mjs"], server: ["node", "/opt/subject/server-ws.mjs"] },
  };

  it("gives the client of a subject: a client that the harness ships by its name, another as an image and its command", () => {
    const shipped: Subject = { name: "grpc", image: { kind: "shipped", name: "grpc" }, base: NODE, programs: { client: ["node", "/opt/harness/grpc/client-grpc.mjs"] } };
    expect(subjectClient(shipped)).toBe("grpc");
    expect(subjectClient(caller)).toEqual({ image: caller.image, command: ["node", "/opt/subject/client-ws.mjs"] });
    expect(programOf(caller, "server")).toEqual(["node", "/opt/subject/server-ws.mjs"]);
    expect(() => programOf(caller, "observer")).toThrow(/has no program observer/);
  });

  it("gives the problems of a subject as data", () => {
    expect(subjectProblems(caller)).toEqual([]);
    expect(subjectProblems({ ...caller, base: "node:24" })).toEqual(["the base node:24 is not pinned by digest"]);
    expect(subjectProblems({ ...caller, programs: {} })).toEqual(["the subject has no programs"]);
    expect(subjectProblems({ ...caller, programs: { client: [] } })).toEqual(["the program client is not a command"]);
  });

  it("gives the image that a target operates: its subject, or its stock image", () => {
    const target: Target = { image: NODE, port: 8080, ready: "listening" };
    expect(targetSourceOf(target)).toBe(NODE);
    expect(targetSourceOf({ ...target, subject: caller.image })).toEqual(caller.image);
  });

  it("gives the client of each run from its source, and names no client that the harness does not ship", async () => {
    await expect(clientOf({ image: caller.image, command: ["node", "/opt/subject/client-ws.mjs"] })).resolves.toEqual({
      clientImage: `ghcr.io/owner/procedures-subject:0.8.0@${DIGEST}`,
      command: ["node", "/opt/subject/client-ws.mjs"],
      clientKind: "image",
      source: caller.image,
    });
    await expect(clientOf({ image: NODE, command: ["node"] })).resolves.toEqual({ clientImage: NODE, command: ["node"], clientKind: "image" });
    await expect(clientOf("nope" as never)).rejects.toThrow(/ships no client nope/);
  });
});

describe("the schemas", () => {
  it("accepts a subject as JSON, and names each problem of one", () => {
    const subject: Subject = {
      name: "procedures",
      image: { kind: "build", name: "procedures-subject", context: "client", dockerfile: "harness/procedures-subject/Dockerfile", files: ["package.json", "packages/client"] },
      base: NODE,
      programs: { client: ["node", "/opt/subject/client-ws.mjs"], server: ["node", "/opt/subject/server-ws.mjs"] },
    };
    const json = JSON.parse(JSON.stringify(subject)) as unknown;
    expect(subjectSchema.parse(json)).toEqual(subject);
    const pinned = { ...subject, image: { kind: "pinned", image: "ghcr.io/owner/subject:0.8.0" } };
    expect(subjectSchema.safeParse(pinned).error?.issues.map((issue) => issue.message)).toEqual([
      "ghcr.io/owner/subject:0.8.0 is not pinned by digest: name@sha256:<64 hex digits>",
    ]);
    // a key that the shape does not know is a mistake, not a setting
    expect(subjectSchema.safeParse({ ...subject, tag: "latest" }).success).toBe(false);
    expect(imageSourceSchema.safeParse({ kind: "shipped", name: "nope" }).success).toBe(false);
  });

  it("accepts a client by its name or as an image with its command", () => {
    expect(clientSchema.parse("grpc")).toBe("grpc");
    expect(clientSchema.safeParse("procedures-ws").success).toBe(false);
    const image = { image: { kind: "build", name: "caller", context: "subject", files: ["Dockerfile"] }, command: ["node", "client.mjs"] };
    expect(clientSchema.parse(image)).toEqual(image);
    expect(clientSchema.safeParse("nope").success).toBe(false);
    expect(clientSchema.safeParse({ image: "x", command: [] }).success).toBe(false);
  });
});
