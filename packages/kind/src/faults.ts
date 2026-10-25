import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { KindCell } from "./cell.ts";
import { CLIENT, REDIS, SERVER } from "./names.ts";

/**
 * This module maps each trigger of a cell to the acts of the lab, as data. The runner finds each
 * target at the time of the run. A target is a pod, the PID of a container, the network namespace
 * of a pod, or a cgroup.
 */

/**
 * A target is a process or a pod of the cell:
 * - `server` is the first replica of the service, in the sequence of its name.
 * - `redis` is the Redis pod.
 * - `kube-proxy` is kube-proxy on the first worker.
 * - `servers` is each replica of the service. Only the injector takes it: a rule in the network
 *   namespace of each replica, with each client pod as a peer. A REJECT resets only the sender of
 *   the segment that it matches, thus the rule goes where the segments of the clients arrive.
 */
export type Target = "server" | "redis" | "kube-proxy" | "servers";

/** A step is one act of a fault, in the sequence of the plan. */
export type Step =
  | { readonly do: "kubectl"; readonly args: readonly string[]; readonly background?: boolean }
  | { readonly do: "signal"; readonly target: Target; readonly signal: "SIGKILL" | "SIGSTOP" | "SIGCONT" }
  /** This step sends SIGSTOP, then SIGCONT `time` later, as the VM times it. The next step starts at once. */
  | { readonly do: "pause"; readonly target: Target; readonly time: Quantity }
  /**
   * This step starts the injector of the harness in the namespace of the target, with each replica of
   * the service as a peer. For the target `servers`, it starts it in the namespace of each replica,
   * with each client pod as a peer. The rules of all replicas commit at one instant.
   */
  | { readonly do: "inject"; readonly target: Target; readonly action: "blackhole" | "clear" | "rst" | "clear-rst" }
  | { readonly do: "flag"; readonly target: Target; readonly on: boolean }
  | { readonly do: "cpu"; readonly target: Target; readonly max: string }
  /** This step blocks the event loop of the target for `time`. */
  | { readonly do: "stall"; readonly target: Target; readonly time: Quantity }
  | { readonly do: "wait"; readonly time: Quantity }
  /** This step applies one object with `kubectl apply`. The runner fills the marks of its strings, for example `{namespace}`. */
  | { readonly do: "apply"; readonly object: Readonly<Record<string, unknown>> };

/**
 * A fault plan is the steps of a run:
 * - `inject` starts the trigger. The stamp of its first act is the `fault` reference.
 * - `heal` ends the fault, `hold` after the fault. A trigger that ends by itself has no heal.
 * - `restore` brings the cell back to its steady state after the run.
 */
export interface FaultPlan {
  readonly inject: readonly Step[];
  readonly hold: Quantity | null;
  readonly heal: readonly Step[];
  readonly restore: readonly Step[];
}

const needs = (time: Quantity | undefined, what: string): Quantity => {
  if (time === undefined) throw new Error(`the trigger needs ${what}`);
  return time;
};

/** This function gives an amount in microseconds as a whole number, for `cpu.max`. */
const micros = (amount: Quantity): number => Math.round(valueIn(amount, "us"));

/** This value marks the name of the target pod in the arguments of kubectl. The runner replaces it. */
export const POD = "{pod}";
/** This value marks the node of the target pod in the arguments of kubectl. */
export const NODE = "{node}";
/** This value marks the next version of the Deployment, for a rollout. */
export const VERSION = "{version}";
/** This annotation of a pod is its deletion cost for its ReplicaSet: a lower cost goes first at a scale-in. */
export const DELETION_COST = "controller.kubernetes.io/pod-deletion-cost";
/** This name is the name of the AuthorizationPolicy of the trigger `authorization-policy`. */
export const POLICY = "lab-deny";
/** This service account is the account of the clients: their pods name no other account. */
export const CLIENT_ACCOUNT = "default";

