import type { Band, KindCell, Prediction } from "@mark1russell7/kind";
import { kubeletBand, latchBand, removalBand, restartBand, showBand, stallRemovalBand } from "@mark1russell7/kind";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { DESIGN_REDIS, KUBE_PROBE, PROPAGATION, WORKERS, WORKLOAD, kubeDefaults, s } from "./kind.ts";

/**
 * The T18 catalog: a health-gated fleet. Three replicas of the service of this repository sit
 * behind a Service, and each one needs Redis. The round trip of the Redis client gates readiness.
 * Thus a fault of Redis fails each replica, and the Service then has no endpoint. The band is the
 * latch, then the probes of the kubelet, then the propagation. Redis 7.4 stands for the
 * valkey-9.1-sentinel of the plan: one server, because failover is the question of T12.
 *
 * The plan's `event:clock-jump` has no cell. A step of CLOCK_REALTIME in the VM steps each clock of
 * the VM: the kubelet, the API server and the cells of the other agents. A time namespace offsets only
 * the monotonic clocks.
 */

const E = PROPAGATION.iptables;
const poll = DESIGN_REDIS.poll;
const timeout = DESIGN_REDIS.redis!.knobs.request_timeout;
/** This band is the trip of the readiness latch on a Redis that refuses: each poll fails at once. */
const refuses = latchBand(DESIGN_REDIS.readiness, poll, "refuses");
/** This band is the trip on a silent Redis: each poll fails at the request timeout of the client (2 s). */
const silent = latchBand(DESIGN_REDIS.readiness, poll, "silent", timeout);

const REDIS_SUB = "Redis 7.4, one server, stands for valkey-9.1-sentinel";

const base: Omit<KindCell, "id" | "name" | "trigger" | "prediction"> = {
  template: "T18",
  substitutes: REDIS_SUB,
  mode: "iptables",
  workers: WORKERS,
  pod: kubeDefaults(3),
  declaration: DESIGN_REDIS,
  workload: WORKLOAD,
  calibrates: false,
  runs: 11,
};

/** This function gives a removal of each replica, and the hold of a fault: the end of the band and 5 s. */
const removal = (latch: Band, how: string): { prediction: Prediction; hold: Quantity } => {
  const band = removalBand(latch, KUBE_PROBE, E);
  return {
    prediction: {
      kind: "removal",
      band,
      why: `the latch trips in ${showBand(latch)} (${how}), the kubelet needs 3 probes 10 s apart, then the propagation: the Service is empty in ${showBand(band)}`,
    },
    hold: s(Math.ceil(valueIn(band.hi, "s")) + 5),
  };
};

const refused = removal(refuses, "each poll fails at once");
const quiet = removal(silent, "each poll fails at the request timeout of 2 s");
const restart = restartBand(silent, KUBE_PROBE, s(0));
const stall = stallRemovalBand(KUBE_PROBE, E);

/** These are the cells of T18, at the defaults of Kubernetes and of the design, on iptables. */
export const T18_CELLS: readonly KindCell[] = [
  {
    ...base,
    id: "T18.defaults.1",
    name: "T18 rst from Redis to each replica, the round trip gates readiness",
    trigger: { kind: "rst", hold: refused.hold },
    prediction: refused.prediction,
  },
  {
    ...base,
    id: "T18.defaults.10",
    name: "T18 Redis frozen with SIGSTOP, the round trip gates readiness",
    trigger: { kind: "freeze-process", hold: quiet.hold },
    prediction: quiet.prediction,
  },
  {
    ...base,
    id: "T18.defaults.11",
    name: "T18 blackhole between Redis and each replica, the round trip gates readiness",
    trigger: { kind: "blackhole", hold: quiet.hold },
    prediction: quiet.prediction,
  },
  {
    ...base,
    declaration: { ...DESIGN_REDIS, redis: { ...DESIGN_REDIS.redis!, gates: null } },
    id: "T18.defaults.11",
    name: "T18 blackhole between Redis and each replica, the round trip gates nothing",
    trigger: { kind: "blackhole", hold: quiet.hold },
    prediction: {
      kind: "stays",
      why: "no check gates readiness on Redis: each replica stays ready, degraded, and each request that needs Redis fails by itself",
    },
  },
  {
    ...base,
    id: "T18.defaults.5",
    name: "T18 Redis gone without a close, the round trip gates readiness",
    trigger: { kind: "peer-gone-without-close", hold: quiet.hold },
    prediction: quiet.prediction,
  },
  {
    ...base,
    id: "T18.defaults.4",
    name: "T18 the event loop of one replica blocked for 40 s",
    trigger: { kind: "app-stall", hold: s(40) },
    prediction: {
      kind: "leaves",
      band: stall,
      why: `each probe in the stall fails at its timeout of 1 s, thus the third failure comes ${showBand(kubeletBand(KUBE_PROBE, true))} after the start, then the propagation: ${showBand(stall)}`,
    },
  },
  {
    ...base,
    id: "T18.defaults.6",
    name: "T18 blackhole of Redis for 60 s, liveness reads only the event loop",
    trigger: { kind: "blackhole", hold: s(60) },
    prediction: { kind: "restarts", band: null, why: "the fault of Redis fails readiness, and nothing couples readiness to liveness: no replica restarts" },
  },
  {
    ...base,
    declaration: { ...DESIGN_REDIS, couplings: [...DESIGN_REDIS.couplings, { from: "readiness", to: "liveness", effect: "fails" }] },
    id: "T18.defaults.6",
    name: "T18 blackhole of Redis, readiness fails liveness",
    trigger: { kind: "blackhole", hold: s(Math.ceil(valueIn(restart.hi, "s")) + 5) },
    prediction: {
      kind: "restarts",
      band: restart,
      why: `the latch trips in ${showBand(silent)}, liveness fails with it, and the liveness probes kill each replica 20 s to 30 s later: SIGTERM in ${showBand(restart)}`,
    },
  },
  {
    ...base,
    id: "T18.defaults.7",
    name: "T18 rolling update while Redis has no endpoint",
    trigger: { kind: "rollout", hold: s(45) },
    prediction: {
      kind: "stalls",
      why: "a new pod earns readiness only through Redis, and maxUnavailable 25 % of 3 is 0: no old pod goes until a new one is ready",
    },
  },
  {
    ...base,
    id: "T18.defaults.9",
    name: "T18 cpu.max of one replica at 1 ms in each 1 s for 40 s",
    trigger: { kind: "cpu-throttle", hold: s(40), cpuMax: { quota: { value: 1000, unit: "us" }, period: { value: 1_000_000, unit: "us" } } },
    prediction: {
      kind: "measured",
      why: "the quota bounds the stall in each period (0.999 s), not the CPU that the replica needs: a probe meets its 1 s deadline or not by that need",
    },
  },
];
