import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import * as harness from "@mark1russell7/harness";
import { STAGES as SERVICE_STAGES } from "@mark1russell7/service";
import { describe, expect, it } from "vitest";
import type { KindCellRecord, KindCellRecordV1 } from "./judge.ts";
import {
  FORMAT,
  FORMAT_V1,
  RELATIVE,
  STAGES,
  judge,
  kindCellRecordSchema,
  kindCellRecordV1Schema,
  medianInterval,
  medianText,
  predictionText,
  quantileOf,
  readRecord,
  unitOf,
  upgrade,
} from "./judge.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * These records are real: three cells of the kind workflow of 2026-10-16, in the format `/1`. Each
 * fixture is a whole record without its load samples and without the kernel release of the runner,
 * thus it names only kind nodes and images.
 */
const FIXTURES = {
  holds: "t07-nftables-scale-in.json.gz",
  fails: "t07-iptables-no-hold.json.gz",
  calibration: "t07-iptables-calibration.json.gz",
} as const;
const fixture = (name: string): KindCellRecordV1 =>
  JSON.parse(gunzipSync(readFileSync(join(here, "..", "test", "records", name))).toString("utf8")) as KindCellRecordV1;

/** the meaning of a record without its units: each `{ value, unit }` as its value */
const bare = (x: unknown): unknown => {
  if (Array.isArray(x)) return x.map(bare);
  if (x !== null && typeof x === "object") {
    const keys = Object.keys(x);
    if (keys.length === 2 && keys.includes("value") && keys.includes("unit")) return (x as { value: unknown }).value;
    return Object.fromEntries(Object.entries(x).map(([key, value]) => [key, bare(value)]));
  }
  return x;
};
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("the upgrade of a record from the format /1 to /2", () => {
  for (const name of [FIXTURES.holds, FIXTURES.fails]) {
    it(`reads ${name} with each amount as a quantity, and the same values`, () => {
      const record = fixture(name);
      const before = json(record);
      expect(kindCellRecordV1Schema.safeParse(record).success).toBe(true);
      const upgraded = upgrade(record);
      expect(upgraded.format).toBe(FORMAT);
      expect(kindCellRecordSchema.safeParse(json(upgraded)).success).toBe(true);
      // the upgrade writes nothing in the record of /1, and only the forms of the amounts change
      expect(record).toEqual(before);
      expect(bare(json({ ...upgraded, format: null }))).toEqual(bare({ ...before, format: null }));
      // the runs, the manifests and the loads stay as they are
      expect(upgraded.runs).toBe(record.runs);
      // the main values count failed requests, and the facts give times in seconds
      expect(upgraded.verdict.median).toEqual({ value: record.verdict.median, unit: "{request}" });
      const check = upgraded.verdict.checks[0]!;
      expect(check.value).toEqual({ value: record.verdict.checks[0]!.value, unit: "{request}" });
      expect(check.facts.intakeAfterDeletion).toEqual({ value: record.verdict.checks[0]!.facts.intakeAfterDeletion, unit: "s" });
      for (const drop of Object.values(check.facts.propagation)) expect(drop?.by.unit).toBe("s");
    });
  }

  it("gives each band of a prediction in seconds", () => {
    const record = fixture(FIXTURES.fails);
    const old = record.cell.prediction;
    const upgraded = upgrade(record).cell.prediction;
    if (old.kind !== "window" || upgraded.kind !== "window" || old.end === null || upgraded.end === null) throw new Error("the fixture predicts a window");
    expect(upgraded.start.band).toEqual({ lo: { value: old.start.band.lo, unit: "s" }, hi: { value: old.start.band.hi, unit: "s" } });
    expect(upgraded.end.band).toEqual({ lo: { value: old.end.band.lo, unit: "s" }, hi: { value: old.end.band.hi, unit: "s" } });
  });

  it("gives the cpu.max of a throttle in microseconds, and a record of /2 as it is", () => {
    const record = fixture(FIXTURES.holds);
    const throttled: KindCellRecordV1 = { ...record, cell: { ...record.cell, trigger: { kind: "cpu-throttle", cpuMax: { quota: 1000, period: 1_000_000 } } } };
    expect(upgrade(throttled).cell.trigger.cpuMax).toEqual({ quota: { value: 1000, unit: "us" }, period: { value: 1_000_000, unit: "us" } });
    const upgraded = upgrade(record);
    expect(upgrade(upgraded)).toBe(upgraded);
  });

  it("names only kind nodes and images in the fixtures", () => {
    for (const name of Object.values(FIXTURES)) {
      const record = fixture(name);
      expect(record.loads).toEqual([]);
      for (const manifest of record.manifests) {
        for (const node of manifest.cluster.nodes) {
          expect(node.name).toMatch(/^lab-(iptables|ipvs|nftables)-\d+-\d+-(control-plane|worker\d*)$/);
          expect(node.kernel).toBe("stripped");
        }
      }
    }
  });
});

