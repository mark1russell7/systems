import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportCopies } from "./copies.ts";

describe("the exporters of a copy", () => {
  const out = mkdtempSync(join(tmpdir(), "copies-"));
  afterEach(() => rmSync(out, { recursive: true, force: true }));

  it("takes only the name of a script of this folder", () => {
    for (const name of ["../../cells/src/all", "port-range.ts", "Port", ""])
      expect(() => exportCopies([name], out, [])).toThrow("is not the name of an exporter");
  });
});
