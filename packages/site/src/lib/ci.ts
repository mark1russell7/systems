/**
 * The CI ledger: one file for each workflow of cells. It has one entry for each event of a run that did not
 * give a clean result. An event is a void run, a hung or cancelled shard, or a step that hit its timeout.
 * A job that failed for a cause outside the cell is also an event. The script `scripts/ci.ts` adds the entries from the
 * artifacts, the jobs and the logs of a run. Thus no entry is written by hand.
 *
 * The functions of this file have no input or output. The script reads a run with `gh`, and the tests give
 * them fixtures.
 */

/** The kind of an event. A hung shard is a cancelled or timed-out shard that waited for most of its step. */
export type EventKind = "void" | "hung" | "cancelled" | "timeout" | "failed";

/** The cause of an event. */
export type Cause = "quiet" | "rest" | "person" | "timeout" | "runner" | "test" | "other";

/** A duration in seconds, as a quantity. */
export interface Seconds {
  readonly value: number;
  readonly unit: "s";
}

/** The lowest and the highest idle share of the CPUs that an event saw, from 0 to 1. */
export interface IdleRange {
  readonly low: number;
  readonly high: number;
}

/** One entry of the ledger: one event of one run. */
export interface LedgerEvent {
  readonly run: number;
  readonly job: number;
  /** the number of the shard in the matrix of the job, or null for a job of no matrix */
  readonly shard: number | null;
  readonly kind: EventKind;
  readonly cause: Cause;
  /** the id or the name of the cell, or null when the event is not of one cell */
  readonly cell: string | null;
  /** the dataplane of the cell: a kube-proxy mode, `cilium`, or `docker` for the harness */
  readonly dataplane: string | null;
  readonly step: string | null;
  /** the environment of the run in the cell, or null */
  readonly env: number | null;
  /** the index of the run in its environment: -1 is the warm-up. Null when the event is not of one run. */
  readonly index: number | null;
  readonly duration: Seconds | null;
  readonly idle: IdleRange | null;
  readonly detail: string;
  readonly link: string;
}

/** One run of a workflow that the ledger examined, with an event or not. It gives the counts for the flake rates. */
export interface LedgerRun {
  readonly run: number;
  readonly at: string;
  readonly event: string;
  readonly branch: string;
  readonly conclusion: string;
  readonly link: string;
  /** the count of the jobs of the matrix */
  readonly shards: number;
  /** the count of the runs of the cells on each dataplane, with the warm-ups and the void runs */
  readonly runs: Readonly<Record<string, number>>;
}

/** The ledger of one workflow of cells. */
export interface Ledger {
  readonly workflow: string;
  readonly file: string;
  /** the idle share of the CPUs that a run of the cells waits for */
  readonly idle: number;
  readonly runs: readonly LedgerRun[];
  readonly events: readonly LedgerEvent[];
}

/** One step of a job, as `gh run view --json jobs` gives it. */
export interface StepInput {
  readonly name: string;
  readonly conclusion: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

/** One job of a run, as `gh run view --json jobs` gives it. */
export interface JobInput {
  readonly databaseId: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly url: string;
  readonly steps: readonly StepInput[];
}

/** One run of a workflow, as `gh run view --json` gives it. */
export interface RunInput {
  readonly databaseId: number;
  readonly event: string;
  readonly headBranch: string;
  readonly conclusion: string;
  readonly status: string;
  readonly createdAt: string;
  readonly url: string;
  readonly jobs: readonly JobInput[];
}

/** One run of a cell, from a raw record: its environment, its index, and its void reason or null. */
export interface CellRunInput {
  readonly env: number | null;
  readonly index: number;
  readonly warmup: boolean;
  readonly void: string | null;
}

/** The runs of one cell in the artifact of a shard. */
export interface RecordInput {
  readonly cell: string;
  readonly dataplane: string;
  readonly runs: readonly CellRunInput[];
}

/** What the script found for one shard: its records, and for a job that did not succeed, its annotations and its log. */
export interface ShardInput {
  readonly records: readonly RecordInput[];
  readonly annotations: readonly string[];
  readonly log: string | null;
}

/** The options of one workflow: the name of its step of the cells, and the idle share that a run waits for. */
export interface WorkflowOptions {
  readonly step: string;
  readonly idle: number;
}

/** The conclusions of a job that give no event. */
const CLEAN = new Set(["success", "skipped", "neutral"]);

/** A hung shard waited for a quiet VM for this share of its step, or more. */
export const HUNG_SHARE = 0.5;

/** This function gives the number of the shard of a job of a matrix, for example 3 of `kind (3)`, or null. */
export const shardOf = (name: string): number | null => {
  const match = /\((\d+)\)$/.exec(name);
  return match === null ? null : Number(match[1]);
};

/** This function gives the seconds from one time stamp to another, rounded to the second. */
const secondsBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 1000);

