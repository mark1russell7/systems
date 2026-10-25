import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./paths.ts";

const WORKFLOWS = join(repoRoot, ".github", "workflows");

describe("the workflows", () => {
  // a tag can move to other code: a pin by commit is the code that a person read
  it("pin each action of another repository by a full commit SHA", () => {
    const loose = readdirSync(WORKFLOWS)
      .filter((name) => name.endsWith(".yml"))
      .flatMap((name) =>
        readFileSync(join(WORKFLOWS, name), "utf8")
          .split("\n")
          .map((line) => /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line)?.[1])
          .filter((ref): ref is string => ref !== undefined && !ref.startsWith("./") && !/@[0-9a-f]{40}$/.test(ref))
          .map((ref) => `${name}: ${ref}`),
      );
    expect(loose).toEqual([]);
  });
});
