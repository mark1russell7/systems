import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Flap, KindCell } from "./cell.ts";
import { CLIENT, REDIS, SERVER } from "./names.ts";
import { HBONE_PORT } from "./observe.ts";

/**
 * This module maps each trigger of a cell to the acts of the lab, as data. The runner finds each
 * target at the time of the run. A target is a pod, the PID of a container, the network namespace
 * of a pod, or a cgroup.
 */

/**
 * A target is a process or a pod of the cell:
 * - `server` is the first replica of the service, in the sequence of its name. The injector acts in
 *   its network namespace only, with each client pod as a peer: the partition of one replica.
 * - `redis` is the Redis pod.
 * - `kube-proxy` is kube-proxy on the first worker.
 * - `servers` is each replica of the service. Only the injector, a middlebox and a sysctl take it.
 *   Each one acts in the network namespace of each replica, with each client pod as a peer. A REJECT
 *   resets only the sender of the segment that it matches, thus the rule goes where the segments of
 *   the clients arrive.
 * - `clients` is the process of each client pod. Only a signal and a sysctl take it: the gap of the
 *   trigger `idle`, and a sysctl of the namespace of each client pod.
 */
export type Target = "server" | "redis" | "kube-proxy" | "servers" | "clients";

/** A step is one act of a fault, in the sequence of the plan. */
export type Step =
  | { readonly do: "kubectl"; readonly args: readonly string[]; readonly background?: boolean }
  /**
   * This step sends a signal to the target. For the target `clients`, it sends it to each client
   * process, the nodes at the same time. SIGUSR1 stops the calls of a gRPC client, and SIGUSR2 starts
   * them again. SIGHUP stops the calls and closes the channel, and the next SIGUSR2 opens a new channel.
   */
  | { readonly do: "signal"; readonly target: Target; readonly signal: "SIGKILL" | "SIGSTOP" | "SIGCONT" | "SIGUSR1" | "SIGUSR2" | "SIGHUP" }
  /** This step sends SIGSTOP, then SIGCONT `time` later, as the VM times it. The next step starts at once. */
  | { readonly do: "pause"; readonly target: Target; readonly time: Quantity }
  /**
   * This step starts the injector of the harness in the namespace of the target, with each replica of
   * the service as a peer. For the target `servers`, it starts it in the namespace of each replica,
   * with each client pod as a peer. The rules of all replicas commit at one instant. For the target
   * `server`, it starts it in the namespace of the target replica only, with each client pod as a peer.
   */
  | { readonly do: "inject"; readonly target: Target; readonly action: "blackhole" | "clear" | "rst" | "clear-rst" }
  | { readonly do: "flag"; readonly target: Target; readonly on: boolean }
  | { readonly do: "cpu"; readonly target: Target; readonly max: string }
  /** This step blocks the event loop of the target for `time`. */
  | { readonly do: "stall"; readonly target: Target; readonly time: Quantity }
  | { readonly do: "wait"; readonly time: Quantity }
  /** This step applies one object with `kubectl apply`. The runner fills the marks of its strings, for example `{namespace}`. */
  | { readonly do: "apply"; readonly object: Readonly<Record<string, unknown>> }
  /**
   * This step sets a sysctl of the network namespace of the target: each client pod (`clients`) or
   * each replica (`servers`). The injector of the harness enters each namespace in turn (`sysctlCommand`).
   */
  | { readonly do: "sysctl"; readonly target: Target; readonly key: string; readonly value: string }
  /**
   * This step puts a stateful middlebox in the network namespace of each replica (`servers`). Each
   * client pod is a peer, on the local port `port` (`middleboxCommands`). With `idle` null, the step
   * removes the middlebox and its chains.
   */
  | { readonly do: "middlebox"; readonly target: Target; readonly idle: Quantity | null; readonly port: number }
  /**
   * This step reads the workload certificates of the ztunnel pod of each node with istioctl. It adds a
   * line `certificates` with the validity of each leaf (`ztunnelCertificates`). It changes nothing.
   */
  | { readonly do: "certificates" };

/**
 * A fault plan is the steps of a run:
 * - `prepare` comes before the fault, and no reference comes from it: a sysctl, a middlebox, or a
 *   stop of the calls. A plan without it has no such steps.
 * - `inject` starts the trigger. The stamp of its first act is the `fault` reference.
 * - `heal` ends the fault, `hold` after the fault. A trigger that ends by itself has no heal.
 * - `restore` brings the cell back to its steady state after the run.
 * - `flaps` are the faults after the first one. A plan without them has one fault.
 */
