import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { BuildImage, Client, ClientImage, ImageSource, Shipped, ShippedImage, Subject, Target } from "./cell.ts";

/**
 * This module resolves the source of each image (`ImageSource`) to an image that a lab can start.
 * A pinned image is its own name. A build context, or an image that the harness ships, becomes a
 * build with a tag from its content. Each image of the harness is a shipped source in one table.
 * Thus the procedures image of a subject is data, as the image of a caller is.
 */

/**
 * These are the roots of the two packages that the shipped images read: this package, and the
 * prober that Node resolves for it. In a workspace, they are two folders side by side. From npm,
 * the prober is a link, and a Docker build context does not follow a link. Thus each image builds
 * from a context that the harness copies from the two roots.
 */
const ROOTS: Readonly<Record<string, string>> = {
  harness: fileURLToPath(new URL("..", import.meta.url)),
  prober: dirname(realpathSync(createRequire(import.meta.url).resolve("@mark1russell7/prober/package.json"))),
};

/** This function gives the path of a part of a shipped image, which is `<package>/<path>` in the context. */
const pathOf = (part: string): string => {
  const [root, ...rest] = part.split("/");
  const base = ROOTS[root!];
  if (base === undefined) throw new Error(`${part} is in no package that the images read`);
  return join(base, ...rest);
};

/** A shipped context is the build context of a shipped image: its Dockerfile, and each file or folder that the Dockerfile reads, as `<package>/<path>`. */
interface ShippedContext {
  readonly name: string;
  readonly dockerfile: string;
  readonly from: readonly string[];
}

/** These are the build contexts of the images that the harness ships, by their names. */
const SHIPPED: Readonly<Record<Shipped, ShippedContext>> = {
  // the prober, the TCP client, the injector and the namespace admin
  harness: {
    name: "loom-harness",
    dockerfile: "harness/image/Dockerfile",
    from: ["harness/image/Dockerfile", "harness/image/native", "prober/bpf", "prober/native", "prober/fixtures"],
  },
  // the Node client: ioredis 6.0.0 on Node 24.21.0
  node: { name: "loom-harness-node", dockerfile: "harness/image/node/Dockerfile", from: ["harness/image/node"] },
  // the Go HTTP client: the http.Transport of Go 1.27.2
  "go-http": { name: "loom-harness-go-http", dockerfile: "harness/image/go-http/Dockerfile", from: ["harness/image/go-http"] },
  // the Node HTTP clients: the http.Agent of Node 24.21.0, and undici 8.12.2
  "node-http": { name: "loom-harness-node-http", dockerfile: "harness/image/node-http/Dockerfile", from: ["harness/image/node-http"] },
  // the MongoDB client: the driver mongodb 7.7.0 on Node 24.21.0, and its step-down script
  mongo: { name: "loom-harness-mongo", dockerfile: "harness/image/mongo/Dockerfile", from: ["harness/image/mongo"] },
  // the PostgreSQL client: node-postgres (pg 8.23.1 with pg-pool 3.14.0) on Node 24.21.0
  pg: { name: "loom-harness-pg", dockerfile: "harness/image/pg/Dockerfile", from: ["harness/image/pg"] },
  // the client of HikariCP 7.1.0 over pgjdbc 42.7.13 on Temurin 21.0.12.1: its jars by their SHA-256
  hikari: { name: "loom-harness-hikari", dockerfile: "harness/image/hikari/Dockerfile", from: ["harness/image/hikari"] },
  // the RabbitMQ client: amqplib 2.2.0 on Node 24.21.0
  amqp: { name: "loom-harness-amqp", dockerfile: "harness/image/amqp/Dockerfile", from: ["harness/image/amqp"] },
  // @procedures/client 0.7.0 on Node 24.21.0: its WebSocket client, and the script of its server
  procedures: { name: "loom-harness-procedures", dockerfile: "harness/image/procedures/Dockerfile", from: ["harness/image/procedures"] },
  // the router of a middlebox chain: NAT and conntrack, with a form for a forgotten flow
  router: { name: "loom-harness-router", dockerfile: "harness/image/router/Dockerfile", from: ["harness/image/router"] },
  // PgBouncer 1.26.1, a pooler hop: built from its release tarball, by its SHA-256
  pgbouncer: { name: "loom-harness-pgbouncer", dockerfile: "harness/image/pgbouncer/Dockerfile", from: ["harness/image/pgbouncer"] },
  // Pgpool-II 4.7.3, a pooler hop: built from the source of its tag, by its SHA-256
  pgpool: { name: "loom-harness-pgpool", dockerfile: "harness/image/pgpool/Dockerfile", from: ["harness/image/pgpool"] },
};