describe("the judgement of a record again", () => {
  for (const [decision, name] of Object.entries(FIXTURES)) {
    it(`judges ${name} as its own verdict says: ${decision}`, () => {
      const record = fixture(name);
      const verdict = judge(record);
      expect(verdict.decision).toBe(decision);
      expect(verdict.decision).toBe(record.verdict.decision);
      expect(json(verdict)).toEqual(json(upgrade(record).verdict));
      // a record of /2 gets the same verdict
      expect(json(judge(upgrade(record)))).toEqual(json(verdict));
    });
  }

  it("reads a record of either format from JSON, and refuses another format", () => {
    const record = fixture(FIXTURES.fails);
    const fromV1 = readRecord(json(record));
    expect(fromV1.format).toBe(FORMAT);
    expect(json(readRecord(json(fromV1)))).toEqual(json(fromV1));
    expect(() => readRecord({ ...record, format: "systems.kind-cell-record/0" })).toThrow(/format/);
    // a median in another unit than the prediction gives is not a record of /2
    const wrong: KindCellRecord = { ...fromV1, verdict: { ...fromV1.verdict, median: { value: 3, unit: "s" } } };
    expect(kindCellRecordSchema.safeParse(json(wrong)).success).toBe(false);
    expect(FORMAT_V1).toBe("systems.kind-cell-record/1");
  });

  it("reads a record of /2 of a cell of T15 with its mesh, and refuses a mesh that is not one", () => {
    const fromV1 = readRecord(json(fixture(FIXTURES.fails)));
    const meshed: KindCellRecord = { ...fromV1, cell: { ...fromV1.cell, template: "T15", stack: "grpc", mesh: { flavor: "sidecar", mode: "sidecar" } } };
    expect(readRecord(json(meshed)).cell.mesh).toEqual({ flavor: "sidecar", mode: "sidecar" });
    const unknown = { ...meshed, cell: { ...meshed.cell, mesh: { flavor: "linkerd", mode: "sidecar" } } };
    expect(kindCellRecordSchema.safeParse(json(unknown)).success).toBe(false);
  });

  it("reads a record of /2 of a policy: its trigger and account, a window from the heal with its outcomes, and the LDS updates", () => {
    const fromV1 = readRecord(json(fixture(FIXTURES.fails)));
    const s = (value: number) => ({ value, unit: "s" });
    const policy: KindCellRecord = {
      ...fromV1,
      cell: {
        ...fromV1.cell,
        template: "T15",
        stack: "grpc",
        mesh: { flavor: "sidecar", mode: "sidecar" },
        trigger: { kind: "authorization-policy", hold: s(15), account: "lab-absent" },
        prediction: {
          kind: "window",
          nodes: "all",
          start: { from: "fault", band: { lo: s(0.1), hi: s(10.5) } },
          end: { from: "heal", band: { lo: s(0.1), hi: s(10.3) } },
          certain: true,
          outcomes: ["denied"],
          why: "a test",
        },
      },
      verdict: {
        ...fromV1.verdict,
        checks: fromV1.verdict.checks.map((check) => ({ ...check, facts: { ...check.facts, updates: { "lab-a": { after: s(0.25), by: s(0.3) } }, healUpdates: { "lab-a": null } } })),
      },
    };
    const read = readRecord(json(policy));
    expect(read.cell.trigger).toEqual({ kind: "authorization-policy", hold: s(15), account: "lab-absent" });
    expect(read.cell.prediction).toMatchObject({ end: { from: "heal" }, outcomes: ["denied"] });
    expect(read.verdict.checks[0]?.facts.updates).toEqual({ "lab-a": { after: s(0.25), by: s(0.3) } });
    expect(kindCellRecordSchema.safeParse(json({ ...policy, cell: { ...policy.cell, trigger: { kind: "authorization-policies" } } })).success).toBe(false);
  });

  it("gives the unit of the main value from the prediction", () => {
    expect(unitOf({ kind: "none" })).toBe("{request}");
    expect(unitOf({ kind: "window" })).toBe("{request}");
    expect(unitOf({ kind: "stays" })).toBe("{request}");
    expect(unitOf({ kind: "measured" })).toBe("{request}");
    expect(unitOf({ kind: "removal", band: null })).toBe("s");
    expect(unitOf({ kind: "leaves" })).toBe("s");
    expect(unitOf({ kind: "stalls" })).toBe("s");
    expect(unitOf({ kind: "restarts", band: { lo: 28, hi: 50 } })).toBe("s");
    expect(unitOf({ kind: "restarts", band: null })).toBe("{replica}");
  });

  it("writes the median of a report through its unit", () => {
    const record = upgrade(fixture(FIXTURES.fails));
    expect(medianText(record)).toBe("3 failed requests");
    const timed = { ...record, verdict: { ...record.verdict, median: { value: 34.244, unit: "s" } } };
    expect(medianText(timed)).toBe("34.244 s");
    const replicas = { ...record, verdict: { ...record.verdict, median: { value: 0, unit: "{replica}" } } };
    expect(medianText(replicas)).toBe("0 replicas");
  });

  it("writes the start of a window with its band, which can open before its reference", () => {
    const s = (value: number) => ({ value, unit: "s" });
    // a pause on one node: a stale SYN_SENT entry from an earlier run can fail it 122 s before the intake
    const paused = {
      kind: "window",
      nodes: "paused",
      start: { from: "intake", band: { lo: s(-122), hi: s(0) } },
      end: { from: "resume", band: { lo: s(0.5), hi: s(125.3) } },
      certain: true,
      why: "",
    } as const;
    expect(predictionText(paused)).toBe(
      "failures only from the intake + [-122, 0] s to the resume + [0.5, 125.3] s, on the paused node, at least one",
    );
    // a band of [0, 0] s is the reference itself
    expect(predictionText({ ...paused, nodes: "all", start: { from: "deletion", band: { lo: s(0), hi: s(0) } }, end: null, certain: false })).toBe(
      "failures only from the deletion",
    );
  });
});

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

