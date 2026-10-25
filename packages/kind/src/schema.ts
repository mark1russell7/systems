import type { Quantity } from "@mark1russell7/quantity";
import { extentSchema, quantitySchema } from "@mark1russell7/quantity/schema";
import type { Stage } from "@mark1russell7/service";
import { z } from "zod";
import type { KindRun, TriggerKind } from "./cell.ts";
import type { KindCellRecord, KindCellRecordV1 } from "./record.ts";
import { FORMAT, FORMAT_V1, upgrade } from "./record.ts";
import type { KubeProxyMode } from "./scenario.ts";
import { unitOf } from "./verdict.ts";

/**
 * This module holds the zod schemas of a kind cell record, in the formats `/1` and `/2`. It names
 * the stages of the shutdown itself, thus it does not load the service. A test holds the names to
 * the service.
 */

/** These are the stages of the shutdown of the service, in their sequence. */
export const STAGES: readonly [Stage, ...Stage[]] = [
  "fail readiness",
  "stop intake",
  "drain",
  "close transports",
  "stop the poller",
  "tear down dependencies",
  "close the health server",
  "flush the output",
];

const TRIGGERS = [
  "pod-deletion",
  "rolling-update",
  "node-drain",
  "scale-in",
  "crash",
  "liveness-restart",
  "freeze-process",
  "rst",
  "blackhole",
  "peer-gone-without-close",
  "app-stall",
  "rollout",
  "cpu-throttle",
  "authorization-policy",
  "idle",
  "ztunnel-restart",
] as const satisfies readonly TriggerKind[];
const MODES = ["iptables", "ipvs", "nftables"] as const satisfies readonly KubeProxyMode[];

const time = quantitySchema("time");
const extent = extentSchema("time");
const count = z.number().int().nonnegative();
const gate = z.enum(["readiness", "liveness"]);
const reference = z.enum(["deletion", "intake", "fault", "resume", "heal", "restart"]);

const probe = z.object({ period: time, threshold: count, timeout: time });
const timing = z.discriminatedUnion("type", [
  z.object({ type: z.literal("debounce"), interval: time, failAfter: count, recoverAfter: count }),
  z.object({ type: z.literal("window"), failAfter: time, recoverAfter: time.optional() }),
]);
const knobs = z.object({
  connect_bound: time,
  request_timeout: time,
  driver_writeoff_time: extent,
  keepalive_idle: extent,
  heartbeat_interval: extent,
  heartbeat_timeout: time,
  client_retry_window: extent,
  retry_base: time,
  retry_cap: time,
  close_bound: time,
  max_connection_age: extent,
  retrans_giveup_time: extent,
});
const declaration = z.object({
  poll: z.object({ interval: time, jitter: z.number().min(0).lt(1), timeout: time }),
  readiness: timing,
  liveness: timing,
  startup: time,
  phases: z.array(z.tuple([z.enum(STAGES), time])),
  cooperativeWindow: extent,
  couplings: z.array(z.object({ from: gate, to: gate, effect: z.literal("fails") })),
  redis: z.object({ gates: gate.nullable(), knobs, misses: count }).nullable(),
  flag: gate.nullable(),
  watchdog: z.object({ tick: time, threshold: time }).nullable(),
});

const replica = z.object({ pod: z.string(), node: z.string(), ip: z.string(), version: z.string() });
/** A line keeps each field that its source wrote. The judge reads `ev`, `t` and the fields of its kind. */
const line = z.object({ ev: z.string(), t: z.number() }).catchall(z.unknown());
const run: z.ZodType<KindRun> = z.object({
  env: count,
  index: z.number().int(),
  warmup: z.boolean(),
  start: z.number(),
  end: z.number(),
  acts: z.object({ fault: z.number().nullable(), heal: z.number().nullable(), resume: z.number().nullable() }),
  target: replica.nullable(),
  paused: z.string().nullable(),
  replicas: z.array(replica),
  void: z.string().nullable(),
  lines: z.array(line),
  dropped: z.record(z.string(), count),
  notes: z.array(z.string()).optional(),
});
const manifest = z.object({
  env: count,
  scenario: z.object({
    name: z.string(),
    kubernetes: z.string(),
    workers: count,
    kubeProxy: z.object({ mode: z.enum(MODES), minSyncPeriod: time, syncPeriod: time }),
    cni: z.literal("kindnet"),
    podSubnet: z.string(),
    serviceSubnet: z.string(),
  }),
  cluster: z.object({
    kind: z.string(),
    nodeImage: z.string(),
    server: z.string(),
    mode: z.string(),
    docker: z.string(),
    nodes: z.array(z.object({ name: z.string(), kubelet: z.string(), kernel: z.string(), runtime: z.string(), os: z.string() })),
  }),
  images: z.record(z.string(), z.string()),
});
const load = z.object({ t: z.number(), idle: z.number(), top: z.array(z.string()), foreign: z.array(z.string()) });

/**
 * This function gives the schema of a record whose amounts have one form. The schema `a` is for a
 * time. The schema `main` is for the main value of a run: a time or a count.
 */
