import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CASES } from "./fixture.ts";

/**
 * The three collectors, Rust, Go and C, against one record contract (README.md, "Three
 * collectors"). The test builds the comparison image, whose build stops unless all three decode
 * the identity fixture to the same bytes. Then it starts image/compare.sh in that image. The image
 * needs a privileged container on a local Docker host, so the test starts only on request:
 *
 *     LOOM_PROBER_COMPARE=1 pnpm --filter @mark1russell7/prober exec vitest run src/compare.test.ts
 *
 * It holds what does not change with the load of the host: the same bytes, and the same records
 * with none lost under a light storm. It prints the numbers of the heavy storm (records lost, CPU,
 * memory) for the record, and does not hold them, because another workload on the host moves them.
 */
const RUN = process.env["LOOM_PROBER_COMPARE"] === "1";
const run = promisify(execFile);
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const IMAGE = "loom-prober-compare";

interface Summary {
  identity: { lines: number; go: boolean; c: boolean };
  throughput: Record<string, { per_second: number }>;
  together: {
    records: Record<string, number>;
    lines_differing_from_rust: Record<string, number>;
    lost: Record<string, number>;
    kinds: string[];
  };
  /** a collector's records, or null when it wrote no clock line before it was stopped */
  alone: Array<{
    collector: string;
    records: number | null;
    lost: number | null;
    cpu: { value: number };
  }>;
}

describe.skipIf(!RUN)("three collectors, one record contract", () => {
  it(
    "prints the same bytes and the same records in Rust, Go and C",
    async () => {
      await run("docker", ["build", "-q", "-f", "image/Dockerfile", "-t", IMAGE, "."], {
        cwd: PACKAGE,
        maxBuffer: 1 << 24,
      });
      const { stdout } = await run("docker", ["run", "--rm", "--privileged", IMAGE], {
        maxBuffer: 1 << 24,
      });
      const summary = JSON.parse(stdout.trim().split("\n").at(-1)!) as Summary;
      console.log(JSON.stringify(summary, null, 1));
      // the fixture, byte for byte
      // every case's line, and the undecodable one for the record cut short
      expect(summary.identity).toEqual({ lines: CASES.length + 1, go: true, c: true });
      // one storm, three copies of the kernel program: the same records, none lost
      const { records, lines_differing_from_rust: differing, lost } = summary.together;
      expect(records["go"]).toBe(records["rust"]);
      expect(records["c"]).toBe(records["rust"]);
      expect(records["rust"]).toBeGreaterThan(10_000);
      expect(differing).toEqual({ go: 0, c: 0 });
      expect(lost).toEqual({ rust: 0, go: 0, c: 0 });
      // a connection's whole life is in them
      expect(summary.together.kinds).toEqual(
        expect.arrayContaining(["accept", "destroy", "req_new", "rx", "state", "tw_enter"]),
      );
      // and each collector, alone, kept a heavy storm's records
      for (const each of summary.alone) expect(each.records, each.collector).toBeGreaterThan(0);
    },
    30 * 60_000,
  );
});