/** This function gives the cause of a void run from its reason. */
export const voidCause = (why: string): Cause => (/not quiet/.test(why) ? "quiet" : /not at rest/.test(why) ? "rest" : "other");

/** This function gives the idle share of a text, for example 0.59 of `59% idle`, or null. */
const idleIn = (text: string): number | null => {
  const match = /(\d+)% idle/.exec(text);
  return match === null ? null : Number(match[1]) / 100;
};

/** One line of the log of a job: its time in milliseconds and its text, without the color codes. */
interface LogLine {
  readonly t: number;
  readonly text: string;
}

/** This function reads the log of a job: each line with a time stamp, in sequence. */
export const logLines = (log: string): LogLine[] => {
  const out: LogLine[] = [];
  for (const raw of log.split("\n")) {
    // a line of `gh run view --log` is the job, the step and the time stamp with the text, apart by tabs
    const tail = raw.split("\t").at(-1) ?? "";
    const match = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) ?(.*)$/.exec(tail);
    if (match === null) continue;
    out.push({ t: Date.parse(match[1]!), text: match[2]!.replace(/\u001b\[[0-9;]*m/g, "").trim() });
  }
  return out;
};

/** What the log of a step tells: the time that it waited for a quiet VM, and the idle range. It also gives the cell and the cluster at its end. */
export interface StepLog {
  readonly waited: number;
  readonly waits: number;
  readonly idle: IdleRange | null;
  readonly cell: string | null;
  readonly env: number | null;
  readonly dataplane: string | null;
}

/**
 * This function reads the lines of a log from `from` to `to`. Each line `waiting: N% idle` is one wait for a
 * quiet VM. A wait lasts until the next line with text. The last line of a cell and of a cluster tell what
 * the step did at its end.
 */
export const stepLog = (lines: readonly LogLine[], from: string, to: string): StepLog => {
  const start = Date.parse(from);
  const end = Date.parse(to) + 1000;
  const inside = lines.filter((line) => line.t >= start && line.t <= end && line.text !== "");
  let waited = 0;
  let waits = 0;
  const idles: number[] = [];
  let cell: string | null = null;
  let env: number | null = null;
  let dataplane: string | null = null;
  for (let at = 0; at < inside.length; at += 1) {
    const line = inside[at]!;
    if (line.text.startsWith("waiting:")) {
      waits += 1;
      const idle = idleIn(line.text);
      if (idle !== null) idles.push(idle);
      waited += Math.min(120, ((inside[at + 1]?.t ?? end) - line.t) / 1000);
      continue;
    }
    const ofCell = /^.+ \((\S+)\), environment (\d+)$/.exec(line.text);
    if (ofCell !== null) {
      cell = ofCell[1]!;
      env = Number(ofCell[2]);
      continue;
    }
    const ofCluster = /^cluster \S+: (\S+), \d+ workers/.exec(line.text);
    if (ofCluster !== null) dataplane = ofCluster[1]!;
  }
  return {
    waited: Math.round(waited),
    waits,
    idle: idles.length === 0 ? null : { low: Math.min(...idles), high: Math.max(...idles) },
    cell,
    env,
    dataplane,
  };
};

/** This function removes each name of a person from a message of GitHub: `canceled by @name` becomes `canceled by a person`. */
const anonymous = (message: string): string => message.replace(/@[\w-]+/g, "a person");

/** This function gives the base kind and the cause of a job that did not succeed, from its conclusion and its annotations. */
const jobCause = (job: JobInput, annotations: readonly string[]): { kind: EventKind; cause: Cause } => {
  const text = annotations.join("\n");
  if (/has timed out|exceeded the maximum execution time/i.test(text)) return { kind: "timeout", cause: "timeout" };
  if (/lost communication|shutdown signal|runner has received|hosted runner/i.test(text)) return { kind: job.conclusion === "cancelled" ? "cancelled" : "failed", cause: "runner" };
  if (job.conclusion === "cancelled") return { kind: "cancelled", cause: /canceled by/i.test(text) ? "person" : "other" };
  if (/Snapshot|AssertionError|Error:|expected/i.test(text)) return { kind: "failed", cause: "test" };
  return { kind: "failed", cause: "other" };
};

/** This function gives the first annotation that tells more than the exit code. */
const mainAnnotation = (annotations: readonly string[]): string | null => {
  if (annotations.some((each) => /^The run was canceled by @/.test(each))) return "A person cancelled the run.";
  const telling = annotations.filter((each) => !/^Process completed with exit code/.test(each));
  const first = telling[0] ?? annotations[0];
  return first === undefined ? null : anonymous(first.split("\n")[0]!.slice(0, 200));
};

