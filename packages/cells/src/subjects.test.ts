import { readFileSync } from "node:fs";
import { subjectSchema } from "@mark1russell7/harness/schema";
import { describe, expect, it } from "vitest";
import { CLIENT_REF, PROCEDURES } from "./subjects.ts";

const workflow = readFileSync(new URL("../../../.github/workflows/cells.yml", import.meta.url), "utf8");

describe("the procedures subject", () => {
  it("is a subject of the harness, with a build of the client repository", () => {
    expect(subjectSchema.parse(JSON.parse(JSON.stringify(PROCEDURES)))).toEqual(PROCEDURES);
    expect(PROCEDURES.image).toMatchObject({ kind: "build", dockerfile: "harness/procedures-subject/Dockerfile" });
  });

  it("is the subject of the checkout of cells.yml, at the same commit", () => {
    expect(CLIENT_REF).toMatch(/^[0-9a-f]{40}$/);
    expect(workflow).toContain(`CLIENT_REF: ${CLIENT_REF}`);
    expect(workflow).toContain("repository: mark1russell7/client");
    expect(workflow).toContain("client/harness/procedures-subject/subject.json");
  });
});
