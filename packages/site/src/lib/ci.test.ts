import { describe, expect, it } from "vitest";
import type { JobInput, Ledger, RunInput, ShardInput } from "./ci.ts";
import { QUIET_LIMIT, eventsOf, keyOf, logLines, merged, ratesOf, shardOf, stepLog, voidCause } from "./ci.ts";

const OPTIONS = { step: "The cells", idle: 0.6 } as const;
const URL = "https://github.com/mark1russell7/systems/actions/runs/7";

const job = (id: number, name: string, conclusion: string, stepConclusion: string, from: string, to: string): JobInput => ({
  databaseId: id,
  name,
  status: "completed",
  conclusion,
  startedAt: from,
  completedAt: to,
  url: `${URL}/job/${id}`,
  steps: [
    { name: "Run pnpm install --frozen-lockfile", conclusion: "success", startedAt: from, completedAt: from },
    { name: "The cells", conclusion: stepConclusion, startedAt: from, completedAt: to },
  ],
});

/** a line of `gh run view --log`, with the color codes of vitest */
const line = (name: string, at: string, text: string): string => `${name}\tUNKNOWN STEP\t${at} \u001b[22m\u001b[39m${text}`;

/** the log of a shard that waited for a quiet VM from 10:01 to 10:30, then a person cancelled it */
const hungLog = [
  line("kind (1)", "2026-10-27T10:00:00.000Z", "cluster lab-cilium-2-1: cilium, 2 workers"),
  line("kind (1)", "2026-10-27T10:00:30.000Z", "T07 cilium, a cell (S2.T07.cilium.x.n6), environment 1"),
  ...Array.from({ length: 30 }, (_, n) => line("kind (1)", new Date(Date.parse("2026-10-27T10:01:00.000Z") + n * 60_000).toISOString(), `  waiting: ${50 + (n % 10)}% idle, other lab containers: none`)),
  line("kind (1)", "2026-10-27T10:31:00.000Z", "##[error]The operation was canceled."),
].join("\n");

const RUN: RunInput = {
  databaseId: 7,
  event: "workflow_dispatch",
  headBranch: "a-branch",
  conclusion: "cancelled",
  status: "completed",
  createdAt: "2026-10-27T09:59:00Z",
  url: URL,
  jobs: [
    job(100, "plan", "success", "success", "2026-10-27T09:59:00Z", "2026-10-27T09:59:10Z"),
    job(101, "kind (0)", "success", "success", "2026-10-27T10:00:00Z", "2026-10-27T10:12:00Z"),
    job(102, "kind (1)", "cancelled", "cancelled", "2026-10-27T10:00:00Z", "2026-10-27T10:31:00Z"),
    job(103, "kind (2)", "cancelled", "cancelled", "2026-10-27T10:00:00Z", "2026-10-27T10:05:00Z"),
    job(104, "kind (3)", "failure", "failure", "2026-10-27T10:00:00Z", "2026-10-27T10:36:00Z"),
    job(105, "kind (4)", "failure", "failure", "2026-10-27T10:00:00Z", "2026-10-27T10:03:00Z"),
  ],
};

const SHARDS = new Map<number, ShardInput>([
  [
    101,
    {
      records: [
        {
          cell: "S2.T07.cilium.x.n1",
          dataplane: "cilium",
          runs: [
            { env: 0, index: -1, warmup: true, void: null },
            { env: 0, index: 0, warmup: false, void: null },
            { env: 1, index: 0, warmup: false, void: "the VM was not quiet in 300 s: 59% idle, other lab containers: none" },
            { env: 1, index: 1, warmup: false, void: "the cell was not at rest: a pod restarted" },
          ],
        },
        { cell: "T07.iptables.y", dataplane: "iptables", runs: [{ env: 0, index: 0, warmup: false, void: null }] },
      ],
      annotations: [],
      log: null,
    },
  ],
  [102, { records: [{ cell: "S2.T07.cilium.x.n6", dataplane: "cilium", runs: [{ env: 0, index: 0, warmup: false, void: null }] }], annotations: ["The run was canceled by @someone.", "The operation was canceled."], log: hungLog }],
  [103, { records: [], annotations: ["The run was canceled by @someone.", "The operation was canceled."], log: line("kind (2)", "2026-10-27T10:01:00.000Z", "cluster lab-ipvs-2-0: ipvs, 2 workers") }],
  [104, { records: [], annotations: ["The action 'The cells' has timed out after 36 minutes."], log: null }],
  [105, { records: [], annotations: ["Process completed with exit code 1.", "Error: Snapshot `the predictions` mismatched\n\n- Expected"], log: null }],
]);