/** This function writes a share as a percent: 0.59 becomes 59%. */
const percent = (share: number): string => `${Math.round(share * 100)}%`;

/** This function gives the event of a job that did not succeed, or null for a clean job. */
export const jobEvent = (run: RunInput, job: JobInput, shard: ShardInput, options: WorkflowOptions): LedgerEvent | null => {
  if (CLEAN.has(job.conclusion)) return null;
  const step = job.steps.find((each) => each.conclusion === "failure" || each.conclusion === "cancelled" || each.conclusion === "timed_out") ?? null;
  const from = step?.startedAt ?? job.startedAt;
  const to = step?.completedAt ?? job.completedAt;
  const total = secondsBetween(from, to);
  const base = jobCause(job, shard.annotations);
  const log = shard.log === null ? null : stepLog(logLines(shard.log), from, to);
  const stopped = base.kind === "cancelled" || base.kind === "timeout";
  const hung = stopped && log !== null && total > 0 && log.waited >= HUNG_SHARE * total;
  const about = stopped && log !== null;
  const note = mainAnnotation(shard.annotations);
  const minutes = (seconds: number): number => Math.round(seconds / 60);
  const detail = hung
    ? `The step waited for a quiet VM for approximately ${minutes(log.waited)} of its ${minutes(total)} min, at ${percent(log.idle?.low ?? 0)} to ${percent(log.idle?.high ?? 0)} idle, under the share of ${percent(options.idle)}.${note === null ? "" : ` ${note}`}`
    : (note ?? `The job ended with the conclusion ${job.conclusion}.`);
  return {
    run: run.databaseId,
    job: job.databaseId,
    shard: shardOf(job.name),
    kind: hung ? "hung" : base.kind,
    cause: hung ? "quiet" : base.cause,
    cell: about ? log.cell : null,
    dataplane: about ? log.dataplane : null,
    step: step?.name ?? null,
    env: about ? log.env : null,
    index: null,
    duration: { value: total, unit: "s" },
    idle: hung ? log.idle : null,
    detail,
    link: job.url,
  };
};

/** This function gives an event for each void run in the records of a shard. */
export const voidEvents = (run: RunInput, job: JobInput, shard: ShardInput, options: WorkflowOptions): LedgerEvent[] => {
  const step = job.steps.find((each) => each.name === options.step)?.name ?? null;
  return shard.records.flatMap((record) =>
    record.runs.flatMap((each): LedgerEvent[] => {
      if (each.void === null) return [];
      const cause = voidCause(each.void);
      const bound = /in (\d+(?:\.\d+)?) s/.exec(each.void);
      const idle = idleIn(each.void);
      return [
        {
          run: run.databaseId,
          job: job.databaseId,
          shard: shardOf(job.name),
          kind: "void",
          cause,
          cell: record.cell,
          dataplane: record.dataplane,
          step,
          env: each.env,
          index: each.warmup ? -1 : each.index,
          duration: cause === "quiet" && bound !== null ? { value: Number(bound[1]), unit: "s" } : null,
          idle: idle === null ? null : { low: idle, high: idle },
          detail: each.void,
          link: job.url,
        },
      ];
    }),
  );
};

/**
 * This function gives the key of an event: the run, the job, and the cell, the environment and the index of
 * a void run. The ledger has one event for each key, thus a second scan of a run adds nothing. The event
 * of a job has one key for each job. Thus a scan after its log expired does not add it again.
 */
export const keyOf = (event: LedgerEvent): string =>
  event.kind === "void" ? [event.run, event.job, "void", event.cell ?? "", event.env ?? "", event.index ?? ""].join("/") : [event.run, event.job, "job"].join("/");

/**
 * This function gives the entry of a run and its events, from the run, its jobs and what the script found
 * for each job. It stops for a run that has not ended.
 */
export const eventsOf = (run: RunInput, shards: ReadonlyMap<number, ShardInput>, options: WorkflowOptions): { run: LedgerRun; events: LedgerEvent[] } => {
  if (run.status !== "completed") throw new Error(`the run ${run.databaseId} has not ended: ${run.status}`);
  const events: LedgerEvent[] = [];
  const runs: Record<string, number> = {};
  for (const job of run.jobs) {
    const shard = shards.get(job.databaseId) ?? { records: [], annotations: [], log: null };
    for (const record of shard.records) runs[record.dataplane] = (runs[record.dataplane] ?? 0) + record.runs.length;
    events.push(...voidEvents(run, job, shard, options));
    const event = jobEvent(run, job, shard, options);
    if (event !== null) {
      events.push(event);
      // the run that the shard did not end is a run of its dataplane too
      if (event.dataplane !== null && event.cell !== null) runs[event.dataplane] = (runs[event.dataplane] ?? 0) + 1;
    }
  }
  return {
    run: {
      run: run.databaseId,
      at: run.createdAt,
      event: run.event,
      branch: run.headBranch,
      conclusion: run.conclusion,
      link: run.url,
      shards: run.jobs.filter((job) => shardOf(job.name) !== null).length,
      runs,
    },
    events,
  };
};