/** These are the names of the images that the harness ships. */
export const SHIPPED_NAMES: readonly [Shipped, ...Shipped[]] = Object.keys(SHIPPED) as [Shipped, ...Shipped[]];

/** This image is the stock base of the Node images of the harness: Node 24.21.0 on Alpine, pinned by digest. */
const NODE_BASE = "node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1";

/**
 * These are the subjects that the harness ships, by their names. `procedures` is
 * `@procedures/client` on Node: its WebSocket client (`client-ws.mjs`) and its server
 * (`server-ws.mjs`), from one image. Thus the client and the server use one release.
 */
export const SUBJECTS: Readonly<Record<"procedures", Subject>> = {
  procedures: {
    name: "procedures",
    image: { kind: "shipped", name: "procedures" },
    base: NODE_BASE,
    programs: {
      client: ["node", "/opt/harness/procedures/client-ws.mjs"],
      server: ["node", "/opt/harness/procedures/server-ws.mjs"],
    },
  },
};

/** This function gives the source of a shipped image. */
const shipped = (name: Shipped): ImageSource => ({ kind: "shipped", name });

/**
 * These are the clients that the harness ships, by their names (`Client`): the image of each, and
 * its command. A cell that names a client gets this image and this command.
 */
export const SHIPPED_CLIENTS: Readonly<Record<Client, ClientImage>> = {
  tcp: { image: shipped("harness"), command: ["/opt/harness/client"] },
  ioredis: { image: shipped("node"), command: ["node", "/opt/harness/node/client-ioredis.mjs"] },
  "go-http": { image: shipped("go-http"), command: ["/opt/harness/client-go"] },
  "http-agent": { image: shipped("node-http"), command: ["node", "/opt/harness/node-http/client-agent.mjs"] },
  undici: { image: shipped("node-http"), command: ["node", "/opt/harness/node-http/client-undici.mjs"] },
  mongodb: { image: shipped("mongo"), command: ["node", "/opt/harness/mongo/client-mongo.mjs"] },
  pg: { image: shipped("pg"), command: ["node", "/opt/harness/pg/client-pg.mjs"] },
  hikari: {
    image: shipped("hikari"),
    command: ["java", "-Dslf4j.internal.verbosity=ERROR", "-cp", "/opt/harness/hikari/classes:/opt/harness/hikari/lib/*", "ClientHikari"],
  },
  amqp: { image: shipped("amqp"), command: ["node", "/opt/harness/amqp/client-amqp.mjs"] },
  "procedures-ws": { image: SUBJECTS.procedures.image, command: SUBJECTS.procedures.programs["client"]! },
};

/** These are the names of the clients that the harness ships. */
export const CLIENT_NAMES: readonly [Client, ...Client[]] = Object.keys(SHIPPED_CLIENTS) as [Client, ...Client[]];

/** This function gives the command of a program of a subject by its role. It fails when the subject has no such program. */
export const programOf = (subject: Subject, role: string): readonly string[] => {
  const program = Object.hasOwn(subject.programs, role) ? subject.programs[role] : undefined;
  if (program === undefined) throw new Error(`the subject ${subject.name} has no program ${role}`);
  return program;
};

/**
 * This function gives the client of a subject for a cell (`Cell.client`): the image of the subject,
 * with the command of a program. A client that the harness ships goes by its name, thus its records
 * stay the same.
 */
export const subjectClient = (subject: Subject, role = "client"): Client | ClientImage => {
  const client: ClientImage = { image: subject.image, command: programOf(subject, role) };
  return CLIENT_NAMES.find((name) => isDeepStrictEqual(SHIPPED_CLIENTS[name], client)) ?? client;
};

