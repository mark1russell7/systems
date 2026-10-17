import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This folder is the root of the package, and its `image/` folder has the files of the image. */
const PACKAGE = fileURLToPath(new URL("../", import.meta.url));
/** This folder is the root of the repository, when the package is in the workspace of the repository. */
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
/** These are the packages of this repository that the image holds, in the sequence of their dependencies. */
export const WORKSPACE_PACKAGES: readonly ["quantity", "algebra", "service"] = ["quantity", "algebra", "service"];
/** These are the files of the image, by their name in the context and their source in the package. */
const FILES: ReadonlyArray<readonly [string, string]> = [
  ["Dockerfile", "image/Dockerfile"],
  ["package.json", "image/package.json"],
  ["npm-lock.json", "image/npm-lock.json"],
  ["app.mjs", "image/app.mjs"],
  ["client.mjs", "image/client.mjs"],
  ["agent.mjs", "image/agent.mjs"],
  ["watch.mjs", "image/watch.mjs"],
  ["compose.ts", "src/compose.ts"],
  ["backends.ts", "src/backends.ts"],
  ["conntrack.ts", "src/conntrack.ts"],
  ["drops.ts", "src/drops.ts"],
];

const shell = process.platform === "win32";

/** This function gives each file of a staged context, with its path in the context, in a stable sequence. */
const filesOf = (root: string, at = ""): string[] =>
  readdirSync(join(root, at), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? filesOf(root, join(at, entry.name)) : [join(at, entry.name)]))
    .sort();

/** This function gives the tag of a staged context from its content: the name, then 12 digits of a sha256. */
export const contentTag = (name: string, root: string): string => {
  const hash = createHash("sha256");
  for (const file of filesOf(root)) {
    hash.update(file.replaceAll("\\", "/"));
    hash.update(readFileSync(join(root, file)));
  }
  return `${name}:${hash.digest("hex").slice(0, 12)}`;
};

/** This function tells if the package is in the workspace of its repository. From npm, it is not. */
const inWorkspace = (): boolean =>
  existsSync(join(REPO, "pnpm-workspace.yaml")) && WORKSPACE_PACKAGES.every((name) => existsSync(join(REPO, "packages", name, "package.json")));

/**
 * This function gives the folder of each installed package that the image holds. Node finds a
 * package from the folder of a package that depends on it. The service depends on the algebra,
 * thus the search starts with the service.
 */
const installedFolders = (): Map<string, string> => {
  const folders = new Map<string, string>();
  for (const name of [...WORKSPACE_PACKAGES].reverse()) {
    const found = [PACKAGE, ...folders.values()].flatMap((from) => {
      try {
        return [dirname(realpathSync(createRequire(join(from, "package.json")).resolve(`@mark1russell7/${name}/package.json`)))];
      } catch {
        return [];
      }
    })[0];
    if (found === undefined) throw new Error(`@mark1russell7/${name} is not installed with @mark1russell7/kind`);
    folders.set(name, found);
  }
  return folders;
};

/**
 * This function stages the build context of the lab image. In the workspace, it builds the packages
 * of the repository and packs each one as npm gets it. From npm, it packs the installed packages.
 * Then it copies the files of the image.
 */
export const stageLabImage = (): string => {
  const context = mkdtempSync(join(tmpdir(), "systems-kind-lab-"));
  const packed = join(context, "workspace");
  mkdirSync(packed);
  if (inWorkspace()) {
    const filters = WORKSPACE_PACKAGES.flatMap((name) => ["--filter", `@mark1russell7/${name}`]);
    execFileSync("pnpm", [...filters, "build"], { cwd: REPO, shell, stdio: "ignore" });
    for (const name of WORKSPACE_PACKAGES)
      execFileSync("pnpm", ["pack", "--pack-destination", packed], { cwd: join(REPO, "packages", name), shell, stdio: "ignore" });
  } else {
    for (const folder of installedFolders().values())
      execFileSync("npm", ["pack", "--pack-destination", packed, "--ignore-scripts"], { cwd: folder, shell, stdio: "ignore" });
  }
  for (const [at, from] of FILES) copyFileSync(join(PACKAGE, from), join(context, at));
  return context;
};

let built: Promise<string> | null = null;

/** This function builds the lab image one time for each process, and gives its tag. Docker keeps its layers between builds. */
export const labImage = (): Promise<string> => {
  built ??= (async () => {
    const context = stageLabImage();
    try {
      const tag = contentTag("systems-kind-lab", context);
      const { GenericContainer } = await import("testcontainers");
      await GenericContainer.fromDockerfile(context).build(tag, { deleteOnExit: false });
      return tag;
    } finally {
      rmSync(context, { recursive: true, force: true });
    }
  })();
  return built;
};