describe("the entry ./judge", () => {
  it("loads no Docker, no Testcontainers, no child process and no node: module", () => {
    const { files, packages } = reach("judge.ts");
    expect(files).toEqual(["bands.ts", "judge.ts", "names.ts", "observe.ts", "record.ts", "report.ts", "schema.ts", "stats.ts", "verdict.ts"]);
    expect(packages).toEqual(["@mark1russell7/quantity", "@mark1russell7/quantity/schema", "zod"]);
  });

  it("loads none of them in a new process either", () => {
    // a new Node process imports the entry, and a hook of the resolver writes each module that it loads
    const probe = [
      'import { registerHooks } from "node:module";',
      "const seen = [];",
      "registerHooks({ resolve(specifier, context, next) { const out = next(specifier, context); seen.push(out.url); return out; } });",
      `const judge = await import(${JSON.stringify(pathToFileURL(join(here, "judge.ts")).href)});`,
      'process.stdout.write(JSON.stringify({ seen, exports: Object.keys(judge).length }));',
    ].join("\n");
    const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--disable-warning=ExperimentalWarning", "-e", probe], { encoding: "utf8" })) as { seen: string[]; exports: number };
    expect(out.exports).toBeGreaterThan(20);
    const loaded = out.seen.filter((url) => /child_process|testcontainers|dockerode|docker-modem|ssh2|@mark1russell7[\\/]harness|packages[\\/]harness/.test(url));
    expect(loaded).toEqual([]);
    expect(out.seen.filter((url) => url.startsWith("node:"))).toEqual([]);
    expect(out.seen.some((url) => url.endsWith("/verdict.ts"))).toBe(true);
  });

  it("holds its statistics to the harness, and its stages to the service", () => {
    expect(RELATIVE).toBe(harness.RELATIVE);
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let n = 1; n <= 60; n += 1) {
      const sorted = Array.from({ length: n }, () => Math.round(random() * 1e6) / 1e3).sort((a, b) => a - b);
      expect(medianInterval(sorted), `n = ${n}`).toEqual(harness.medianInterval(sorted));
      for (const p of [0.5, 0.9, 0.99, 0.999]) expect(quantileOf(sorted, p)).toBe(harness.quantileOf(sorted, p));
    }
    expect([...STAGES]).toEqual([...SERVICE_STAGES]);
  });
});

/** KIND_RECORDS=<folder> judges each raw record under a folder again, and holds the verdict to its own. */
const RECORDS = process.env["KIND_RECORDS"];
const recordsUnder = (folder: string): string[] =>
  readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return name === "partial" ? [] : recordsUnder(path);
    return name.endsWith(".json") && !name.startsWith("summary") ? [path] : [];
  });

describe.skipIf(RECORDS === undefined)("the records under KIND_RECORDS", () => {
  it("judges each record as its own verdict says", () => {
    const files = recordsUnder(RECORDS!);
    for (const file of files) {
      const data = JSON.parse(readFileSync(file, "utf8")) as { format?: string };
      if (data.format !== FORMAT && data.format !== FORMAT_V1) continue;
      const record = data as KindCellRecord | KindCellRecordV1;
      expect(json(judge(record)), file).toEqual(json(upgrade(record).verdict));
    }
    expect(files.length).toBeGreaterThan(0);
  });
});