/** This pattern matches an image pinned by digest: a name, a tag or none, then `@sha256:` and 64 hex digits. */
export const PINNED: RegExp = /^[a-z0-9][A-Za-z0-9._\-/:]*@sha256:[0-9a-f]{64}$/;
/** This pattern matches the repository of a tag that the harness builds. Its parts are lower case, with `/` between them. */
export const REPOSITORY: RegExp = /^[a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*$/;

/** This function tells if a path stays in its context: relative, with `/` between its parts, and no `..`. */
export const inContext = (path: string): boolean =>
  typeof path === "string" &&
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !/^[A-Za-z]:/.test(path) &&
  !path.split("/").includes("..");

/** This function tells if a value is a command: an array of one text or more. */
const isCommand = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0 && value.every((word) => typeof word === "string" && word.length > 0);

/**
 * This function gives the problems of the source of an image, as data. A pinned image names a
 * digest. A build names a repository, a context, and paths that stay in the context. A shipped image
 * is one that the harness ships.
 */
export const imageProblems = (source: ImageSource): string[] => {
  const kind = (source as { readonly kind?: unknown } | null)?.kind;
  if (kind === "pinned") {
    const { image } = source as { readonly image?: unknown };
    return typeof image === "string" && PINNED.test(image) ? [] : [`${String(image)} is not pinned by digest: name@sha256:<64 hex digits>`];
  }
  if (kind === "shipped") {
    const { name } = source as { readonly name?: unknown };
    return typeof name === "string" && Object.hasOwn(SHIPPED, name) ? [] : [`the harness ships no image ${String(name)}: ${SHIPPED_NAMES.join(", ")}`];
  }
  if (kind === "build") {
    const build = source as Partial<BuildImage>;
    const problems: string[] = [];
    if (typeof build.name !== "string" || !REPOSITORY.test(build.name)) problems.push(`${String(build.name)} is not the name of a repository`);
    if (typeof build.context !== "string" || build.context.length === 0) problems.push("the build names no context");
    if (build.files !== undefined && (!Array.isArray(build.files) || build.files.length === 0)) problems.push("the build names no files");
    for (const path of [build.dockerfile ?? "Dockerfile", ...(Array.isArray(build.files) ? build.files : [])])
      if (!inContext(path)) problems.push(`${String(path)} is not a path in the context`);
    return problems;
  }
  return [`${JSON.stringify(kind)} is not a kind of image source: pinned, build or shipped`];
};

/**
 * This function gives the problems of a subject, as data. A subject has a name and a base that a
 * digest pins. Its image source has no problems, and each of its programs is a command.
 */
export const subjectProblems = (subject: Subject): string[] => {
  const programs = (subject as { readonly programs?: unknown }).programs;
  const roles = typeof programs === "object" && programs !== null ? Object.entries(programs) : [];
  return [
    ...(typeof subject.name === "string" && subject.name.length > 0 ? [] : ["the subject has no name"]),
    ...(typeof subject.base === "string" && PINNED.test(subject.base) ? [] : [`the base ${String(subject.base)} is not pinned by digest`]),
    ...imageProblems(subject.image),
    ...(roles.length === 0 ? ["the subject has no programs"] : []),
    ...roles.flatMap(([role, command]) => (isCommand(command) ? [] : [`the program ${role} is not a command`])),
  ];
};

/**
 * This function gives each `FROM` of a Dockerfile that no digest pins. A `FROM` of an earlier stage
 * by its name, or of `scratch`, needs no digest. A base from an `ARG` has no digest that the harness
 * can read, thus it is in the list too.
 */
export const unpinnedBases = (dockerfile: string): string[] => {
  const stages = new Set<string>(["scratch"]);
  const found: string[] = [];
  for (const line of dockerfile.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    const from = /^\s*FROM\s+(.+)$/i.exec(line)?.[1];
    if (from === undefined) continue;
    const [image, as, stage] = from.split(/\s+/).filter((word) => !word.startsWith("--"));
    if (image === undefined) continue;
    if (!stages.has(image.toLowerCase()) && !PINNED.test(image)) found.push(image);
    if (as?.toLowerCase() === "as" && stage !== undefined) stages.add(stage.toLowerCase());
  }
  return found;
};

/** These are the lockfiles of each manifest of packages. A manifest without a lockfile installs other packages each time. */
const LOCKFILES: Readonly<Record<string, readonly string[]>> = {
  "package.json": ["package-lock.json", "npm-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"],
  "Cargo.toml": ["Cargo.lock"],
};

/**
 * This function gives each manifest of packages in a context (`package.json`, `Cargo.toml`) that
 * has no lockfile in its folder or in a folder above it. The paths are the paths in the context.
 */
export const unlockedManifests = (paths: readonly string[]): string[] => {
  const present = new Set(paths);
  return paths.filter((path) => {
    const parts = path.split("/");
    const locks = LOCKFILES[parts.at(-1)!];
    if (locks === undefined) return false;
    for (let depth = parts.length - 1; depth >= 0; depth -= 1) {
      const folder = parts.slice(0, depth).join("/");
      if (locks.some((lock) => present.has(folder === "" ? lock : `${folder}/${lock}`))) return false;
    }
    return true;
  });
};

/**
 * An image plan tells how the harness gets the image of a source. It is a pull of an image by its
 * name, or a build of a context. A build has its tag, its Dockerfile, and each file with its path.
 */
export type ImagePlan =
  | { readonly kind: "pull"; readonly image: string }
  | {
      readonly kind: "build";
      readonly tag: string;
      readonly dockerfile: string;
      readonly files: ReadonlyArray<{ readonly file: string; readonly at: string }>;
    };

/** This function gives each file under a path, in a stable sequence, but not the output of a local build. */
const sources = (path: string): string[] => {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.name !== "target" && entry.name !== "node_modules")
    .flatMap((entry) => sources(join(path, entry.name)))
    .sort();
};

