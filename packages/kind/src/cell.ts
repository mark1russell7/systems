import type { Extent, Quantity } from "@mark1russell7/quantity";
import type { Coupling, Gate, Poll, Stage, Timing } from "@mark1russell7/service";
import type { RedisKnobs } from "@mark1russell7/service/redis";
import type { KubeProxyMode } from "./scenario.ts";

/** A template is the topology of a cell: T07, the endpoint lifecycle of a Service, or T18, a health-gated fleet. */
export type Template = "T07" | "T18";

/**
 * A trigger is the event or the fault of a cell, by the name of the plan:
 * - `pod-deletion`, `rolling-update`, `node-drain` and `scale-in` stop a pod with its grace.
 * - `crash` stops the process of the service with SIGKILL from the node.
 * - `liveness-restart` fails the liveness check of one replica, and the kubelet restarts it.
 * - `freeze-process` stops a process with SIGSTOP from the node: kube-proxy on one node (T07), or Redis (T18).
 * - `rst` and `blackhole` are the rules of the injector of the harness in the namespace of Redis.
 * - `peer-gone-without-close` drops the segments of Redis, and then Redis goes away.
 * - `app-stall` blocks the event loop of one replica.
 * - `rollout` is a rolling update while Redis is down.
 * - `cpu-throttle` sets `cpu.max` in the cgroup of one replica.
 * - `none` injects nothing: a calibration measures the path itself.
 */
export type TriggerKind =
  | "pod-deletion"
  | "rolling-update"
  | "node-drain"
  | "scale-in"
  | "crash"
  | "liveness-restart"
  | "freeze-process"
  | "rst"
  | "blackhole"
  | "peer-gone-without-close"
  | "app-stall"
  | "rollout"
  | "cpu-throttle";

/**
 * A trigger is its kind and the settings of its fault. The parameter `A` is the form of an amount:
 * a quantity in the format `/2`, a number in the format `/1`.
 */
export interface Trigger<A = Quantity> {
  readonly kind: TriggerKind;
  /** This time is how long a fault holds before it ends: a stall, a pause of kube-proxy, a black hole on Redis. */
  readonly hold?: Quantity | undefined;
  /** This time is how long before the deletion a pause of kube-proxy starts (T07 `freeze-process`). */
  readonly lead?: Quantity | undefined;
  /** This value is the `cpu.max` of a throttle: the quota and the period. The format `/1` gives each one in microseconds. */
  readonly cpuMax?: { readonly quota: A; readonly period: A } | undefined;
}

/** A kubelet probe is the period, the failure threshold and the timeout of one probe of the pod. */
export interface KubeletProbe {
  readonly period: Quantity;
  readonly threshold: number;
  readonly timeout: Quantity;
}

/** The pod settings are the part of the cell that the manifest of the Deployment holds. */
export interface PodSettings {
  readonly replicas: number;
  /** This time is `terminationGracePeriodSeconds`. */
  readonly grace: Quantity;
  /** This time is the preStop sleep, or zero for no preStop hook. */
  readonly preStop: Quantity;
  readonly readiness: KubeletProbe;
  readonly liveness: KubeletProbe;
  /** This probe is the startup probe, or null for none, the default of Kubernetes. */
  readonly startup: KubeletProbe | null;
}

/** The Redis part of a declaration: the gate of the round trip of the client, its knobs and its watchdog. */
export interface RedisDeclaration {
  /** This gate is the policy that the round-trip check controls, or null for a check that only reports. */
  readonly gates: Gate | null;
  readonly knobs: RedisKnobs;
  readonly misses: number;
}

/**
 * A declaration is the settings of the service in the image. The app composes its service from them
 * with `@mark1russell7/service`, and `lint()` reads the same declaration.
 */
export interface Declaration {
  readonly poll: Poll;
  readonly readiness: Timing;
  readonly liveness: Timing;
  readonly startup: Quantity;
  /** These are the caps of each stage of the shutdown, in the sequence of the stages. */
  readonly phases: ReadonlyArray<readonly [Stage, Quantity]>;
  readonly cooperativeWindow: Extent;
  readonly couplings: readonly Coupling[];
  /** This part is null for a service without Redis. */
  readonly redis: RedisDeclaration | null;
  /** This gate is the policy of the check that a flag file fails, the seam of `liveness-restart`, or null for no such check. */
  readonly flag: Gate | null;
  /** This watchdog of the event loop gates liveness: a tick later than the threshold fails it. Null declares no watchdog. */
  readonly watchdog: { readonly tick: Quantity; readonly threshold: Quantity } | null;
}

/** A workload is the clients: one pod on each node, each with requests on new connections to the ClusterIP. */
export interface Workload {
  /** This time is the interval between two requests of one client. The clients do not wait for an answer. */
  readonly every: Quantity;
  /** This time is how long a client waits for an answer before the request is a timeout. */
  readonly timeout: Quantity;
}

