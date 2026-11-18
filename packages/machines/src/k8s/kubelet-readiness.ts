import type { Machine } from "@mark1russell7/automata";
import { machineSchema } from "@mark1russell7/automata/schema";

const AT = "kubernetes v1.37.0";
const WORKER = `${AT} pkg/kubelet/prober/worker.go`;

/**
 * This document is the readiness probe of the kubelet of Kubernetes 1.37.0 for one container. Each
 * fact comes from the source at the tag v1.37.0, with the file and the line. The defaults are a
 * period of 10 s, a timeout of 1 s and a failure threshold of 3.
 *
 * - The worker probes once at its start, then once at each tick of a Go ticker of one period. The
 *   probe is synchronous. A Go ticker keeps one tick for a slow receiver, thus a probe that takes
 *   longer than a period starts the next probe at once. The interval is max(period, timeout).
 * - A probe of a pod that stops to answer fails at its timeout. An HTTP probe that times out is a
 *   failure without an error, thus the kubelet does not try it again.
 * - The result changes after `threshold` failures in a row. Thus the pod becomes unready at the
 *   timeout of probe `threshold`, counted from the first probe after the fault.
 * - The first probe after the fault comes within one period. Thus the band is one period wide.
 * - A tcpSocket probe passes on a stalled process, because its kernel accepts the connection.
 *
 * This document does not hold two delays of the start of a container. The probe waits for
 * `initialDelaySeconds` after the start. A kubelet that started less than one period ago sleeps a
 * random part of a period before its first probe.
 */
export const KUBELET_READINESS: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "kubelet-readiness",
  title: "The readiness probe of the kubelet of Kubernetes 1.37.0, for one container",
  layer: "canary",
  version: "1.37.0",
  conditions: { kubernetes: "1.37.0", go: "1.26.6" },
  sources: [
    {
      ref: `${AT} pkg/apis/core/v1/defaults.go:275-288 SetDefaults_Probe: TimeoutSeconds 1, PeriodSeconds 10, SuccessThreshold 1, FailureThreshold 3. InitialDelaySeconds has no default, thus 0`,
      rung: "implemented",
    },
    {
      ref: `${AT} staging/src/k8s.io/api/core/v1/types.go:2936-2972 type Probe: initialDelaySeconds (:2942), timeoutSeconds with a minimum of 1 (:2947), periodSeconds with a minimum of 1 (:2951), successThreshold (:2955), failureThreshold with a minimum of 1 (:2959)`,
      rung: "documented",
    },
    { ref: `${WORKER}:113-116 a readiness probe starts with the result Failure`, rung: "implemented" },
    {
      ref: `${WORKER}:157-202 run: a sleep of rand.Float64() × period if the kubelet started less than one period ago (:162-167), a ticker of periodSeconds (:160, :169), and one probe at once, then one probe at each tick (:187-200)`,
      rung: "implemented",
    },
    { ref: `${WORKER}:330-333 the probe is off for InitialDelaySeconds after the start of the container`, rung: "implemented" },
    {
      ref: `${WORKER}:366-379 resultRun counts the equal results in a row. The result changes only at failureThreshold failures or successThreshold successes`,
      rung: "implemented",
    },
    {
      ref: `${AT} pkg/kubelet/prober/prober.go:42, :139-150, :154 a probe runs again up to 3 times only on an error, and its timeout is TimeoutSeconds`,
      rung: "implemented",
    },
    {
      ref: `${AT} pkg/probe/http/http.go:91-104, :119-125 an http.Client with the timeout, and an error of client.Do is a Failure without an error`,
      rung: "implemented",
    },
    { ref: `${AT} pkg/probe/tcp/tcp.go:50-62 DoTCPProbe dials with the timeout, and a connection is a Success`, rung: "implemented" },
    {
      ref: "go1.26.6 src/time/tick.go:21-24, :40-41 NewTicker: a channel of one tick, and the ticker drops ticks for a slow receiver",
      rung: "implemented",
    },
  ],
  states: {
    READY: { initial: true, note: "the probes pass" },
    UNREADY: { note: "the kubelet sets the result Failure, and the endpoints of the Service drop the pod" },
  },
  events: {
    "probe.fail": { kind: "local", note: "a probe fails at its timeout, or with a failure status" },
    "probe.pass": { kind: "local" },
    "timer.probe": { kind: "timer" },
    "timer.unready": { kind: "timer" },
  },
  knobs: {
    period: { key: "readinessProbe.periodSeconds", scope: "pod", unit: "s", default: 10 },
    threshold: { key: "readinessProbe.failureThreshold", scope: "pod", unit: "count", default: 3 },
    timeout: { key: "readinessProbe.timeoutSeconds", scope: "pod", unit: "s", default: 1 },
  },
  timers: {
    probe: {
      duration: { expr: "max(period, timeout)", unit: "s" },
      arms: ["enter:READY"],
      fires: "timer.probe",
      backoff: { resets: ["enter:READY"] },
      note: "worker.go:187-200: the next probe, at the next tick. A probe longer than a period gets the kept tick at once, the same each time",
    },
    unready: {
      duration: { expr: "period + (threshold - 1) * max(period, timeout) + timeout", unit: "s" },
      early: { knob: "period", unit: "s" },
      arms: ["probe.fail"],
      cancels: ["probe.pass"],
      fires: "timer.unready",
      note: "from the fault: the first probe within one period, threshold - 1 intervals, then the timeout of the last probe. A probe in flight at the fault gets its reply within milliseconds, thus the band does not hold it",
    },
  },
  transitions: [
    { id: "kr.probe", from: "READY", to: "READY", on: ["timer.probe", "probe.pass"], timer: "probe", source: "worker.go:187-200" },
    { id: "kr.unready", from: "READY", to: "UNREADY", on: "timer.unready", timer: "unready", source: "worker.go:366-379" },
  ],
});