/** A part is a file or a folder of a context: its path on the machine, and its path in the context. */
interface Part {
  readonly path: string;
  readonly at: string;
}

/** This function gives the name, the Dockerfile and the parts of the context of a build or of a shipped image. */
const contextOf = (source: BuildImage | ShippedImage): { name: string; dockerfile: string; parts: Part[] } => {
  if (source.kind === "shipped") {
    const { name, dockerfile, from } = SHIPPED[source.name];
    return { name, dockerfile, parts: from.map((part) => ({ path: pathOf(part), at: part })) };
  }
  const root = resolve(source.context);
  return {
    name: source.name,
    dockerfile: posix.normalize(source.dockerfile ?? "Dockerfile"),
    parts: (source.files ?? ["."]).map((file) => ({ path: resolve(root, file), at: file === "." ? "" : file })),
  };
};

/** This function gives a text for a source in a message. */
const labelOf = (source: ImageSource): string =>
  source.kind === "pinned" ? source.image : `the ${source.kind === "build" ? "build" : "shipped image"} ${source.name}`;

const shippedPlans = new Map<Shipped, ImagePlan>();

/**
 * This function gives the plan of the image of a source. A stock image by its name, or a pinned
 * image, is a pull. A build or a shipped image is a build. Its tag is its name, then 12 digits of a
 * sha256. The sha256 reads the path of the Dockerfile, and the path and the content of each file.
 * Thus a changed program cannot operate as an old one.
 *
 * A build fails before it starts on a problem of its source. It also fails on a `FROM` that no
 * digest pins, and on a manifest of packages without a lockfile.
 */
export const planOf = (source: string | ImageSource): ImagePlan => {
  if (typeof source === "string") return { kind: "pull", image: source };
  const problems = imageProblems(source);
  if (problems.length > 0) throw new Error(`${labelOf(source)}: ${problems.join(", ")}`);
  if (source.kind === "pinned") return { kind: "pull", image: source.image };
  const known = source.kind === "shipped" ? shippedPlans.get(source.name) : undefined;
  if (known !== undefined) return known;
  const { name, dockerfile, parts } = contextOf(source);
  const files = parts.flatMap((part) =>
    sources(part.path).map((file) => ({ file, at: join(part.at, relative(part.path, file)).replaceAll("\\", "/") })),
  );
  const docker = files.find((each) => each.at === dockerfile);
  if (docker === undefined) throw new Error(`${labelOf(source)}: the context has no ${dockerfile}`);
  const unpinned = unpinnedBases(readFileSync(docker.file, "utf8"));
  const unlocked = unlockedManifests(files.map((each) => each.at));
  if (unpinned.length > 0 || unlocked.length > 0)
    throw new Error(
      `${labelOf(source)}: ${[
        ...unpinned.map((image) => `the base ${image} is not pinned by digest`),
        ...unlocked.map((path) => `${path} has no lockfile`),
      ].join(", ")}`,
    );
  const hash = createHash("sha256");
  hash.update(dockerfile);
  for (const { file, at } of files) {
    hash.update(at);
    hash.update(readFileSync(file));
  }
  const plan: ImagePlan = { kind: "build", tag: `${name}:${hash.digest("hex").slice(0, 12)}`, dockerfile, files };
  if (source.kind === "shipped") shippedPlans.set(source.name, plan);
  return plan;
};