/** This function sorts the events of a ledger: by run, shard, cell, environment and index. */
const byPlace = (a: LedgerEvent, b: LedgerEvent): number =>
  a.run - b.run || (a.shard ?? -1) - (b.shard ?? -1) || (a.cell ?? "").localeCompare(b.cell ?? "") || (a.env ?? -1) - (b.env ?? -1) || (a.index ?? -2) - (b.index ?? -2) || a.kind.localeCompare(b.kind);

/**
 * This function adds a run and its events to a ledger. The entry of a run replaces an entry of the same
 * run. An event with a key that the ledger has is not added again.
 */
export const merged = (ledger: Ledger, run: LedgerRun, events: readonly LedgerEvent[]): Ledger => {
  const known = new Set(ledger.events.map(keyOf));
  const added = events.filter((event) => {
    const key = keyOf(event);
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
  return {
    ...ledger,
    runs: [...ledger.runs.filter((each) => each.run !== run.run), run].sort((a, b) => a.run - b.run),
    events: [...ledger.events, ...added].sort(byPlace),
  };
};

/**
 * This limit is for the idle share of 60%. The share holds for a dataplane while at most this part of its
 * runs is void by the wait for a quiet VM. A hung shard with that cause counts as one such run.
 */
export const QUIET_LIMIT = 0.05;

/** The flake rate of one dataplane: its runs, its events, and the runs that the wait for a quiet VM voided or hung. */
export interface DataplaneRate {
  readonly dataplane: string;
  readonly runs: number;
  readonly events: number;
  readonly rate: number;
  readonly quiet: number;
  readonly quietRate: number;
  /** the lowest idle share that an event of the wait saw, or null */
  readonly lowest: number | null;
  /** `change` when the share of the runs that the wait voided is above `QUIET_LIMIT` */
  readonly threshold: "holds" | "change";
}

/** The flake rate of one workflow: the shards with at least one event, of all its shards, and the rate of each dataplane. */
export interface WorkflowRate {
  readonly workflow: string;
  readonly runs: number;
  readonly shards: number;
  readonly flaky: number;
  readonly rate: number;
  readonly events: number;
  readonly causes: Readonly<Partial<Record<Cause, number>>>;
  readonly dataplanes: readonly DataplaneRate[];
}

/** This function gives the flake rates of a ledger. A rate with no runs is 0. */
export const ratesOf = (ledger: Ledger): WorkflowRate => {
  const shards = ledger.runs.reduce((sum, run) => sum + run.shards, 0);
  const flaky = new Set(ledger.events.filter((event) => event.shard !== null).map((event) => `${event.run}/${event.job}`)).size;
  const causes: Partial<Record<Cause, number>> = {};
  for (const event of ledger.events) causes[event.cause] = (causes[event.cause] ?? 0) + 1;
  const names = [...new Set([...ledger.runs.flatMap((run) => Object.keys(run.runs)), ...ledger.events.flatMap((event) => (event.dataplane === null ? [] : [event.dataplane]))])].sort();
  const dataplanes = names.map((dataplane): DataplaneRate => {
    const runs = ledger.runs.reduce((sum, run) => sum + (run.runs[dataplane] ?? 0), 0);
    const mine = ledger.events.filter((event) => event.dataplane === dataplane);
    const quiet = mine.filter((event) => event.cause === "quiet");
    const lows = quiet.flatMap((event) => (event.idle === null ? [] : [event.idle.low]));
    const quietRate = runs === 0 ? 0 : quiet.length / runs;
    return {
      dataplane,
      runs,
      events: mine.length,
      rate: runs === 0 ? 0 : mine.length / runs,
      quiet: quiet.length,
      quietRate,
      lowest: lows.length === 0 ? null : Math.min(...lows),
      threshold: quietRate > QUIET_LIMIT ? "change" : "holds",
    };
  });
  return { workflow: ledger.workflow, runs: ledger.runs.length, shards, flaky, rate: shards === 0 ? 0 : flaky / shards, events: ledger.events.length, causes, dataplanes };
};