/**
 * A band is a range of times after a reference event of the run. The format `/1` gives each end
 * in seconds, as a number.
 */
export interface Band<A = Quantity> {
  readonly lo: A;
  readonly hi: A;
}

/**
 * A reference is the event of a run that a band counts from:
 * - `deletion`: the first deletion timestamp of a target pod, as the watcher receives it.
 * - `intake`: the stop of the intake of the target pod, as its service records it.
 * - `fault`: the commit of the fault, as the injector or the agent stamps it.
 * - `resume`: the end of a pause of kube-proxy, as the agent stamps it.
 */
export type Reference = "deletion" | "intake" | "fault" | "resume";

/**
 * A prediction is what the cell expects:
 * - `none`: no request fails in the run.
 * - `window`: the requests that fail start in a window. The window starts at `start` and ends in
 *   `end`. With `certain`, at least one request fails.
 * - `removal`: the Service has no ready endpoint, and the rules of each node have no backend, in the band.
 * - `leaves`: the target replica leaves the EndpointSlice and the rules of each node in the band.
 * - `restarts`: each replica receives SIGTERM in the band, or no replica does.
 * - `stays`: no endpoint leaves the Service, and no request is refused.
 * - `stalls`: the rollout does not continue while Redis is down, and it ends after Redis is back.
 * - `measured`: no document bounds the outcome. The run keeps the measurement.
 */
export type Prediction<A = Quantity> =
  | {
      readonly kind: "none";
      /** These outcomes are the failures that the prediction excludes. Without them, it excludes each outcome but `ok`. */
      readonly outcomes?: readonly string[] | undefined;
      readonly why: string;
    }
  | {
      readonly kind: "window";
      readonly nodes: "all" | "paused";
      readonly start: { readonly from: Reference; readonly band: Band<A> };
      readonly end: { readonly from: Reference; readonly band: Band<A> } | null;
      readonly certain: boolean;
      readonly why: string;
    }
  | { readonly kind: "removal"; readonly band: Band<A>; readonly why: string }
  | { readonly kind: "leaves"; readonly band: Band<A>; readonly why: string }
  | { readonly kind: "restarts"; readonly band: Band<A> | null; readonly why: string }
  | { readonly kind: "stays"; readonly why: string }
  | { readonly kind: "stalls"; readonly why: string }
  | { readonly kind: "measured"; readonly why: string };

/** A replica is one pod of the service at the start of a run. */
export interface Replica {
  readonly pod: string;
  readonly node: string;
  readonly ip: string;
  readonly version: string;
}

/**
 * A kind run is one run of a cell: its lines, the stamps of its acts, and the replicas at its
 * start. The judge derives each other reference from the lines, thus a holder of the raw record
 * can judge it again.
 *
 * A stamp is a reading of CLOCK_MONOTONIC in milliseconds. It is a point on a clock, not an
 * amount, thus it stays a number, as in each line.
 */
export interface KindRun {
  readonly env: number;
  readonly index: number;
  readonly warmup: boolean;
  /** These stamps are the start and the end of the run. */
  readonly start: number;
  readonly end: number;
  /** These are the stamps of the acts: the start of the fault, its heal, and the end of a pause of kube-proxy. */
  readonly acts: { readonly fault: number | null; readonly heal: number | null; readonly resume: number | null };
  /** This replica is the target of the trigger, or null for a fault on Redis. */
  readonly target: Replica | null;
  /** This node is the node whose kube-proxy paused, or null. */
  readonly paused: string | null;
  readonly replicas: readonly Replica[];
  readonly void: string | null;
  readonly lines: ReadonlyArray<{ readonly ev: string; readonly t: number; readonly [field: string]: unknown }>;
  /** These counts are the kernel records that the lab did not keep, by kind. */
  readonly dropped: Readonly<Record<string, number>>;
  /** These texts tell of an act of the heal or the restore that failed. */
  readonly notes?: readonly string[] | undefined;
}

/** A kind cell is all that one measurement in kind needs, as data. The parameter `A` is the form of an amount. */
export interface KindCell<A = Quantity> {
  /** This identifier is the cell of the plan that the cell stands for. */
  readonly id: string;
  readonly name: string;
  readonly template: Template;
  /** This text names a system of the plan that the cell replaces with the service of this repository, or null. */
  readonly substitutes: string | null;
  readonly mode: KubeProxyMode;
  readonly workers: number;
  readonly trigger: Trigger<A>;
  readonly pod: PodSettings;
  readonly declaration: Declaration;
  readonly workload: Workload;
  readonly prediction: Prediction<A>;
  /** This flag marks a calibration: its runs measure the propagation of the endpoints, and nothing fails. */
  readonly calibrates: boolean;
  readonly runs: number;
}