export interface FaultPlan {
  readonly prepare?: readonly Step[] | undefined;
  readonly inject: readonly Step[];
  readonly hold: Quantity | null;
  readonly heal: readonly Step[];
  readonly restore: readonly Step[];
  /** These flaps are the faults after the first one (`Trigger.flaps`). Each one does the inject and the heal again. */
  readonly flaps?: readonly Flap[] | undefined;
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
/** This selector gives the ztunnel pods in istio-system: the label `app` of the chart of ztunnel. */
export const ZTUNNEL_PODS = "app=ztunnel";

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

/** These are the names of the sysctls that the steps of a plan set. Each one is a sysctl of a network namespace. */
export const SYSCTL = {
  retries: "net.ipv4.tcp_retries2",
} as const;

/**
 * These are the values of those sysctls in a new network namespace of Linux v6.17. A restore puts
 * them back. `tcp_retries2` is TCP_RETR2 (include/net/tcp.h, line 105, and net/ipv4/tcp_ipv4.c,
 * line 3604).
 */
export const NETNS_DEFAULTS = { retries: "15" } as const;

/**
 * These are the names of the middlebox in the filter table of a replica. One chain takes the
 * segments from the peers, and one chain takes the segments to them. The table of xt_recent holds
 * the time of the last segment of each peer.
 */
export const MIDDLEBOX = { input: "LAB-MBX-IN", output: "LAB-MBX-OUT", table: "LAB-MBX" } as const;

/** This time is between the stop of the calls and the fault of a quiet black hole. The last answers and their ACKs, at most 200 ms late, come in it. */
export const QUIET_LEAD: Quantity = { value: 1, unit: "s" };

/** This time is between the close of the old channel of each client and the fault of a gap with `close`. The stream of the old channel ends in it. */
export const CLOSE_LEAD: Quantity = { value: 2, unit: "s" };

/** This time is how long each client calls on its new channel at the fault of a gap with `close`, before it closes it. */
export const CHANNEL_USE: Quantity = { value: 5, unit: "s" };

/**
 * This time is between the SIGHUP of `cannot-serve` and its fault. Each client opens new connections
 * at the signal, and the requests on its old connections end in this time (the timeout and 100 ms).
 */
export const SPREAD_LEAD: Quantity = { value: 3, unit: "s" };

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * This function gives the command of the injector that sets one sysctl of its network namespace.
 * Only a sysctl of the namespace (`net.`) and a whole number reach it.
 */
export const sysctlCommand = (key: string, value: string): string[] => {
  if (!/^net\.[a-z0-9_.]+$/.test(key)) throw new Error(`not a sysctl of a network namespace: ${key}`);
  if (!/^\d+$/.test(value)) throw new Error(`not a whole number: ${value}`);
  return ["sysctl", "-w", `${key}=${value}`];
};

/**
 * This function gives the commands of the injector that put a stateful middlebox in its network
 * namespace, with each peer, on the local port `port`. With `idle` null, they remove it.
 *
 * The middlebox forgets a flow of the port after `idle` with no segment. Then it drops each later
 * segment of it: the silent-drop form of the router of the harness. Conntrack stays as it is. The
 * local leg from ztunnel to the app has no PING, and istio-cni needs its conntrack entry. The
 * connmark of that entry sends each answer of the app back to ztunnel (cni/pkg/iptables/iptables.go
 * of Istio 1.31.3, lines 172–178, 278–284 and 336–347).
 *
 * The match recent keeps a table in each network namespace (xt_recent.c of Linux v6.17). Its key is
 * the address of the peer: the source of a segment from it, or the destination of a segment to it
 * (lines 251–257). The chain of each direction has these rules, in sequence:
 * - In the input chain only, a SYN sets the time of its peer and passes: a new flow.
 * - A segment of a peer with a time in the last `idle` seconds passes, and it sets the time again
 *   (lines 298–321).
 * - A segment of a peer with an older time is dropped, and the time stays old. Thus the flow stays forgotten.
 * - A segment of a peer that the table does not hold sets its time and passes (lines 283–290). That
 *   is the flow that was open before the set.
 *
 * Each rule that passes a segment goes back to INPUT or OUTPUT (RETURN), thus the other rules of the
 * namespace still act on it. The key is an address, not a flow. Thus a new SYN of a peer also refreshes an
 * old flow of the peer. A cell of the middlebox opens no new flow in its gap.
 */
export const middleboxCommands = (peers: readonly string[], idle: Quantity | null, port: number): string[][] => {
  if (peers.length === 0) throw new Error("a middlebox needs a peer");
  for (const peer of peers) if (!IPV4.test(peer)) throw new Error(`not an address: ${peer}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${port}`);
  const op = idle === null ? "-D" : "-I";
  // the option of a port follows the protocol that loads its match
  const jumps = peers.flatMap((peer) => [
    ["iptables", op, "INPUT", "-s", `${peer}/32`, "-p", "tcp", "--dport", String(port), "-j", MIDDLEBOX.input],
    ["iptables", op, "OUTPUT", "-d", `${peer}/32`, "-p", "tcp", "--sport", String(port), "-j", MIDDLEBOX.output],
  ]);
  const chains = [MIDDLEBOX.input, MIDDLEBOX.output];
  // the chains are empty first: a jump that a failed fault did not add does not keep the drops
  if (idle === null) return [...chains.map((chain) => ["iptables", "-F", chain]), ...jumps, ...chains.map((chain) => ["iptables", "-X", chain])];
  const time = valueIn(idle, "s");
  if (!Number.isInteger(time) || time < 1) throw new Error(`the idle timeout of the middlebox is a whole number of seconds, not ${time}`);
  const rules = (chain: string, side: "--rsource" | "--rdest"): string[][] => {
    const recent = ["-m", "recent", "--name", MIDDLEBOX.table, side];
    return [
      ...(chain === MIDDLEBOX.input ? [["iptables", "-A", chain, "-p", "tcp", "--syn", ...recent, "--set", "-j", "RETURN"]] : []),
      ["iptables", "-A", chain, ...recent, "--update", "--seconds", String(time), "-j", "RETURN"],
      ["iptables", "-A", chain, ...recent, "--rcheck", "-j", "DROP"],
      ["iptables", "-A", chain, ...recent, "--set", "-j", "RETURN"],
    ];
  };
  return [...chains.map((chain) => ["iptables", "-N", chain]), ...rules(MIDDLEBOX.input, "--rsource"), ...rules(MIDDLEBOX.output, "--rdest"), ...jumps];
};

/**
 * This function gives the target of a reset or a black hole of a cell. In T07 and T18 it is Redis,
 * with the replicas as peers. In T15 the fault is on the mesh leg between the client pods and the
 * replicas. It is a rule in each replica, with the client pods as peers. A partition (`partition`)
 * is a rule in the target replica only, with the client pods as peers.
 */
const linkOf = (cell: KindCell): Target => (cell.trigger.partition === true ? "server" : cell.template === "T15" ? "servers" : "redis");

/**
 * This function gives the fault plan of a cell. A trigger with flaps (`Trigger.flaps`) gives them to
 * its plan: the runner then does the inject and the heal again for each flap. A plan with no hold or
 * no heal cannot flap.
 */
export const planOf = (cell: KindCell): FaultPlan => {
  const plan = stepsOf(cell);
  const flaps = cell.trigger.flaps;
  if (flaps === undefined || flaps.length === 0) return plan;
  if (plan.hold === null || plan.heal.length === 0) throw new Error(`the trigger ${cell.trigger.kind} has no hold and heal, thus it cannot flap`);
  for (const flap of flaps) {
    if (valueIn(flap.rest, "ms") <= 0 || valueIn(flap.hold, "ms") <= 0) throw new Error("each flap has a rest and a hold above zero");
  }
  return { ...plan, flaps };
};

/**
 * This function gives the time from the first fault of a trigger to its last heal. It is the hold,
 * then the rest and the hold of each flap. A trigger with no hold gives zero.
 */
export const faultSpan = (trigger: Pick<KindCell["trigger"], "hold" | "flaps">): Quantity => {
  const hold = trigger.hold === undefined ? 0 : valueIn(trigger.hold, "s");
  const flaps = (trigger.flaps ?? []).reduce((sum, flap) => sum + valueIn(flap.rest, "s") + valueIn(flap.hold, "s"), 0);
  return { value: Math.round((hold + flaps) * 1e6) / 1e6, unit: "s" };
};

/** This function gives the steps of the fault plan of a cell, with no flaps. */
const stepsOf = (cell: KindCell): FaultPlan => {
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
    case "blackhole": {
      // a quiet black hole stops the calls before the fault, and starts them again after the clear.
      // The restore puts back the tcp_retries2 of each client pod, and starts the calls of a client
      // that a failed heal left stopped
      const quiet = trigger.quiet === true;
      const retries = trigger.retries;
      if (retries !== undefined && !(Number.isInteger(retries) && retries >= 1 && retries <= 255)) throw new Error(`tcp_retries2 is a count from 1 to 255, not ${retries}`);
      const start: Step[] = quiet ? [{ do: "signal", target: "clients", signal: "SIGUSR2" }] : [];
      // a partition gives each client new connections first, as cannot-serve does
      const spread: Step[] = trigger.partition === true ? [{ do: "signal", target: "clients", signal: "SIGHUP" }, { do: "wait", time: SPREAD_LEAD }] : [];
      const prepare: Step[] = [
        ...spread,
        ...(retries === undefined ? [] : [{ do: "sysctl" as const, target: "clients" as const, key: SYSCTL.retries, value: String(retries) }]),
        ...(quiet ? [{ do: "signal" as const, target: "clients" as const, signal: "SIGUSR1" as const }, { do: "wait" as const, time: QUIET_LEAD }] : []),
      ];
      return {
        ...(prepare.length === 0 ? {} : { prepare }),
        inject: [{ do: "inject", target: linkOf(cell), action: "blackhole" }],
        hold: needs(trigger.hold, "a hold"),
        heal: [{ do: "inject", target: linkOf(cell), action: "clear" }, ...start],
        restore: [...(retries === undefined ? [] : [{ do: "sysctl" as const, target: "clients" as const, key: SYSCTL.retries, value: NETNS_DEFAULTS.retries }]), ...start],
      };
    }
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
    case "app-stall": {
      // in T07, each client opens new connections first, as a partition does. Thus they spread over the replicas in each run
      const spread: Step[] = cell.template === "T07" ? [{ do: "signal", target: "clients", signal: "SIGHUP" }, { do: "wait", time: SPREAD_LEAD }] : [];
      return {
        ...(spread.length === 0 ? {} : { prepare: spread }),
        inject: [{ do: "stall", target: "server", time: needs(trigger.hold, "a hold") }],
        hold: null,
        heal: [],
        restore: [],
      };
    }
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
    case "idle": {
      // the gap of the clients: the restore starts the calls of a client that a failed heal left stopped
      const hold = needs(trigger.hold, "a hold, the time of the gap");
      const start: Step = { do: "signal", target: "clients", signal: "SIGUSR2" };
      if (trigger.close === true) {
        // each client closes its channel before the fault. At the fault it opens a new channel, calls
        // on it, and closes it. Thus the fault is the last use of the HBONE connection of the client
        const close: Step = { do: "signal", target: "clients", signal: "SIGHUP" };
        return { prepare: [close, { do: "wait", time: CLOSE_LEAD }], inject: [start, { do: "wait", time: CHANNEL_USE }, close], hold, heal: [start], restore: [start] };
      }
      const middlebox = trigger.middlebox;
      // the middlebox is in the namespace of each replica from before the gap to the end of the run
      return {
        ...(middlebox === undefined ? {} : { prepare: [{ do: "middlebox" as const, target: "servers" as const, idle: middlebox, port: HBONE_PORT }] }),
        inject: [{ do: "signal", target: "clients", signal: "SIGUSR1" }],
        hold,
        heal: [start],
        restore: [start, ...(middlebox === undefined ? [] : [{ do: "middlebox" as const, target: "servers" as const, idle: null, port: HBONE_PORT }])],
      };
    }
    case "ztunnel-restart":
      // the ztunnel pod of each node goes with its grace. The flow of each client crosses the ztunnel
      // of its own node, thus each client meets the restart. The restore waits for the DaemonSet
      return {
        inject: [{ do: "kubectl", args: ["-n", "istio-system", "delete", "pod", "-l", ZTUNNEL_PODS, "--wait=false"] }],
        hold: null,
        heal: [],
        restore: [{ do: "kubectl", args: ["-n", "istio-system", "rollout", "status", "daemonset/ztunnel", "--timeout=300s"] }],
      };
    case "certificate-expiry":
      // the calls go on through the hold. The reads of the certificates are the evidence of their
      // lifetime, at the fault and at the heal. Thus a run shows each leaf that expired in the hold
      return {
        inject: [{ do: "certificates" }],
        hold: needs(trigger.hold, "a hold, the time past the lifetime of the certificates"),
        heal: [{ do: "certificates" }],
        restore: [],
      };
    case "cannot-serve":
      // each client opens its connections again before the fault, thus they spread over the replicas
      // in each run. The flag fails the route and the readiness of the target. The heal removes it
      return {
        prepare: [{ do: "signal", target: "clients", signal: "SIGHUP" }, { do: "wait", time: SPREAD_LEAD }],
        inject: [{ do: "flag", target: "server", on: true }],
        hold: needs(trigger.hold, "a hold, the time that the replica cannot serve"),
        heal: [{ do: "flag", target: "server", on: false }],
        restore: [{ do: "flag", target: "server", on: false }],
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