describe("the events of a run", () => {
  const { run, events } = eventsOf(RUN, SHARDS, OPTIONS);

  it("gives the shard of a job of a matrix, and null for another job", () => {
    expect([shardOf("kind (3)"), shardOf("cells (12)"), shardOf("plan")]).toEqual([3, 12, null]);
  });

  it("gives each void run of a record as an event, with its cause, its bound and its idle share", () => {
    const voids = events.filter((event) => event.kind === "void");
    expect(voids.map((event) => [event.cell, event.env, event.index, event.cause, event.duration?.value ?? null, event.idle?.low ?? null])).toEqual([
      ["S2.T07.cilium.x.n1", 1, 0, "quiet", 300, 0.59],
      ["S2.T07.cilium.x.n1", 1, 1, "rest", null, null],
    ]);
    expect(voids.every((event) => event.step === "The cells" && event.shard === 0 && event.link === `${URL}/job/101`)).toBe(true);
    expect([voidCause("the VM was not quiet in 300 s: 51% idle"), voidCause("the cell was not at rest: x"), voidCause("no replica")]).toEqual(["quiet", "rest", "other"]);
  });

  it("gives a cancelled shard that waited for most of its step as hung, by the wait for a quiet VM", () => {
    const hung = events.find((event) => event.job === 102)!;
    expect([hung.kind, hung.cause, hung.cell, hung.env, hung.dataplane, hung.step, hung.duration?.value]).toEqual(["hung", "quiet", "S2.T07.cilium.x.n6", 1, "cilium", "The cells", 1860]);
    expect(hung.idle).toEqual({ low: 0.5, high: 0.59 });
    expect(hung.detail).toBe("The step waited for a quiet VM for approximately 30 of its 31 min, at 50% to 59% idle, under the share of 60%. A person cancelled the run.");
    expect(hung.detail).not.toContain("@");
  });

  it("gives a shard that a person cancelled early as cancelled, with no wait", () => {
    const cancelled = events.find((event) => event.job === 103)!;
    expect([cancelled.kind, cancelled.cause, cancelled.dataplane, cancelled.idle, cancelled.duration?.value]).toEqual(["cancelled", "person", "ipvs", null, 300]);
  });

  it("gives a step that hit its timeout, and a job that failed in a test outside the cells", () => {
    const timeout = events.find((event) => event.job === 104)!;
    const failed = events.find((event) => event.job === 105)!;
    expect([timeout.kind, timeout.cause, timeout.duration?.value, timeout.detail]).toEqual(["timeout", "timeout", 2160, "The action 'The cells' has timed out after 36 minutes."]);
    expect([failed.kind, failed.cause, failed.cell, failed.detail]).toEqual(["failed", "test", null, "Error: Snapshot `the predictions` mismatched"]);
  });

  it("gives no event for a clean job, and counts the runs of each dataplane", () => {
    expect(events.filter((event) => event.job === 100)).toEqual([]);
    expect(events).toHaveLength(6);
    // 4 runs of the first cilium cell, 1 of the hung cell in its record, and 1 that it did not end
    expect(run.runs).toEqual({ cilium: 6, iptables: 1 });
    expect(run.shards).toBe(5);
  });

  it("stops for a run that has not ended", () => {
    expect(() => eventsOf({ ...RUN, status: "in_progress" }, SHARDS, OPTIONS)).toThrow(/has not ended/);
  });
});