/** This function builds a staged context with Docker, through Testcontainers. */
const dockerBuild = async (context: string, plan: Extract<ImagePlan, { readonly kind: "build" }>): Promise<void> => {
  const { GenericContainer } = await import("testcontainers");
  await GenericContainer.fromDockerfile(context, plan.dockerfile).build(plan.tag, { deleteOnExit: false });
};

const built = new Map<string, Promise<string>>();

/**
 * This function builds the image of a plan one time for each process, from a new context that it
 * copies the files into. Docker keeps its layers between runs. A build that fails leaves the cache.
 * Thus a later cell builds again after a fault of Docker or of the network.
 */
export const buildOnce = (
  plan: Extract<ImagePlan, { readonly kind: "build" }>,
  builder: (context: string, plan: Extract<ImagePlan, { readonly kind: "build" }>) => Promise<void> = dockerBuild,
): Promise<string> => {
  let tag = built.get(plan.tag);
  if (tag === undefined) {
    const building = (async () => {
      const context = mkdtempSync(join(tmpdir(), `${plan.tag.split(":")[0]!.replaceAll("/", "-")}-`));
      try {
        for (const { file, at } of plan.files) {
          mkdirSync(dirname(join(context, at)), { recursive: true });
          copyFileSync(file, join(context, at));
        }
        await builder(context, plan);
      } finally {
        rmSync(context, { recursive: true, force: true });
      }
      return plan.tag;
    })();
    // a failed build does not stay: the next caller tries again
    building.catch(() => {
      if (built.get(plan.tag) === building) built.delete(plan.tag);
    });
    built.set(plan.tag, building);
    tag = building;
  }
  return tag;
};

/**
 * This function gives an image that a lab can start, from its source. It is the name of a stock
 * image or of a pinned image, which the lab pulls, or the tag of a build. This function loads
 * Testcontainers only for a build.
 */
export const imageOf = async (source: string | ImageSource): Promise<string> => {
  const plan = planOf(source);
  return plan.kind === "pull" ? plan.image : buildOnce(plan);
};

/** This function gives the image of the harness: the prober, the TCP client, the injector and the namespace admin. */
export const harnessImage = (): Promise<string> => imageOf(shipped("harness"));
/** This function gives the image of the Node client. */
export const nodeClientImage = (): Promise<string> => imageOf(shipped("node"));
/** This function gives the image of the router. */
export const routerImage = (): Promise<string> => imageOf(shipped("router"));
/** This function gives the image of the Go HTTP client. */
export const goHttpImage = (): Promise<string> => imageOf(shipped("go-http"));
/** This function gives the image of the Node HTTP clients. */
export const nodeHttpImage = (): Promise<string> => imageOf(shipped("node-http"));
/** This function gives the image of the MongoDB client. */
export const mongoClientImage = (): Promise<string> => imageOf(shipped("mongo"));
/** This function gives the image of the PostgreSQL client. */
export const pgClientImage = (): Promise<string> => imageOf(shipped("pg"));
/** This function gives the image of the client of HikariCP over pgjdbc. */
export const hikariClientImage = (): Promise<string> => imageOf(shipped("hikari"));
/** This function gives the image of the RabbitMQ client: amqplib, with the client and the admin of a cluster cell. */
export const amqpClientImage = (): Promise<string> => imageOf(shipped("amqp"));
/** This function gives the image of the procedures subject: the WebSocket client of `@procedures/client`, and its server. */
export const proceduresImage = (): Promise<string> => imageOf(SUBJECTS.procedures.image);

/**
 * This function gives the source of the image that a target operates. It is the image of its
 * subject (`Target.subject`), a shipped image by its short form (`Target.harness`), or its stock image.
 */
export const targetSourceOf = (target: Target): string | ImageSource =>
  target.subject ?? (target.harness === undefined ? target.image : shipped(target.harness));

/** This function gives the image that a target operates: the image of its subject, or its stock image. */
export const targetImageOf = (target: Target): Promise<string> => imageOf(targetSourceOf(target));
