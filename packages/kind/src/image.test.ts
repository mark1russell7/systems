import { readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planOf } from "@mark1russell7/harness";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WORKSPACE_PACKAGES, labImage, labSource, stageLabImage } from "./image.ts";

type Done = (error: Error | null, stdout: string, stderr: string) => void;

// no pnpm and no Docker: the stage packs nothing, and the build of the resolver is a mock
const { execFile } = vi.hoisted(() => ({ execFile: vi.fn<(file: string, args: readonly string[], options: object, done: Done) => void>() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
  execFile,
}));

// a build that does not go through the mock finds no program `docker`, thus it builds nothing
beforeAll(() => {
  vi.stubEnv("PATH", "");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

/** These are the files of a staged context, by their paths in the context: the tarballs of the stage are none here. */
const STAGED = [
  "Dockerfile",
  "package.json",
  "npm-lock.json",
  "app.mjs",
  "client.mjs",
  "client-grpc.mjs",
  "agent.mjs",
  "watch.mjs",
  "compose.ts",
  "backends.ts",
  "conntrack.ts",
  "drops.ts",
  "eds.ts",
  "lds.ts",
  "client-lines.ts",
  "place.ts",
];

describe("the lab image", () => {
  it("is a build source that the resolver of the harness plans, with a tag from its content", () => {
    const context = stageLabImage();
    try {
      const plan = planOf(labSource(context));
      if (plan.kind !== "build") throw new Error("the lab image is not a build");
      expect(plan.tag).toMatch(/^systems-kind-lab:[0-9a-f]{12}$/);
      expect(plan.dockerfile).toBe("Dockerfile");
      expect(plan.files.map((each) => each.at)).toEqual(STAGED);
      // the same content gives the same tag, and a changed program gives another
      expect(planOf(labSource(context))).toEqual(plan);
      writeFileSync(join(context, "app.mjs"), "console.log('changed');\n");
      expect(planOf(labSource(context))).not.toEqual(expect.objectContaining({ tag: plan.tag }));
      // the rules of each build apply: a lockfile for each manifest, and a digest on each FROM
      unlinkSync(join(context, "npm-lock.json"));
      expect(() => planOf({ ...labSource(context), files: STAGED.filter((at) => at !== "npm-lock.json") })).toThrow(/package.json has no lockfile/);
      writeFileSync(join(context, "Dockerfile"), "FROM node:24-alpine\n");
      expect(() => planOf({ ...labSource(context), files: ["Dockerfile"] })).toThrow(/the base node:24-alpine is not pinned by digest/);
    } finally {
      rmSync(context, { recursive: true, force: true });
    }
  });

  it("installs each dependency from npm of the packages that it unpacks over node_modules", () => {
    // the Dockerfile unpacks each tarball with no install, thus npm ci must get its dependencies (on 11-02 the server stopped at start without rational)
    const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { dependencies?: Record<string, string> };
    const image = read("../image/package.json").dependencies ?? {};
    const needed = WORKSPACE_PACKAGES.flatMap((name) => Object.keys(read(`../../${name}/package.json`).dependencies ?? {}));
    const missing = needed.filter((name) => !WORKSPACE_PACKAGES.some((each) => name === `@mark1russell7/${each}`) && image[name] === undefined);
    expect(missing).toEqual([]);
  });

  it("builds through the CLI of Docker, tries again after each wait, and builds again after a build that failed each try", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      let tries = 0;
      execFile.mockImplementation((_file, _args, _options, done) => {
        tries += 1;
        done(tries <= 3 ? new Error("the Docker daemon stopped") : null, "", "ERROR: the Docker daemon stopped\n");
      });
      // three tries, with the two waits of the resolver between them
      const failed = expect(labImage()).rejects.toThrow(/docker build of systems-kind-lab:[0-9a-f]{12} failed/);
      await vi.advanceTimersByTimeAsync(25_000);
      await failed;
      const tag = await labImage();
      expect(tag).toMatch(/^systems-kind-lab:[0-9a-f]{12}$/);
      expect(execFile).toHaveBeenCalledTimes(4);
      const [file, args] = execFile.mock.calls[3]!;
      expect(file).toBe("docker");
      expect(args.slice(0, 4)).toEqual(["build", "--progress=plain", "--tag", tag]);
      // a build that passed stays: the next call gives the same tag, and does not stage or build
      await expect(labImage()).resolves.toBe(tag);
      expect(execFile).toHaveBeenCalledTimes(4);
    } finally {
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });
});