describe("the log of a step", () => {
  it("reads the time stamp and the text of each line without the color codes", () => {
    const lines = logLines(hungLog);
    expect(lines[0]).toEqual({ t: Date.parse("2026-10-27T10:00:00.000Z"), text: "cluster lab-cilium-2-1: cilium, 2 workers" });
  });

  it("adds the waits for a quiet VM in the step, up to the next line, and keeps the cell at its end", () => {
    const log = stepLog(logLines(hungLog), "2026-10-27T10:00:00Z", "2026-10-27T10:31:00Z");
    expect([log.waits, log.waited, log.cell, log.env, log.dataplane]).toEqual([30, 1800, "S2.T07.cilium.x.n6", 1, "cilium"]);
  });

  it("counts no line outside the step", () => {
    expect(stepLog(logLines(hungLog), "2026-10-27T10:20:00Z", "2026-10-27T10:31:00Z").waits).toBe(11);
  });
});

describe("the ledger", () => {
  const EMPTY: Ledger = { workflow: "kind", file: ".github/workflows/kind.yml", idle: 0.6, runs: [], events: [] };
  const { run, events } = eventsOf(RUN, SHARDS, OPTIONS);

  it("adds the events of a run once: a second scan replaces the entry of the run and adds no event", () => {
    const once = merged(EMPTY, run, events);
    const twice = merged(once, run, events);
    expect(twice).toEqual(once);
    expect(new Set(twice.events.map(keyOf)).size).toBe(twice.events.length);
    expect(twice.runs).toHaveLength(1);
  });

  it("keeps the event of a job after its log expired", () => {
    const once = merged(EMPTY, run, events);
    const noLog = new Map([...SHARDS].map(([id, shard]) => [id, { ...shard, log: null }]));
    const again = eventsOf(RUN, noLog, OPTIONS);
    const twice = merged(once, again.run, again.events);
    expect(twice.events.find((event) => event.job === 102)?.kind).toBe("hung");
    expect(twice.events).toHaveLength(once.events.length);
  });

  it("gives the flake rate of the workflow by shard, and of each dataplane by run", () => {
    const rates = ratesOf(merged(EMPTY, run, events));
    expect([rates.runs, rates.shards, rates.flaky, rates.rate, rates.events]).toEqual([1, 5, 5, 1, 6]);
    expect(rates.causes).toEqual({ quiet: 2, rest: 1, person: 1, timeout: 1, test: 1 });
    expect(rates.dataplanes).toEqual([
      { dataplane: "cilium", runs: 6, events: 3, rate: 0.5, quiet: 2, quietRate: 2 / 6, lowest: 0.5, threshold: "change" },
      { dataplane: "iptables", runs: 1, events: 0, rate: 0, quiet: 0, quietRate: 0, lowest: null, threshold: "holds" },
      { dataplane: "ipvs", runs: 0, events: 1, rate: 0, quiet: 0, quietRate: 0, lowest: null, threshold: "holds" },
    ]);
  });

  it("keeps the share of a dataplane while its void runs of the wait are at the limit or below", () => {
    const ledger: Ledger = {
      ...EMPTY,
      runs: [{ run: 1, at: "", event: "", branch: "", conclusion: "success", link: "", shards: 1, runs: { cilium: 20 } }],
      events: [{ ...events.find((event) => event.cause === "quiet" && event.kind === "void")!, run: 1 }],
    };
    expect(ratesOf(ledger).dataplanes[0]?.quietRate).toBe(QUIET_LIMIT);
    expect(ratesOf(ledger).dataplanes[0]?.threshold).toBe("holds");
    expect(ratesOf({ ...EMPTY }).rate).toBe(0);
  });
});