const recordOf = <A>(a: z.ZodType<A>, main: z.ZodType<A>) => {
  const band = z.object({ lo: a, hi: a });
  const window = z.object({
    kind: z.literal("window"),
    nodes: z.enum(["all", "paused"]),
    start: z.object({ from: reference, band }),
    end: z.object({ from: reference, band }).nullable(),
    certain: z.boolean(),
    afterReset: z.object({ life: a, outcome: z.string() }).optional(),
    each: z.boolean().optional(),
    propagation: band.optional(),
    outcomes: z.array(z.string()).optional(),
    why: z.string(),
  });
  const prediction = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none"), outcomes: z.array(z.string()).optional(), why: z.string() }),
    window,
    z.object({ kind: z.literal("removal"), band, why: z.string() }),
    z.object({ kind: z.literal("leaves"), band, why: z.string() }),
    z.object({ kind: z.literal("restarts"), band: band.nullable(), why: z.string() }),
    z.object({ kind: z.literal("stays"), why: z.string() }),
    z.object({ kind: z.literal("stalls"), why: z.string() }),
    z.object({ kind: z.literal("ends"), from: reference, band: band.nullable(), window: window.optional(), of: z.enum(["socket", "tunnel"]).optional(), answer: band.optional(), why: z.string() }),
    z.object({ kind: z.literal("measured"), why: z.string() }),
  ]);
  const cell = z.object({
    id: z.string(),
    name: z.string(),
    template: z.enum(["T07", "T15", "T18"]),
    stack: z.enum(["service", "grpc"]).optional(),
    mesh: z
      .object({ flavor: z.enum(["sidecar", "ambient"]), mode: z.enum(["sidecar", "ambient"]), ztunnel: z.record(z.string(), z.string()).optional() })
      .optional(),
    substitutes: z.string().nullable(),
    mode: z.enum(MODES),
    workers: count,
    trigger: z.object({
      kind: z.enum(TRIGGERS),
      hold: time.optional(),
      lead: time.optional(),
      cpuMax: z.object({ quota: a, period: a }).optional(),
      account: z.string().optional(),
      middlebox: time.optional(),
      retries: count.optional(),
      quiet: z.boolean().optional(),
      close: z.boolean().optional(),
    }),
    pod: z.object({ replicas: count, grace: time, preStop: time, readiness: probe, liveness: probe, startup: probe.nullable() }),
    declaration: declaration.nullable(),
    workload: z.object({ every: time, timeout: time }),
    prediction,
    calibrates: z.boolean(),
    runs: count,
  });
  const facts = z.object({
    failures: count,
    outcomes: z.record(z.string(), count),
    byNode: z.record(z.string(), count),
    first: z.number().nullable(),
    last: z.number().nullable(),
    deletion: z.number().nullable(),
    intakeAfterDeletion: a.nullable(),
    sliceAfter: a.nullable(),
    propagation: z.record(z.string(), z.object({ after: a.nullable(), by: a }).nullable()),
    sliceEmpty: a.optional(),
    rules: z.record(z.string(), a.nullable()).optional(),
    left: a.optional(),
    signals: z.array(a.nullable()).optional(),
    windows: z.array(z.object({ pod: z.string(), intake: z.number().nullable(), deletion: z.number() })).optional(),
    updates: z.record(z.string(), z.object({ after: a.nullable(), by: a }).nullable()).optional(),
    healUpdates: z.record(z.string(), z.object({ after: a.nullable(), by: a }).nullable()).optional(),
    closes: z.record(z.string(), a.nullable()).optional(),
  });
  const verdict = z.object({
    decision: z.enum(["holds", "fails", "extend", "measured", "calibration", "void"]),
    counted: count,
    voided: count,
    failed: count,
    median: main.nullable(),
    why: z.string(),
    checks: z.array(z.object({ ok: z.boolean(), why: z.string(), value: main.nullable(), facts, tail: z.string().optional() })),
  });
  return { cell, verdict, runs: z.array(run), manifests: z.array(manifest), loads: z.array(load), at: z.string() };
};

const v2 = recordOf<Quantity>(time, quantitySchema(["time", "count"]));
const v1 = recordOf<number>(z.number(), z.number());

/**
 * This schema accepts a record in the format `/2`. The median and the main value of each run must
 * have the unit of the prediction of the cell (`unitOf`).
 */
export const kindCellRecordSchema: z.ZodType<KindCellRecord> = z
  .object({ format: z.literal(FORMAT), ...v2 })
  .superRefine((record, ctx) => {
    const unit = unitOf(record.cell.prediction);
    const values = [record.verdict.median, ...record.verdict.checks.map((check) => check.value)];
    for (const value of values) {
      if (value !== null && value.unit !== unit)
        ctx.addIssue({ code: "custom", message: `the main value is in ${value.unit}, and the prediction ${record.cell.prediction.kind} gives ${unit}` });
    }
  });

/** This schema accepts a record in the format `/1`. */
export const kindCellRecordV1Schema: z.ZodType<KindCellRecordV1> = z.object({ format: z.literal(FORMAT_V1), ...v1 });

/** This function reads a record of either format from parsed JSON, and gives it in the format `/2`. */
export const readRecord = (data: unknown): KindCellRecord => {
  const format = typeof data === "object" && data !== null ? (data as { format?: unknown }).format : undefined;
  if (format === FORMAT_V1) return upgrade(kindCellRecordV1Schema.parse(data));
  if (format === FORMAT) return kindCellRecordSchema.parse(data);
  throw new Error(`a kind cell record has the format ${FORMAT} or ${FORMAT_V1}, not ${String(format)}`);
};
