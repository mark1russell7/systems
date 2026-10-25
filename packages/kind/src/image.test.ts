import { describe, expect, it, vi } from "vitest";
import { labImage } from "./image.ts";

// no pnpm and no Docker: the staging packs nothing, and the build is a mock that fails one time
const { build } = vi.hoisted(() => ({ build: vi.fn<(tag: string, options: { deleteOnExit: boolean }) => Promise<void>>() }));
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("testcontainers", () => ({ GenericContainer: { fromDockerfile: () => ({ build }) } }));

describe("the lab image", () => {
  it("builds again after a build that failed", async () => {
    build.mockRejectedValueOnce(new Error("the Docker daemon stopped")).mockResolvedValueOnce(undefined);
    await expect(labImage()).rejects.toThrow("the Docker daemon stopped");
    await expect(labImage()).resolves.toMatch(/^systems-kind-lab:[0-9a-f]{12}$/);
    expect(build).toHaveBeenCalledTimes(2);
    // a build that passed stays: the next call gives the same tag, and does not build
    await labImage();
    expect(build).toHaveBeenCalledTimes(2);
  });
});