/**
 * This function gives the AuthorizationPolicy of the trigger `authorization-policy`. It denies each
 * request to the server pods from the principal of the service account `account`. Istio gives a
 * pod of the mesh the principal `cluster.local/ns/<namespace>/sa/<account>` of its account. The
 * RBAC filter of the server sidecar reads the principal of the peer from its mTLS certificate.
 */
export const policyObject = (account: string): Readonly<Record<string, unknown>> => ({
  apiVersion: "security.istio.io/v1",
  kind: "AuthorizationPolicy",
  metadata: { name: POLICY, namespace: "{namespace}" },
  spec: {
    selector: { matchLabels: { app: SERVER } },
    action: "DENY",
    rules: [{ from: [{ source: { principals: [`cluster.local/ns/{namespace}/sa/${account}`] } }] }],
  },
});

/**
 * This function gives the target of a reset or a black hole of a cell. In T07 and T18 it is Redis,
 * with the replicas as peers. In T15 the fault is on the mesh leg between the client pods and the
 * replicas. It is a rule in each replica, with the client pods as peers.
 */
const linkOf = (cell: KindCell): Target => (cell.template === "T15" ? "servers" : "redis");

/** This function gives the fault plan of a cell. */
export const planOf = (cell: KindCell): FaultPlan => {
  const ns = ["-n", "{namespace}"];
  const trigger = cell.trigger;
  const replicas = cell.pod.replicas;
  switch (trigger.kind) {
    case "pod-deletion":
      return { inject: [{ do: "kubectl", args: [...ns, "delete", "pod", POD, "--wait=false"] }], hold: null, heal: [], restore: [] };
    case "rolling-update":
      return {
        inject: [{ do: "kubectl", args: [...ns, "set", "env", `deployment/${SERVER}`, `LAB_VERSION=${VERSION}`] }],
        hold: null,
        heal: [],
        restore: [],
      };
    case "node-drain":
      return {
        inject: [
          {
            do: "kubectl",
            args: ["drain", NODE, "--ignore-daemonsets", "--delete-emptydir-data", "--timeout=180s", `--pod-selector=app=${SERVER}`],
            background: true,
          },
        ],
        hold: null,
        heal: [],
        restore: [{ do: "kubectl", args: ["uncordon", NODE] }],
      };
    case "scale-in":
      return {
        inject: [
          // the ReplicaSet removes a pod of a lower deletion cost first. The rank by readiness comes before
          // it, and the pods of a node come after it (pkg/controller/controller_utils.go at v1.37.0, lines
          // 853–874). The gate PodDeletionCost is on from 1.22 (pkg/features/kube_features.go, line 1953).
          // Thus the clients of gRPC on the first replica see its stop
          ...(cell.stack === "grpc" ? [{ do: "kubectl" as const, args: [...ns, "annotate", "pod", POD, `${DELETION_COST}=-1`, "--overwrite"] }] : []),
          { do: "kubectl", args: [...ns, "scale", `deployment/${SERVER}`, `--replicas=${replicas - 1}`] },
        ],
        hold: null,
        heal: [],
        restore: [{ do: "kubectl", args: [...ns, "scale", `deployment/${SERVER}`, `--replicas=${replicas}`] }],
      };
    case "crash":
      return { inject: [{ do: "signal", target: "server", signal: "SIGKILL" }], hold: null, heal: [], restore: [] };
    case "liveness-restart":
      // the container that the kubelet starts again has a new /tmp, thus the flag ends with it
      return { inject: [{ do: "flag", target: "server", on: true }], hold: null, heal: [], restore: [] };
    case "freeze-process":
      if (cell.template === "T07") {
        return {
          inject: [
            { do: "pause", target: "kube-proxy", time: needs(trigger.hold, "a hold") },
            { do: "wait", time: needs(trigger.lead, "a lead") },
            { do: "kubectl", args: [...ns, "delete", "pod", POD, "--wait=false"] },
          ],
          hold: null,
          heal: [],
          restore: [],
        };
      }
      return {
        inject: [{ do: "signal", target: "redis", signal: "SIGSTOP" }],
        hold: needs(trigger.hold, "a hold"),
        heal: [{ do: "signal", target: "redis", signal: "SIGCONT" }],
        restore: [],
      };
    case "rst":
      return {
        inject: [{ do: "inject", target: linkOf(cell), action: "rst" }],
        hold: needs(trigger.hold, "a hold"),
        heal: [{ do: "inject", target: linkOf(cell), action: "clear-rst" }],
        restore: [],
      };
    case "blackhole":
      return {
        inject: [{ do: "inject", target: linkOf(cell), action: "blackhole" }],
        hold: needs(trigger.hold, "a hold"),
        heal: [{ do: "inject", target: linkOf(cell), action: "clear" }],
        restore: [],
      };
    case "peer-gone-without-close":
      // the rules drop the FIN of Redis, then Redis goes away with its namespace and its rules
      return {
        inject: [
          { do: "inject", target: "redis", action: "blackhole" },
          { do: "kubectl", args: [...ns, "scale", `deployment/${REDIS}`, "--replicas=0"] },
        ],
        hold: needs(trigger.hold, "a hold"),
        heal: [{ do: "kubectl", args: [...ns, "scale", `deployment/${REDIS}`, "--replicas=1"] }],
        restore: [],
      };
    case "app-stall":
      return { inject: [{ do: "stall", target: "server", time: needs(trigger.hold, "a hold") }], hold: null, heal: [], restore: [] };
    case "rollout":
      // Redis is down for each pod, a new one too: the Service of Redis has no endpoint
      return {
        inject: [
          { do: "kubectl", args: [...ns, "scale", `deployment/${REDIS}`, "--replicas=0"] },
          { do: "kubectl", args: [...ns, "set", "env", `deployment/${SERVER}`, `LAB_VERSION=${VERSION}`] },
        ],
        hold: needs(trigger.hold, "a hold"),
        heal: [{ do: "kubectl", args: [...ns, "scale", `deployment/${REDIS}`, "--replicas=1"] }],
        restore: [],
      };
    case "cpu-throttle": {
      const max = trigger.cpuMax;
      if (max === undefined) throw new Error("the trigger needs its cpu.max");
      // the kernel reads cpu.max as the quota and the period in microseconds
      return {
        inject: [{ do: "cpu", target: "server", max: `${micros(max.quota)} ${micros(max.period)}` }],
        hold: needs(trigger.hold, "a hold"),
        heal: [{ do: "cpu", target: "server", max: `max ${micros(max.period)}` }],
        restore: [],
      };
    }
    case "authorization-policy":
      // the restore deletes a policy that a failed heal left
      return {
        inject: [{ do: "apply", object: policyObject(trigger.account ?? CLIENT_ACCOUNT) }],
        hold: needs(trigger.hold, "a hold"),
        heal: [{ do: "kubectl", args: [...ns, "delete", "authorizationpolicy", POLICY] }],
        restore: [{ do: "kubectl", args: [...ns, "delete", "authorizationpolicy", POLICY, "--ignore-not-found"] }],
      };
  }
};

/** This function tells if a trigger stops a pod of the service with its grace: a deletion, an eviction, a scale-in or a rollout. */
export const deletes = (cell: KindCell): boolean =>
  ["pod-deletion", "rolling-update", "node-drain", "scale-in"].includes(cell.trigger.kind) ||
  (cell.template === "T07" && cell.trigger.kind === "freeze-process");

/** These are the names of the objects of a cell that a plan names. */
export const OBJECTS: { readonly server: typeof SERVER; readonly client: typeof CLIENT; readonly redis: typeof REDIS } = {
  server: SERVER,
  client: CLIENT,
  redis: REDIS,
};
